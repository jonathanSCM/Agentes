'use strict';
// lib/services/reservaPublica.js
//
// PÁGINA PÚBLICA DE RESERVAS (/reservar/:slug, docs/09 fase 3). Cualquiera puede reservar sin login, así que acá
// vive todo lo que protege al negocio:
//   - Los horarios y cupos salen SOLO del motor de agenda (agenda.js): la web no decide si hay lugar.
//   - La misma persona del bot y de la web es una sola: se identifica por su teléfono (con código de país), igual que
//     en WhatsApp. Un cliente que ya existe NO cambia de nombre por lo que alguien escriba en la web.
//   - Anti abuso: honeypot, límite de reservas activas por teléfono, y (en las rutas) límite por IP.
//   - La confirmación y la cancelación se abren con un token firmado: no se pueden adivinar ni enumerar.
//   - Solo negocios de CITAS con la reserva web activada y el plan en regla.

const crypto = require('crypto');
const { prisma } = require('../db');
const agenda = require('./agenda');
const { agendaDe } = require('./configAgenda');
const planes = require('./planesCliente');
const T = require('./tiempo');

const MAX_ACTIVAS_POR_TELEFONO = 3;
const SECRETO = process.env.APP_ENCRYPTION_KEY || 'clave-de-desarrollo-cambia-esto-en-produccion';

// Código de país por zona horaria (el que se ofrece por defecto en el formulario).
const CODIGO_POR_ZONA = {
  'America/La_Paz': '591', 'America/Lima': '51', 'America/Bogota': '57', 'America/Santiago': '56', 'America/Argentina/Buenos_Aires': '54',
  'America/Asuncion': '595', 'America/Mexico_City': '52', 'America/Guayaquil': '593', 'America/Caracas': '58', 'America/Montevideo': '598', 'Europe/Madrid': '34',
};
const PAISES = [
  { codigo: '591', nombre: 'Bolivia (+591)' }, { codigo: '51', nombre: 'Perú (+51)' }, { codigo: '57', nombre: 'Colombia (+57)' },
  { codigo: '56', nombre: 'Chile (+56)' }, { codigo: '54', nombre: 'Argentina (+54)' }, { codigo: '595', nombre: 'Paraguay (+595)' },
  { codigo: '598', nombre: 'Uruguay (+598)' }, { codigo: '593', nombre: 'Ecuador (+593)' }, { codigo: '58', nombre: 'Venezuela (+58)' },
  { codigo: '52', nombre: 'México (+52)' }, { codigo: '34', nombre: 'España (+34)' }, { codigo: '1', nombre: 'EE. UU. / Canadá (+1)' }, { codigo: '55', nombre: 'Brasil (+55)' },
];

class ErrorReserva extends Error {
  constructor(mensaje, codigo = 'RESERVA') { super(mensaje); this.codigo = codigo; }
}

// ------------------------------------------------------------------ datos de entrada

/** Teléfono completo de WhatsApp (solo dígitos) a partir del código de país y el número local. */
function normalizarTelefono(codigo, numero) {
  const cod = String(codigo || '').replace(/\D/g, '');
  if (!PAISES.some((p) => p.codigo === cod)) throw new ErrorReserva('Elegí el código de tu país.');
  let local = String(numero || '').replace(/\D/g, '');
  // Si ya escribió el código de país delante, no se repite; el 0 inicial local sobra.
  if (local.startsWith(cod) && local.length > cod.length + 6) local = local.slice(cod.length);
  local = local.replace(/^0+/, '');
  const completo = `${cod}${local}`;
  if (local.length < 7 || local.length > 12 || completo.length > 15) throw new ErrorReserva('Revisá tu número de WhatsApp: parece incompleto.');
  return completo;
}

/** Nombre de persona: de 2 a 60 caracteres, solo letras, espacios, guion y apóstrofe. */
function nombreValido(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 60) return null;
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'’\- .]+$/.test(t)) return null;
  if (t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '').length < 2) return null;
  return t;
}

// ------------------------------------------------------------------ token de la confirmación

const firma = (id, telefono) => crypto.createHmac('sha256', SECRETO).update(`reserva:${id}:${telefono}`).digest('base64url').slice(0, 24);
/** Token que abre la confirmación (y permite cancelar) de UNA cita: ligado a su id y a su teléfono. */
const tokenDeCita = (cita, telefono) => firma(cita.id, telefono);
function tokenValido(token, citaId, telefono) {
  const esperado = firma(citaId, telefono);
  const t = String(token || '');
  if (t.length !== esperado.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(esperado));
}

// ------------------------------------------------------------------ negocio disponible

/**
 * El negocio con todo lo que necesita la página, o un motivo si no se puede reservar:
 * 'NO_EXISTE' | 'NO_ES_DE_CITAS' | 'DESACTIVADA' | 'PLAN'.
 */
async function negocioParaReservar(slug) {
  const empresa = await prisma.empresa.findUnique({ where: { slug: String(slug || '').slice(0, 80) } });
  if (!empresa) return { motivo: 'NO_EXISTE' };
  if (empresa.modeloNegocio !== 'CITAS') return { motivo: 'NO_ES_DE_CITAS' };
  const cfg = agendaDe(empresa);
  if (!cfg.reservaPublica) return { motivo: 'DESACTIVADA', empresa };
  const valores = await planes.valoresDe(empresa.id);
  if (!valores.vigencia.puedeUsarAgente) return { motivo: 'PLAN', empresa };
  const agente = await prisma.agente.findFirst({ where: { empresaId: empresa.id }, include: { config: true, conexion: true } });
  return { empresa, cfg, config: agente ? agente.config : null, conexion: agente ? agente.conexion : null };
}

