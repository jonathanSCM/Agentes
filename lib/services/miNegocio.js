'use strict';
// lib/services/miNegocio.js
//
// Valida el formulario "Mi negocio" de Configuracion: que hace el negocio
// (productos o citas), su rubro, zona horaria, vocabulario y reglas de agenda,
// y como habla el agente (vos / tu). Puro: no toca la base.

const { RUBROS, PALABRAS_BASE } = require('./rubros');
const { POR_DEFECTO } = require('./configAgenda');
const { esZonaValida } = require('./tiempo');

const CAMPOS_VOCABULARIO = { vocabCita: 'cita', vocabCitas: 'citas', vocabServicio: 'servicio', vocabServicios: 'servicios', vocabProfesional: 'profesional', vocabProfesionales: 'profesionales' };

const limpiar = (s, max) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

function entero(valor, { min, max, etiqueta }, errores) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    errores.push(`${etiqueta}: tiene que ser un número entero entre ${min} y ${max}.`);
    return null;
  }
  return n;
}

/**
 * @param body    req.body del formulario
 * @param actual  la empresa actual (para no pisar lo que el formulario no manda)
 * @returns {{ empresa: object, registro: string|null, errores: string[] }}
 */
function parsearNegocio(body = {}, actual = {}) {
  const errores = [];
  const empresa = {};

  // ---- que hace el negocio
  empresa.modeloNegocio = ['PRODUCTOS', 'CITAS'].includes(body.modeloNegocio) ? body.modeloNegocio : actual.modeloNegocio || 'PRODUCTOS';

  // ---- rubro (solo ayuda a elegir palabras y datos de ejemplo)
  const rubro = limpiar(body.rubro, 30);
  empresa.rubro = rubro && RUBROS[rubro] ? rubro : null;

  // ---- zona horaria y pais
  const zona = limpiar(body.zonaHoraria, 60) || actual.zonaHoraria || 'America/La_Paz';
  if (!esZonaValida(zona)) errores.push('La zona horaria no es válida.');
  else empresa.zonaHoraria = zona;
  const pais = limpiar(body.pais, 10).toUpperCase();
  if (pais && !/^[A-Z]{2}$/.test(pais)) errores.push('El país tiene que ser un código de 2 letras (por ejemplo BO).');
  else empresa.pais = pais || null;

  // ---- vocabulario: solo se guarda lo que difiere de las palabras de su rubro
  const delRubro = { ...PALABRAS_BASE, ...(empresa.rubro ? RUBROS[empresa.rubro].vocabulario : {}) };
  const vocabulario = {};
  for (const [campo, palabra] of Object.entries(CAMPOS_VOCABULARIO)) {
    const valor = limpiar(body[campo], 40);
    if (valor && valor !== delRubro[palabra]) vocabulario[palabra] = valor;
  }
  empresa.vocabulario = vocabulario;

  // ---- reglas de agenda
  if (body.agendaIntervalo !== undefined || body.agendaDiasMaximos !== undefined) {
    const intervalo = entero(body.agendaIntervalo ?? POR_DEFECTO.intervaloMin, { min: 5, max: 240, etiqueta: 'Cada cuántos minutos ofrecer horarios' }, errores);
    const horas = entero(body.agendaAnticipacionHoras ?? 1, { min: 0, max: 24 * 14, etiqueta: 'Anticipación mínima (horas)' }, errores);
    const dias = entero(body.agendaDiasMaximos ?? POR_DEFECTO.diasMaximos, { min: 1, max: 365, etiqueta: 'Hasta cuántos días adelante se puede agendar' }, errores);
    empresa.configAgenda = {
      ...(actual.configAgenda || {}),
      ...(intervalo !== null ? { intervaloMin: intervalo } : {}),
      ...(horas !== null ? { anticipacionMin: horas * 60 } : {}),
      ...(dias !== null ? { diasMaximos: dias } : {}),
      cerrarFeriados: body.agendaCerrarFeriados === '1',
      permiteElegirRecurso: body.agendaPermiteElegir === '1',
    };
  }

  // ---- como habla el agente
  const registro = ['vos', 'tu'].includes(body.registro) ? body.registro : null;

  return { empresa, registro, errores };
}

module.exports = { parsearNegocio, CAMPOS_VOCABULARIO };
