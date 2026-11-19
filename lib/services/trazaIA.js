'use strict';
// lib/services/trazaIA.js
//
// HISTORIAL DE ACTIVIDAD DEL AGENTE (fase 3 del planning). Cada mensaje de un cliente atendido = un TURNO (`ia_turnos`); lo que pasa dentro
// (herramientas, bloqueos, derivaciones, fallas) = EVENTOS (`ia_eventos`); cada llamada a la IA queda ligada al turno por `usos_ia.turnoId`.
//
//   - El turno viaja en un AsyncLocalStorage: no hace falta pasar un id por todo el motor. Fuera de un turno, los eventos se ignoran.
//   - Registrar NUNCA rompe la atencion: todo va en try/catch y, si la base falla, el cliente igual es atendido.
//   - El telefono se guarda enmascarado (5917***555).
//   - Retencion: el detalle (turnos y eventos) se borra a los 120 dias, DESPUES de resumirlo en `ia_resumen_diario` (que se conserva siempre).

const { AsyncLocalStorage } = require('node:async_hooks');
const { DateTime } = require('luxon');
const { prisma } = require('../db');

const ALS = new AsyncLocalStorage();
const RETENCION_DIAS = Number(process.env.IA_RETENCION_DIAS) > 0 ? Number(process.env.IA_RETENCION_DIAS) : 120;
const ZONA = 'America/La_Paz';

function enmascarar(tel) {
  const t = String(tel || '').replace(/\D/g, '');
  if (!t) return null;
  if (t.length <= 6) return `${t.slice(0, 1)}***`;
  return `${t.slice(0, 4)}***${t.slice(-3)}`;
}

const actual = () => ALS.getStore() || null;

// Etapas del agente que se convierten en evento: [tipo, gravedad, campos de `datos` que se guardan].
const ETAPAS = {
  tool_ejecutada: ['herramienta', 'INFO', ['tool', 'fallidos']],
  envio_fallido: ['envio_fallido', 'ERROR', ['tipo', 'motivo']],
  pedido_creado: ['pedido_creado', 'INFO', ['pedidoId', 'total']],
  derivacion: ['derivacion', 'AVISO', ['tipo']],
  guardia_entrada: ['guardia_entrada', 'AVISO', ['tema']],
  revisor_salida: ['revisor_salida', 'AVISO', ['modo', 'problemas']],
  respuesta_modo_sin_ia: ['modo_sin_ia', 'AVISO', ['motivo', 'paso']],
  error_aviso_sin_ia: ['error_aviso_sin_ia', 'ERROR', ['error']],
};

function recortar(v) {
  if (typeof v === 'string') return v.slice(0, 300);
  if (Array.isArray(v)) return v.slice(0, 10).map(recortar);
  if (v && typeof v === 'object') { try { return JSON.parse(JSON.stringify(v).slice(0, 600)); } catch (_) { return null; } }
  return v;
}

async function evento({ tipo, gravedad = 'INFO', detalle = {}, empresaId, agenteId = null }) {
  try {
    const ctx = actual();
    const emp = empresaId || (ctx && ctx.empresaId);
    if (!emp) return null;
    const det = {};
    for (const [k, v] of Object.entries(detalle || {})) det[k] = recortar(v);
    return await prisma.eventoIA.create({ data: { turnoId: ctx ? ctx.turnoId : null, empresaId: emp, agenteId: agenteId || (ctx && ctx.agenteId) || null, tipo, gravedad, detalle: det } });
  } catch (err) { console.error('[trazaIA] evento:', err.message); return null; }
}

/** Llamado desde logEtapa del agente: solo las etapas conocidas, y solo dentro de un turno. */
function desdeEtapa(etapa, datos = {}) {
  const ctx = actual();
  const def = ETAPAS[etapa];
  if (!ctx || !def) return;
  if (etapa === 'respuesta_modo_sin_ia') ctx.acum.sinIA = true;
  if (etapa === 'guardia_entrada') ctx.acum.guardia = true;
  if (etapa === 'derivacion') ctx.acum.derivado = true;
  const detalle = {};
  for (const k of def[2]) if (datos && datos[k] !== undefined) detalle[k] = datos[k];
  // Una herramienta fallida es un aviso, no un dato neutro.
  const gravedad = etapa === 'tool_ejecutada' && datos && datos.fallidos ? 'AVISO' : def[1];
  ctx.pendientes.push(evento({ tipo: def[0], gravedad, detalle }));
}

