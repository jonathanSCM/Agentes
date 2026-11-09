'use strict';
// lib/services/solicitudesPlan.js
//
// CAMBIO DE PLAN pedido por el cliente. Mientras no haya pasarela de pago, el cliente elige un plan y una
// duración y el pedido llega al buzón del superadmin, que lo aprueba (se asigna el plan con sus valores
// copiados, empezando hoy) o lo rechaza con un motivo. Pedir NO cambia nada: el plan solo cambia al aprobar.
//   - Solo se puede pedir un plan activo y visible (los ocultos, como "Acceso total", solo los asigna el superadmin).
//   - Pedir el mismo plan que ya tiene sirve para RENOVARLO.
//   - Aprobar "reclama" el pedido de forma atómica: dos clics no asignan el plan dos veces; si no se puede asignar
//     (por ejemplo, hay una caja abierta y el plan nuevo no trae Punto de venta), el pedido vuelve a quedar pendiente.

const { prisma } = require('../db');
const planes = require('./planesCliente');
const notif = require('./notificaciones');
const auditoria = require('./auditoria');

const MESES = [1, 2, 3, 6, 12];
const MAX_PENDIENTES = 2; // por cliente: evita llenar el buzón

class ErrorSolicitudPlan extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'SOLICITUD'; }
}

/** Planes que el cliente puede pedir: activos y visibles, con sus características para compararlos. */
function disponibles() {
  return prisma.plan.findMany({
    where: { activo: true, oculto: false, ilimitado: false },
    include: { caracteristicas: { where: { incluida: true }, include: { caracteristica: true } } },
    orderBy: [{ orden: 'asc' }, { mensualidadBs: 'asc' }],
  });
}

/** El cliente pide un plan por N meses (con una nota opcional, por ejemplo cómo va a pagar). */
async function crear(empresaId, { planId, meses, nota }) {
  const plan = await prisma.plan.findUnique({ where: { id: Number(planId) } });
  if (!plan || !plan.activo || plan.oculto || plan.ilimitado) throw new ErrorSolicitudPlan('Ese plan no está disponible.');
  const m = Number(meses);
  if (!MESES.includes(m)) throw new ErrorSolicitudPlan('Elegí la duración: 1, 2, 3, 6 o 12 meses.');
  const texto = String(nota || '').trim().slice(0, 300) || null;
  const pendientes = await prisma.solicitudPlan.findMany({ where: { empresaId, estado: 'PENDIENTE' }, select: { planId: true } });
  if (pendientes.some((p) => p.planId === plan.id)) throw new ErrorSolicitudPlan('Ya pediste ese plan y lo estamos revisando.');
  if (pendientes.length >= MAX_PENDIENTES) throw new ErrorSolicitudPlan('Ya tenés pedidos de plan esperando respuesta. Esperá a que los revisemos antes de enviar otro.');
  return prisma.solicitudPlan.create({ data: { empresaId, planId: plan.id, planNombre: plan.nombre, meses: m, nota: texto } });
}

/** Buzón del superadmin. */
function listar({ estado = null, limite = 100 } = {}) {
  return prisma.solicitudPlan.findMany({
    where: estado ? { estado } : {},
    include: { empresa: { select: { id: true, nombre: true, slug: true } }, plan: { select: { modulos: true, mensualidadBs: true } } },
    orderBy: [{ estado: 'asc' }, { createdAt: 'desc' }],
    take: limite,
  });
}
const contarPendientes = () => prisma.solicitudPlan.count({ where: { estado: 'PENDIENTE' } });
const delCliente = (empresaId, limite = 10) => prisma.solicitudPlan.findMany({ where: { empresaId }, orderBy: { createdAt: 'desc' }, take: limite });

/** Aprueba: asigna el plan (copiando sus valores, desde hoy) por los meses pedidos (o los que ajuste el superadmin). */
async function aprobar(id, { meses = null, respuesta = null, ahora = new Date() } = {}) {
  const sol = await prisma.solicitudPlan.findUnique({ where: { id: Number(id) } });
  if (!sol) throw new ErrorSolicitudPlan('Ese pedido no existe.');
  if (!sol.planId) throw new ErrorSolicitudPlan('Ese plan ya no existe: rechazá el pedido y asignale uno desde el cliente.');
  const duracion = meses === null || meses === '' ? sol.meses : Number(meses);
  if (!MESES.includes(duracion)) throw new ErrorSolicitudPlan('La duración tiene que ser 1, 2, 3, 6 o 12 meses.');

  const reclamo = await prisma.solicitudPlan.updateMany({
    where: { id: sol.id, estado: 'PENDIENTE' },
    data: { estado: 'APROBADA', respuesta: respuesta ? String(respuesta).slice(0, 300) : null, resueltaAt: ahora },
  });
  if (reclamo.count === 0) throw new ErrorSolicitudPlan('Ese pedido ya fue resuelto.');

  let resultado;
  try {
    resultado = await planes.asignarPlan(sol.empresaId, sol.planId, { meses: duracion, ahora });
  } catch (err) {
    await prisma.solicitudPlan.update({ where: { id: sol.id }, data: { estado: 'PENDIENTE', respuesta: null, resueltaAt: null } });
    throw err;
  }
  const sub = resultado.suscripcion;
  await auditoria.registrarSinRiesgo({
    empresaId: sol.empresaId, actor: { nombre: 'Proshop (administración)', rol: 'PROSHOP_ADMIN' }, accion: 'PLAN_ASIGNADO', entidad: 'Suscripcion',
    detalle: { plan: sub.planNombre, hasta: sub.planFin ? sub.planFin.toISOString().slice(0, 10) : null, origen: `Pedido de plan #${sol.id}` },
  });
  await notif.crear(sol.empresaId, {
    titulo: 'Tu plan fue actualizado',
    mensaje: `Ahora tenés el plan ${sub.planNombre} por ${duracion} ${duracion === 1 ? 'mes' : 'meses'}.${respuesta ? ` ${respuesta}` : ''}`,
    tipo: 'PAGO_CONFIRMADO',
  });
  return prisma.solicitudPlan.findUnique({ where: { id: sol.id } });
}

/** Rechaza (con un motivo opcional que ve el cliente). No cambia el plan. */
async function rechazar(id, { respuesta = null, ahora = new Date() } = {}) {
  const sol = await prisma.solicitudPlan.findUnique({ where: { id: Number(id) } });
  if (!sol) throw new ErrorSolicitudPlan('Ese pedido no existe.');
  const r = await prisma.solicitudPlan.updateMany({
    where: { id: sol.id, estado: 'PENDIENTE' },
    data: { estado: 'RECHAZADA', respuesta: respuesta ? String(respuesta).slice(0, 300) : null, resueltaAt: ahora },
  });
  if (r.count === 0) throw new ErrorSolicitudPlan('Ese pedido ya fue resuelto.');
  await notif.crear(sol.empresaId, {
    titulo: 'No pudimos confirmar tu cambio de plan',
    mensaje: `${respuesta ? `${respuesta} ` : ''}Escribinos y lo revisamos juntos.`.trim(),
    tipo: 'MANUAL',
  });
  return prisma.solicitudPlan.findUnique({ where: { id: sol.id } });
}

module.exports = { ErrorSolicitudPlan, MESES, MAX_PENDIENTES, disponibles, crear, listar, contarPendientes, delCliente, aprobar, rechazar };
