'use strict';
// lib/services/atencion.js
//
// Validacion y guardado de lo que el negocio de CITAS configura en su panel:
// servicios, equipo (personas o recursos), horarios de atencion y bloqueos.
// Las funciones validar* son puras (devuelven { datos, errores }); las demas
// escriben en la base SIEMPRE filtrando por empresa.

const { prisma } = require('../db');
const T = require('./tiempo');
const limites = require('./limitesCitas');

const limpiar = (s, max) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '').trim()) ? String(v).trim() : null);

function entero(valor, { min, max }) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// ------------------------------------------------------------------ servicios

function validarServicio(body = {}) {
  const errores = [];
  const nombre = limpiar(body.nombre, 80);
  if (!nombre) errores.push('Poné el nombre del servicio.');
  const duracionMin = entero(body.duracionMin, { min: 5, max: 720 });
  if (duracionMin === null) errores.push('La duración tiene que ser un número de minutos entre 5 y 720.');
  const bufferMin = entero(body.bufferMin === '' || body.bufferMin === undefined ? 0 : body.bufferMin, { min: 0, max: 240 });
  if (bufferMin === null) errores.push('El tiempo de descanso tiene que ser entre 0 y 240 minutos.');
  let precio = null;
  if (body.precio !== undefined && String(body.precio).trim() !== '') {
    precio = Number(String(body.precio).replace(',', '.'));
    if (!Number.isFinite(precio) || precio < 0 || precio > 9999999) { errores.push('El precio no es válido.'); precio = null; }
  }
  const usaPersonas = body.usaPersonas === '1' || body.usaPersonas === 'on';
  let maxPersonas = null;
  if (usaPersonas) {
    maxPersonas = entero(body.maxPersonas === '' || body.maxPersonas === undefined ? 12 : body.maxPersonas, { min: 1, max: 500 });
    if (maxPersonas === null) errores.push('El máximo de personas por reserva tiene que ser entre 1 y 500.');
  }
  return {
    errores,
    datos: { nombre, descripcion: limpiar(body.descripcion, 300) || null, duracionMin, bufferMin, precio, usaPersonas, maxPersonas, color: hex(body.color) },
  };
}

/** Crea el servicio respetando el tope del plan. @throws Error con .codigo = 'TOPE_SERVICIOS' */
async function crearServicio(empresaId, datos) {
  const tope = await limites.puedeCrearServicio(empresaId);
  if (!tope.ok) {
    const e = new Error(`Tu plan permite ${tope.tope} servicios y ya tenés ${tope.usados}. Mejorá tu plan para agregar más.`);
    e.codigo = 'TOPE_SERVICIOS';
    throw e;
  }
  const orden = await prisma.servicio.count({ where: { empresaId } });
  const creado = await prisma.servicio.create({ data: { empresaId, orden, ...datos } });
  limites.revisarAvisos(empresaId, 'servicios');
  return creado;
}

async function actualizarServicio(empresaId, id, datos) {
  const r = await prisma.servicio.updateMany({ where: { id, empresaId }, data: datos });
  if (!r.count) throw new Error('Ese servicio no existe.');
}

/** Activa o desactiva. Activar vuelve a contar para el tope del plan. */
async function cambiarActivoServicio(empresaId, id, activo) {
  if (activo) {
    const tope = await limites.puedeCrearServicio(empresaId);
    if (!tope.ok) {
      const e = new Error(`Tu plan permite ${tope.tope} servicios activos y ya tenés ${tope.usados}.`);
      e.codigo = 'TOPE_SERVICIOS';
      throw e;
    }
  }
  const r = await prisma.servicio.updateMany({ where: { id, empresaId }, data: { activo } });
  if (!r.count) throw new Error('Ese servicio no existe.');
}

/** Borra solo si nunca se agendo con el (si no, hay que desactivarlo para no perder el historial). */
async function eliminarServicio(empresaId, id) {
  const citas = await prisma.cita.count({ where: { empresaId, servicioId: id } });
  if (citas) {
    const e = new Error('Ese servicio ya tiene citas en el historial: desactivalo en vez de borrarlo.');
    e.codigo = 'CON_HISTORIAL';
    throw e;
  }
  await prisma.servicio.deleteMany({ where: { id, empresaId } });
}

// --------------------------------------------------------------------- equipo

function validarRecurso(body = {}) {
  const errores = [];
  const nombre = limpiar(body.nombre, 80);
  if (!nombre) errores.push('Poné el nombre.');
  const tipo = body.tipo === 'recurso' ? 'recurso' : 'persona';
  const capacidad = entero(body.capacidad === '' || body.capacidad === undefined ? 1 : body.capacidad, { min: 1, max: 500 });
  if (capacidad === null) errores.push('La capacidad tiene que ser un número entre 1 y 500.');
  return { errores, datos: { nombre, tipo, especialidad: limpiar(body.especialidad, 80) || null, capacidad, color: hex(body.color) } };
}

const idsDe = (v) => [...new Set([].concat(v === undefined ? [] : v).map(Number).filter(Number.isInteger))];

/** Que servicios atiende (vacio = todos). Solo acepta servicios de ESTA empresa. */
async function guardarServiciosDelRecurso(empresaId, recursoId, serviciosIds) {
  const validos = (await prisma.servicio.findMany({ where: { empresaId, id: { in: idsDe(serviciosIds) } }, select: { id: true } })).map((s) => s.id);
  await prisma.$transaction([
    prisma.recursoServicio.deleteMany({ where: { recursoId } }),
    ...(validos.length ? [prisma.recursoServicio.createMany({ data: validos.map((servicioId) => ({ recursoId, servicioId })) })] : []),
  ]);
}