const codigoPorDefecto = (empresa) => CODIGO_POR_ZONA[empresa.zonaHoraria] || '591';

// ------------------------------------------------------------------ reservar y cancelar

/**
 * Crea la reserva. `datos`: { servicioId, recursoId, personas, fecha, hora, nombre, codigo, telefono }.
 * Devuelve { cita, telefono, cliente }. Errores de negocio: ErrorReserva (mensaje listo para mostrar) o ErrorAgenda del motor.
 */
async function reservar(empresa, datos) {
  const nombre = nombreValido(datos.nombre);
  if (!nombre) throw new ErrorReserva('Escribí tu nombre (por ejemplo: Ana Pérez).');
  const telefono = normalizarTelefono(datos.codigo, datos.telefono);
  if (!T.esFecha(datos.fecha) || !T.esHora(datos.hora)) throw new ErrorReserva('El horario elegido no es válido. Elegí otro.');
  const personas = Math.max(1, Math.min(50, Number(datos.personas) || 1));

  const activas = await prisma.cita.count({
    where: { empresaId: empresa.id, estado: { in: ['PENDIENTE', 'CONFIRMADA'] }, inicio: { gt: new Date() }, cliente: { telefono } },
  });
  if (activas >= MAX_ACTIVAS_POR_TELEFONO) {
    throw new ErrorReserva(`Ya tenés ${MAX_ACTIVAS_POR_TELEFONO} reservas pendientes con este número. Para agendar otra, cancelá una o escribinos por WhatsApp.`, 'LIMITE_TELEFONO');
  }

  // El cliente es el mismo que el de WhatsApp (mismo teléfono): si ya tenía nombre, no se pisa.
  const existente = await prisma.clienteFinal.findUnique({ where: { empresaId_telefono: { empresaId: empresa.id, telefono } } });
  const cliente = existente || await prisma.clienteFinal.create({ data: { empresaId: empresa.id, telefono, nombre } });
  if (existente && !existente.nombre) await prisma.clienteFinal.update({ where: { id: existente.id }, data: { nombre } });
  const nota = existente && existente.nombre && existente.nombre.toLowerCase() !== nombre.toLowerCase() ? `Reservó desde la web como "${nombre}"` : null;

  const cita = await agenda.crearCita(empresa, {
    clienteId: cliente.id, servicioId: Number(datos.servicioId), recursoId: Number(datos.recursoId) || undefined,
    fecha: datos.fecha, hora: datos.hora, personas, origen: 'web', notas: nota,
  });
  await prisma.notificacion.create({
    data: {
      empresaId: empresa.id, titulo: 'Reserva nueva desde la web',
      mensaje: `${existente && existente.nombre ? existente.nombre : nombre} (+${telefono}): ${T.legible(cita.inicio, empresa.zonaHoraria)}.`, tipo: 'MANUAL',
    },
  }).catch(() => {});
  return { cita, telefono, cliente };
}

/** La cita de una confirmación, solo si el token corresponde a su id y teléfono y es de esa empresa. */
async function citaConToken(empresaId, citaId, token) {
  const cita = await prisma.cita.findFirst({
    where: { id: Number(citaId) || 0, empresaId, origen: 'web' },
    include: { servicio: true, recurso: true, cliente: true },
  });
  if (!cita || !tokenValido(token, cita.id, cita.cliente.telefono)) return null;
  return cita;
}

/** Cancela desde la confirmación (el cliente, con su token). Solo citas activas que todavía no empezaron. */
async function cancelarConToken(empresa, citaId, token) {
  const cita = await citaConToken(empresa.id, citaId, token);
  if (!cita) throw new ErrorReserva('No encontramos esa reserva.', 'NO_EXISTE');
  if (!['PENDIENTE', 'CONFIRMADA'].includes(cita.estado)) throw new ErrorReserva('Esa reserva ya no está activa.', 'INACTIVA');
  if (cita.inicio.getTime() <= Date.now()) throw new ErrorReserva('Esa reserva ya empezó: no se puede cancelar por acá.', 'YA_EMPEZO');
  const r = await prisma.cita.updateMany({ where: { id: cita.id, empresaId: empresa.id, estado: { in: ['PENDIENTE', 'CONFIRMADA'] } }, data: { estado: 'CANCELADA' } });
  if (r.count === 0) throw new ErrorReserva('Esa reserva ya no está activa.', 'INACTIVA');
  await prisma.notificacion.create({
    data: {
      empresaId: empresa.id, titulo: 'Reserva cancelada por el cliente (web)',
      mensaje: `${cita.cliente.nombre || cita.cliente.telefono}: ${cita.servicio ? cita.servicio.nombre : ''}, ${T.legible(cita.inicio, empresa.zonaHoraria)}.`, tipo: 'MANUAL',
    },
  }).catch(() => {});
  return cita;
}

module.exports = {
  MAX_ACTIVAS_POR_TELEFONO, PAISES, ErrorReserva, normalizarTelefono, nombreValido, tokenDeCita, tokenValido,
  negocioParaReservar, codigoPorDefecto, reservar, citaConToken, cancelarConToken,
};
