'use strict';
// lib/services/tipoCambio.js
//
// TIPO DE CAMBIO Bs por USD, con fecha y fuente, para comparar ingresos (Bs) con costos de IA (USD).
//
// Desde mediados de 2026 Bolivia tiene un tipo de cambio OFICIAL FLEXIBLE (ya no el fijo de 6,96): el Banco Central (BCB) publica cada día el "TCO"
// (mediana ponderada de las compras de dólares de los bancos) en una página pública. Fuentes, en orden de prioridad:
//   MANUAL  valor puesto a mano en el panel (para una emergencia o una corrección),
//   BCB     la cotización oficial publicada por el BCB (se lee su página pública; no tiene API documentada, por eso hay respaldo),
//   API     cotización de referencia de una API gratuita (open.er-api.com), solo si el BCB no se pudo leer.
// Se guarda UNA fila por fecha y fuente: la rentabilidad convierte cada costo con el cambio de SU fecha, no con el de hoy.

const { DateTime } = require('luxon');
const { prisma } = require('../db');

const URL_BCB = process.env.TIPO_CAMBIO_URL_BCB || 'https://www.bcb.gob.bo/bcb_tco_publico_ultima_cotizacion.php';
const URL_API = process.env.TIPO_CAMBIO_URL_API || 'https://open.er-api.com/v6/latest/USD';
const ZONA = 'America/La_Paz';
const PRIORIDAD = { MANUAL: 3, BCB: 2, API: 1 };
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const MIN_RAZONABLE = 1; const MAX_RAZONABLE = 100; // Bs por USD: fuera de este rango es un error de lectura

class ErrorCambio extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'CAMBIO'; }
}

const hoyBolivia = () => DateTime.now().setZone(ZONA).toFormat('yyyy-MM-dd');
const aFechaBD = (iso) => new Date(`${iso}T00:00:00.000Z`);
const razonable = (n) => Number.isFinite(n) && n >= MIN_RAZONABLE && n <= MAX_RAZONABLE;

/** "11,68" -> 11.68 ; "1.234,56" -> 1234.56 */
function aNumeroBO(texto) {
  const t = String(texto || '').trim();
  if (!t) return NaN;
  return Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
}

/**
 * Lee la página pública del BCB. Busca la frase "El TCO de Bs 11,68/$us tiene vigencia el jueves 19 de noviembre de 2026".
 * @returns {{ valor: number, fecha: string } | null}  fecha = día de vigencia (YYYY-MM-DD)
 */
