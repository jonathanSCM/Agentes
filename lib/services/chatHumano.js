'use strict';
// lib/services/chatHumano.js
//
// Lo que un humano puede mandarle a un cliente desde el chat del panel, además del texto: ARCHIVOS (foto, video, audio, documento)
// y UBICACIONES, como en WhatsApp. Acá viven las reglas puras (se prueban sin red ni base):
//   - qué archivos se aceptan y de qué tamaño (los límites reales de WhatsApp: imagen 5 MB, video/audio/documento 16 MB;
//     nada que el navegador pueda ejecutar si alguien abre el link: ni .html, ni .svg, ni scripts);
//   - cómo se lee una ubicación (coordenadas, link de Google Maps o la ubicación del local) y que sea válida;
//   - cómo se explica un error de WhatsApp en palabras del usuario (la ventana de 24 h, sobre todo).

const path = require('path');
const { resolverCoordenadas } = require('./ubicacion');

const MB = 1024 * 1024;

// extensión -> { tipo (el del chat), waTipo (el de la API), max }
const EXTENSIONES = {
  jpg: { tipo: 'imagen', waTipo: 'image', max: 5 * MB }, jpeg: { tipo: 'imagen', waTipo: 'image', max: 5 * MB },
  png: { tipo: 'imagen', waTipo: 'image', max: 5 * MB }, webp: { tipo: 'imagen', waTipo: 'image', max: 5 * MB },
  mp4: { tipo: 'video', waTipo: 'video', max: 16 * MB }, '3gp': { tipo: 'video', waTipo: 'video', max: 16 * MB },
  mp3: { tipo: 'audio', waTipo: 'audio', max: 16 * MB }, ogg: { tipo: 'audio', waTipo: 'audio', max: 16 * MB }, m4a: { tipo: 'audio', waTipo: 'audio', max: 16 * MB },
  aac: { tipo: 'audio', waTipo: 'audio', max: 16 * MB }, amr: { tipo: 'audio', waTipo: 'audio', max: 16 * MB },
  pdf: { tipo: 'documento', waTipo: 'document', max: 16 * MB }, doc: { tipo: 'documento', waTipo: 'document', max: 16 * MB }, docx: { tipo: 'documento', waTipo: 'document', max: 16 * MB },
  xls: { tipo: 'documento', waTipo: 'document', max: 16 * MB }, xlsx: { tipo: 'documento', waTipo: 'document', max: 16 * MB },
  ppt: { tipo: 'documento', waTipo: 'document', max: 16 * MB }, pptx: { tipo: 'documento', waTipo: 'document', max: 16 * MB },
  txt: { tipo: 'documento', waTipo: 'document', max: 16 * MB }, csv: { tipo: 'documento', waTipo: 'document', max: 16 * MB },
};
const MAX_BYTES = 16 * MB;
const ACEPTADOS = Object.keys(EXTENSIONES).map((e) => `.${e}`).join(',');

class ErrorChat extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.codigo = 'CHAT';
  }
}

const mb = (bytes) => `${Math.round(bytes / MB)} MB`;

/** Nombre para mostrar: sin carpetas ni caracteres de control, con tope de largo. */
function nombreVisible(nombre) {
  const base = path.basename(String(nombre || '').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const limpio = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (limpio || 'archivo').slice(0, 120);
}

/** Qué es este archivo y si se puede mandar. Devuelve { tipo, waTipo, ext, nombre }. */
function clasificarArchivo({ nombre, bytes }) {
  const visible = nombreVisible(nombre);
  const ext = path.extname(visible).slice(1).toLowerCase();
  const regla = EXTENSIONES[ext];
  if (!regla) throw new ErrorChat('Ese tipo de archivo no se puede enviar. Podés mandar fotos, videos, audios, PDF, Word, Excel, PowerPoint, TXT o CSV.');
  const tam = Number(bytes);
  if (!Number.isFinite(tam) || tam <= 0) throw new ErrorChat('El archivo está vacío.');
  if (tam > regla.max) throw new ErrorChat(`El archivo es muy pesado: ${regla.tipo === 'imagen' ? 'las fotos' : 'este tipo de archivo'} pueden pesar hasta ${mb(regla.max)} en WhatsApp.`);
  return { tipo: regla.tipo, waTipo: regla.waTipo, ext, nombre: visible };
}

const mapsUrl = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

const texto = (v, max) => { const t = String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max); return t || null; };
// Number(null) y Number('') dan 0: un campo vacío NO es la coordenada (0, 0).
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? NaN : Number(v));
const enRango = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * Lee la ubicación que pidió mandar el usuario. `datos`: { lat, lng } | { enlace } | { tienda: true }, más nombre y dirección opcionales.
 * `tienda`: { lat, lng, direccion } del local (de la configuración del agente). `resolver`: para probar sin red.
 * @returns {Promise<{ lat, lng, nombre, direccion }>}
 */
async function normalizarUbicacion(datos = {}, tienda = null, resolver = resolverCoordenadas) {
  let nombre = texto(datos.nombre, 100);
  let direccion = texto(datos.direccion, 200);
  let lat; let lng;
  if (datos.tienda) {
    if (!tienda || !enRango(num(tienda.lat), num(tienda.lng))) throw new ErrorChat('Todavía no cargaste la ubicación de tu local. Hacelo en Configuración y vas a poder mandarla con un toque.');
    lat = num(tienda.lat); lng = num(tienda.lng);
    direccion = direccion || texto(tienda.direccion, 200);
    nombre = nombre || texto(tienda.nombre, 100);
  } else if (datos.enlace) {
    const c = await resolver(String(datos.enlace).slice(0, 600));
    if (!c) throw new ErrorChat('No pude sacar la ubicación de ese link. Pegá el link de Google Maps (o escribí las coordenadas).');
    lat = num(c.lat); lng = num(c.lng);
  } else {
    lat = num(datos.lat); lng = num(datos.lng);
  }
  if (!enRango(lat, lng)) throw new ErrorChat('La ubicación no es válida: la latitud va de -90 a 90 y la longitud de -180 a 180.');
  return { lat, lng, nombre, direccion };
}

/** Un error de WhatsApp dicho en palabras del usuario. */
function mensajeDeError(error, codigo = null) {
  const e = String(error || '');
  if (Number(codigo) === 131047 || /re-?engagement|24 ?h|24 hours|outside the allowed window/i.test(e)) {
    return 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite mandarle una plantilla aprobada. Esperá a que te escriba.';
  }
  if (/media.*(upload|download)|unsupported|not.*support|invalid.*(link|url)/i.test(e)) return `WhatsApp no pudo usar ese archivo (${e}).`;
  return e || 'WhatsApp rechazó el mensaje.';
}

module.exports = { ErrorChat, EXTENSIONES, ACEPTADOS, MAX_BYTES, nombreVisible, clasificarArchivo, normalizarUbicacion, mapsUrl, mensajeDeError };
