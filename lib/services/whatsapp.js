// Cliente de la WhatsApp Business Cloud API (Meta).
// Se usa para enviar mensajes desde el número conectado de cada cliente.
const { prisma } = require('../db');
const { descifrar } = require('../crypto');

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

/**
 * Envía un mensaje de texto por WhatsApp usando las credenciales de una conexión.
 * @param {object} conexion  fila de ConexionWhatsApp (con phoneNumberId y tokenCifrado)
 * @param {string} para      número destino en formato internacional (solo dígitos)
 * @param {string} texto
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function enviarTexto(conexion, para, texto) {
  if (!conexion || !conexion.phoneNumberId || !conexion.tokenCifrado) {
    return { ok: false, error: 'La conexión no tiene credenciales configuradas.' };
  }
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return { ok: false, error: 'No se pudo leer el token de acceso.' };

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${conexion.phoneNumberId}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(para).replace(/\D/g, ''),
        type: 'text',
        text: { body: texto },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `Error HTTP ${resp.status}`;
      return { ok: false, error: msg };
    }
    const id = data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Marca un mensaje entrante como leido y muestra el indicador de "escribiendo..."
 * (hasta 25s o hasta que se manda la respuesta real, lo que pase primero). Es
 * un extra de UX: si falla no debe frenar el procesamiento real del mensaje,
 * por eso el llamador la usa "fire and forget" con su propio try/catch.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function marcarLeidoYEscribiendo(conexion, messageId) {
  if (!conexion || !conexion.phoneNumberId || !conexion.tokenCifrado || !messageId) {
    return { ok: false, error: 'La conexión no tiene credenciales configuradas.' };
  }
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return { ok: false, error: 'No se pudo leer el token de acceso.' };

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${conexion.phoneNumberId}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `Error HTTP ${resp.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Envía una imagen (con caption opcional) por WhatsApp.
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function enviarImagen(conexion, para, urlImagen, caption) {
  if (!conexion || !conexion.phoneNumberId || !conexion.tokenCifrado) {
    return { ok: false, error: 'La conexión no tiene credenciales configuradas.' };
  }
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return { ok: false, error: 'No se pudo leer el token de acceso.' };

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${conexion.phoneNumberId}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(para).replace(/\D/g, ''),
        type: 'image',
        image: { link: urlImagen, caption: caption || '' },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `Error HTTP ${resp.status}`;
      return { ok: false, error: msg };
    }
    const id = data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Manda un mensaje interactivo con hasta 3 botones (WhatsApp no permite mas
 * que eso para este tipo de mensaje). Pensado para elecciones cerradas donde
 * el backend ya conoce las opciones reales de antemano (ej. forma de pago):
 * el cliente toca un boton en vez de tipear, y el ID que vuelve es
 * exactamente el que se le paso aca (interpretarMensajeEntrante en server.js
 * ya sabe leer `interactive.button_reply.id`).
 * @param {Array<{id:string, titulo:string}>} botones  maximo 3
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function enviarBotones(conexion, para, texto, botones) {
  if (!conexion || !conexion.phoneNumberId || !conexion.tokenCifrado) {
    return { ok: false, error: 'La conexión no tiene credenciales configuradas.' };
  }
  if (!Array.isArray(botones) || !botones.length || botones.length > 3) {
    return { ok: false, error: 'Se necesitan entre 1 y 3 botones.' };
  }
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return { ok: false, error: 'No se pudo leer el token de acceso.' };

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${conexion.phoneNumberId}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(para).replace(/\D/g, ''),
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: texto },
          action: { buttons: botones.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.titulo } })) },
        },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `Error HTTP ${resp.status}`;
      return { ok: false, error: msg };
    }
    const id = data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Manda varias imagenes en secuencia con una pequeña pausa entre cada una
 * (sin la pausa, WhatsApp Cloud API acepta todas las llamadas pero en la
 * practica solo entrega la ultima si se mandan demasiado rapido). La primera
 * imagen lleva el caption (la ficha del producto); las demas van limpias.
 */
async function enviarImagenes(conexion, para, urlsImagenes, captionPrimera) {
  const resultados = [];
  let primera = true;
  for (const url of urlsImagenes) {
    resultados.push(await enviarImagen(conexion, para, url, primera ? captionPrimera : undefined));
    primera = false;
    await esperar(1200);
  }
  return resultados;
}

/**
 * Descarga un archivo multimedia (foto o audio) que un cliente envio por
 * WhatsApp. La API de Meta entrega el archivo en 2 pasos: primero resuelve
 * el mediaId a una URL firmada (que expira y requiere el mismo token), y
 * recien esa URL se puede descargar de verdad.
 * @returns {Promise<{buffer:Buffer, mimeType:string}|null>}
 */
async function obtenerMedia(conexion, mediaId) {
  if (!conexion || !conexion.tokenCifrado || !mediaId) return null;
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return null;

  try {
    const metaResp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaResp.json().catch(() => ({}));
    if (!metaResp.ok || !meta.url) return null;

    const fileResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileResp.ok) return null;

    const arrayBuffer = await fileResp.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type || fileResp.headers.get('content-type') || '' };
  } catch (err) {
    console.error('Error descargando media de WhatsApp:', err.message);
    return null;
  }
}

/**
 * Verifica la conexión consultando los datos del número en la Graph API.
 * @returns {Promise<{ok:boolean, numero?:string, error?:string}>}
 */
async function verificarConexion(conexion) {
  if (!conexion || !conexion.phoneNumberId || !conexion.tokenCifrado) {
    return { ok: false, error: 'La conexión no tiene credenciales configuradas.' };
  }
  const token = descifrar(conexion.tokenCifrado);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${conexion.phoneNumberId}?fields=display_phone_number,verified_name`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `Error HTTP ${resp.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, numero: data.display_phone_number, nombre: data.verified_name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { enviarTexto, enviarImagen, enviarImagenes, enviarBotones, obtenerMedia, verificarConexion, marcarLeidoYEscribiendo };
