'use strict';
// lib/services/posCatalogo.js
//
// Lo que el punto de venta busca en el catalogo: por nombre, SKU o CODIGO DE BARRAS (el lector USB escribe
// el codigo como un teclado y manda Enter). Si el texto coincide EXACTO con un codigo de barras o SKU,
// se devuelve ese producto/opcion listo para agregar al carrito. Todo por empresa, solo activos.

const { prisma } = require('../db');
const codigos = require('./codigosBarras');

const LIMITE = 30;
const atributosTexto = (a) => Object.values(a || {}).filter(Boolean).join(' ');

/** Stock real: si tiene opciones activas, la suma de ellas; si no, el del producto. */
function stockTotal(p) {
  const vs = (p.variantes || []).filter((v) => v.activa !== false);
  return vs.length ? vs.reduce((t, v) => t + (Number(v.stock) || 0), 0) : Number(p.stock) || 0;
}

function fichaDe(p) {
  const variantes = (p.variantes || []).filter((v) => v.activa !== false).map((v) => ({
    id: v.id, etiqueta: atributosTexto(v.atributos) || 'Única', precio: Number(v.precio !== null && v.precio !== undefined ? v.precio : p.precio),
    stock: Number(v.stock) || 0, codigoBarras: v.codigoBarras || null,
  }));
  return {
    id: p.id, nombre: p.nombre, precio: Number(p.precio), stock: stockTotal(p), sku: p.sku || null,
    foto: (p.fotos && p.fotos[0]) || null, tieneVariantes: variantes.length > 0, variantes,
  };
}

/** Una linea lista para el carrito a partir de un producto y (opcional) una opcion. */
function lineaDe(p, v = null) {
  if (v) {
    const extra = atributosTexto(v.atributos);
    return { productoId: p.id, varianteId: v.id, nombre: extra ? `${p.nombre} (${extra})` : p.nombre, precio: Number(v.precio !== null && v.precio !== undefined ? v.precio : p.precio), stock: Number(v.stock) || 0 };
  }
  return { productoId: p.id, varianteId: null, nombre: p.nombre, precio: Number(p.precio), stock: Number(p.stock) || 0 };
}

/**
 * @returns {{ exacto: object|null, productos: object[] }}  exacto = linea lista para agregar si el texto es un codigo/SKU exacto
 */
async function buscar(empresaId, texto, { limite = LIMITE } = {}) {
  const q = String(texto || '').trim().slice(0, 80);
  if (q) {
    const hallado = await codigos.buscar(empresaId, q);
    if (hallado) {
      // Si es un producto con opciones y se escaneo el del producto (sin opcion), hay que elegir la opcion.
      const conOpciones = !hallado.variante && (await prisma.variante.count({ where: { productoId: hallado.producto.id, activa: true } })) > 0;
      if (!conOpciones) {
        const exacto = lineaDe(hallado.producto, hallado.variante);
        if (exacto.stock > 0) return { exacto, productos: [] };
        return { exacto: null, productos: [], sinStock: hallado.variante ? exacto.nombre : hallado.producto.nombre };
      }
    }
  }
  const productos = await prisma.producto.findMany({
    where: {
      empresaId, activo: true,
      ...(q ? { OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }, { codigoBarras: q }] } : {}),
    },
    include: { variantes: { where: { activa: true }, orderBy: { id: 'asc' } } },
    orderBy: { nombre: 'asc' },
    take: Math.min(Number(limite) || LIMITE, 60),
  });
  return { exacto: null, productos: productos.map(fichaDe) };
}

module.exports = { stockTotal, fichaDe, lineaDe, buscar };
