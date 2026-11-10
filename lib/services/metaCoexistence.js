'use strict';
// lib/services/metaCoexistence.js
//
// CONEXIÓN DE WHATSAPP POR COEXISTENCE (Embedded Signup de Meta): el negocio conecta su número SIN dejar de usar la app
// WhatsApp Business del celular; Proshop atiende por la API y el dueño puede seguir contestando desde el teléfono.
//
// Flujo (docs: developers.facebook.com › WhatsApp › Embedded Signup › "Onboard WhatsApp Business app users"):
//   1. El navegador abre el registro de Meta con `featureType: 'whatsapp_business_app_onboarding'` (+ App ID y config_id nuestros).
//   2. Meta devuelve un `code` (intercambiable por token) y el evento FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING con el WABA id.
//   3. El servidor (acá): canjea el code por el token del negocio, suscribe nuestra app a esa cuenta (WABA), encuentra el número,
//      lo guarda cifrado y PIDE a Meta la sincronización de contactos e historial (solo se puede pedir UNA vez y dentro de las
//      24 h de la conexión).
//   4. Los mensajes que el dueño manda desde la app del celular llegan por webhook como "ecos" (smb_message_echoes).
//
// TODO lo que depende de Meta está acá y recibe `http` (fetch) inyectable: se prueba sin red. NO se pudo verificar con credenciales
// reales; los campos de Meta marcados "VERIFICAR" se confirman en la primera conexión real (ver docs/12-coexistence.md).

const crypto = require('crypto');
const { prisma } = require('../db');
const cripto = require('../crypto');

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const FEATURE_TYPE = 'whatsapp_business_app_onboarding';
// Campos del webhook que hay que tener marcados en la app de Meta para que coexistence funcione de punta a punta.
const CAMPOS_WEBHOOK = ['messages', 'smb_message_echoes', 'smb_app_state_sync', 'history'];

class ErrorMeta extends Error {
  constructor(mensaje, detalle = {}) { super(mensaje); this.codigo = 'META'; this.detalle = detalle; }
}

/** ¿Está configurado Proshop para conectar números por coexistence? Qué variables faltan, en palabras claras. */
function configuracion(env = process.env) {
  const faltan = [];
  if (!env.META_APP_ID) faltan.push('META_APP_ID');
  if (!env.META_APP_SECRET) faltan.push('META_APP_SECRET');
  if (!env.META_EMBEDDED_SIGNUP_CONFIG_ID) faltan.push('META_EMBEDDED_SIGNUP_CONFIG_ID');
  return {
    listo: faltan.length === 0, faltan,
    appId: env.META_APP_ID || null, configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID || null, graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  };
}

/** Lo que necesita el navegador para abrir el registro de Meta (nunca incluye el secreto de la app). */
function parametrosParaNavegador(env = process.env) {
  const c = configuracion(env);
  if (!c.listo) return null;
  return {
    appId: c.appId, configId: c.configId, graphVersion: c.graphVersion,
    login: { config_id: c.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: FEATURE_TYPE, sessionInfoVersion: '3' } },
  };
}

/** Firma X-Hub-Signature-256 de los webhooks de Meta: HMAC-SHA256 del cuerpo CRUDO con el secreto de la app. */
function verificarFirma(cuerpoCrudo, cabecera, secreto) {
  if (!secreto) return { ok: true, verificada: false }; // sin secreto cargado no se puede verificar (se avisa en el log)
  const recibida = String(cabecera || '');
  if (!recibida.startsWith('sha256=') || !cuerpoCrudo) return { ok: false, verificada: true };
  const esperada = `sha256=${crypto.createHmac('sha256', secreto).update(cuerpoCrudo).digest('hex')}`;
  const a = Buffer.from(recibida); const b = Buffer.from(esperada);
  return { ok: a.length === b.length && crypto.timingSafeEqual(a, b), verificada: true };
}

// ------------------------------------------------------------------ llamadas a Meta

async function llamar(http, url, { metodo = 'GET', token = null, cuerpo = null } = {}) {
  let resp;
  try {
    resp = await http(url, {
      method: metodo,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
  } catch (err) { throw new ErrorMeta(`No se pudo comunicar con Meta: ${err.message}`); }
  const datos = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = datos && datos.error ? datos.error : {};
    throw new ErrorMeta(e.message || `Meta respondió con error ${resp.status}.`, { codigo: e.code, subcodigo: e.error_subcode, http: resp.status });
  }
  return datos;
}

/** Canjea el `code` del registro por el token de acceso del negocio. */
async function canjearCodigo(code, { http = globalThis.fetch, env = process.env } = {}) {
  const c = configuracion(env);
  if (!c.listo) throw new ErrorMeta(`Falta configurar Meta en el servidor (${c.faltan.join(', ')}).`);
  if (!code || String(code).length > 1000) throw new ErrorMeta('Meta no devolvió el código de autorización.');
  const q = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, code: String(code) });
  const d = await llamar(http, `${GRAPH}/oauth/access_token?${q.toString()}`);
  if (!d.access_token) throw new ErrorMeta('Meta no devolvió el token de acceso.');
  return d.access_token;
}

