'use strict';
// lib/services/stock.js
//
// STOCK UNIFICADO (docs/11 F4): el bot, el mostrador y el panel descuentan del MISMO stock, y todo
// cambio queda en el historial (movimientos_stock).
//
// Reglas (aprendidas de una auditoria de la barbería: sobreventa por carrera, cantidades raras):
//   - El descuento es ATOMICO y CONDICIONADO: UPDATE ... WHERE stock >= cantidad. Si dos ventas
//     compiten por la ultima unidad, una sola pasa; la otra recibe ErrorStock. Nunca "leer, restar
//     en memoria y escribir".
//   - Todo corre dentro de la transaccion del que llama (tx): si algo falla, no queda nada a medias.
//   - Las lineas se procesan en orden fijo (evita deadlocks entre dos pedidos con los mismos productos).
//   - Cantidades enteras, mayores a 0 y con tope. Todo filtrado por empresa.
//   - La base ademas rechaza stock negativo (CHECK): red de seguridad si un camino de codigo falla.

const { prisma } = require('../db');

const TIPOS = ['INICIAL', 'PEDIDO', 'CANCELACION_PEDIDO', 'AJUSTE', 'IMPORTACION', 'VENTA', 'ANULACION_VENTA', 'DEVOLUCION_VENTA', 'COMPRA'];
const MAX_CANTIDAD = 100000;
const MAX_LINEAS = 100;

const ETIQUETAS = {
  INICIAL: 'Stock inicial', PEDIDO: 'Pedido de WhatsApp', CANCELACION_PEDIDO: 'Pedido cancelado', AJUSTE: 'Ajuste manual',
  IMPORTACION: 'Importación', VENTA: 'Venta en mostrador', ANULACION_VENTA: 'Venta anulada', DEVOLUCION_VENTA: 'Devolución', COMPRA: 'Compra a proveedor',
};

class ErrorStock extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje);
    this.codigo = 'STOCK';
    this.detalle = detalle;
  }
}

function validarLineas(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) throw new ErrorStock('No hay productos para mover.');
  if (lineas.length > MAX_LINEAS) throw new ErrorStock(`Demasiadas líneas (máximo ${MAX_LINEAS}).`);
  return lineas.map((l) => {
    const cantidad = Number(l.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > MAX_CANTIDAD) throw new ErrorStock('La cantidad tiene que ser un número entero mayor a 0.');
    const productoId = Number(l.productoId);
    const varianteId = l.varianteId ? Number(l.varianteId) : null;
    if (!Number.isInteger(productoId) && !Number.isInteger(varianteId)) throw new ErrorStock('Falta el producto.');
    return { productoId: Number.isInteger(productoId) ? productoId : null, varianteId, cantidad };
  }).sort((a, b) => (a.varianteId || 0) - (b.varianteId || 0) || (a.productoId || 0) - (b.productoId || 0));
}

const atributosTexto = (a) => Object.values(a || {}).filter(Boolean).join(' ');

/** Busca el producto/variante de ESTA empresa. Devuelve { productoId, varianteId, nombre, stock }. */
async function resolver(tx, empresaId, l) {
  if (l.varianteId) {
    const v = await tx.variante.findFirst({ where: { id: l.varianteId, producto: { empresaId } }, include: { producto: { select: { id: true, nombre: true } } } });
    if (!v) throw new ErrorStock('Ese producto no existe.', { varianteId: l.varianteId });
    const extra = atributosTexto(v.atributos);
    return { productoId: v.productoId, varianteId: v.id, nombre: extra ? `${v.producto.nombre} (${extra})` : v.producto.nombre, stock: v.stock };
  }
  const p = await tx.producto.findFirst({ where: { id: l.productoId, empresaId } });
  if (!p) throw new ErrorStock('Ese producto no existe.', { productoId: l.productoId });
  return { productoId: p.id, varianteId: null, nombre: p.nombre, stock: p.stock };
}

async function stockActual(tx, destino) {
  const fila = destino.varianteId
    ? await tx.variante.findUnique({ where: { id: destino.varianteId }, select: { stock: true } })
    : await tx.producto.findUnique({ where: { id: destino.productoId }, select: { stock: true } });
  return fila ? fila.stock : 0;
}

