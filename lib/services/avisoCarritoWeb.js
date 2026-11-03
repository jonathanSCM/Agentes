// Aviso por WhatsApp cuando el cliente agrega algo al carrito DESDE LA WEB.
//
// Antes no pasaba nada en el chat hasta que el cliente volvia y escribia el
// mensaje prellenado ("Quiero X"): la web no tenia confirmacion util y el bot
// no se enteraba. Ahora, apenas agrega, le llega un mensaje con el detalle y
// (con el flujo de botones activo) los botones para seguir.
//
// Reglas de diseño:
//  - Se AGRUPA: si agrega varias cosas seguidas se espera unos segundos de
//    calma y se manda UN solo mensaje con todo el carrito (no 4 mensajes).
//  - Solo se manda dentro de las 24 h de WhatsApp desde el ultimo mensaje del
//    cliente (fuera de esa ventana haria falta una plantilla paga): si no se
//    puede, la web lo avisa por su cuenta y el chat sigue como antes.
//  - Si el cliente ya escribio ("Quiero X") antes de que se cumpla la espera,
//    el bot ya le confirmo: no se duplica (se mira carritoWebPendiente).

const { prisma } = require('../db');
const wa = require('./whatsapp');
const { carritoDe, resumenCarrito } = require('./carrito');
const { dentroDeVentana24h } = require('./pedidos');
const { VENTANA_HORAS } = require('./conversaciones');

const ESPERA_MS = Number(process.env.AVISO_CARRITO_WEB_MS || 25 * 1000);
const temporizadores = new Map();

const BOTONES_AVISO = [
  { id: 'mas:si', titulo: 'Seguir comprando' },
  { id: 'mas:no', titulo: 'Finalizar' },
  { id: 'mas:ver', titulo: 'Ver carrito' },
];

/** Texto (y botones) del aviso. Puro: sin base ni red. */
function armarAviso(items, formatearPrecio, conBotones) {
  const cuerpo = resumenCarrito(items, formatearPrecio);
  const cierre = conBotones
    ? '¿Qué hacemos?'
    : 'Escribime "finalizar" cuando quieras cerrar tu pedido, o decime qué más querés ver.';
  const texto = `✅ *Agregado a tu carrito*\n${cuerpo}\n\n${cierre}`;
  return { texto, botones: conBotones ? BOTONES_AVISO : null };
}

/**
 * ¿Se le puede escribir a este cliente por WhatsApp ahora mismo?
 * @returns {Promise<{ok:boolean, motivo?:string, conexion?:object, agente?:object, conversacionId?:number|null}>}
 */
async function evaluarEnvio(empresaId, telefono, ahora = new Date()) {
  const ultimo = await prisma.mensaje.findFirst({
    where: { rol: 'CLIENTE', conversacion: { telefonoCliente: telefono, agente: { empresaId } } },
    orderBy: { createdAt: 'desc' },
    include: { conversacion: true },
  });
  if (!ultimo) return { ok: false, motivo: 'SIN_CHAT_PREVIO' };
  if (!dentroDeVentana24h(ultimo.createdAt, ahora)) return { ok: false, motivo: 'FUERA_DE_24H' };

  const conexion = await prisma.conexionWhatsApp.findUnique({
    where: { agenteId: ultimo.conversacion.agenteId },
    include: { agente: { include: { config: true, empresa: true } } },
  });
  if (!conexion || conexion.estado !== 'CONECTADO') return { ok: false, motivo: 'SIN_CONEXION' };

  const abierta = ahora.getTime() - ultimo.conversacion.ultimoMensajeAt.getTime() < VENTANA_HORAS * 60 * 60 * 1000;
  return { ok: true, conexion, agente: conexion.agente, conversacionId: abierta ? ultimo.conversacion.id : null };
}

/**
 * Manda el aviso AHORA (la espera ya paso). Devuelve que hizo, para logs/tests.
 * `deps` permite inyectar el envio y la base en los tests.
 */