/** Suscribe NUESTRA app a los webhooks de la cuenta de WhatsApp Business (WABA) del negocio. */
async function suscribirApp(wabaId, token, { http = globalThis.fetch } = {}) {
  await llamar(http, `${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, { metodo: 'POST', token });
}

/** Números de la cuenta: [{ id, numero, nombre }]. */
async function listarNumeros(wabaId, token, { http = globalThis.fetch } = {}) {
  const d = await llamar(http, `${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`, { token });
  return (d.data || []).map((n) => ({ id: String(n.id), numero: n.display_phone_number || '', nombre: n.verified_name || '' }));
}

/** Elige el número a conectar: el que dijo el cliente, o el único que hay. */
function elegirNumero(numeros, { phoneNumberId = null, numeroVisible = null } = {}) {
  if (phoneNumberId) {
    const n = numeros.find((x) => x.id === String(phoneNumberId));
    if (!n) throw new ErrorMeta('Ese número no pertenece a la cuenta de WhatsApp Business que autorizaste.');
    return n;
  }
  if (!numeros.length) throw new ErrorMeta('La cuenta de WhatsApp Business no tiene números todavía.');
  if (numeros.length === 1) return numeros[0];
  const digitos = String(numeroVisible || '').replace(/\D/g, '');
  const coincide = digitos ? numeros.find((x) => x.numero.replace(/\D/g, '').endsWith(digitos) || digitos.endsWith(x.numero.replace(/\D/g, ''))) : null;
  if (coincide) return coincide;
  throw new ErrorMeta('La cuenta tiene varios números: elegí cuál conectar.');
}

/**
 * Pide a Meta la sincronización de contactos (smb_app_state_sync) e historial (history). Cada una se puede pedir UNA sola vez y dentro de las
 * 24 h de la conexión. Nunca rompe la conexión: devuelve el resultado de cada una. (VERIFICAR: ruta y nombres en la primera conexión real.)
 */
async function pedirSincronizacion(phoneNumberId, token, { http = globalThis.fetch } = {}) {
  const resultado = { contactos: 'pendiente', historial: 'pendiente', error: null, at: new Date().toISOString() };
  for (const [campo, tipo] of [['contactos', 'smb_app_state_sync'], ['historial', 'history']]) {
    try {
      await llamar(http, `${GRAPH}/${encodeURIComponent(phoneNumberId)}/smb_app_data`, { metodo: 'POST', token, cuerpo: { messaging_product: 'whatsapp', sync_type: tipo } });
      resultado[campo] = 'solicitado';
    } catch (err) {
      resultado[campo] = 'error';
      resultado.error = resultado.error ? `${resultado.error} | ${campo}: ${err.message}` : `${campo}: ${err.message}`;
    }
  }
  return resultado;
}

/**
 * Orquesta la conexión de un agente por coexistence. `datos`: { code, wabaId, phoneNumberId? }.
 * Idempotente: repetirla con el mismo número deja la misma conexión. Un número solo puede estar conectado a UN agente.
 * @returns {{ conexion, numero, sincronizacion, pasos: string[] }}
 */
async function conectar(agenteId, datos, { http = globalThis.fetch, env = process.env } = {}) {
  const wabaId = String(datos.wabaId || '').trim();
  if (!/^\d{5,30}$/.test(wabaId)) throw new ErrorMeta('Meta no devolvió la cuenta de WhatsApp Business. Probá de nuevo.');
  const token = await canjearCodigo(datos.code, { http, env });
  const numeros = await listarNumeros(wabaId, token, { http });
  const existente = await prisma.conexionWhatsApp.findUnique({ where: { agenteId } });
  const numero = elegirNumero(numeros, { phoneNumberId: datos.phoneNumberId, numeroVisible: existente && existente.numeroVisible });

  const otro = await prisma.conexionWhatsApp.findUnique({ where: { phoneNumberId: numero.id } });
  if (otro && otro.agenteId !== agenteId) throw new ErrorMeta('Ese número ya está conectado a otra cuenta de Proshop.');

  const pasos = [];
  await suscribirApp(wabaId, token, { http });
  pasos.push('Webhooks suscritos');
  const primeraVez = !(existente && existente.modo === 'COEXISTENCE' && existente.phoneNumberId === numero.id);
  // La sincronización solo se puede pedir una vez: si ya se pidió para este número, no se repite.
  const sincronizacion = primeraVez ? await pedirSincronizacion(numero.id, token, { http }) : (existente.estadoSync || null);
  if (primeraVez) pasos.push('Sincronización pedida');

  const data = {
    estado: 'CONECTADO', modo: 'COEXISTENCE', phoneNumberId: numero.id, wabaId, tokenCifrado: cripto.cifrar(token),
    numeroVisible: numero.numero || (existente && existente.numeroVisible) || null, verificado: true, estadoSync: sincronizacion || undefined,
    ...(primeraVez ? { conectadoAt: new Date() } : {}),
  };
  const conexion = existente
    ? await prisma.conexionWhatsApp.update({ where: { agenteId }, data })
    : await prisma.conexionWhatsApp.create({ data: { agenteId, ...data } });
  pasos.push('Número guardado');
  return { conexion, numero, sincronizacion, pasos };
}

// ------------------------------------------------------------------ ecos: lo que el dueño escribe desde la app del celular

/**
 * Interpreta el valor de un webhook `smb_message_echoes`: mensajes que el NEGOCIO mandó desde la app WhatsApp Business.
 * @returns {{ para: string, id: string, texto: string, tipo: string, at: Date }[]}
 */
function leerEcos(valor) {
  const lista = (valor && (valor.message_echoes || valor.messages)) || [];
  return lista.map((m) => {
    const tipo = m.type || 'text';
    const texto = tipo === 'text' ? (m.text && m.text.body) || '' : `[${tipo === 'image' ? 'Foto' : tipo === 'audio' ? 'Audio' : tipo === 'video' ? 'Video' : tipo === 'document' ? 'Documento' : tipo === 'location' ? 'Ubicación' : 'Mensaje'} · enviado desde la app de WhatsApp]`;
    return { para: String(m.to || '').replace(/\D/g, ''), id: String(m.id || ''), texto: String(texto).slice(0, 4000), tipo, at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() };
  }).filter((e) => e.para && e.id && e.texto);
}

/**
 * Guarda los ecos como mensajes del equipo en el chat del cliente y deja el chat en manos de una persona (la IA no le contesta encima
 * a quien está escribiendo desde el celular). Devuelve cuántos guardó. `yaVisto(id)` evita duplicar los reenvíos de Meta.
 */
async function registrarEcos(agente, ecos, { yaVisto = () => false, emitir = () => {} } = {}) {
  let guardados = 0;
  for (const e of ecos) {
    if (yaVisto(e.id)) continue;
    const conv = await prisma.conversacion.findFirst({ where: { agenteId: agente.id, telefonoCliente: e.para }, orderBy: { createdAt: 'desc' } });
    if (!conv) continue; // chat que el negocio abrió fuera de Proshop: no hay hilo donde ponerlo
    // Por si Meta devolviera como "eco" lo que mandó el propio agente por la API: el mismo texto de hace instantes no se repite
    // ni pasa el chat a manos de una persona. (VERIFICAR en la primera conexión real si Meta lo hace.)
    const reciente = await prisma.mensaje.findFirst({ where: { conversacionId: conv.id, rol: 'AGENTE', contenido: e.texto, createdAt: { gte: new Date(Date.now() - 120000) } }, select: { id: true } });
    if (reciente) continue;
    const msg = await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'AGENTE', contenido: e.texto, meta: { desdeApp: true, waId: e.id } } });
    await prisma.conversacion.update({ where: { id: conv.id }, data: { ultimoMensajeAt: e.at, ...(conv.modo === 'IA' ? { modo: 'HUMANO' } : {}) } });
    emitir(conv, { conversacionId: conv.id, rol: 'AGENTE', contenido: e.texto, createdAt: msg.createdAt, usuarioNombre: 'App de WhatsApp' });
    guardados += 1;
  }
  return guardados;
}

module.exports = {
  ErrorMeta, GRAPH_VERSION, FEATURE_TYPE, CAMPOS_WEBHOOK, configuracion, parametrosParaNavegador, verificarFirma,
  canjearCodigo, suscribirApp, listarNumeros, elegirNumero, pedirSincronizacion, conectar, leerEcos, registrarEcos,
};
