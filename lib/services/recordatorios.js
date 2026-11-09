'use strict';
// lib/services/recordatorios.js
//
// RECORDATORIOS DE CITAS por WhatsApp (docs/09 fase 5): "mañana tenés turno" (24 h antes) y "hoy a las 10:30" (2 h antes),
// con botones Confirmo / Cambiar horario / Cancelar que resuelve el bot de citas por código (0 IA).
//
// Reglas:
//   - Son mensajes SALIENTES a clientes del negocio: están APAGADOS hasta que el negocio los activa (configAgenda.recordatorios).
//   - Horas de silencio: no se manda entre las 21:00 y las 08:00 (hora del negocio). Si cae en ese rato, se manda al abrir
//     el horario siempre que todavía tenga sentido.
//   - Una cita recién reservada no recibe un recordatorio inútil: el de 24 h solo si se agendó con más de 24 h de anticipación; el de
//     2 h solo si se agendó con más de 3 h. Si se juntan los dos (el sistema estuvo caído), se manda solo el más cercano.
//   - WhatsApp: dentro de las 24 h del último mensaje del cliente se manda texto con botones; FUERA de esa ventana solo se puede
//     mandar una PLANTILLA aprobada por Meta. Sin plantilla aprobada no se manda y queda anotado (nunca se rompe la regla de Meta).
//   - Nunca se manda dos veces: cada recordatorio se "reclama" de forma atómica (jsonb) antes de enviarlo; un fallo se reintenta hasta 3
//     veces y después queda como fallido.
//   - Todo texto sale del catálogo de mensajes (editable por el negocio); la plantilla es fija (la aprobó Meta).

const { prisma } = require('../db');
const T = require('./tiempo');
const { agendaDe } = require('./configAgenda');
const mensajesSrv = require('./mensajes');
const rubros = require('./rubros');
const { dentroDeVentana24h } = require('./pedidos');
const waDefecto = require('./whatsapp');

const HORA_MS = 3600000;
const SILENCIO = { desde: 21, hasta: 8 };
const MAX_FALLOS = 3;
const ACTIVAS = ['PENDIENTE', 'CONFIRMADA'];

// ------------------------------------------------------------------ la plantilla (texto fijo aprobado por Meta)

const PLANTILLA = Object.freeze({
  nombre: 'recordatorio_cita',
  idioma: 'es',
  categoria: 'UTILITY',
  cuerpo: 'Hola {{1}}, te recordamos tu {{2}} de {{3}}: {{4}}. ¿Nos confirmás que venís?',
  ejemplo: ['Ana', 'cita', 'Corte de pelo', 'jueves 12 de noviembre, 10:30'],
  botones: ['Confirmo', 'Cambiar horario', 'Cancelar'],
});

/** Lo que se le manda a Meta para crear la plantilla. */
function definicionPlantilla() {
  return {
    name: PLANTILLA.nombre, language: PLANTILLA.idioma, category: PLANTILLA.categoria,
    components: [
      { type: 'BODY', text: PLANTILLA.cuerpo, example: { body_text: [PLANTILLA.ejemplo] } },
      { type: 'BUTTONS', buttons: PLANTILLA.botones.map((text) => ({ type: 'QUICK_REPLY', text })) },
    ],
  };
}

// ------------------------------------------------------------------ cuándo toca (reglas puras)

/** ¿Es hora de silencio (21:00 a 08:00) en la zona del negocio? */
function enSilencio(ahora, zona) {
  const hora = Number(T.aLocal(ahora, zona).hora.slice(0, 2));
  return hora >= SILENCIO.desde || hora < SILENCIO.hasta;
}

/**
 * Qué recordatorio corresponde mandar ahora para una cita (o null), y cuál se da por superado.
 * @returns {{ enviar: '24h'|'2h'|null, superados: string[] }}
 */
function queToca(cita, cfg, ahora) {
  const rec = cita.recordatorios || {};
  const restante = cita.inicio.getTime() - ahora.getTime();
  const anticipacion = cita.inicio.getTime() - cita.createdAt.getTime();
  const r = cfg.recordatorios;
  const quiere2 = r.h2 && !rec['2h'] && restante <= 2 * HORA_MS && restante > 10 * 60000 && anticipacion > 3 * HORA_MS;
  const quiere24 = r.h24 && !rec['24h'] && restante <= 24 * HORA_MS && restante > 4 * HORA_MS && anticipacion > 24 * HORA_MS;
  if (quiere2) return { enviar: '2h', superados: r.h24 && !rec['24h'] ? ['24h'] : [] };
  if (quiere24) return { enviar: '24h', superados: [] };
  return { enviar: null, superados: [] };
}

