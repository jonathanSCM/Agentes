'use strict';
// lib/services/opiniones.js
//
// PEDIR COMENTARIOS a los clientes por WhatsApp para llenar el buscador de comentarios de Inteligencia de negocio.
//
// Cuándo se pide (solo si el negocio lo activó: son mensajes salientes, por defecto apagado):
//   - cuando un pedido se marca como ENTREGADO, y
//   - cuando una cita se marca como COMPLETADA.
// A quién: al cliente en su 1.ª, 2.ª y 3.ª vez (entre pedidos entregados y citas completadas). Después deja de pedir: un cliente
// fiel no tiene que recibir una encuesta cada vez. Nunca dos pedidos en menos de 7 días al mismo cliente.
// Cómo: un mensaje de texto una hora después (no justo al cerrar), nunca entre las 21:00 y las 08:00, y solo dentro de las 24 h
// del último mensaje del cliente (fuera de esa ventana WhatsApp solo deja mandar plantillas: queda "omitida" y se explica por qué).
// La respuesta del cliente llega como un mensaje normal, así que el buscador de comentarios ya la encuentra.
// Nunca se manda dos veces: hay una sola solicitud por pedido o cita (única en la base) y cada envío se reclama de forma atómica.

const { prisma } = require('../db');
const mensajesSrv = require('./mensajes');
const rubros = require('./rubros');
const waDefecto = require('./whatsapp');
const { enSilencio } = require('./recordatorios');

const HORA_MS = 3600000;
const DIA_MS = 24 * HORA_MS;
const ESPERA_MS = HORA_MS;           // se pide una hora después de cerrar el servicio
const SERVICIOS_QUE_SE_PIDEN = 3;    // 1.ª, 2.ª y 3.ª vez
const SEPARACION_MIN_MS = 7 * DIA_MS; // entre un pedido y otro al mismo cliente
const VENCE_MS = 24 * HORA_MS;       // si pasó un día sin poder enviarse, ya no tiene sentido pedirlo
const ORDINALES = { 2: 'segunda', 3: 'tercera' };

/** Pura: ¿corresponde pedir comentario en este servicio? `numero` = cuántos servicios completos lleva el cliente (contando este). */
function correspondePedir({ numero, ultimaSolicitudAt, ahora = new Date() }) {
  if (!(numero >= 1) || numero > SERVICIOS_QUE_SE_PIDEN) return { pedir: false, motivo: 'YA_NO_SE_PIDE' };
  if (ultimaSolicitudAt && ahora.getTime() - ultimaSolicitudAt.getTime() < SEPARACION_MIN_MS) return { pedir: false, motivo: 'PEDIDO_RECIENTE' };
  return { pedir: true };
}

/** Cuántos servicios completos lleva el cliente con el negocio (pedidos entregados + citas completadas). */
async function serviciosDelCliente(empresaId, clienteId) {
  const [pedidos, citas] = await Promise.all([
    prisma.pedido.count({ where: { empresaId, clienteId, estado: 'ENTREGADO' } }),
    prisma.cita.count({ where: { empresaId, clienteId, estado: 'COMPLETADA' } }),
  ]);
  return pedidos + citas;
}

/**
 * Anota (si corresponde) que hay que pedirle un comentario a este cliente. No manda nada: lo manda el barrido.
 * Nunca rompe el flujo que la llama. @returns {{programada:boolean, motivo?:string}}
 */
