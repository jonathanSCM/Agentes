'use strict';
// lib/services/caja.js
//
// La CAJA del mostrador (docs/11 F5): se abre con un efectivo inicial, se venden cosas, se mueve efectivo
// a mano (entradas y salidas) y se cierra contando. Una sola caja abierta por empresa (la base lo
// garantiza con un indice unico parcial). El efectivo esperado se calcula siempre desde las ventas y los
// movimientos: nunca se guarda un saldo que pueda quedar desactualizado.

const { prisma } = require('../db');
const auditoria = require('./auditoria');
const { aCentavos, deCentavos, efectivoEsperado, ErrorVenta } = require('./ventaCalculo');

class ErrorCaja extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.codigo = 'CAJA';
  }
}

const monto = (valor, nombre) => {
  const c = aCentavos(valor);
  if (!Number.isFinite(c) || c < 0 || c > 100000000 * 100) throw new ErrorCaja(`${nombre} no es válido.`);
  return c;
};

const sesionAbierta = (empresaId, tx = prisma) => tx.sesionCaja.findFirst({ where: { empresaId, estado: 'ABIERTA' } });

/** Abre la caja. Si ya hay una abierta (aunque la abra otra persona a la vez) se rechaza. */
async function abrir(empresaId, usuarioId, efectivoInicial = 0, notas = null) {
  const c = monto(efectivoInicial === '' || efectivoInicial === undefined ? 0 : efectivoInicial, 'El efectivo inicial');
  try {
    const sesion = await prisma.sesionCaja.create({
      data: { empresaId, abiertaPorId: usuarioId, efectivoInicial: deCentavos(c), notas: notas ? String(notas).slice(0, 300) : null },
    });
    await auditoria.registrarSinRiesgo({ empresaId, actor: { id: usuarioId }, accion: 'CAJA_ABIERTA', entidad: 'SesionCaja', entidadId: sesion.id, detalle: { efectivoInicial: Number(sesion.efectivoInicial) } });
    return sesion;
  } catch (err) {
    if (err.code === 'P2002' || /sesiones_caja_una_abierta|unique/i.test(String(err.message))) throw new ErrorCaja('Ya hay una caja abierta.');
    throw err;
  }
}

/** Entrada o salida manual de efectivo de la caja abierta. */
async function registrarMovimiento(empresaId, usuarioId, { tipo, monto: valor, nota }) {
  const t = String(tipo || '').toUpperCase();
  if (!['ENTRADA', 'SALIDA'].includes(t)) throw new ErrorCaja('Elegí si entra o sale efectivo.');
  const c = monto(valor, 'El monto');
  if (c <= 0) throw new ErrorCaja('El monto tiene que ser mayor a 0.');
  const texto = String(nota || '').trim().slice(0, 200);
  if (texto.length < 3) throw new ErrorCaja('Escribí el motivo (por ejemplo "pago a proveedor").');
  const sesion = await sesionAbierta(empresaId);
  if (!sesion) throw new ErrorCaja('No hay una caja abierta.');
  // Una salida no puede dejar la caja en negativo.
  if (t === 'SALIDA') {
    const r = await resumen(sesion.id);
    if (c > r.efectivoEsperadoCentavos) throw new ErrorCaja(`No hay tanto efectivo en la caja (hay ${(r.efectivoEsperadoCentavos / 100).toFixed(2)}).`);
  }
  const mov = await prisma.movimientoCaja.create({ data: { sesionId: sesion.id, tipo: t, monto: deCentavos(c), nota: texto, usuarioId } });
  await auditoria.registrarSinRiesgo({ empresaId, actor: { id: usuarioId }, accion: 'CAJA_MOVIMIENTO', entidad: 'SesionCaja', entidadId: sesion.id, detalle: { tipo: t, monto: Number(mov.monto), nota: texto } });
  return mov;
}