async function enviarAviso({ empresaId, telefono, ahora = new Date(), deps = {} }) {
  const db = deps.prisma || prisma;
  const envio = deps.wa || wa;
  const formatear = deps.formatearPrecio || require('./agente').formatearPrecio;

  const eval_ = await evaluarEnvio(empresaId, telefono, ahora);
  if (!eval_.ok) return { enviado: false, motivo: eval_.motivo };

  const cliente = await db.clienteFinal.findUnique({ where: { empresaId_telefono: { empresaId, telefono } } });
  if (!cliente) return { enviado: false, motivo: 'SIN_CLIENTE' };
  const contexto = cliente.contexto || {};
  // El cliente ya escribio y el bot ya le confirmo: no se repite.
  if (!contexto.carritoWebPendiente) return { enviado: false, motivo: 'YA_CONFIRMADO_EN_EL_CHAT' };

  const items = carritoDe(contexto, eval_.conversacionId);
  if (!items.length) return { enviado: false, motivo: 'CARRITO_VACIO' };

  const config = eval_.agente.config || {};
  const moneda = eval_.agente.empresa ? eval_.agente.empresa.moneda : 'BOB';
  const { texto, botones } = armarAviso(items, (m) => formatear(m, moneda), Boolean(config.flujoDeterminista));

  const r = botones
    ? await envio.enviarBotones(eval_.conexion, telefono, texto, botones)
    : await envio.enviarTexto(eval_.conexion, telefono, texto);
  let resultado = r;
  if (botones && !(r && r.ok)) resultado = await envio.enviarTexto(eval_.conexion, telefono, `${texto}\n${botones.map((b) => `• ${b.titulo}`).join('\n')}`);
  if (!(resultado && resultado.ok)) return { enviado: false, motivo: 'FALLO_DE_ENVIO', error: resultado && resultado.error };

  // Ya se le aviso: se limpia la marca (relee antes de escribir, para no pisar
  // algo que el chat haya guardado mientras tanto) y queda en el historial.
  const fresco = await db.clienteFinal.findUnique({ where: { id: cliente.id } });
  await db.clienteFinal.update({ where: { id: cliente.id }, data: { contexto: { ...(fresco.contexto || {}), carritoWebPendiente: null } } });
  if (eval_.conversacionId) {
    const textoRegistro = botones ? `${texto}\n${botones.map((b) => `• ${b.titulo}`).join('\n')}` : texto;
    await db.mensaje.create({ data: { conversacionId: eval_.conversacionId, rol: 'AGENTE', contenido: textoRegistro } });
    await db.conversacion.update({ where: { id: eval_.conversacionId }, data: { ultimoMensajeAt: new Date() } });
  }
  return { enviado: true, conBotones: Boolean(botones) };
}

/**
 * Llamar justo despues de guardar el carrito desde la web. Si se puede avisar
 * por WhatsApp, agenda UN mensaje (agrupando lo que agregue en los proximos
 * segundos) y devuelve true; si no, devuelve false y la web se arregla sola.
 */
async function programarAviso({ empresaId, telefono, esperaMs = ESPERA_MS, deps = {} }) {
  const eval_ = await evaluarEnvio(empresaId, telefono);
  if (!eval_.ok) return false;
  const clave = `${empresaId}:${telefono}`;
  clearTimeout(temporizadores.get(clave));
  const t = setTimeout(() => {
    temporizadores.delete(clave);
    enviarAviso({ empresaId, telefono, deps }).catch((err) => console.error('--- aviso carrito web: ' + (err && err.message ? err.message : err)));
  }, esperaMs);
  if (t.unref) t.unref(); // no frena el cierre del proceso
  temporizadores.set(clave, t);
  return true;
}

function cancelarTodos() {
  for (const t of temporizadores.values()) clearTimeout(t);
  temporizadores.clear();
}

module.exports = { armarAviso, evaluarEnvio, enviarAviso, programarAviso, cancelarTodos, BOTONES_AVISO, ESPERA_MS, pendientes: () => temporizadores.size };
