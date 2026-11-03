'use strict';
// lib/services/saludIA.js
//
// Salud del proveedor de IA: que el bot NUNCA dependa de que la IA este viva.
//
//  1. clasificarError: que paso (sin saldo, limite, caida, timeout, clave...).
//  2. Cortacircuitos en memoria: tras varias fallas seguidas se deja de llamar
//     a la IA un rato y el cliente recibe de inmediato la respuesta del modo
//     sin IA (ver modoSinIA.js), en vez de esperar un timeout cada mensaje.
//  3. Alertas inmediatas al admin (ntfy, Telegram o webhook propio), con tope
//     de un aviso cada 30 min por tipo, para no inundar.
//  4. Simulacion de caidas (SIMULAR_CAIDA_IA) para probar todos los caminos.
//
// El estado vive en memoria (instancia unica en Coolify): se pierde al
// reiniciar, y esta bien - el cortacircuitos se vuelve a armar solo.

const cfg = {
  timeoutMs: Number(process.env.IA_TIMEOUT_MS || 15000), // por intento (SDK)
  ventanaMs: 5 * 60 * 1000, // fallas que cuentan para abrir el circuito
  umbralFallas: 3,
  pausaMs: 2 * 60 * 1000, // circuito abierto por fallas "normales"
  pausaSinSaldoMs: 10 * 60 * 1000,
  pausaClaveMs: 30 * 60 * 1000,
  sondaMs: 30 * 1000, // tras una pausa, UN mensaje prueba si volvio
  alertaCadaMs: 30 * 60 * 1000,
  // Inyectable en tests: (texto) => Promise. Si es null se usan los canales de entorno.
  enviar: null,
};

const TIPOS = ['SIN_SALDO', 'LIMITE', 'CAIDA', 'TIMEOUT', 'CLAVE_INVALIDA', 'SOLICITUD_INVALIDA', 'CIRCUITO_ABIERTO', 'DESCONOCIDO'];

const estado = nuevoEstado();

function nuevoEstado() {
  return {
    fallas: [], // { t, tipo }
    abiertoHasta: 0,
    requiereSonda: false,
    sondaHasta: 0,
    ultimoError: null, // { tipo, detalle, en, proveedor, modelo }
    ultimoExito: 0,
    abiertoDesde: 0,
    turnosSinIA: 0,
    contadores: {}, // fallas por tipo desde que arranco el proceso
  };
}

function reiniciar() {
  Object.assign(estado, nuevoEstado());
  ultimasAlertas.clear();
  historialAlertas.length = 0;
  simulado = null;
}

function configurar(cambios) {
  Object.assign(cfg, cambios || {});
}

// ------------------------------------------------------------ clasificacion

const mensajeDe = (err) => String((err && (err.message || (err.error && err.error.message))) || '').toLowerCase();

/** Devuelve uno de TIPOS segun lo que dijo el proveedor (OpenAI/Anthropic) o la red. */
function clasificarError(err) {
  if (!err) return 'DESCONOCIDO';
  if (err.tipoIA) return err.tipoIA;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status) || 0);
  const code = String(err.code || (err.error && (err.error.code || err.error.type)) || '').toLowerCase();
  const msg = mensajeDe(err);

  if (code === 'ia_timeout' || err.name === 'APIConnectionTimeoutError' || err.name === 'TimeoutError' || /timed? ?out|timeout/.test(msg)) return 'TIMEOUT';
  if (/insufficient_quota|exceeded your current quota|credit balance|billing|out of credits|insufficient funds/.test(`${code} ${msg}`)) return 'SIN_SALDO';
  if (status === 401 || status === 403 || code === 'invalid_api_key' || /invalid api key|incorrect api key|invalid x-api-key|authentication/.test(msg)) return 'CLAVE_INVALIDA';
  if (status === 429 || code === 'rate_limit_exceeded' || /rate limit/.test(msg)) return 'LIMITE';
  if (
    status >= 500 || /overloaded/.test(msg)
    || ['econnreset', 'enotfound', 'econnrefused', 'etimedout', 'eai_again', 'econnaborted', 'epipe'].includes(code)
    || err.name === 'APIConnectionError' || /connection error|fetch failed|socket hang up|network/.test(msg)
  ) return 'CAIDA';
  if (status === 400 || status === 404 || status === 422) return 'SOLICITUD_INVALIDA';
  return 'DESCONOCIDO';
}

