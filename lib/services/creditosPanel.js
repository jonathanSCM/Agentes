'use strict';
// lib/services/creditosPanel.js
//
// Datos de creditos para las pantallas (dueño del negocio y superadmin). Solo lectura.

const { prisma } = require('../db');
const cr = require('./creditos');

const ETQ_ACCION = { CONVERSACION_NUEVA: 'Conversaciones nuevas', TURNO_IA: 'Respuestas con IA', PLANTILLA_SALIENTE: 'Plantillas enviadas' };
const ETQ_TIPO = { ASIGNACION: 'Créditos del plan', COMPRA: 'Compra de créditos', MIGRACION: 'Conversión de tu saldo', CONSUMO: 'Consumo', DEVOLUCION: 'Devolución', AJUSTE: 'Ajuste', VENCIMIENTO: 'Vencimiento' };

/**
 * Resumen para "Mi plan y consumo". Devuelve null si los creditos no estan activos o el plan es ilimitado
 * (en ese caso la pantalla muestra lo de siempre).
 */
async function resumenCliente(empresaId, db = prisma) {
  if (cr.modo() !== 'ACTIVO') return null;
  const sus = await db.suscripcion.findUnique({ where: { empresaId }, select: { ilimitado: true } });
  if (!sus || sus.ilimitado) return null;
  const ahora = new Date();
  const hace30 = new Date(ahora.getTime() - 30 * 24 * 60 * 60 * 1000);
  const hace7 = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [s, porAccion, ultimos, gasto7] = await Promise.all([
    cr.saldo(empresaId, { db }),
    db.creditoMovimiento.groupBy({ by: ['accion'], where: { empresaId, tipo: 'CONSUMO', createdAt: { gte: hace30 } }, _sum: { cantidad: true }, _count: true }),
    db.creditoMovimiento.findMany({ where: { empresaId, tipo: { not: 'SOMBRA' } }, orderBy: { id: 'desc' }, take: 15 }),
    db.creditoMovimiento.aggregate({ where: { empresaId, tipo: 'CONSUMO', createdAt: { gte: hace7 } }, _sum: { cantidad: true } }),
  ]);
  const gastoDia = Math.abs(gasto7._sum.cantidad || 0) / 7;
  const proximoVence = s.lotes.filter((l) => l.vence).sort((a, b) => a.vence - b.vence)[0] || null;
  return {
    total: s.total, delPlan: s.porOrigen.PLAN || 0, comprados: (s.porOrigen.COMPRA || 0) + (s.porOrigen.AJUSTE || 0) + (s.porOrigen.MIGRACION || 0),
    equivaleConversaciones: await cr.equivalenteConversaciones(s.total, db),
    proximoVence: proximoVence ? { fecha: proximoVence.vence, restante: proximoVence.restante, origen: proximoVence.origen } : null,
    gastoPorDia: Math.round(gastoDia * 10) / 10,
    diasAlcanza: gastoDia > 0 ? Math.floor(s.total / gastoDia) : null,
    consumoMes: porAccion.map((a) => ({ accion: ETQ_ACCION[a.accion] || a.accion || 'Otros', veces: a._count, creditos: Math.abs(a._sum.cantidad || 0) })).sort((a, b) => b.creditos - a.creditos),
    ultimos: ultimos.map((m) => ({ fecha: m.createdAt, tipo: ETQ_TIPO[m.tipo] || m.tipo, detalle: m.accion ? (ETQ_ACCION[m.accion] || m.accion) : (m.nota || ''), cantidad: m.cantidad, saldoDespues: m.saldoDespues })),
  };
}

/** Datos completos de una empresa para el superadmin: saldo, lotes, libro y cuadre. */
async function detalleEmpresa(empresaId, { pagina = 1, db = prisma } = {}) {
  const POR = 30;
  const pag = Math.max(1, Number(pagina) || 1);
  const [empresa, s, lotes, total, movs, cuadre] = await Promise.all([
    db.empresa.findUnique({ where: { id: empresaId }, select: { id: true, nombre: true } }),
    cr.saldo(empresaId, { db }),
    db.creditoLote.findMany({ where: { empresaId }, orderBy: { id: 'desc' }, take: 40 }),
    db.creditoMovimiento.count({ where: { empresaId, tipo: { not: 'SOMBRA' } } }),
    db.creditoMovimiento.findMany({ where: { empresaId, tipo: { not: 'SOMBRA' } }, orderBy: { id: 'desc' }, skip: (pag - 1) * POR, take: POR }),
    cr.verificarCuadre(empresaId, db),
  ]);
  return { empresa, saldo: s, lotes, movimientos: movs, total, paginas: Math.max(1, Math.ceil(total / POR)), pagina: pag, cuadre };
}

module.exports = { ETQ_ACCION, ETQ_TIPO, resumenCliente, detalleEmpresa };
