'use strict';
// lib/services/solicitudesConv.js
//
// Pedidos de MAS CONVERSACIONES (docs/11 §11.1). El cliente no compra un plan nuevo: pide una
// cantidad y escribe una nota ("voy a pagar por transferencia..."). El pedido llega al buzon del
// superadmin, que lo aprueba (carga el paquete a mano) o lo rechaza, hasta que haya pasarela de pago.
// El saldo se acredita SOLO al aprobar: pedir no da conversaciones.

const { prisma } = require('../db');
const { registrarCompraPaquete } = require('./suscripciones');
const notif = require('./notificaciones');

const MIN_CANTIDAD = 100;
const MAX_CANTIDAD = 1000000;
const MAX_PENDIENTES = 3; // por cliente: evita llenar el buzon
const VIGENCIA_DIAS = 90;

class ErrorSolicitud extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'SOLICITUD'; }
}

const entero = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

/** El cliente pide una cantidad de conversaciones con una nota. */
async function crear(empresaId, { cantidad, nota }) {
  const n = entero(cantidad);
  if (!Number.isFinite(n) || n < MIN_CANTIDAD || n > MAX_CANTIDAD) {
    throw new ErrorSolicitud(`Pedí entre ${MIN_CANTIDAD.toLocaleString('es-BO')} y ${MAX_CANTIDAD.toLocaleString('es-BO')} conversaciones.`);
  }
  const texto = String(nota || '').trim().slice(0, 500);
  if (texto.length < 5) throw new ErrorSolicitud('Escribí una nota (por ejemplo cómo vas a pagar) para que podamos confirmar tu pedido.');
  const pendientes = await prisma.solicitudConversaciones.count({ where: { empresaId, estado: 'PENDIENTE' } });
  if (pendientes >= MAX_PENDIENTES) throw new ErrorSolicitud('Ya tenés pedidos esperando respuesta. Esperá a que los revisemos antes de enviar otro.');
  return prisma.solicitudConversaciones.create({ data: { empresaId, cantidad: n, nota: texto } });
}

/** Buzon del superadmin. */
async function listar({ estado = null, limite = 100 } = {}) {
  return prisma.solicitudConversaciones.findMany({
    where: estado ? { estado } : {},
    include: { empresa: { select: { id: true, nombre: true, slug: true } } },
    orderBy: [{ estado: 'asc' }, { createdAt: 'desc' }],
    take: limite,
  });
}

const contarPendientes = () => prisma.solicitudConversaciones.count({ where: { estado: 'PENDIENTE' } });

const delCliente = (empresaId, limite = 20) => prisma.solicitudConversaciones.findMany({ where: { empresaId }, orderBy: { createdAt: 'desc' }, take: limite });

/**
 * Aprueba: carga un paquete con saldo (por defecto la cantidad pedida, ajustable) con su vigencia.
 * Se "reclama" el pedido de forma atomica para que dos clicks no carguen el saldo dos veces.
 */
async function aprobar(id, { cantidad = null, vigenciaDias = VIGENCIA_DIAS, respuesta = null, ahora = new Date() } = {}) {
  const sol = await prisma.solicitudConversaciones.findUnique({ where: { id: Number(id) } });
  if (!sol) throw new ErrorSolicitud('Ese pedido no existe.');
  const aprobada = cantidad === null || cantidad === '' ? sol.cantidad : entero(cantidad);
  if (!Number.isFinite(aprobada) || aprobada <= 0 || aprobada > MAX_CANTIDAD) throw new ErrorSolicitud('La cantidad a cargar no es válida.');
  const dias = entero(vigenciaDias);
  if (!Number.isFinite(dias) || dias < 1 || dias > 3650) throw new ErrorSolicitud('La vigencia tiene que estar entre 1 y 3650 días.');

  const reclamo = await prisma.solicitudConversaciones.updateMany({
    where: { id: sol.id, estado: 'PENDIENTE' },
    data: { estado: 'APROBADA', cantidadAprobada: aprobada, respuesta: respuesta ? String(respuesta).slice(0, 300) : null, resueltaAt: ahora },
  });
  if (reclamo.count === 0) throw new ErrorSolicitud('Ese pedido ya fue resuelto.');

  try {
    const compra = await registrarCompraPaquete({
      empresaId: sol.empresaId, cantidad: aprobada, precioUsd: 0,
      fechaRenovacion: new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000),
      nota: `Pedido #${sol.id}: ${sol.nota || ''}`.slice(0, 300), estado: 'ACTIVA',
    });
    await prisma.solicitudConversaciones.update({ where: { id: sol.id }, data: { compraPaqueteId: compra.id } });
  } catch (err) {
    // Si no se pudo cargar el saldo, el pedido vuelve a quedar pendiente (nunca "aprobado" sin saldo).
    await prisma.solicitudConversaciones.update({ where: { id: sol.id }, data: { estado: 'PENDIENTE', cantidadAprobada: null, resueltaAt: null } });
    throw err;
  }
  await notif.crear(sol.empresaId, {
    titulo: 'Tus conversaciones ya están disponibles',
    mensaje: `Cargamos ${aprobada.toLocaleString('es-BO')} conversaciones a tu saldo (vigentes ${dias} días).${respuesta ? ` ${respuesta}` : ''}`,
    tipo: 'PAGO_CONFIRMADO',
  });
  return prisma.solicitudConversaciones.findUnique({ where: { id: sol.id } });
}

/** Rechaza (con un motivo opcional que ve el cliente). No acredita nada. */
async function rechazar(id, { respuesta = null, ahora = new Date() } = {}) {
  const sol = await prisma.solicitudConversaciones.findUnique({ where: { id: Number(id) } });
  if (!sol) throw new ErrorSolicitud('Ese pedido no existe.');
  const r = await prisma.solicitudConversaciones.updateMany({
    where: { id: sol.id, estado: 'PENDIENTE' },
    data: { estado: 'RECHAZADA', respuesta: respuesta ? String(respuesta).slice(0, 300) : null, resueltaAt: ahora },
  });
  if (r.count === 0) throw new ErrorSolicitud('Ese pedido ya fue resuelto.');
  await notif.crear(sol.empresaId, {
    titulo: 'No pudimos confirmar tu pedido de conversaciones',
    mensaje: `${respuesta ? `${respuesta} ` : ''}Escribinos y lo revisamos juntos.`.trim(),
    tipo: 'MANUAL',
  });
  return prisma.solicitudConversaciones.findUnique({ where: { id: sol.id } });
}

module.exports = { ErrorSolicitud, MIN_CANTIDAD, MAX_CANTIDAD, MAX_PENDIENTES, VIGENCIA_DIAS, crear, listar, contarPendientes, delCliente, aprobar, rechazar };