const ETIQUETAS = {
  SIN_SALDO: 'sin saldo o cuota agotada',
  LIMITE: 'limite de velocidad (429)',
  CAIDA: 'caida o error del servicio',
  TIMEOUT: 'no respondio a tiempo',
  CLAVE_INVALIDA: 'clave invalida o revocada',
  SOLICITUD_INVALIDA: 'solicitud rechazada (¿modelo mal escrito?)',
  CIRCUITO_ABIERTO: 'en pausa por fallas recientes',
  DESCONOCIDO: 'error desconocido',
};

// Nada de claves ni textos largos en logs y alertas.
function detalleSeguro(err) {
  const base = String((err && (err.message || (err.error && err.error.message))) || err || '');
  return base.replace(/(sk-|key[-_ ]?)[A-Za-z0-9_\-]{8,}/gi, '$1***').slice(0, 180);
}

// ------------------------------------------------------------- simulacion

let simulado = null; // override en runtime (tests): 'saldo' | 'limite' | '5xx' | 'timeout' | 'clave' | 'modelo' | null

function simular(tipo) { simulado = tipo || null; }

function errorSimulado() {
  const t = String(simulado || process.env.SIMULAR_CAIDA_IA || '').toLowerCase();
  if (!t) return null;
  const e = new Error(`Caida simulada (${t})`);
  if (t === 'saldo') { e.status = 429; e.code = 'insufficient_quota'; e.message = 'You exceeded your current quota (simulado)'; }
  else if (t === 'limite') { e.status = 429; e.code = 'rate_limit_exceeded'; }
  else if (t === '5xx' || t === 'caida') { e.status = 503; }
  else if (t === 'timeout') { e.code = 'IA_TIMEOUT'; }
  else if (t === 'clave') { e.status = 401; e.code = 'invalid_api_key'; }
  else if (t === 'modelo') { e.status = 404; }
  else return null;
  return e;
}

// ------------------------------------------------------------ cortacircuitos

function podar(ahora) {
  estado.fallas = estado.fallas.filter((f) => ahora - f.t <= cfg.ventanaMs);
}

/** ¿Se puede llamar a la IA ahora? Tras una pausa deja pasar UNA sonda por vez. */
function iaDisponible(ahora = Date.now()) {
  if (ahora < estado.abiertoHasta) return false;
  if (estado.requiereSonda) {
    if (ahora < estado.sondaHasta) return false;
    estado.sondaHasta = ahora + cfg.sondaMs; // este llamador es la sonda
  }
  return true;
}

/** Anota una falla. Devuelve { abrio } si con esta el circuito paso a abierto. */
function registrarFalla(tipo, { detalle = '', proveedor = null, modelo = null } = {}, ahora = Date.now()) {
  estado.contadores[tipo] = (estado.contadores[tipo] || 0) + 1;
  estado.ultimoError = { tipo, detalle, en: ahora, proveedor, modelo };
  if (tipo === 'CIRCUITO_ABIERTO') return { abrio: false };
  estado.fallas.push({ t: ahora, tipo });
  podar(ahora);

  const estabaAbierto = ahora < estado.abiertoHasta || estado.requiereSonda;
  let pausa = 0;
  if (tipo === 'SIN_SALDO') pausa = cfg.pausaSinSaldoMs;
  else if (tipo === 'CLAVE_INVALIDA') pausa = cfg.pausaClaveMs;
  else if (estado.fallas.length >= cfg.umbralFallas) pausa = cfg.pausaMs;
  if (pausa) {
    estado.abiertoHasta = ahora + pausa;
    estado.requiereSonda = true;
    estado.sondaHasta = 0;
    if (!estabaAbierto) estado.abiertoDesde = ahora;
  }
  return { abrio: Boolean(pausa) && !estabaAbierto, pausa };
}

