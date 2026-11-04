'use strict';
// lib/services/pendientes.js
//
// Mensajes pendientes recuperables (idea de AgendaBot: meta.hasta + meta.fallo).
//
// Cuando la IA no puede entender un texto libre, el cliente recibe el menú del
// modo sin IA y su pregunta queda SIN CONTESTAR. Esa respuesta del agente se
// guarda con meta { pendienteIA: true, hasta: <id del mensaje del cliente>,
// texto }. Acá se recuperan:
//
//   recuperar({ conversacionId })   contesta ahora (botón "Que el agente responda" del panel)
//   recuperarTodos()                cada pocos minutos, cuando la IA vuelve, contesta lo pendiente
//
// Reglas (para no molestar ni mandar cosas fuera de lugar):
//  - solo si el cliente NO escribió nada después (si siguió con el menú, ya no es pendiente);
//  - solo dentro de la ventana de 24 h de WhatsApp (se usa 23 h);
//  - nunca si un humano tomó la conversación;
//  - si la IA sigue caída, no se manda nada y se vuelve a intentar (máx. 5 veces).

const { prisma } = require('../db');
const saludIA = require('./saludIA');
const { enviarSalidaPorWhatsApp } = require('./salidaWhatsApp');
const { registrarRespuestaAgente } = require('./conversaciones');
const { emitMensaje } = require('./realtime');

const VENTANA_MS = 23 * 60 * 60 * 1000;
const MAX_INTENTOS = 5;
const PREFIJO = 'Perdón la demora 🙏 ';

const esTelefonoReal = (t) => /^\d{8,}$/.test(String(t || ''));
const baseUrlPorDefecto = () => process.env.APP_BASE_URL || process.env.PUBLIC_URL || null;

/**
 * El mensaje del agente que dejó algo sin contestar en esta conversación, o
 * null si no hay nada pendiente (o ya no corresponde).
 */
async function pendienteDe(conversacionId, ahora = Date.now()) {
  const ultima = await prisma.mensaje.findFirst({ where: { conversacionId, rol: 'AGENTE' }, orderBy: { id: 'desc' } });
  const meta = ultima && ultima.meta;
  if (!meta || !meta.pendienteIA || meta.recuperado || meta.abandonado) return null;
  if (ahora - ultima.createdAt.getTime() > VENTANA_MS) return null;
  const despues = await prisma.mensaje.count({ where: { conversacionId, rol: 'CLIENTE', id: { gt: ultima.id } } });
  if (despues > 0) return null;
  let texto = meta.texto || null;
  if (!texto && meta.hasta) {
    const m = await prisma.mensaje.findUnique({ where: { id: meta.hasta } });
    texto = m && m.contenido;
  }
  return texto ? { agenteMsg: ultima, texto, meta } : null;
}

async function marcar(agenteMsg, cambios) {
  await prisma.mensaje.update({ where: { id: agenteMsg.id }, data: { meta: { ...(agenteMsg.meta || {}), ...cambios } } });
}

/**
 * Contesta lo que quedó pendiente en una conversación.
 * @returns {{ ok: boolean, motivo?: string }}
 *   motivos: NO_EXISTE | EN_MANOS_HUMANAS | NADA_PENDIENTE | SIN_WHATSAPP | IA_NO_DISPONIBLE | ENVIO_FALLIDO
 */