/** Evento fuera de un turno (p. ej. audio/imagen no soportado): no hubo atencion del agente pero conviene verlo. */
function eventoSuelto({ empresaId, agenteId = null, tipo, gravedad = 'INFO', detalle = {} }) {
  return evento({ tipo, gravedad, detalle, empresaId, agenteId });
}

/** Suma una llamada a la IA al turno en curso. Devuelve el turnoId para guardarlo en usos_ia. */
function sumarUso({ estado, modelo, promptTokens = 0, completionTokens = 0, costoUsd = null, latenciaMs = null }) {
  const ctx = actual();
  if (!ctx) return null;
  const a = ctx.acum;
  if (estado === 'FALLIDA') a.fallidas += 1;
  else {
    a.llamadas += 1; a.tokIn += promptTokens || 0; a.tokOut += completionTokens || 0;
    if (costoUsd !== null && costoUsd !== undefined) a.costo = (a.costo || 0) + Number(costoUsd);
  }
  if (modelo) a.modelo = modelo;
  return ctx.turnoId;
}

function turnoIdActual() { const c = actual(); return c ? c.turnoId : null; }

/**
 * Envuelve la atencion de un mensaje. `fn` devuelve la salida del agente ({ ok, respuesta, error }).
 * @param {{ empresaId, agenteId?, conversacionId?, telefono?, entrada?, prueba?, citas? }} d
 */
async function conTurno(d, fn) {
  let turno = null;
  try {
    turno = await prisma.turnoIA.create({
      data: { empresaId: d.empresaId, agenteId: d.agenteId || null, conversacionId: d.conversacionId || null, telefonoMasc: enmascarar(d.telefono), entrada: d.prueba ? 'PRUEBA' : (d.entrada || 'TEXTO'), prueba: Boolean(d.prueba) },
    });
  } catch (err) { console.error('[trazaIA] no se pudo abrir el turno:', err.message); }
  if (!turno) return fn();

  const ctx = { turnoId: turno.id, empresaId: d.empresaId, agenteId: d.agenteId || null, pendientes: [], acum: { llamadas: 0, fallidas: 0, tokIn: 0, tokOut: 0, costo: null, modelo: null } };
  const t0 = Date.now();
  let salida; let fallo = null;
  try { salida = await ALS.run(ctx, fn); } catch (err) { fallo = err; }
  try {
    await Promise.allSettled(ctx.pendientes);
    const a = ctx.acum;
    let resultado = 'OK';
    if (fallo || (salida && (salida.ok === false || salida.error === true))) resultado = 'ERROR';
    else if (a.derivado) resultado = 'DERIVADO';
    else if (!salida || !salida.respuesta) resultado = 'SIN_RESPUESTA';
    const ruta = d.citas ? 'CITAS' : a.guardia ? 'GUARDIA' : a.sinIA ? 'SIN_IA' : (a.llamadas + a.fallidas) > 0 ? 'IA' : 'FLUJO';
    const msg = fallo ? fallo.message : (resultado === 'ERROR' && salida && typeof salida.error === 'string' ? salida.error : null);
    await prisma.turnoIA.update({
      where: { id: turno.id },
      data: { ruta, resultado, modelo: a.modelo, llamadasIA: a.llamadas, fallidasIA: a.fallidas, tokensEntrada: a.tokIn, tokensSalida: a.tokOut, costoUsd: a.costo, latenciaMs: Date.now() - t0, error: msg ? String(msg).slice(0, 300) : null },
    });
  } catch (err) { console.error('[trazaIA] no se pudo cerrar el turno:', err.message); }
  if (fallo) throw fallo;
  return salida;
}

// ----------------------------- Retencion -----------------------------

