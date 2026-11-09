'use strict';
// lib/services/codigosBarras.js
//
// Codigos de barras de productos y variantes (lector del punto de venta, docs/11).
// Un codigo identifica UNA cosa vendible dentro de la empresa: no puede repetirse entre productos ni variantes.
// Los lectores USB escriben el codigo como si fuera un teclado: se busca por texto exacto.

const { prisma } = require('../db');

const MAX_LARGO = 60;

/** Deja el codigo listo para guardar: sin espacios, sin caracteres de control, o null si esta vacio. */
function normalizar(valor) {
  const t = String(valor === undefined || valor === null ? '' : valor).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LARGO);
  return t || null;
}

/**
 * Devuelve un texto de error si el codigo ya lo usa otro producto o variante de la empresa; si no, null.
 * `excluir` permite editar sin chocar contra uno mismo.
 */
async function duplicado(empresaId, codigo, { excluirProductoId = null, excluirVarianteId = null } = {}) {
  const c = normalizar(codigo);
  if (!c) return null;
  const producto = await prisma.producto.findFirst({
    where: { empresaId, codigoBarras: c, ...(excluirProductoId ? { id: { not: Number(excluirProductoId) } } : {}) },
    select: { nombre: true },
  });
  if (producto) return `El código de barras ${c} ya lo usa "${producto.nombre}".`;
  const variante = await prisma.variante.findFirst({
    where: { codigoBarras: c, producto: { empresaId }, ...(excluirVarianteId ? { id: { not: Number(excluirVarianteId) } } : {}) },
    include: { producto: { select: { nombre: true } } },
  });
  if (variante) return `El código de barras ${c} ya lo usa "${variante.producto.nombre}" (otra opción).`;
  return null;
}

/** Busca lo que corresponde a un codigo escaneado (por codigo de barras o por SKU exacto). */
async function buscar(empresaId, codigo) {
  const c = normalizar(codigo);
  if (!c) return null;
  const variante = await prisma.variante.findFirst({
    where: { activa: true, producto: { empresaId, activo: true }, OR: [{ codigoBarras: c }, { sku: c }] },
    include: { producto: true },
  });
  if (variante) return { producto: variante.producto, variante };
  const producto = await prisma.producto.findFirst({ where: { empresaId, activo: true, OR: [{ codigoBarras: c }, { sku: c }] } });
  return producto ? { producto, variante: null } : null;
}

module.exports = { MAX_LARGO, normalizar, duplicado, buscar };