// ------------------------------------------------------------------ estado en la cita (jsonb, atómico)

/** Reclama el recordatorio: true si ESTE proceso es el único que lo va a mandar. */
async function reclamar(citaId, clave, ahora) {
  const n = await prisma.$executeRaw`
    UPDATE "citas"
       SET "recordatorios" = COALESCE("recordatorios", '{}'::jsonb) || jsonb_build_object(${clave}::text, jsonb_build_object('estado', 'enviando', 'at', ${ahora.toISOString()}::text))
     WHERE "id" = ${citaId} AND NOT jsonb_exists(COALESCE("recordatorios", '{}'::jsonb), ${clave}::text)`;
  return n === 1;
}
const fijar = (citaId, clave, objeto) => prisma.$executeRaw`
  UPDATE "citas" SET "recordatorios" = COALESCE("recordatorios", '{}'::jsonb) || jsonb_build_object(${clave}::text, ${JSON.stringify(objeto)}::jsonb) WHERE "id" = ${citaId}`;
/** Falló el envío: se libera para reintentar, y al tercer fallo queda como fallido. */
async function registrarFallo(cita, clave, error, ahora) {
  const fallos = ((cita.recordatorios && cita.recordatorios.fallos && cita.recordatorios.fallos[clave]) || 0) + 1;
  if (fallos >= MAX_FALLOS) return fijar(cita.id, clave, { estado: 'fallo', at: ahora.toISOString(), motivo: String(error || '').slice(0, 200) });
  return prisma.$executeRaw`
    UPDATE "citas"
       SET "recordatorios" = (COALESCE("recordatorios", '{}'::jsonb) - ${clave}::text)
           || jsonb_build_object('fallos', COALESCE("recordatorios"->'fallos', '{}'::jsonb) || jsonb_build_object(${clave}::text, ${fallos}::int))
     WHERE "id" = ${cita.id}`;
}

// ------------------------------------------------------------------ envío de uno

const primerNombre = (cliente) => String(cliente.nombre || cliente.nombrePerfil || '').trim().split(/\s+/)[0] || 'cliente';
const cuandoLegible = (cita, zona, clave) => (clave === '2h' ? `hoy a las ${T.legible(cita.inicio, zona).split(', ')[1]}` : T.legible(cita.inicio, zona));

async function conexionDe(empresaId) {
  return prisma.conexionWhatsApp.findFirst({ where: { estado: 'CONECTADO', agente: { empresaId } }, include: { agente: { include: { config: true } } } });
}

/**
 * Manda UN recordatorio ya reclamado. Devuelve { estado: 'enviado'|'omitido'|'fallo', via?, motivo? }.
 * `deps.wa` permite probar sin red.
 */
