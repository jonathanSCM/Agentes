'use strict';
// lib/services/configAgenda.js
//
// Reglas de la agenda de un negocio (Empresa.configAgenda) con sus valores por
// defecto, y el pais para los feriados. Puro: no toca la base.

const PAIS_POR_ZONA = {
  'America/La_Paz': 'BO',
  'America/Lima': 'PE',
  'America/Bogota': 'CO',
  'America/Santiago': 'CL',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Asuncion': 'PY',
  'America/Mexico_City': 'MX',
  'America/Guayaquil': 'EC',
  'America/Caracas': 'VE',
  'America/Montevideo': 'UY',
  'Europe/Madrid': 'ES',
};

const POR_DEFECTO = {
  intervaloMin: 30, // cada cuantos minutos arranca un horario ofrecido
  anticipacionMin: 60, // no se agenda con menos de esto de anticipacion
  diasMaximos: 60, // hasta cuantos dias adelante se puede agendar
  permiteElegirRecurso: true, // el cliente puede elegir con quien
  cerrarFeriados: true, // se cierra en los feriados nacionales
  feriadosAbiertos: [], // fechas de feriado en que SI se trabaja
};

const entero = (v, min, max, defecto) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : defecto;
};

/** Reglas completas y validas de un negocio (lo que falte o venga mal se completa con el valor por defecto). */
function agendaDe(empresa) {
  const c = (empresa && empresa.configAgenda) || {};
  return {
    intervaloMin: entero(c.intervaloMin, 5, 240, POR_DEFECTO.intervaloMin),
    anticipacionMin: entero(c.anticipacionMin, 0, 60 * 24 * 14, POR_DEFECTO.anticipacionMin),
    diasMaximos: entero(c.diasMaximos, 1, 365, POR_DEFECTO.diasMaximos),
    permiteElegirRecurso: c.permiteElegirRecurso !== false,
    cerrarFeriados: c.cerrarFeriados !== false,
    feriadosAbiertos: Array.isArray(c.feriadosAbiertos) ? c.feriadosAbiertos.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)) : [],
  };
}

/** Codigo de pais para los feriados: el que eligio el negocio o el de su zona horaria. */
function paisDe(empresa) {
  return (empresa && empresa.pais) || PAIS_POR_ZONA[empresa && empresa.zonaHoraria] || null;
}

module.exports = { agendaDe, paisDe, POR_DEFECTO, PAIS_POR_ZONA };
