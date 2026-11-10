'use strict';
// lib/services/calendarioCitas.js
//
// CALENDARIO de citas (semana, mes y día): lo que ve un PROFESIONAL con sus citas, y el negocio con "Calendario" (todas o las de
// una persona). Todo se calcula en la zona horaria del negocio y por empresa. Piezas puras (`distribuir`, `rangoDe`) para probarlas
// sin base de datos.
//   - Las citas CANCELADAS no se muestran (liberan el horario); las demás sí, con su estado.
//   - Las que se superponen (capacidad mayor a 1, o dos recursos) se reparten lado a lado dentro del día.
//   - La grilla arranca a las 8:00 y termina a las 20:00 como mínimo, y se amplía si el horario del negocio o alguna cita salen de ese rango.

const { DateTime } = require('luxon');
const { prisma } = require('../db');
const T = require('./tiempo');

const HORA_MIN_POR_DEFECTO = 8;
const HORA_MAX_POR_DEFECTO = 20;
const VISTAS = ['semana', 'mes', 'dia'];
const NOMBRES_DIA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

const dt = (fecha, zona) => DateTime.fromISO(fecha, { zone: zona });
const aFecha = (d) => d.toFormat('yyyy-MM-dd');
const minutosDelDia = (instante, zona) => { const d = DateTime.fromJSDate(instante, { zone: zona }); return d.hour * 60 + d.minute; };

/** Lunes de la semana de una fecha. */
function lunesDe(fecha, zona = 'UTC') {
  const d = dt(fecha, zona);
  return aFecha(d.minus({ days: d.weekday - 1 }));
}

/**
 * Rango visible de una vista: desde (incluido) y hasta (excluido) en fechas 'YYYY-MM-DD', más las fechas de cada día.
 * semana: lunes a domingo · mes: las semanas completas que cubren el mes · dia: un solo día.
 */
function rangoDe(vista, fecha, zona = 'UTC') {
  const v = VISTAS.includes(vista) ? vista : 'semana';
  if (v === 'dia') return { vista: v, fecha, desde: fecha, hasta: T.sumarDias(fecha, 1), dias: [fecha] };
  if (v === 'semana') {
    const lunes = lunesDe(fecha, zona);
    const dias = Array.from({ length: 7 }, (_, i) => T.sumarDias(lunes, i));
    return { vista: v, fecha, desde: lunes, hasta: T.sumarDias(lunes, 7), dias };
  }
  const primero = dt(fecha, zona).startOf('month');
  const ultimo = primero.endOf('month');
  const desde = lunesDe(aFecha(primero), zona);
  const finLunes = lunesDe(aFecha(ultimo), zona);
  const hasta = T.sumarDias(finLunes, 7);
  const dias = [];
  for (let f = desde; f < hasta; f = T.sumarDias(f, 1)) dias.push(f);
  return { vista: v, fecha, desde, hasta, dias, mes: primero.toFormat('yyyy-MM') };
}

/**
 * Reparte las citas de UN día que se superponen: a cada una le asigna columna (`col`) y cuántas columnas tiene su grupo (`cols`),
 * para dibujarlas lado a lado. Cada cita trae `inicioMin` y `finMin` (minutos desde medianoche).
 */
function distribuir(citas) {
  const orden = [...citas].sort((a, b) => a.inicioMin - b.inicioMin || a.finMin - b.finMin);
  const salida = [];
  let grupo = []; let finGrupo = -1;
  const cerrar = () => {
    const cols = grupo.reduce((m, c) => Math.max(m, c.col + 1), 1);
    for (const c of grupo) salida.push({ ...c, cols });
    grupo = [];
  };
  const columnas = []; // fin de la ultima cita de cada columna del grupo actual
  for (const c of orden) {
    if (grupo.length && c.inicioMin >= finGrupo) { cerrar(); columnas.length = 0; finGrupo = -1; }
    let col = columnas.findIndex((fin) => fin <= c.inicioMin);
    if (col === -1) { col = columnas.length; columnas.push(c.finMin); } else columnas[col] = c.finMin;
    grupo.push({ ...c, col });
    finGrupo = Math.max(finGrupo, c.finMin);
  }
  if (grupo.length) cerrar();
  return salida;
}

