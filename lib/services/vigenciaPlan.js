'use strict';
// lib/services/vigenciaPlan.js
//
// Reglas de FECHAS de un plan, sin base de datos (se prueban solas).
// Docs: docs/11-plan-planes-pos-panel-y-rediseno.md §11.1
//
//   - La duracion se elige en meses (1, 2, 3, 6, 12) o con una fecha personalizada.
//   - Las conversaciones incluidas se reinician cada mes, el mismo dia en que empezo el plan.
//   - Con fecha de fin: 7 dias antes "por vencer"; al vencer hay 5 dias de gracia con todo
//     funcionando; pasada la gracia se corta el agente (el panel y el POS siguen).
//   - Renovar suma meses a la fecha de fin (si ya vencio, cuenta desde hoy).
//   - Avisos de corte: 7 dias antes, 2 dias antes y el mismo dia. Avisos de uso: 80 % y 95 %.
//
// Todas las fechas se manejan en UTC: el "dia" de un plan no depende del servidor.

const DIA_MS = 24 * 60 * 60 * 1000;
const DURACIONES_MESES = [1, 2, 3, 6, 12];
const POR_VENCER_DIAS = 7;
const GRACIA_DIAS = 5;
const AVISOS_CORTE = [7, 2, 0]; // dias antes del corte (0 = el mismo dia)
const AVISOS_USO = [80, 95];

const aFecha = (d) => (d instanceof Date ? d : new Date(d));

/** Suma `n` meses; si el dia no existe en el mes destino queda en el ultimo (31 ene + 1 mes = 28/29 feb). */
function sumarMeses(fecha, n) {
  const f = aFecha(fecha);
  const dia = f.getUTCDate();
  const r = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + n, 1, f.getUTCHours(), f.getUTCMinutes(), f.getUTCSeconds(), f.getUTCMilliseconds()));
  const ultimo = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(dia, ultimo));
  return r;
}

/** Fin de un plan: por meses o por una fecha personalizada (que debe ser posterior al inicio). */
function calcularFin({ desde, meses = null, fechaPersonalizada = null }) {
  const inicio = aFecha(desde);
  if (fechaPersonalizada) {
    const fin = aFecha(fechaPersonalizada);
    if (Number.isNaN(fin.getTime())) throw new Error('La fecha de fin no es valida.');
    if (fin <= inicio) throw new Error('La fecha de fin tiene que ser posterior al inicio.');
    return fin;
  }
  if (!DURACIONES_MESES.includes(Number(meses))) throw new Error('Elegi 1, 2, 3, 6 o 12 meses, o una fecha personalizada.');
  return sumarMeses(inicio, Number(meses));
}

/** Renovar: suma meses al fin actual; si ya vencio, desde `ahora`. */
function renovarFin({ planFin, meses, ahora = new Date() }) {
  if (!DURACIONES_MESES.includes(Number(meses))) throw new Error('Elegi 1, 2, 3, 6 o 12 meses.');
  const fin = planFin ? aFecha(planFin) : null;
  const base = fin && fin > aFecha(ahora) ? fin : aFecha(ahora);
  return sumarMeses(base, Number(meses));
}

/**
 * Ventana mensual de conversaciones vigente: desde el ultimo "aniversario mensual" del inicio
 * del plan hasta el siguiente. Si todavia no empezo, devuelve el primer mes.
 */
function periodoMensual(inicio, ahora = new Date()) {
  const ini = aFecha(inicio);
  const hoy = aFecha(ahora);
  if (hoy < ini) return { desde: ini, hasta: sumarMeses(ini, 1) };
  let meses = (hoy.getUTCFullYear() - ini.getUTCFullYear()) * 12 + (hoy.getUTCMonth() - ini.getUTCMonth());
  let desde = sumarMeses(ini, meses);
  if (desde > hoy) { meses -= 1; desde = sumarMeses(ini, meses); }
  return { desde, hasta: sumarMeses(ini, meses + 1) };
}

/**
 * Estado por fecha. `planFin` null = sin vencimiento (plan "a medida" o acceso total).
 * @returns {{ estado: 'SIN_FIN'|'VIGENTE'|'POR_VENCER'|'GRACIA'|'VENCIDO', diasRestantes: number|null, graciaHasta: Date|null, puedeUsarAgente: boolean }}
 */
function estadoVigencia({ planFin, ahora = new Date(), graciaDias = GRACIA_DIAS, porVencerDias = POR_VENCER_DIAS }) {
  if (!planFin) return { estado: 'SIN_FIN', diasRestantes: null, graciaHasta: null, puedeUsarAgente: true };
  const fin = aFecha(planFin);
  const hoy = aFecha(ahora);
  const diasRestantes = Math.ceil((fin.getTime() - hoy.getTime()) / DIA_MS);
  const graciaHasta = new Date(fin.getTime() + graciaDias * DIA_MS);
  if (hoy < fin) {
    return { estado: diasRestantes <= porVencerDias ? 'POR_VENCER' : 'VIGENTE', diasRestantes, graciaHasta, puedeUsarAgente: true };
  }
  if (hoy < graciaHasta) return { estado: 'GRACIA', diasRestantes, graciaHasta, puedeUsarAgente: true };
  return { estado: 'VENCIDO', diasRestantes, graciaHasta, puedeUsarAgente: false };
}

/**
 * Avisos de corte que corresponde mandar ahora y todavia no se mandaron.
 * `enviados` = lista de claves ya enviadas para ESTE fin de plan (ej. ['corte7']).
 * Cada aviso se manda una sola vez; si el job no corrio un dia, sale el mas urgente y los
 * anteriores quedan marcados (no se mandan tres avisos juntos).
 */
function avisosDeCorte({ planFin, ahora = new Date(), enviados = [] }) {
  if (!planFin) return [];
  // Dias de CALENDARIO (UTC): "el mismo dia" es el dia del corte, antes o despues de la hora exacta.
  const diaUTC = (d) => Math.floor(aFecha(d).getTime() / DIA_MS);
  const diasRestantes = diaUTC(planFin) - diaUTC(ahora);
  if (diasRestantes < 0) return [];
  const aplicables = AVISOS_CORTE.filter((d) => diasRestantes <= d);
  if (!aplicables.length) return [];
  const masUrgente = Math.min(...aplicables);
  const clave = `corte${masUrgente}`;
  if (enviados.includes(clave)) return [];
  return [{ clave, diasAntes: masUrgente, diasRestantes, marcar: aplicables.map((d) => `corte${d}`) }];
}

/** Avisos de uso de conversaciones (80 % y 95 %); igual criterio: el mas alto alcanzado, una sola vez. */
function avisosDeUso({ usadas, total, enviados = [] }) {
  if (!total || total <= 0) return [];
  const pct = (usadas / total) * 100;
  const alcanzados = AVISOS_USO.filter((p) => pct >= p);
  if (!alcanzados.length) return [];
  const masAlto = Math.max(...alcanzados);
  const clave = `uso${masAlto}`;
  if (enviados.includes(clave)) return [];
  return [{ clave, porcentaje: masAlto, usadas, total, marcar: alcanzados.map((p) => `uso${p}`) }];
}

module.exports = {
  DURACIONES_MESES, POR_VENCER_DIAS, GRACIA_DIAS, AVISOS_CORTE, AVISOS_USO,
  sumarMeses, calcularFin, renovarFin, periodoMensual, estadoVigencia, avisosDeCorte, avisosDeUso,
};