async function enviarUno(cita, clave, { ahora = new Date(), deps = {} } = {}) {
  const wa = deps.wa || waDefecto;
  const empresa = cita.empresa;
  const zona = empresa.zonaHoraria;
  const conexion = await conexionDe(empresa.id);
  if (!conexion) return { estado: 'omitido', motivo: 'sin_conexion' };
  const telefono = cita.cliente.telefono;

  const ultimo = await prisma.mensaje.findFirst({
    where: { rol: 'CLIENTE', conversacion: { telefonoCliente: telefono, agente: { empresaId: empresa.id } } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true, conversacionId: true },
  });
  const dentro = Boolean(ultimo && dentroDeVentana24h(ultimo.createdAt, ahora));
  const vocab = rubros.vocabularioDe(empresa);
  const nombre = primerNombre(cita.cliente);
  const servicio = cita.servicio ? cita.servicio.nombre : vocab.servicio;
  const cuando = cuandoLegible(cita, zona, clave);
  const botonesId = { rok: `ct:rok:0:0:1:0:${cita.id}:`, rep: `ct:rep:0:0:1:0:${cita.id}:`, can: `ct:can:0:0:1:0:${cita.id}:` };

  if (dentro) {
    const m = await mensajesSrv.cargarContexto({ empresa, config: conexion.agente.config, vocab });
    const direccion = conexion.agente.config && conexion.agente.config.direccionTienda;
    const texto = clave === '2h'
      ? m.t('citas_recordatorio_2h', { nombre, servicio, hora: T.legible(cita.inicio, zona).split(', ')[1], ...(direccion ? { direccion } : {}) })
      : m.t('citas_recordatorio_24h', { nombre, servicio, cuando });
    const botones = [{ id: botonesId.rok, titulo: 'Confirmo' }, { id: botonesId.rep, titulo: 'Cambiar horario' }, { id: botonesId.can, titulo: 'Cancelar' }];
    let r = await wa.enviarBotones(conexion, telefono, texto, botones);
    if (!(r && r.ok)) r = await wa.enviarTexto(conexion, telefono, `${texto}\n${botones.map((b) => `• ${b.titulo}`).join('\n')}`);
    if (!(r && r.ok)) return { estado: 'fallo', motivo: r && r.error };
    const registro = `${texto}\n${botones.map((b) => `• ${b.titulo}`).join('\n')}`;
    await prisma.mensaje.create({ data: { conversacionId: ultimo.conversacionId, rol: 'AGENTE', contenido: registro } }).catch(() => {});
    try { require('./realtime').emitMensaje(empresa.id, { conversacionId: ultimo.conversacionId, rol: 'AGENTE', contenido: registro, createdAt: new Date() }); } catch (_) { /* el panel se actualiza solo despues */ }
    return { estado: 'enviado', via: 'ventana' };
  }

  // Fuera de las 24 h: solo una plantilla aprobada por Meta.
  const plantilla = (empresa.configAgenda && empresa.configAgenda.plantilla) || null;
  if (!plantilla || plantilla.estado !== 'APPROVED') return { estado: 'omitido', motivo: 'sin_plantilla' };
  const r = await wa.enviarPlantilla(conexion, telefono, {
    nombre: plantilla.nombre || PLANTILLA.nombre, idioma: PLANTILLA.idioma, variables: [nombre, vocab.cita, servicio, cuando], botones: [botonesId.rok, botonesId.rep, botonesId.can],
  });
  if (!(r && r.ok)) return { estado: 'fallo', motivo: r && r.error };
  return { estado: 'enviado', via: 'plantilla' };
}

// ------------------------------------------------------------------ el barrido

let corriendo = false;

/**
 * Revisa las citas próximas y manda los recordatorios que toquen. Se llama cada pocos minutos desde el job.
 * @returns {{ revisadas, enviadas, omitidas, fallos }}
 */
async function procesar({ ahora = new Date(), deps = {} } = {}) {
  const res = { revisadas: 0, enviadas: 0, omitidas: 0, fallos: 0 };
  if (corriendo) return { ...res, ocupado: true };
  corriendo = true;
  try {
    const citas = await prisma.cita.findMany({
      where: { estado: { in: ACTIVAS }, inicio: { gt: ahora, lte: new Date(ahora.getTime() + 25 * HORA_MS) } },
      include: { cliente: true, servicio: true, empresa: true }, orderBy: { inicio: 'asc' }, take: 500,
    });
    for (const cita of citas) {
      const cfg = agendaDe(cita.empresa);
      if (!cfg.recordatorios.activo) continue;
      res.revisadas += 1;
      const { enviar, superados } = queToca(cita, cfg, ahora);
      if (!enviar) continue;
      if (enSilencio(ahora, cita.empresa.zonaHoraria)) continue; // se manda al abrir el horario
      for (const s of superados) await fijar(cita.id, s, { estado: 'omitido', motivo: 'superado', at: ahora.toISOString() });
      if (!(await reclamar(cita.id, enviar, ahora))) continue; // otro proceso lo tomó
      let r;
      try { r = await enviarUno(cita, enviar, { ahora, deps }); } catch (err) { r = { estado: 'fallo', motivo: err.message }; }
      if (r.estado === 'fallo') { await registrarFallo(cita, enviar, r.motivo, ahora); res.fallos += 1; console.error(`--- recordatorios: fallo con la cita #${cita.id} (${enviar}): ${r.motivo}`); } else {
        await fijar(cita.id, enviar, { estado: r.estado, at: ahora.toISOString(), ...(r.via ? { via: r.via } : {}), ...(r.motivo ? { motivo: r.motivo } : {}) });
        if (r.estado === 'enviado') res.enviadas += 1; else res.omitidas += 1;
      }
    }
  } finally { corriendo = false; }
  return res;
}

// ------------------------------------------------------------------ aviso cuando el NEGOCIO cancela

/**
 * Avisa al cliente que su cita fue cancelada por el negocio. Solo si escribió en las últimas 24 h (fuera de eso WhatsApp no deja
 * mandar texto libre). Devuelve { avisado, motivo? }: el panel le dice al negocio si el cliente fue avisado o no.
 */
