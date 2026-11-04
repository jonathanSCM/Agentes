'use strict';
// lib/services/tiempo.js
//
// Todo el manejo de zonas horarias del modelo de citas pasa por aca (portado de
// AgendaBot). En la base las citas se guardan como instantes (UTC); el negocio y
// el cliente hablan en hora local de la zona horaria del negocio
// ("2026-10-02" + "15:30").

const { DateTime } = require('luxon');

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

/** "2026-10-02" + "15:30" en la zona del negocio -> Date (instante), o null si no es valida. */
function aInstante(fecha, hora, zona) {
  const dt = DateTime.fromISO(`${fecha}T${hora}`, { zone: zona });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Instante -> { fecha: 'YYYY-MM-DD', hora: 'HH:MM', diaSemana: 0-6 (0 = domingo) } en la zona del negocio. */
function aLocal(instante, zona) {
  const dt = DateTime.fromJSDate(new Date(instante), { zone: zona });
  return { fecha: dt.toFormat('yyyy-MM-dd'), hora: dt.toFormat('HH:mm'), diaSemana: dt.weekday % 7 };
}

const hoy = (zona) => DateTime.now().setZone(zona).toFormat('yyyy-MM-dd');
const sumarDias = (fecha, n) => DateTime.fromISO(fecha).plus({ days: n }).toFormat('yyyy-MM-dd');
const diaSemanaDe = (fecha) => DateTime.fromISO(fecha).weekday % 7;

function minutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** "jueves 2 de octubre, 15:30" para mensajes al cliente. */
function legible(instante, zona) {
  return DateTime.fromJSDate(new Date(instante), { zone: zona }).setLocale('es').toFormat("cccc d 'de' LLLL, HH:mm");
}

/** "jueves 2 de octubre" (sin hora). */
function diaLegible(fecha, zona) {
  return DateTime.fromISO(fecha, { zone: zona }).setLocale('es').toFormat("cccc d 'de' LLLL");
}

const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
const esHora = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** ¿Es una zona horaria que luxon conoce? (para validar el formulario). */
const esZonaValida = (zona) => DateTime.local().setZone(zona).isValid;

module.exports = { DIAS, DIAS_CORTOS, aInstante, aLocal, hoy, sumarDias, diaSemanaDe, minutos, hhmm, legible, diaLegible, esFecha, esHora, esZonaValida };
