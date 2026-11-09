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

// ---------------------------------------------------------------------------
// Mensajes interactivos: lista y pedido de ubicacion (flujo determinista).
// ---------------------------------------------------------------------------

async function enviarInteractivo(conexion, para, interactive) {
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
        type: 'interactive',
        interactive,
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
 * Mensaje tipo lista (hasta 10 filas en total, repartidas en secciones).
 * lista = { boton, secciones: [{ titulo, filas: [{ id, titulo, descripcion? }] }] }
 * Limites de WhatsApp: cuerpo 1024, boton 20, titulo de seccion/fila 24,
 * descripcion 72, id 200.
 */
async function enviarLista(conexion, para, texto, lista) {
  const total = ((lista && lista.secciones) || []).reduce((n, s) => n + s.filas.length, 0);
  if (!total || total > 10) return { ok: false, error: 'Una lista necesita entre 1 y 10 filas.' };
  return enviarInteractivo(conexion, para, {
    type: 'list',
    body: { text: String(texto).slice(0, 1024) },
    action: {
      button: String(lista.boton || 'Ver opciones').slice(0, 20),
      sections: lista.secciones.map((s) => ({
        title: String(s.titulo || 'Opciones').slice(0, 24),
        rows: s.filas.map((f) => ({
          id: String(f.id).slice(0, 200),
          title: String(f.titulo).slice(0, 24),
          ...(f.descripcion ? { description: String(f.descripcion).slice(0, 72) } : {}),
        })),
      })),
    },
  });
}

/**
 * Tarjeta con imagen, texto y UN boton que abre un link ("Ver catalogo"): se ve
 * mucho mas limpio que pegar la URL cruda en el texto. Es el mensaje
 * interactivo tipo "cta_url" de la Cloud API (cuerpo max 1024, boton max 20).
 *
 * Si Meta lo rechaza (cuenta sin acceso, formato, imagen que no baja...) cae al
 * metodo de siempre: la imagen con el link escrito al pie, asi el cliente nunca
 * se queda sin el catalogo. `conBoton` dice cual de los dos salio.
 */
async function enviarImagenConBoton(conexion, para, { urlImagen, texto, boton, url }) {
  const interactive = {
    type: 'cta_url',
    ...(urlImagen ? { header: { type: 'image', image: { link: urlImagen } } } : {}),
    body: { text: String(texto).slice(0, 1024) },
    action: { name: 'cta_url', parameters: { display_text: String(boton || 'Ver catálogo').slice(0, 20), url } },
  };
  const r = await enviarInteractivo(conexion, para, interactive);
  if (r.ok) return { ...r, conBoton: true };
  const respaldo = `${texto}

👉 ${boton || 'Ver catálogo'}: ${url}`.slice(0, 1024);
  const f = urlImagen ? await enviarImagen(conexion, para, urlImagen, respaldo) : await enviarTexto(conexion, para, respaldo);
  return { ...f, conBoton: false, errorBoton: r.error };
}

/** Boton nativo "Enviar ubicacion" (el cliente toca y comparte el pin). */
async function enviarSolicitudUbicacion(conexion, para, texto) {
  return enviarInteractivo(conexion, para, {
    type: 'location_request_message',
    body: { text: String(texto).slice(0, 1024) },
    action: { name: 'send_location' },
  });
}

/** Respaldo en texto numerado si WhatsApp rechaza la lista. */
function textoDeLista(texto, lista) {
  const filas = ((lista && lista.secciones) || []).flatMap((s) => s.filas);
  return `${texto}\n${filas.map((f, i) => `${i + 1}. ${f.titulo}`).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Plantillas (mensajes aprobados por Meta): para escribirle a un cliente FUERA de las 24 h desde su ultimo mensaje.
// ---------------------------------------------------------------------------

/** Meta no admite saltos de linea, tabulaciones ni mas de 4 espacios seguidos dentro de una variable de plantilla. */
const limpiarVariable = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').trim().slice(0, 60) || '-';

/**
 * Manda una plantilla APROBADA. `variables`: valores de {{1}}, {{2}}... del cuerpo. `botones`: payloads de los
 * botones de respuesta rapida (vuelven en el webhook como un toque de boton).
 */
async function enviarPlantilla(conexion, para, { nombre, idioma = 'es', variables = [], botones = [] }) {
  if (!conexion || !conexion.phoneNumberId || !conexion.tokenCifrado) return { ok: false, error: 'La conexión no tiene credenciales configuradas.' };
  if (!nombre) return { ok: false, error: 'Falta el nombre de la plantilla.' };
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return { ok: false, error: 'No se pudo leer el token de acceso.' };
  const componentes = [];
  if (variables.length) componentes.push({ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: limpiarVariable(v) })) });
  botones.forEach((payload, i) => componentes.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: String(payload).slice(0, 128) }] }));
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${conexion.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: String(para).replace(/\D/g, ''), type: 'template',
        template: { name: nombre, language: { code: idioma }, ...(componentes.length ? { components: componentes } : {}) },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: (data && data.error && data.error.message) || `Error HTTP ${resp.status}` };
    return { ok: true, id: data.messages && data.messages[0] && data.messages[0].id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Crea una plantilla en la cuenta de WhatsApp Business (queda PENDING hasta que Meta la apruebe). */
async function crearPlantilla(conexion, definicion) {
  if (!conexion || !conexion.wabaId || !conexion.tokenCifrado) return { ok: false, error: 'Falta el ID de la cuenta de WhatsApp Business (WABA) en la conexión.' };
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return { ok: false, error: 'No se pudo leer el token de acceso.' };
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${conexion.wabaId}/message_templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(definicion),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: (data && data.error && (data.error.error_user_msg || data.error.message)) || `Error HTTP ${resp.status}` };
    return { ok: true, id: data.id || null, estado: data.status || 'PENDING' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Estado de una plantilla por nombre: APPROVED | PENDING | REJECTED | PAUSED | DISABLED | NO_EXISTE. */
async function estadoPlantilla(conexion, nombre) {
  if (!conexion || !conexion.wabaId || !conexion.tokenCifrado) return { ok: false, error: 'Falta el ID de la cuenta de WhatsApp Business (WABA) en la conexión.' };
  const token = descifrar(conexion.tokenCifrado);
  if (!token) return { ok: false, error: 'No se pudo leer el token de acceso.' };
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${conexion.wabaId}/message_templates?name=${encodeURIComponent(nombre)}&fields=name,status,rejected_reason`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: (data && data.error && data.error.message) || `Error HTTP ${resp.status}` };
    const t = (data.data || []).find((x) => x.name === nombre);
    return t ? { ok: true, estado: String(t.status || '').toUpperCase(), motivo: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null } : { ok: true, estado: 'NO_EXISTE' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  enviarPlantilla, crearPlantilla, estadoPlantilla, limpiarVariable,
  enviarTexto, enviarImagen, enviarImagenes, enviarBotones, obtenerMedia, verificarConexion, marcarLeidoYEscribiendo,
  enviarLista, enviarSolicitudUbicacion, textoDeLista, enviarImagenConBoton,
};