async function avisarCancelacion(empresa, cita, { ahora = new Date(), deps = {} } = {}) {
  const wa = deps.wa || waDefecto;
  const completa = await prisma.cita.findUnique({ where: { id: cita.id }, include: { cliente: true } });
  if (!completa) return { avisado: false, motivo: 'SIN_CITA' };
  const { evaluarEnvio } = require('./avisoCarritoWeb');
  const ev = await evaluarEnvio(empresa.id, completa.cliente.telefono, ahora);
  if (!ev.ok) return { avisado: false, motivo: ev.motivo };
  const vocab = rubros.vocabularioDe(empresa);
  const m = await mensajesSrv.cargarContexto({ empresa, config: ev.agente.config, vocab });
  const texto = m.t('citas_cancelada_por_negocio', { nombre: primerNombre(completa.cliente), cuando: T.legible(completa.inicio, empresa.zonaHoraria) });
  const botones = [{ id: 'ct:agendar:0:0:1:0::', titulo: `Agendar ${vocab.cita}`.slice(0, 20) }];
  let r = await wa.enviarBotones(ev.conexion, completa.cliente.telefono, texto, botones);
  if (!(r && r.ok)) r = await wa.enviarTexto(ev.conexion, completa.cliente.telefono, texto);
  if (!(r && r.ok)) return { avisado: false, motivo: 'FALLO_DE_ENVIO' };
  if (ev.conversacionId) await prisma.mensaje.create({ data: { conversacionId: ev.conversacionId, rol: 'AGENTE', contenido: `${texto}\n• ${botones[0].titulo}` } }).catch(() => {});
  return { avisado: true };
}

// ------------------------------------------------------------------ plantilla: crear y consultar (panel)

const guardarPlantilla = async (empresa, datos) => {
  const actual = (await prisma.empresa.findUnique({ where: { id: empresa.id }, select: { configAgenda: true } })).configAgenda || {};
  const configAgenda = { ...actual, plantilla: { ...(actual.plantilla || {}), ...datos, actualizadoAt: new Date().toISOString() } };
  await prisma.empresa.update({ where: { id: empresa.id }, data: { configAgenda } });
  return configAgenda.plantilla;
};

/** Crea la plantilla en Meta (queda pendiente de aprobación). */
async function crearPlantillaEnMeta(empresa, { deps = {} } = {}) {
  const wa = deps.wa || waDefecto;
  const conexion = await conexionDe(empresa.id) || await prisma.conexionWhatsApp.findFirst({ where: { agente: { empresaId: empresa.id } } });
  if (!conexion) return { ok: false, error: 'Primero conectá tu WhatsApp.' };
  const r = await wa.crearPlantilla(conexion, definicionPlantilla());
  if (!r.ok) {
    // Si ya existía (se creó antes), se toma su estado en vez de fallar.
    if (/exist|already|duplic/i.test(String(r.error))) return actualizarEstadoPlantilla(empresa, { deps });
    return { ok: false, error: r.error };
  }
  const plantilla = await guardarPlantilla(empresa, { nombre: PLANTILLA.nombre, estado: String(r.estado || 'PENDING').toUpperCase(), motivo: null, metaId: r.id || null, creadaAt: new Date().toISOString() });
  return { ok: true, plantilla };
}

/** Consulta a Meta cómo va la aprobación. */
async function actualizarEstadoPlantilla(empresa, { deps = {} } = {}) {
  const wa = deps.wa || waDefecto;
  const conexion = await conexionDe(empresa.id) || await prisma.conexionWhatsApp.findFirst({ where: { agente: { empresaId: empresa.id } } });
  if (!conexion) return { ok: false, error: 'Primero conectá tu WhatsApp.' };
  const r = await wa.estadoPlantilla(conexion, PLANTILLA.nombre);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.estado === 'NO_EXISTE') return { ok: true, plantilla: await guardarPlantilla(empresa, { nombre: PLANTILLA.nombre, estado: 'NO_EXISTE', motivo: null }) };
  return { ok: true, plantilla: await guardarPlantilla(empresa, { nombre: PLANTILLA.nombre, estado: r.estado, motivo: r.motivo }) };
}

module.exports = {
  PLANTILLA, SILENCIO, MAX_FALLOS, definicionPlantilla, enSilencio, queToca, reclamar, enviarUno, procesar, avisarCancelacion,
  crearPlantillaEnMeta, actualizarEstadoPlantilla,
};
