'use strict';
// lib/services/tarifasIA.js
//
// TARIFAS DE IA VERSIONADAS (directrices de IA, 2.9-B): el costo de cada solicitud se calcula con la tarifa vigente EN SU FECHA, guardada en la
// tabla `tarifas_ia` (USD por millón de tokens), no con valores escritos en el código. Cambiar un precio cierra la tarifa anterior y abre una nueva:
// el costo de lo ya registrado no se mueve.
//
// El costo es una ESTIMACIÓN (se contrasta con la factura del proveedor aparte). Un modelo sin tarifa devuelve null: no se inventa un importe.

const { prisma } = require('../db');

const TTL_MS = 60 * 1000;
const cache = new Map(); // clave -> { t, hasta }

class ErrorTarifa extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'TARIFA'; }
}

const clave = (proveedor, modelo, servicio) => `${proveedor}|${modelo}|${servicio}`;
const aNumero = (v) => (v === null || v === undefined ? 0 : Number(v));

function limpiarCache() { cache.clear(); }

/**
 * Tarifa vigente de un modelo en una fecha (por defecto, ahora). Con fecha pasada no usa la caché (puede ser otra tarifa).
 * @returns {Promise<object|null>}
 */
async function vigente({ proveedor, modelo, servicio = 'chat', fecha = null }, db = prisma) {
  if (!proveedor || !modelo) return null;
  const ahora = Date.now();
  const esAhora = !fecha || Math.abs(new Date(fecha).getTime() - ahora) < 5000;
  const k = clave(proveedor, modelo, servicio);
  if (esAhora) {
    const c = cache.get(k);
    if (c && c.hasta > ahora) return c.t;
  }
  const f = fecha ? new Date(fecha) : new Date();
  const t = await db.tarifaIA.findFirst({
    where: { proveedor, modelo, servicio, vigenteDesde: { lte: f }, OR: [{ vigenteHasta: null }, { vigenteHasta: { gt: f } }] },
    orderBy: { vigenteDesde: 'desc' },
  });
  if (esAhora) cache.set(k, { t, hasta: ahora + TTL_MS });
  return t;
}

/** Costo en USD de un uso con una tarifa. Los tokens de caché se cobran con su tarifa; entrada = prompt - caché. */
function costo(tarifa, { promptTokens = 0, cachedTokens = 0, completionTokens = 0 } = {}) {
  if (!tarifa) return null;
  const sinCache = Math.max(0, promptTokens - cachedTokens);
  const usd = (sinCache * aNumero(tarifa.entradaUsdPorM) + cachedTokens * aNumero(tarifa.cacheUsdPorM) + completionTokens * aNumero(tarifa.salidaUsdPorM)) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6; // 6 decimales, como la columna
}

const valida = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100000;

/**
 * Cambia el precio de un modelo: cierra la tarifa vigente (a `desde`) y abre la nueva. `desde` no puede ser anterior al comienzo de la vigente.
 * @param {{ proveedor, modelo, servicio?, entradaUsdPorM, cacheUsdPorM?, salidaUsdPorM, desde?, nota? }} datos
 */
async function cambiar(datos, db = prisma) {
  const proveedor = String(datos.proveedor || '').trim().toLowerCase();
  const modelo = String(datos.modelo || '').trim();
  const servicio = String(datos.servicio || 'chat').trim().toLowerCase();
  if (!proveedor || !modelo) throw new ErrorTarifa('Indicá el proveedor y el modelo.');
  if (!valida(datos.entradaUsdPorM) || !valida(datos.salidaUsdPorM)) throw new ErrorTarifa('Los precios de entrada y de salida tienen que ser números de 0 o más (USD por millón de tokens).');
  const entrada = Number(datos.entradaUsdPorM);
  const salida = Number(datos.salidaUsdPorM);
  const cache_ = datos.cacheUsdPorM === '' || datos.cacheUsdPorM === undefined || datos.cacheUsdPorM === null ? entrada : Number(datos.cacheUsdPorM);
  if (!valida(cache_)) throw new ErrorTarifa('El precio de la entrada cacheada tiene que ser un número de 0 o más.');
  const desde = datos.desde ? new Date(datos.desde) : new Date();
  if (Number.isNaN(desde.getTime())) throw new ErrorTarifa('La fecha de vigencia no es válida.');

  const nueva = await db.$transaction(async (tx) => {
    const actual = await tx.tarifaIA.findFirst({ where: { proveedor, modelo, servicio, vigenteHasta: null }, orderBy: { vigenteDesde: 'desc' } });
    if (actual) {
      if (desde <= actual.vigenteDesde) throw new ErrorTarifa('La nueva tarifa tiene que empezar después de la que está vigente.');
      await tx.tarifaIA.update({ where: { id: actual.id }, data: { vigenteHasta: desde } });
    }
    return tx.tarifaIA.create({ data: { proveedor, modelo, servicio, entradaUsdPorM: entrada, cacheUsdPorM: cache_, salidaUsdPorM: salida, vigenteDesde: desde, nota: datos.nota ? String(datos.nota).slice(0, 200) : null } });
  });
  limpiarCache();
  return nueva;
}

async function listar(db = prisma) {
  return db.tarifaIA.findMany({ orderBy: [{ proveedor: 'asc' }, { modelo: 'asc' }, { servicio: 'asc' }, { vigenteDesde: 'desc' }] });
}

module.exports = { ErrorTarifa, vigente, costo, cambiar, listar, limpiarCache };