/** Citas de un rango de fechas, ya en forma de "eventos" del calendario. `recursoId` limita a UNA persona. */
async function eventos(empresa, desde, hasta, { recursoId = null } = {}) {
  const zona = empresa.zonaHoraria;
  const citas = await prisma.cita.findMany({
    where: {
      empresaId: empresa.id, estado: { not: 'CANCELADA' },
      inicio: { gte: T.aInstante(desde, '00:00', zona), lt: T.aInstante(hasta, '00:00', zona) },
      ...(recursoId ? { recursoId } : {}),
    },
    include: { cliente: { select: { nombre: true, nombrePerfil: true, telefono: true } }, servicio: { select: { nombre: true, color: true } }, recurso: { select: { nombre: true, color: true } } },
    orderBy: [{ inicio: 'asc' }, { id: 'asc' }],
  });
  return citas.map((c) => {
    const inicioMin = minutosDelDia(c.inicio, zona);
    const finMin = Math.max(inicioMin + 15, minutosDelDia(c.fin, zona) || inicioMin + 15);
    return {
      id: c.id, fecha: DateTime.fromJSDate(c.inicio, { zone: zona }).toFormat('yyyy-MM-dd'), inicioMin, finMin,
      hora: DateTime.fromJSDate(c.inicio, { zone: zona }).toFormat('HH:mm'), horaFin: DateTime.fromJSDate(c.fin, { zone: zona }).toFormat('HH:mm'),
      estado: c.estado, personas: c.personas, notas: c.notas, origen: c.origen,
      cliente: c.cliente.nombre || c.cliente.nombrePerfil || 'Cliente sin nombre', telefono: c.cliente.telefono,
      servicio: c.servicio ? c.servicio.nombre : 'Servicio eliminado', recurso: c.recurso ? c.recurso.nombre : null,
      color: (c.recurso && c.recurso.color) || (c.servicio && c.servicio.color) || null,
      confirmo: Boolean(c.recordatorios && c.recordatorios.confirmada),
      yaEmpezo: c.inicio.getTime() <= Date.now(),
      puedeCerrar: c.estado === 'CONFIRMADA' && c.inicio.getTime() <= Date.now(),
    };
  });
}

/** Horas de la grilla: de 8:00 a 20:00, ampliadas si el horario del negocio o alguna cita salen de ahí. */
async function ventanaDeHoras(empresa, evs, { recursoId = null } = {}) {
  const horarios = await prisma.horarioAtencion.findMany({ where: { empresaId: empresa.id, OR: [{ recursoId: null }, ...(recursoId ? [{ recursoId }] : [])] } });
  const aMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  let min = HORA_MIN_POR_DEFECTO * 60; let max = HORA_MAX_POR_DEFECTO * 60;
  for (const h of horarios) { min = Math.min(min, aMin(h.horaInicio)); max = Math.max(max, aMin(h.horaFin)); }
  for (const e of evs) { min = Math.min(min, e.inicioMin); max = Math.max(max, e.finMin); }
  return { desde: Math.floor(min / 60), hasta: Math.min(24, Math.ceil(max / 60)) };
}

/**
 * Calendario completo de una vista, listo para dibujar.
 * @returns {{ rango, ventana, dias: Array<{ fecha, etiqueta, numero, esHoy, delMes, eventos, total }>, semanas?: string[][] }}
 */
async function calendario(empresa, vista, fecha, { recursoId = null } = {}) {
  const zona = empresa.zonaHoraria;
  const hoy = T.hoy(zona);
  const base = T.esFecha(fecha) ? fecha : hoy;
  const rango = rangoDe(vista, base, zona);
  const evs = await eventos(empresa, rango.desde, rango.hasta, { recursoId });
  const ventana = await ventanaDeHoras(empresa, evs, { recursoId });
  const porDia = new Map(rango.dias.map((f) => [f, []]));
  for (const e of evs) if (porDia.has(e.fecha)) porDia.get(e.fecha).push(e);
  const dias = rango.dias.map((f) => {
    const d = dt(f, zona);
    const lista = distribuir(porDia.get(f) || []);
    return {
      fecha: f, etiqueta: NOMBRES_DIA[d.weekday % 7], numero: d.day, esHoy: f === hoy, delMes: !rango.mes || f.slice(0, 7) === rango.mes,
      eventos: lista, total: lista.length,
    };
  });
  const semanas = rango.vista === 'mes' ? Array.from({ length: dias.length / 7 }, (_, i) => dias.slice(i * 7, i * 7 + 7)) : null;
  return { rango, ventana, dias, semanas, hoy };
}

/** Texto del periodo: "9 – 15 de noviembre de 2026", "noviembre de 2026", "lunes 9 de noviembre". */
function tituloDe(rango, zona) {
  const f = (s, fmt) => dt(s, zona).setLocale('es').toFormat(fmt);
  if (rango.vista === 'dia') return f(rango.fecha, "cccc d 'de' LLLL 'de' yyyy");
  if (rango.vista === 'mes') return f(rango.fecha, "LLLL 'de' yyyy");
  const ini = dt(rango.desde, zona); const fin = dt(T.sumarDias(rango.hasta, -1), zona);
  return ini.month === fin.month ? `${ini.day} – ${fin.day} de ${ini.setLocale('es').toFormat('LLLL')} de ${ini.year}` : `${ini.day} ${ini.setLocale('es').toFormat('LLL')} – ${fin.day} ${fin.setLocale('es').toFormat('LLL')} de ${fin.year}`;
}

/** Fecha a la que lleva "anterior" y "siguiente" en cada vista. */
function vecinas(vista, fecha, zona) {
  const d = dt(fecha, zona);
  if (vista === 'mes') return { anterior: aFecha(d.minus({ months: 1 })), siguiente: aFecha(d.plus({ months: 1 })) };
  if (vista === 'dia') return { anterior: T.sumarDias(fecha, -1), siguiente: T.sumarDias(fecha, 1) };
  return { anterior: T.sumarDias(fecha, -7), siguiente: T.sumarDias(fecha, 7) };
}

module.exports = { VISTAS, HORA_MIN_POR_DEFECTO, HORA_MAX_POR_DEFECTO, lunesDe, rangoDe, distribuir, eventos, ventanaDeHoras, calendario, tituloDe, vecinas };
