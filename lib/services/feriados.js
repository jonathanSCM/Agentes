'use strict';
// lib/services/feriados.js
//
// Feriados nacionales desde internet (https://date.nager.at, gratis y sin clave),
// cacheados en la base. El negocio los cierra automaticamente salvo los que marque
// como "se trabaja" (configAgenda.feriadosAbiertos). Portado de AgendaBot.

const { prisma } = require('../db');
const { agendaDe, paisDe } = require('./configAgenda');

const API = 'https://date.nager.at/api/v3/PublicHolidays';
const VIGENCIA_MS = 30 * 24 * 60 * 60 * 1000; // se refresca una vez al mes

async function descargar(pais, anio) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${API}/${anio}/${pais}`, { signal: ctrl.signal });
    if (res.status === 404) return []; // pais no soportado
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lista = await res.json();
    return lista.map((f) => ({ fecha: f.date, nombre: f.localName || f.name, regional: f.global === false }));
  } finally {
    clearTimeout(t);
  }
}

/** { feriados, error }. Si internet falla se usa el cache aunque este viejo (nunca bloquea la agenda). */
async function feriadosDelAnio(pais, anio) {
  if (!pais) return { feriados: [], error: null };
  const cache = await prisma.feriadoCache.findUnique({ where: { pais_anio: { pais, anio } } });
  if (cache && Date.now() - cache.actualizadoEn.getTime() < VIGENCIA_MS) return { feriados: cache.datos, error: null };
  try {
    const feriados = await descargar(pais, anio);
    await prisma.feriadoCache.upsert({
      where: { pais_anio: { pais, anio } },
      update: { datos: feriados, actualizadoEn: new Date() },
      create: { pais, anio, datos: feriados },
    });
    return { feriados, error: null };
  } catch (err) {
    console.warn(`[feriados] no se pudo descargar ${pais}/${anio}: ${err.message}`);
    return { feriados: (cache && cache.datos) || [], error: 'No se pudieron actualizar los feriados desde internet.' };
  }
}

/** Fechas (YYYY-MM-DD) en que el negocio cierra por feriado nacional dentro del rango. */
async function fechasCerradas(empresa, desde, hasta) {
  const cfg = agendaDe(empresa);
  if (!cfg.cerrarFeriados || process.env.FERIADOS_OFFLINE) return new Set();
  const pais = paisDe(empresa);
  const abiertos = new Set(cfg.feriadosAbiertos);
  const cerradas = new Set();
  for (let anio = Number(desde.slice(0, 4)); anio <= Number(hasta.slice(0, 4)); anio += 1) {
    const { feriados } = await feriadosDelAnio(pais, anio);
    for (const f of feriados) {
      if (!f.regional && f.fecha >= desde && f.fecha <= hasta && !abiertos.has(f.fecha)) cerradas.add(f.fecha);
    }
  }
  return cerradas;
}

module.exports = { feriadosDelAnio, fechasCerradas };