async function recuperar({ conversacionId, baseUrl = baseUrlPorDefecto(), forzar = false, enviar = enviarSalidaPorWhatsApp, opciones = {} }) {
  const conv = await prisma.conversacion.findUnique({
    where: { id: conversacionId },
    include: { agente: { include: { conexion: true } } },
  });
  if (!conv) return { ok: false, motivo: 'NO_EXISTE' };
  if (conv.modo === 'HUMANO') return { ok: false, motivo: 'EN_MANOS_HUMANAS' };
  if (!esTelefonoReal(conv.telefonoCliente)) return { ok: false, motivo: 'NADA_PENDIENTE' };

  const p = await pendienteDe(conversacionId);
  if (!p) return { ok: false, motivo: 'NADA_PENDIENTE' };
  const conexion = conv.agente.conexion;
  if (!conexion || conexion.estado !== 'CONECTADO') return { ok: false, motivo: 'SIN_WHATSAPP' };
  // Con la IA en pausa (circuito abierto) ni se intenta, salvo que el dueño lo pida a mano.
  if (!forzar && saludIA.resumen().estado === 'EN_PAUSA') return { ok: false, motivo: 'IA_NO_DISPONIBLE' };

  // Historial SIN la pregunta pendiente ni el menú con que se la "contestó":
  // se le entrega a la IA como el mensaje actual, no dos veces.
  const mensajes = await prisma.mensaje.findMany({ where: { conversacionId }, orderBy: { id: 'desc' }, take: 24 });
  const historial = mensajes
    .reverse()
    .filter((m) => m.id !== p.agenteMsg.id && m.id !== p.meta.hasta)
    .map((m) => ({ rol: m.rol, contenido: m.contenido }));

  const { generarRespuesta } = require('./agente');
  let salida;
  try {
    salida = await generarRespuesta(conv.agenteId, conv.telefonoCliente, historial, p.texto, conversacionId, { baseUrl, soloConIA: true, ...opciones });
  } catch (err) {
    console.error('[pendientes] error generando la respuesta:', err.message);
    salida = null;
  }
  const sirve = salida && salida.ok && salida.respuesta && !salida.fallaIA && !salida.modoSinIA && !salida.error;
  if (!sirve) {
    const intentos = Number(p.meta.intentos || 0) + 1;
    await marcar(p.agenteMsg, { intentos, ...(intentos >= MAX_INTENTOS ? { abandonado: true } : {}) });
    return { ok: false, motivo: 'IA_NO_DISPONIBLE' };
  }

  const conPrefijo = {
    ...salida,
    respuesta: `${PREFIJO}${salida.respuesta}`,
    ...(salida.textoRegistro ? { textoRegistro: `${PREFIJO}${salida.textoRegistro}` } : {}),
  };
  const envio = await enviar(conexion, conv.telefonoCliente, conPrefijo);
  if (!envio || !envio.ok) {
    await marcar(p.agenteMsg, { intentos: Number(p.meta.intentos || 0) + 1 });
    return { ok: false, motivo: 'ENVIO_FALLIDO' };
  }

  const texto = conPrefijo.textoRegistro || conPrefijo.respuesta;
  await registrarRespuestaAgente(conversacionId, texto, { recuperacion: true, de: p.agenteMsg.id });
  await marcar(p.agenteMsg, { recuperado: true, recuperadoEn: new Date().toISOString() });
  emitMensaje(conv.agente.empresaId, { conversacionId, rol: 'AGENTE', contenido: texto, createdAt: new Date() });
  return { ok: true };
}

/** Recorre lo pendiente de las últimas 23 h y lo contesta (máx. `limite` por vuelta). */
async function recuperarTodos({ limite = 5, baseUrl, enviar, opciones } = {}) {
  if (saludIA.resumen().estado === 'EN_PAUSA') return { recuperadas: 0, intentadas: 0 };
  const candidatos = await prisma.mensaje.findMany({
    where: { rol: 'AGENTE', createdAt: { gte: new Date(Date.now() - VENTANA_MS) }, meta: { path: ['pendienteIA'], equals: true } },
    select: { conversacionId: true, meta: true },
    orderBy: { id: 'desc' },
    take: 60,
  });
  const conversaciones = [...new Set(candidatos.filter((c) => !c.meta.recuperado && !c.meta.abandonado).map((c) => c.conversacionId))].slice(0, limite);
  let recuperadas = 0;
  for (const conversacionId of conversaciones) {
    const r = await recuperar({ conversacionId, baseUrl, enviar, opciones }).catch((e) => { console.error('[pendientes]', e.message); return { ok: false }; });
    if (r.ok) recuperadas += 1;
    // Si la IA sigue sin responder, no tiene sentido probar con las demas ahora.
    if (r.motivo === 'IA_NO_DISPONIBLE') break;
  }
  return { recuperadas, intentadas: conversaciones.length };
}

const INTERVALO_MS = 2 * 60 * 1000;
function iniciarJobPendientes() {
  const correr = () => recuperarTodos().catch((e) => console.error('[pendientes] job:', e.message));
  const t = setInterval(correr, INTERVALO_MS);
  if (t.unref) t.unref();
  return t;
}

module.exports = { pendienteDe, recuperar, recuperarTodos, iniciarJobPendientes, PREFIJO };