/**
 * Resume por dia/empresa y luego borra el detalle de mas de `dias` dias (corte al inicio del dia, hora de Bolivia).
 * Idempotente: se puede correr varias veces el mismo dia.
 */
async function purgar({ dias = RETENCION_DIAS, ahora = DateTime.now() } = {}, db = prisma) {
  const corteBo = ahora.setZone(ZONA).startOf('day').minus({ days: dias });
  const corte = corteBo.toUTC().toJSDate();
  const resumidos = await db.$executeRaw`
    INSERT INTO "ia_resumen_diario" ("fecha","empresaId","turnos","porRuta","errores","derivados","llamadasIA","fallidasIA","tokens","costoUsd","latenciaMediaMs")
    SELECT d."fecha", d."empresaId", d."turnos",
           (SELECT COALESCE(jsonb_object_agg(r."ruta", r."n"), '{}'::jsonb) FROM (
              SELECT t2."ruta", COUNT(*)::int AS n FROM "ia_turnos" t2
              WHERE t2."empresaId" = d."empresaId" AND t2."createdAt" < ${corte} AND t2."prueba" = false
                AND ((t2."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz')::date = d."fecha" GROUP BY t2."ruta") r),
           d."errores", d."derivados", d."llamadas", d."fallidas", d."tokens", d."costo", d."latencia"
    FROM (
      SELECT ((t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz')::date AS "fecha", t."empresaId",
             COUNT(*)::int AS "turnos",
             COUNT(*) FILTER (WHERE t."resultado" = 'ERROR')::int AS "errores",
             COUNT(*) FILTER (WHERE t."resultado" = 'DERIVADO')::int AS "derivados",
             COALESCE(SUM(t."llamadasIA"),0)::int AS "llamadas", COALESCE(SUM(t."fallidasIA"),0)::int AS "fallidas",
             COALESCE(SUM(t."tokensEntrada" + t."tokensSalida"),0)::int AS "tokens", COALESCE(SUM(t."costoUsd"),0) AS "costo",
             ROUND(AVG(t."latenciaMs"))::int AS "latencia"
      FROM "ia_turnos" t WHERE t."createdAt" < ${corte} AND t."prueba" = false
      GROUP BY 1, 2
    ) d
    ON CONFLICT ("fecha","empresaId") DO UPDATE SET "turnos" = EXCLUDED."turnos", "porRuta" = EXCLUDED."porRuta", "errores" = EXCLUDED."errores",
      "derivados" = EXCLUDED."derivados", "llamadasIA" = EXCLUDED."llamadasIA", "fallidasIA" = EXCLUDED."fallidasIA", "tokens" = EXCLUDED."tokens",
      "costoUsd" = EXCLUDED."costoUsd", "latenciaMediaMs" = EXCLUDED."latenciaMediaMs"`;
  const eventos = await db.eventoIA.deleteMany({ where: { createdAt: { lt: corte } } });
  const turnos = await db.turnoIA.deleteMany({ where: { createdAt: { lt: corte } } });
  return { corte, resumidos: Number(resumidos), turnosBorrados: turnos.count, eventosBorrados: eventos.count };
}

/** Trabajo diario: limpia poco despues de arrancar y cada 24 h. Nunca tumba el servidor. */
function iniciarJob({ cadaMs = 24 * 60 * 60 * 1000 } = {}) {
  if (process.env.NODE_TEST_CONTEXT || process.env.IA_PURGA_JOB === '0') return null;
  const ciclo = async () => {
    try { const r = await purgar(); console.log(`[trazaIA] purga: ${r.turnosBorrados} turnos y ${r.eventosBorrados} eventos de mas de ${RETENCION_DIAS} dias (resumidos antes de borrar)`); }
    catch (err) { console.error('[trazaIA] error en la purga:', err.message); }
  };
  const inicio = setTimeout(ciclo, 60 * 1000); if (inicio.unref) inicio.unref();
  const t = setInterval(ciclo, cadaMs); if (t.unref) t.unref();
  return t;
}

module.exports = { RETENCION_DIAS, enmascarar, actual, turnoIdActual, conTurno, evento, eventoSuelto, desdeEtapa, sumarUso, purgar, iniciarJob };