function leerBCB(html) {
  const limpio = String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = limpio.match(/TCO de Bs\s*([\d.,]+)\s*\/\s*\$us\s+tiene vigencia el\s+\S+\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  const valor = aNumeroBO(m[1]);
  const mes = MESES[m[3].toLowerCase()];
  if (!razonable(valor) || !mes) return null;
  const fecha = DateTime.fromObject({ year: Number(m[4]), month: mes, day: Number(m[2]) }, { zone: 'utc' });
  if (!fecha.isValid) return null;
  return { valor, fecha: fecha.toFormat('yyyy-MM-dd') };
}

/** Lee la respuesta de la API gratuita ({ result:'success', rates:{ BOB } }). */
function leerAPI(json) {
  const valor = Number(json && json.rates && json.rates.BOB);
  if (!json || json.result !== 'success' || !razonable(valor)) return null;
  return { valor, fecha: hoyBolivia() };
}

async function pedir(http, url, { latin1 = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await http(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Proshop/1.0 (tipo de cambio)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (latin1 && r.arrayBuffer) return new TextDecoder('latin1').decode(await r.arrayBuffer());
    return latin1 ? await r.text() : await r.json();
  } finally { clearTimeout(timer); }
}

async function guardar({ fecha, valor, fuente, nota = null }, db = prisma) {
  const f = aFechaBD(fecha);
  return db.tipoCambio.upsert({
    where: { fecha_fuente: { fecha: f, fuente } },
    create: { fecha: f, bobPorUsd: valor, fuente, nota },
    update: { bobPorUsd: valor, nota },
  });
}

/**
 * Trae el tipo de cambio de hoy: primero el oficial del BCB; si no se pudo leer, la API gratuita. Guarda la fila.
 * @returns {{ ok: boolean, fuente?: string, valor?: number, fecha?: string, errores: string[] }}
 */
async function actualizar({ http = globalThis.fetch, db = prisma } = {}) {
  const errores = [];
  try {
    const bcb = leerBCB(await pedir(http, URL_BCB, { latin1: true }));
    if (bcb) { await guardar({ ...bcb, fuente: 'BCB' }, db); return { ok: true, fuente: 'BCB', ...bcb, errores }; }
    errores.push('BCB: no se encontró la cotización en la página (¿cambió su formato?)');
  } catch (err) { errores.push(`BCB: ${err.message}`); }
  try {
    const api = leerAPI(await pedir(http, URL_API));
    if (api) { await guardar({ ...api, fuente: 'API', nota: 'Respaldo: el BCB no se pudo leer' }, db); return { ok: true, fuente: 'API', ...api, errores }; }
    errores.push('API: respuesta sin cotización válida');
  } catch (err) { errores.push(`API: ${err.message}`); }
  return { ok: false, errores };
}

/** Pone un valor a mano (tiene prioridad sobre las demás fuentes ese día). */
async function ponerManual({ valor, fecha = null, nota = null }, db = prisma) {
  const v = aNumeroBO(valor);
  if (!razonable(v)) throw new ErrorCambio(`El tipo de cambio tiene que ser un número entre ${MIN_RAZONABLE} y ${MAX_RAZONABLE} (Bs por dólar).`);
  const f = fecha ? String(fecha) : hoyBolivia();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw new ErrorCambio('La fecha no es válida.');
  return guardar({ fecha: f, valor: v, fuente: 'MANUAL', nota: nota ? String(nota).slice(0, 200) : null }, db);
}

/**
 * Tipo de cambio de una fecha: el del último día publicado hasta esa fecha; si hay varias fuentes ese día, la de mayor prioridad.
 * @returns {Promise<{ bobPorUsd: number, fecha: string, fuente: string, diasAntiguedad: number } | null>}
 */
async function delDia(fecha = null, db = prisma) {
  const f = fecha || hoyBolivia();
  const filas = await db.tipoCambio.findMany({ where: { fecha: { lte: aFechaBD(f) } }, orderBy: { fecha: 'desc' }, take: 8 });
  if (!filas.length) return null;
  const dia = filas[0].fecha.getTime();
  const delUltimoDia = filas.filter((x) => x.fecha.getTime() === dia).sort((a, b) => (PRIORIDAD[b.fuente] || 0) - (PRIORIDAD[a.fuente] || 0));
  const x = delUltimoDia[0];
  const dias = Math.round((aFechaBD(f).getTime() - x.fecha.getTime()) / 86400000);
  return { bobPorUsd: Number(x.bobPorUsd), fecha: x.fecha.toISOString().slice(0, 10), fuente: x.fuente, diasAntiguedad: Math.max(0, dias) };
}

/** USD -> Bs con el cambio de esa fecha (null si no hay ningún tipo de cambio guardado). */
async function usdABs(usd, fecha = null, db = prisma) {
  if (usd === null || usd === undefined) return null;
  const tc = await delDia(fecha, db);
  return tc ? Math.round(Number(usd) * tc.bobPorUsd * 100) / 100 : null;
}

async function historial(dias = 30, db = prisma) {
  const desde = aFechaBD(DateTime.now().setZone(ZONA).minus({ days: dias }).toFormat('yyyy-MM-dd'));
  return db.tipoCambio.findMany({ where: { fecha: { gte: desde } }, orderBy: [{ fecha: 'desc' }, { fuente: 'asc' }] });
}

/** Trabajo automático: busca el tipo de cambio poco después de arrancar y cada 6 horas (el BCB publica una vez al día). Nunca tumba el servidor. */
function iniciarJob({ cadaMs = 6 * 60 * 60 * 1000, http = globalThis.fetch } = {}) {
  if (process.env.NODE_TEST_CONTEXT || process.env.TIPO_CAMBIO_JOB === '0') return null;
  const ciclo = async () => {
    try {
      const r = await actualizar({ http });
      console.log(r.ok ? `[tipo-cambio] Bs ${r.valor} por USD (${r.fuente}, ${r.fecha})` : `[tipo-cambio] no se pudo actualizar: ${r.errores.join(' | ')}`);
    } catch (err) { console.error('[tipo-cambio] error:', err.message); }
  };
  const inicio = setTimeout(ciclo, 20 * 1000); if (inicio.unref) inicio.unref();
  const t = setInterval(ciclo, cadaMs); if (t.unref) t.unref();
  return t;
}

module.exports = { iniciarJob, ErrorCambio, URL_BCB, URL_API, PRIORIDAD, hoyBolivia, aNumeroBO, leerBCB, leerAPI, actualizar, ponerManual, delDia, usdABs, historial };