async function programar({ empresaId, clienteId, tipo, refId, ahora = new Date() }) {
  try {
    if (!clienteId || !['PEDIDO', 'CITA'].includes(tipo)) return { programada: false, motivo: 'SIN_CLIENTE' };
    const empresa = await prisma.empresa.findUnique({ where: { id: empresaId }, select: { pedirOpiniones: true } });
    if (!empresa || !empresa.pedirOpiniones) return { programada: false, motivo: 'APAGADO' };
    const numero = await serviciosDelCliente(empresaId, clienteId);
    const ultima = await prisma.solicitudOpinion.findFirst({
      where: { empresaId, clienteId, estado: { in: ['PROGRAMADA', 'ENVIANDO', 'ENVIADA'] } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    const dec = correspondePedir({ numero, ultimaSolicitudAt: ultima && ultima.createdAt, ahora });
    if (!dec.pedir) return { programada: false, motivo: dec.motivo };
    const r = await prisma.solicitudOpinion.createMany({
      data: [{ empresaId, clienteId, tipo, refId, numeroServicio: numero, programadaPara: new Date(ahora.getTime() + ESPERA_MS) }], skipDuplicates: true,
    });
    return { programada: r.count === 1, ...(r.count === 1 ? {} : { motivo: 'YA_EXISTIA' }) };
  } catch (err) {
    console.error('No se pudo programar el pedido de comentario:', err.message);
    return { programada: false, motivo: 'ERROR' };
  }
}

const primerNombre = (c) => String(c.nombre || c.nombrePerfil || '').trim().split(/\s+/)[0] || 'cliente';

/** Manda UNA solicitud ya reclamada. @returns {{estado:'ENVIADA'|'OMITIDA'|'FALLO', motivo?:string}} */
async function enviarUna(sol, { ahora = new Date(), deps = {} } = {}) {
  const wa = deps.wa || waDefecto;
  const [empresa, cliente] = await Promise.all([
    prisma.empresa.findUnique({ where: { id: sol.empresaId } }),
    prisma.clienteFinal.findUnique({ where: { id: sol.clienteId } }),
  ]);
  if (!empresa || !cliente) return { estado: 'OMITIDA', motivo: 'SIN_CLIENTE' };
  if (!empresa.pedirOpiniones) return { estado: 'OMITIDA', motivo: 'APAGADO' };
  const { evaluarEnvio } = require('./avisoCarritoWeb');
  const ev = await evaluarEnvio(empresa.id, cliente.telefono, ahora);
  if (!ev.ok) return { estado: 'OMITIDA', motivo: ev.motivo };

  const vocab = rubros.vocabularioDe(empresa);
  const m = await mensajesSrv.cargarContexto({ empresa, config: ev.agente.config, vocab });
  const nombre = primerNombre(cliente);
  let clave = sol.tipo === 'CITA' ? 'opinion_cita' : 'opinion_pedido';
  const vars = { nombre };
  if (sol.tipo === 'CITA') {
    const cita = await prisma.cita.findUnique({ where: { id: sol.refId }, include: { servicio: { select: { nombre: true } } } });
    vars.servicio = (cita && cita.servicio && cita.servicio.nombre) || vocab.servicio;
  }
  if (sol.numeroServicio >= 2 && ORDINALES[sol.numeroServicio]) { clave = 'opinion_recurrente'; vars.veces = ORDINALES[sol.numeroServicio]; }
  const texto = m.t(clave, vars);

  const r = await wa.enviarTexto(ev.conexion, cliente.telefono, texto);
  if (!(r && r.ok)) return { estado: 'FALLO', motivo: String((r && r.error) || 'envio').slice(0, 120) };
  if (ev.conversacionId) {
    const guardado = await prisma.mensaje.create({ data: { conversacionId: ev.conversacionId, rol: 'SISTEMA', contenido: texto } }).catch(() => null);
    try { require('./realtime').emitMensaje(empresa.id, { conversacionId: ev.conversacionId, rol: 'SISTEMA', contenido: texto, createdAt: (guardado && guardado.createdAt) || new Date() }); } catch (_) { /* el panel se actualiza solo despues */ }
  }
  return { estado: 'ENVIADA' };
}

let corriendo = false;

/** Barrido: manda los pedidos de comentario que ya toquen. @returns {{revisadas, enviadas, omitidas, fallos}} */
async function procesar({ ahora = new Date(), deps = {} } = {}) {
  const res = { revisadas: 0, enviadas: 0, omitidas: 0, fallos: 0 };
  if (corriendo) return { ...res, ocupado: true };
  corriendo = true;
  try {
    const pendientes = await prisma.solicitudOpinion.findMany({ where: { estado: 'PROGRAMADA', programadaPara: { lte: ahora } }, orderBy: { programadaPara: 'asc' }, take: 200 });
    const zonas = new Map();
    for (const sol of pendientes) {
      res.revisadas += 1;
      if (ahora.getTime() - sol.programadaPara.getTime() > VENCE_MS) {
        await prisma.solicitudOpinion.updateMany({ where: { id: sol.id, estado: 'PROGRAMADA' }, data: { estado: 'OMITIDA', motivo: 'VENCIDA' } });
        res.omitidas += 1; continue;
      }
      if (!zonas.has(sol.empresaId)) zonas.set(sol.empresaId, (await prisma.empresa.findUnique({ where: { id: sol.empresaId }, select: { zonaHoraria: true } }) || {}).zonaHoraria || 'America/La_Paz');
      if (enSilencio(ahora, zonas.get(sol.empresaId))) continue; // se manda al abrir el horario
      const reclamo = await prisma.solicitudOpinion.updateMany({ where: { id: sol.id, estado: 'PROGRAMADA' }, data: { estado: 'ENVIANDO' } });
      if (reclamo.count !== 1) continue; // otro proceso la tomó
      let r;
      try { r = await enviarUna(sol, { ahora, deps }); } catch (err) { r = { estado: 'FALLO', motivo: err.message }; }
      await prisma.solicitudOpinion.update({ where: { id: sol.id }, data: { estado: r.estado, motivo: r.motivo || null, ...(r.estado === 'ENVIADA' ? { enviadaAt: ahora } : {}) } });
      if (r.estado === 'ENVIADA') res.enviadas += 1; else if (r.estado === 'FALLO') { res.fallos += 1; console.error(`--- opiniones: fallo con la solicitud #${sol.id}: ${r.motivo}`); } else res.omitidas += 1;
    }
  } finally { corriendo = false; }
  return res;
}

// ------------------------------------------------------------------ para el panel

const MOTIVOS = {
  FUERA_DE_24H: 'el cliente no escribió en las últimas 24 h (WhatsApp no deja mandar texto libre)',
  SIN_CHAT_PREVIO: 'el cliente nunca escribió por WhatsApp',
  SIN_CONEXION: 'no había WhatsApp conectado',
  VENCIDA: 'pasó más de un día sin poder enviarse',
  APAGADO: 'se apagó la opción',
  SIN_CLIENTE: 'no había cliente',
};

/** Resumen para el panel: cuántos se pidieron, cuántos respondieron y las respuestas (primer mensaje del cliente después del pedido). */
async function resumen(empresaId, { ahora = new Date(), dias = 120 } = {}) {
  const desde = new Date(ahora.getTime() - dias * DIA_MS);
  const sols = await prisma.solicitudOpinion.findMany({ where: { empresaId, createdAt: { gte: desde } }, orderBy: { createdAt: 'desc' }, take: 300, include: { cliente: { select: { telefono: true, nombre: true, nombrePerfil: true } } } });
  const porEstado = { ENVIADA: 0, PROGRAMADA: 0, OMITIDA: 0, FALLO: 0 };
  for (const s of sols) { const k = s.estado === 'ENVIANDO' ? 'PROGRAMADA' : s.estado; porEstado[k] = (porEstado[k] || 0) + 1; }
  const enviadas = sols.filter((s) => s.estado === 'ENVIADA' && s.enviadaAt);
  const respuestas = [];
  for (const s of enviadas.slice(0, 60)) {
    const hasta = new Date(s.enviadaAt.getTime() + 7 * DIA_MS);
    const msg = await prisma.mensaje.findFirst({
      where: { rol: 'CLIENTE', createdAt: { gt: s.enviadaAt, lte: hasta }, conversacion: { telefonoCliente: s.cliente.telefono, agente: { empresaId } } },
      orderBy: { createdAt: 'asc' }, select: { contenido: true, createdAt: true },
    });
    if (msg) respuestas.push({ id: s.id, tipo: s.tipo, numeroServicio: s.numeroServicio, nombre: s.cliente.nombre || s.cliente.nombrePerfil || s.cliente.telefono, contenido: msg.contenido, fecha: msg.createdAt });
  }
  const omitidas = sols.filter((s) => s.estado === 'OMITIDA' || s.estado === 'FALLO').slice(0, 5).map((s) => ({ id: s.id, motivo: MOTIVOS[s.motivo] || s.motivo || 'sin detalle' }));
  return { dias, total: sols.length, enviadas: porEstado.ENVIADA, programadas: porEstado.PROGRAMADA, omitidas: porEstado.OMITIDA, fallos: porEstado.FALLO, respondieron: respuestas.length, respuestas, omitidasEjemplos: omitidas };
}

/** Enciende o apaga el pedido de comentarios del negocio. */
async function activar(empresaId, activo) {
  await prisma.empresa.update({ where: { id: empresaId }, data: { pedirOpiniones: Boolean(activo) } });
}

module.exports = { ESPERA_MS, SERVICIOS_QUE_SE_PIDEN, SEPARACION_MIN_MS, correspondePedir, serviciosDelCliente, programar, enviarUna, procesar, resumen, activar };