/** Una llamada salio bien. Devuelve true si con esto se cierra un circuito que estaba abierto. */
function registrarExito(ahora = Date.now()) {
  const recupero = estado.requiereSonda || estado.fallas.length >= cfg.umbralFallas;
  estado.fallas = [];
  estado.abiertoHasta = 0;
  estado.requiereSonda = false;
  estado.sondaHasta = 0;
  estado.ultimoExito = ahora;
  return recupero;
}

function contarTurnoSinIA() { estado.turnosSinIA += 1; }

function resumen(ahora = Date.now()) {
  podar(ahora);
  const abierto = ahora < estado.abiertoHasta;
  return {
    estado: abierto ? 'EN_PAUSA' : (estado.requiereSonda ? 'PROBANDO' : (estado.fallas.length ? 'CON_FALLAS' : 'OK')),
    segundosParaReintentar: abierto ? Math.ceil((estado.abiertoHasta - ahora) / 1000) : 0,
    fallasRecientes: estado.fallas.length,
    ultimoError: estado.ultimoError
      ? { ...estado.ultimoError, etiqueta: ETIQUETAS[estado.ultimoError.tipo] || estado.ultimoError.tipo }
      : null,
    ultimoExito: estado.ultimoExito || null,
    turnosSinIA: estado.turnosSinIA,
    contadores: { ...estado.contadores },
    simulando: Boolean(simulado || process.env.SIMULAR_CAIDA_IA),
    alertas: historialAlertas.slice(-10).reverse(),
    canalesDeAlerta: canalesConfigurados(),
  };
}

// ----------------------------------------------------------------- alertas

const ultimasAlertas = new Map(); // clave -> timestamp del ultimo envio
const historialAlertas = []; // { en, clave, texto, canales }

function canalesConfigurados() {
  const c = [];
  if (process.env.ALERTA_NTFY_TOPIC) c.push('ntfy');
  if (process.env.ALERTA_TELEGRAM_BOT_TOKEN && process.env.ALERTA_TELEGRAM_CHAT_ID) c.push('telegram');
  if (process.env.ALERTA_WEBHOOK_URL) c.push('webhook');
  return c;
}

