'use strict';
// lib/services/mediaEntrante.js
//
// SOLO TEXTO (fase 1 del planning de créditos y Centro de IA): por ahora el agente NO procesa audios, fotos, videos, documentos ni stickers.
// Procesarlos gasta IA (transcripción, visión) que hoy no se mide ni se cobra. Cuando un cliente manda uno de esos mensajes:
//   - NO se descarga el archivo ni se envía a ningún modelo: costo cero;
//   - se le responde un mensaje breve y amable del catálogo de mensajes (editable por el negocio) pidiendo que escriba su consulta;
//   - si ya hay una conversación abierta, el intento queda en el chat del panel (sin cobrar nada); si no la hay, NO se abre una (no se cobra);
//   - para no responder en bucle, el aviso se repite como mucho una vez cada 10 minutos por cliente (los demás intentos se ignoran);
//   - queda constancia en el log (luego, en el historial de eventos del Centro de IA).
// Las ubicaciones se siguen aceptando (no usan IA y el flujo de entrega las necesita). Se puede reactivar con MEDIA_ENTRANTE_ACTIVA=1.

const { prisma } = require('../db');

const TIPOS_NO_SOPORTADOS = ['image', 'audio', 'video', 'document', 'sticker'];
const ETIQUETAS = { image: 'una foto', audio: 'un audio', video: 'un video', document: 'un documento', sticker: 'un sticker' };
const AVISO_CADA_MS = 10 * 60 * 1000;

const avisados = new Map(); // "agenteId:telefono" -> instante del ultimo aviso

/** ¿Está reactivado el procesamiento de audios e imágenes? (apagado por defecto) */
const mediaActiva = (env = process.env) => String(env.MEDIA_ENTRANTE_ACTIVA || '') === '1';

/** ¿Este mensaje entrante es un tipo que hoy no se procesa? Devuelve el tipo o null. */
function tipoNoSoportado(mensaje) {
  const t = mensaje && mensaje.type;
  return TIPOS_NO_SOPORTADOS.includes(t) ? t : null;
}

function reiniciar() { avisados.clear(); }

/**
 * Responde al cliente que por ahora solo se lee texto. No descarga nada ni usa IA.
 * @param {{ conexion: { agente: { id: number } }, telefono: string, tipo: string }} datos
 * @param {{ enviar?: Function, ahora?: number }} dependencias
 * @returns {Promise<{ ok: boolean, respondido: boolean, motivo?: string, texto?: string, conversacionId?: number|null }>}
 */
async function responder({ conexion, telefono, tipo }, { enviar = null, ahora = Date.now() } = {}) {
  const agenteId = conexion && conexion.agente && conexion.agente.id;
  if (!agenteId || !telefono) return { ok: false, respondido: false, motivo: 'SIN_DATOS' };

  const clave = `${agenteId}:${telefono}`;
  const antes = avisados.get(clave);
  if (antes && ahora - antes < AVISO_CADA_MS) return { ok: true, respondido: false, motivo: 'YA_AVISADO' };
  avisados.set(clave, ahora);
  if (avisados.size > 5000) for (const [k, v] of avisados) if (ahora - v > AVISO_CADA_MS) avisados.delete(k);

  const agente = await prisma.agente.findUnique({ where: { id: agenteId }, include: { empresa: true, config: true } });
  if (!agente) return { ok: false, respondido: false, motivo: 'SIN_AGENTE' };
  const mensajesSrv = require('./mensajes');
  const m = await mensajesSrv.cargarContexto({ empresa: agente.empresa, config: agente.config });
  const texto = m.t('media_no_soportada');

  // Si hay una conversación abierta, el intento queda visible en el panel. Nunca se abre una nueva (eso cobraría).
  let conversacionId = null;
  const { buscarConversacionAbierta } = require('./conversaciones');
  const abierta = await buscarConversacionAbierta(agenteId, telefono);
  if (abierta) {
    conversacionId = abierta.id;
    await prisma.$transaction([
      prisma.mensaje.create({ data: { conversacionId: abierta.id, rol: 'CLIENTE', contenido: `[El cliente envió ${ETIQUETAS[tipo] || 'un archivo'}: por ahora no se procesa]`, meta: { mediaNoSoportada: tipo } } }),
      prisma.mensaje.create({ data: { conversacionId: abierta.id, rol: 'AGENTE', contenido: texto, meta: { mediaNoSoportada: tipo } } }),
      prisma.conversacion.update({ where: { id: abierta.id }, data: { ultimoMensajeAt: new Date() } }),
    ]);
  }

  const envio = await (enviar || ((c, para, t) => require('./whatsapp').enviarTexto(c, para, t)))(conexion, telefono, texto);
  console.log(`[MEDIA_NO_SOPORTADA] tipo=${tipo} agente=${agenteId} conversacion=${conversacionId || '-'} enviado=${envio && envio.ok !== false}`);
  return { ok: true, respondido: true, texto, conversacionId };
}

module.exports = { TIPOS_NO_SOPORTADOS, AVISO_CADA_MS, mediaActiva, tipoNoSoportado, responder, reiniciar };
