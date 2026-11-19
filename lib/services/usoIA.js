'use strict';
// lib/services/usoIA.js
//
// REGISTRO DE CADA SOLICITUD A UN PROVEEDOR DE IA (directrices de IA, 2.9-A). Una fila en `usos_ia` por llamada, con empresa, agente, conversación,
// proveedor, modelo, servicio (chat, embedding…), tokens (entrada, salida y caché), estado, id de la solicitud en el proveedor, latencia, costo estimado
// en USD y la tarifa usada.
//
//   - Una llamada FALLIDA también deja fila, con tokens en 0 y SIN costo: no se inventa un importe cuando no se sabe qué consumió.
//   - El costo usa la tarifa vigente en la fecha (tarifasIA.js). Sin tarifa para ese modelo, queda sin costo (no se inventa).
//   - Registrar NUNCA rompe la atención al cliente: `registrarSinRiesgo` solo anota el error en el log.

const { prisma } = require('../db');
const tarifas = require('./tarifasIA');

const ESTADOS = ['COMPLETADA', 'FALLIDA', 'CANCELADA'];
const entero = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

/**
 * @param {{ empresaId, agenteId?, conversacionId?, proveedor, modelo, servicio?, proposito?, vuelta?, promptTokens?, cachedTokens?, completionTokens?,
 *           estado?, error?, solicitudId?, latenciaMs? }} d
 */
async function registrar(d, db = prisma) {
  const estado = ESTADOS.includes(d.estado) ? d.estado : 'COMPLETADA';
  const servicio = d.servicio || 'chat';
  const tokens = estado === 'COMPLETADA'
    ? { promptTokens: entero(d.promptTokens), cachedTokens: entero(d.cachedTokens), completionTokens: entero(d.completionTokens) }
    : { promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
  let costoUsd = null; let tarifaId = null;
  if (estado === 'COMPLETADA') {
    const t = await tarifas.vigente({ proveedor: d.proveedor, modelo: d.modelo, servicio }, db);
    if (t) { costoUsd = tarifas.costo(t, tokens); tarifaId = t.id; }
  }
  const turnoId = require('./trazaIA').sumarUso({ estado, modelo: d.modelo, promptTokens: tokens.promptTokens, completionTokens: tokens.completionTokens, costoUsd });
  return db.usoIA.create({
    data: {
      turnoId,
      empresaId: d.empresaId, agenteId: d.agenteId || null, conversacionId: d.conversacionId || null,
      proveedor: d.proveedor, modelo: d.modelo, servicio, proposito: d.proposito || 'respuesta', vuelta: entero(d.vuelta),
      ...tokens, estado, error: d.error ? String(d.error).slice(0, 60) : null, solicitudId: d.solicitudId ? String(d.solicitudId).slice(0, 120) : null,
      latenciaMs: d.latenciaMs === null || d.latenciaMs === undefined ? null : entero(d.latenciaMs), costoUsd, tarifaId, costoFuente: 'CALCULADO',
    },
  });
}

async function registrarSinRiesgo(d, db = prisma) {
  try { return await registrar(d, db); } catch (err) { console.error('[usoIA] no se pudo registrar el uso:', err.message); return null; }
}

/** Errores que ocurren ANTES de llamar al proveedor (tope propio, circuito abierto): no son una solicitud al proveedor, no se registran. */
const SIN_LLAMADA = new Set(['TOPE_EMPRESA', 'TOPE_CLIENTE', 'CIRCUITO_ABIERTO']);
const huboLlamada = (err) => Boolean(err) && !SIN_LLAMADA.has(err.tipoIA);

module.exports = { ESTADOS, registrar, registrarSinRiesgo, huboLlamada };