async function postear(url, opciones) {
  const resp = await fetch(url, { ...opciones, signal: AbortSignal.timeout(6000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
}

async function enviarPorCanales(texto, titulo) {
  const enviados = [];
  const tareas = [];
  const probar = (nombre, fn) => tareas.push(fn().then(() => enviados.push(nombre)).catch((e) => console.error(`[alerta] canal ${nombre} fallo: ${e.message}`)));
  if (process.env.ALERTA_NTFY_TOPIC) {
    const base = (process.env.ALERTA_NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
    probar('ntfy', () => postear(`${base}/${encodeURIComponent(process.env.ALERTA_NTFY_TOPIC)}`, {
      method: 'POST', body: texto, headers: { Title: encodeURIComponent(titulo).slice(0, 200), Priority: 'high' },
    }));
  }
  if (process.env.ALERTA_TELEGRAM_BOT_TOKEN && process.env.ALERTA_TELEGRAM_CHAT_ID) {
    probar('telegram', () => postear(`https://api.telegram.org/bot${process.env.ALERTA_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.ALERTA_TELEGRAM_CHAT_ID, text: `${titulo}\n${texto}` }),
    }));
  }
  if (process.env.ALERTA_WEBHOOK_URL) {
    // Formato comun a Slack ("text") y Discord ("content").
    probar('webhook', () => postear(process.env.ALERTA_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${titulo}\n${texto}`, content: `${titulo}\n${texto}` }),
    }));
  }
  await Promise.all(tareas);
  return enviados;
}

/**
 * Avisa al admin. `clave` agrupa avisos iguales (uno cada 30 min). Nunca lanza.
 * Siempre queda en el log y en el historial que muestra /admin.
 */
async function alertar(clave, titulo, texto, ahora = Date.now()) {
  try {
    const ultima = ultimasAlertas.get(clave) || 0;
    if (ahora - ultima < cfg.alertaCadaMs) return { enviada: false, motivo: 'RECIENTE' };
    ultimasAlertas.set(clave, ahora);
    console.error(`[alerta-ia] ${titulo} - ${texto}`);
    const canales = cfg.enviar ? (await cfg.enviar(`${titulo}\n${texto}`), ['inyectado']) : await enviarPorCanales(texto, titulo);
    historialAlertas.push({ en: ahora, clave, titulo, texto, canales });
    if (historialAlertas.length > 30) historialAlertas.shift();
    return { enviada: true, canales };
  } catch (e) {
    console.error(`[alerta-ia] no se pudo alertar: ${e.message}`);
    return { enviada: false, motivo: 'ERROR' };
  }
}

function alertaPorFalla(tipo, abrio, { proveedor, modelo, detalle }) {
  const donde = `${proveedor || 'IA'}${modelo ? ` / ${modelo}` : ''}`;
  const base = `${donde}: ${ETIQUETAS[tipo] || tipo}. Detalle: ${detalle || '-'}`;
  if (tipo === 'SIN_SALDO') return alertar('ia:SIN_SALDO', '🔴 La IA se quedó sin saldo', `${base}\nEl bot atiende en modo menú hasta que cargues saldo.`);
  if (tipo === 'CLAVE_INVALIDA') return alertar('ia:CLAVE_INVALIDA', '🔴 Clave de IA inválida', `${base}\nRevisá OPENAI_API_KEY en Coolify. El bot atiende en modo menú.`);
  if (tipo === 'SOLICITUD_INVALIDA') return alertar('ia:SOLICITUD_INVALIDA', '🟠 La IA rechazó la solicitud', `${base}\nRevisá el nombre del modelo del plan (Admin > Planes) y OPENAI_MODEL.`);
  if (abrio) return alertar('ia:CIRCUITO', '🟠 La IA está fallando', `${base}\nSe pausa unos minutos; el bot atiende en modo menú y reintenta solo.`);
  return Promise.resolve({ enviada: false, motivo: 'SIN_ALERTA' });
}

// -------------------------------------------------------------- envoltorio

const esperar = (ms, valor) => new Promise((resolve) => setTimeout(resolve, ms, valor));

/**
 * Ejecuta UNA llamada a la IA con todas las protecciones: circuito, simulacion
 * de caidas, tope de tiempo total, clasificacion del error, registro y alerta.
 * `err.tipoIA` queda puesto en el error que se relanza.
 */
async function proteger(fn, { proveedor = null, modelo = null } = {}) {
  if (!iaDisponible()) {
    const e = new Error('IA en pausa por fallas recientes');
    e.tipoIA = 'CIRCUITO_ABIERTO';
    throw e;
  }
  let temporizador;
  try {
    const sim = errorSimulado();
    if (sim) throw sim;
    const tope = new Promise((_, rechazar) => {
      temporizador = setTimeout(() => {
        const e = new Error('La IA no respondio a tiempo');
        e.code = 'IA_TIMEOUT';
        rechazar(e);
      }, cfg.timeoutMs * 2 + 2000);
    });
    const r = await Promise.race([fn(), tope]);
    clearTimeout(temporizador);
    if (registrarExito()) {
      alertar('ia:RECUPERADA', '🟢 La IA volvió a responder', `${proveedor || 'IA'}${modelo ? ` / ${modelo}` : ''} responde otra vez; el bot vuelve al modo normal.`).catch(() => {});
    }
    return r;
  } catch (err) {
    clearTimeout(temporizador);
    const tipo = clasificarError(err);
    err.tipoIA = tipo;
    const detalle = detalleSeguro(err);
    const { abrio } = registrarFalla(tipo, { detalle, proveedor, modelo });
    alertaPorFalla(tipo, abrio, { proveedor, modelo, detalle }).catch(() => {});
    throw err;
  }
}

module.exports = {
  cfg, TIPOS, ETIQUETAS,
  clasificarError, detalleSeguro,
  simular, errorSimulado,
  iaDisponible, registrarFalla, registrarExito, contarTurnoSinIA, resumen, reiniciar, configurar,
  alertar, canalesConfigurados, proteger, esperar,
};