async function registrar(tx, { empresaId, destino, tipo, cantidad, stockAntes, stockDespues, referenciaTipo = null, referenciaId = null, usuarioId = null, nota = null }) {
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo de movimiento desconocido: ${tipo}`);
  return tx.movimientoStock.create({
    data: {
      empresaId, productoId: destino.productoId, varianteId: destino.varianteId, nombre: destino.nombre, tipo, cantidad,
      stockAntes, stockDespues, referenciaTipo, referenciaId, usuarioId, nota: nota ? String(nota).slice(0, 300) : null,
    },
  });
}

/**
 * Descuenta stock de forma atomica. Lanza ErrorStock (y el que llama deshace su transaccion) si alguna
 * linea no alcanza. `lineas`: [{ productoId, varianteId?, cantidad }].
 */
async function descontar(tx, { empresaId, lineas, tipo = 'PEDIDO', referenciaTipo = null, referenciaId = null, usuarioId = null, nota = null }) {
  const movimientos = [];
  for (const l of validarLineas(lineas)) {
    const destino = await resolver(tx, empresaId, l);
    const r = destino.varianteId
      ? await tx.variante.updateMany({ where: { id: destino.varianteId, stock: { gte: l.cantidad } }, data: { stock: { decrement: l.cantidad } } })
      : await tx.producto.updateMany({ where: { id: destino.productoId, empresaId, stock: { gte: l.cantidad } }, data: { stock: { decrement: l.cantidad } } });
    if (r.count === 0) {
      const disponible = await stockActual(tx, destino);
      throw new ErrorStock(`No hay stock suficiente de ${destino.nombre}: quedan ${disponible}.`, { ...destino, pedido: l.cantidad, disponible });
    }
    const despues = await stockActual(tx, destino);
    movimientos.push(await registrar(tx, { empresaId, destino, tipo, cantidad: -l.cantidad, stockAntes: despues + l.cantidad, stockDespues: despues, referenciaTipo, referenciaId, usuarioId, nota }));
  }
  return movimientos;
}

/** Devuelve stock (cancelacion, anulacion, devolucion). */
async function reponer(tx, { empresaId, lineas, tipo = 'CANCELACION_PEDIDO', referenciaTipo = null, referenciaId = null, usuarioId = null, nota = null }) {
  const movimientos = [];
  for (const l of validarLineas(lineas)) {
    const destino = await resolver(tx, empresaId, l);
    if (destino.varianteId) await tx.variante.update({ where: { id: destino.varianteId }, data: { stock: { increment: l.cantidad } } });
    else await tx.producto.update({ where: { id: destino.productoId }, data: { stock: { increment: l.cantidad } } });
    const despues = await stockActual(tx, destino);
    movimientos.push(await registrar(tx, { empresaId, destino, tipo, cantidad: l.cantidad, stockAntes: despues - l.cantidad, stockDespues: despues, referenciaTipo, referenciaId, usuarioId, nota }));
  }
  return movimientos;
}

/**
 * Deja el stock en un valor exacto (ajuste manual, importacion, stock inicial). Registra la diferencia;
 * si no cambia, no registra nada. Devuelve el movimiento o null.
 */
async function fijar(tx, { empresaId, productoId, varianteId = null, stock, tipo = 'AJUSTE', referenciaTipo = null, referenciaId = null, usuarioId = null, nota = null }) {
  const nuevo = Number(stock);
  if (!Number.isInteger(nuevo) || nuevo < 0 || nuevo > 10000000) throw new ErrorStock('El stock tiene que ser un número entero, 0 o más.');
  const destino = await resolver(tx, empresaId, { productoId, varianteId });
  const antes = destino.stock;
  if (nuevo === antes) return null;
  if (destino.varianteId) await tx.variante.update({ where: { id: destino.varianteId }, data: { stock: nuevo } });
  else await tx.producto.update({ where: { id: destino.productoId }, data: { stock: nuevo } });
  return registrar(tx, { empresaId, destino, tipo, cantidad: nuevo - antes, stockAntes: antes, stockDespues: nuevo, referenciaTipo, referenciaId, usuarioId, nota });
}

/** Registra el stock con el que nace un producto/variante (ya guardado en su alta). */
async function registrarInicial(tx, { empresaId, productoId, varianteId = null, usuarioId = null, nota = null }) {
  const destino = await resolver(tx, empresaId, { productoId, varianteId });
  if (!destino.stock) return null;
  return registrar(tx, { empresaId, destino, tipo: 'INICIAL', cantidad: destino.stock, stockAntes: 0, stockDespues: destino.stock, usuarioId, nota });
}

/**
 * Registra el stock inicial de un producto recien creado y de sus variantes con stock que todavia no
 * tienen ningun movimiento (se puede llamar varias veces: no duplica).
 */
async function registrarInicialDeProducto(tx, { empresaId, productoId, usuarioId = null }) {
  const p = await tx.producto.findFirst({ where: { id: productoId, empresaId }, include: { variantes: true } });
  if (!p) return [];
  const hechos = [];
  const yaTiene = async (varianteId) => (await tx.movimientoStock.count({ where: { productoId: p.id, varianteId } })) > 0;
  if (p.stock > 0 && !(await yaTiene(null))) hechos.push(await registrarInicial(tx, { empresaId, productoId: p.id, usuarioId }));
  for (const v of p.variantes) {
    if (v.stock > 0 && !(await yaTiene(v.id))) hechos.push(await registrarInicial(tx, { empresaId, productoId: p.id, varianteId: v.id, usuarioId }));
  }
  return hechos.filter(Boolean);
}

/** Historial (kardex) de la empresa, mas nuevo primero. */
async function listarMovimientos(empresaId, { productoId = null, tipo = null, limite = 100, desde = null } = {}) {
  return prisma.movimientoStock.findMany({
    where: {
      empresaId,
      ...(productoId ? { productoId: Number(productoId) } : {}),
      ...(tipo && TIPOS.includes(tipo) ? { tipo } : {}),
      ...(desde ? { createdAt: { gte: desde } } : {}),
    },
    include: { usuario: { select: { nombre: true } } },
    orderBy: { id: 'desc' },
    take: Math.min(Number(limite) || 100, 500),
  });
}

module.exports = { ErrorStock, TIPOS, ETIQUETAS, MAX_CANTIDAD, descontar, reponer, fijar, registrarInicial, registrarInicialDeProducto, listarMovimientos };