/** Totales de una sesion: ventas, cobros por metodo y efectivo esperado (las anuladas no cuentan). */
async function resumen(sesionId) {
  const [sesion, ventas, movimientos] = await Promise.all([
    prisma.sesionCaja.findUnique({ where: { id: sesionId } }),
    prisma.venta.findMany({ where: { sesionCajaId: sesionId, estado: 'COMPLETADA' }, include: { pagos: true } }),
    prisma.movimientoCaja.findMany({ where: { sesionId } }),
  ]);
  if (!sesion) throw new ErrorCaja('Esa caja no existe.');
  const porMetodo = { EFECTIVO: 0, QR: 0, TARJETA: 0, TRANSFERENCIA: 0 };
  let vendido = 0;
  for (const v of ventas) {
    vendido += aCentavos(v.total);
    for (const p of v.pagos) porMetodo[p.metodo] += aCentavos(p.monto);
  }
  const entradas = movimientos.filter((m) => m.tipo === 'ENTRADA').reduce((s, m) => s + aCentavos(m.monto), 0);
  const salidas = movimientos.filter((m) => m.tipo === 'SALIDA').reduce((s, m) => s + aCentavos(m.monto), 0);
  const esperado = efectivoEsperado({ inicialCentavos: aCentavos(sesion.efectivoInicial), cobrosEfectivoCentavos: porMetodo.EFECTIVO, entradasCentavos: entradas, salidasCentavos: salidas });
  return {
    sesion, cantidadVentas: ventas.length, vendidoCentavos: vendido, porMetodoCentavos: porMetodo,
    entradasCentavos: entradas, salidasCentavos: salidas, efectivoEsperadoCentavos: esperado, movimientos,
  };
}

/**
 * Cierra la caja con el efectivo contado. Se "reclama" el cierre (ABIERTA -> CERRADA) de forma atomica,
 * asi dos cierres simultaneos no se pisan. Guarda lo esperado, lo contado y la diferencia.
 */
async function cerrar(empresaId, usuarioId, { efectivoContado, notas = null }) {
  const contado = monto(efectivoContado, 'El efectivo contado');
  const sesion = await sesionAbierta(empresaId);
  if (!sesion) throw new ErrorCaja('No hay una caja abierta.');
  const r = await resumen(sesion.id);
  const reclamo = await prisma.sesionCaja.updateMany({
    where: { id: sesion.id, empresaId, estado: 'ABIERTA' },
    data: {
      estado: 'CERRADA', cerradaPorId: usuarioId, cerradaAt: new Date(),
      efectivoEsperado: deCentavos(r.efectivoEsperadoCentavos), efectivoContado: deCentavos(contado), diferencia: deCentavos(contado - r.efectivoEsperadoCentavos),
      notas: notas ? String(notas).slice(0, 300) : sesion.notas,
    },
  });
  if (reclamo.count === 0) throw new ErrorCaja('Esa caja ya fue cerrada.');
  await auditoria.registrarSinRiesgo({
    empresaId, actor: { id: usuarioId }, accion: 'CAJA_CERRADA', entidad: 'SesionCaja', entidadId: sesion.id,
    detalle: { esperado: r.efectivoEsperadoCentavos / 100, contado: contado / 100, diferencia: (contado - r.efectivoEsperadoCentavos) / 100 },
  });
  return { ...r, sesion: await prisma.sesionCaja.findUnique({ where: { id: sesion.id } }), diferenciaCentavos: contado - r.efectivoEsperadoCentavos };
}

/** Ultimas cajas de la empresa (con su diferencia). */
function historial(empresaId, limite = 30) {
  return prisma.sesionCaja.findMany({
    where: { empresaId }, orderBy: { id: 'desc' }, take: Math.min(Number(limite) || 30, 100),
    include: { abiertaPor: { select: { nombre: true } }, cerradaPor: { select: { nombre: true } }, _count: { select: { ventas: true } } },
  });
}

module.exports = { ErrorCaja, ErrorVenta, sesionAbierta, abrir, registrarMovimiento, resumen, cerrar, historial };