async function crearRecurso(empresaId, datos, serviciosIds) {
  const r = await prisma.recurso.create({ data: { empresaId, ...datos } });
  await guardarServiciosDelRecurso(empresaId, r.id, serviciosIds);
  return r;
}

async function actualizarRecurso(empresaId, id, datos, serviciosIds) {
  const r = await prisma.recurso.updateMany({ where: { id, empresaId }, data: datos });
  if (!r.count) throw new Error('Esa persona o recurso no existe.');
  if (serviciosIds !== undefined) await guardarServiciosDelRecurso(empresaId, id, serviciosIds);
}

async function eliminarRecurso(empresaId, id) {
  const citas = await prisma.cita.count({ where: { empresaId, recursoId: id } });
  if (citas) {
    const e = new Error('Ya tiene citas en el historial: desactivalo en vez de borrarlo.');
    e.codigo = 'CON_HISTORIAL';
    throw e;
  }
  await prisma.recurso.deleteMany({ where: { id, empresaId } });
}

// ------------------------------------------------------------------- horarios

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Lee el horario semanal del formulario: por cada dia 0-6 los campos repetidos
 * ini{dia} / fin{dia} (un par por tramo; varios tramos = turno partido).
 * @returns {{ filas: Array<{diaSemana,horaInicio,horaFin}>, errores: string[] }}
 */
function parsearHorarioSemana(body = {}, prefijo = '') {
  const errores = [];
  const filas = [];
  const nombres = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  for (let dia = 0; dia <= 6; dia += 1) {
    const ini = [].concat(body[`${prefijo}ini${dia}`] === undefined ? [] : body[`${prefijo}ini${dia}`]);
    const fin = [].concat(body[`${prefijo}fin${dia}`] === undefined ? [] : body[`${prefijo}fin${dia}`]);
    const tramos = [];
    for (let i = 0; i < Math.max(ini.length, fin.length); i += 1) {
      const a = limpiar(ini[i], 5); const b = limpiar(fin[i], 5);
      if (!a && !b) continue;
      if (!HORA.test(a) || !HORA.test(b)) { errores.push(`El ${nombres[dia]} tiene una hora inválida.`); continue; }
      if (a >= b) { errores.push(`El ${nombres[dia]}: la hora de cierre (${b}) tiene que ser después de la de apertura (${a}).`); continue; }
      tramos.push({ diaSemana: dia, horaInicio: a, horaFin: b });
    }
    tramos.sort((x, y) => (x.horaInicio < y.horaInicio ? -1 : 1));
    for (let i = 1; i < tramos.length; i += 1) {
      if (tramos[i].horaInicio < tramos[i - 1].horaFin) { errores.push(`El ${nombres[dia]} tiene horarios que se pisan.`); break; }
    }
    filas.push(...tramos);
  }
  return { filas, errores };
}

/** Reemplaza el horario de un recurso (o el general si recursoId es null). */
async function guardarHorario(empresaId, recursoId, filas) {
  if (recursoId) {
    const existe = await prisma.recurso.count({ where: { id: recursoId, empresaId } });
    if (!existe) throw new Error('Esa persona o recurso no existe.');
  }
  await prisma.$transaction([
    prisma.horarioAtencion.deleteMany({ where: { empresaId, recursoId: recursoId || null } }),
    ...(filas.length ? [prisma.horarioAtencion.createMany({ data: filas.map((f) => ({ empresaId, recursoId: recursoId || null, ...f })) })] : []),
  ]);
}

// ------------------------------------------------------------------- bloqueos

/**
 * Vacaciones, cierres o ausencias. Con fechas (desde/hasta) y, opcionalmente, horas:
 * sin horas bloquea los dias completos. Se interpreta en la zona horaria del negocio.
 */
function validarBloqueo(body = {}, zona = 'America/La_Paz') {
  const errores = [];
  const desde = limpiar(body.fechaDesde, 10);
  const hasta = limpiar(body.fechaHasta, 10) || desde;
  if (!T.esFecha(desde) || !T.esFecha(hasta)) errores.push('Elegí las fechas del cierre.');
  const horaDesde = limpiar(body.horaDesde, 5); const horaHasta = limpiar(body.horaHasta, 5);
  if ((horaDesde && !HORA.test(horaDesde)) || (horaHasta && !HORA.test(horaHasta))) errores.push('Las horas no son válidas.');
  let inicio = null; let fin = null;
  if (!errores.length) {
    inicio = T.aInstante(desde, horaDesde || '00:00', zona);
    fin = horaHasta ? T.aInstante(hasta, horaHasta, zona) : T.aInstante(T.sumarDias(hasta, 1), '00:00', zona);
    if (!inicio || !fin || fin <= inicio) errores.push('El cierre tiene que terminar después de empezar.');
  }
  return { errores, datos: { inicio, fin, motivo: limpiar(body.motivo, 120) || null, recursoId: entero(body.recursoId, { min: 1, max: 2147483647 }) } };
}

async function crearBloqueo(empresaId, { inicio, fin, motivo, recursoId }) {
  if (recursoId && !(await prisma.recurso.count({ where: { id: recursoId, empresaId } }))) throw new Error('Esa persona o recurso no existe.');
  return prisma.bloqueoAgenda.create({ data: { empresaId, inicio, fin, motivo, recursoId: recursoId || null } });
}

const eliminarBloqueo = (empresaId, id) => prisma.bloqueoAgenda.deleteMany({ where: { id, empresaId } });

module.exports = {
  validarServicio, crearServicio, actualizarServicio, cambiarActivoServicio, eliminarServicio,
  validarRecurso, crearRecurso, actualizarRecurso, eliminarRecurso, guardarServiciosDelRecurso,
  parsearHorarioSemana, guardarHorario, validarBloqueo, crearBloqueo, eliminarBloqueo,
};
