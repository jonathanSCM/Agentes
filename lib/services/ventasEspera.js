'use strict';
// lib/services/ventasEspera.js
//
// VENTAS EN ESPERA (POS pulido): el cajero deja un carrito guardado ("el cliente fue a buscar la plata") y atiende a otro;
// después lo retoma, incluso desde otro equipo. Reglas:
//   - Una venta en espera NO toca el stock ni la caja: es solo una lista de lo que se quiere llevar.
//   - Los PRECIOS no se guardan: al retomar se leen de nuevo de la base (si cambiaron, vale el precio de hoy), y la cantidad se ajusta al
//     stock que hay en ese momento (se avisa). Lo que ya no existe o se desactivó se avisa y se saca.
//   - Retomar la BORRA de forma atómica: dos cajeros tocando "Retomar" a la vez no se llevan la misma venta dos veces.
//   - Máximo 10 por negocio y vencen a los 3 días (para que el listado no se llene de carritos olvidados).

const { prisma } = require('../db');
const V = require('./ventaCalculo');
const { lineaDe } = require('./posCatalogo');

const { ErrorVenta } = V;
const MAX_EN_ESPERA = 10;
const VENCE_DIAS = 3;

/** Borra las vencidas de este negocio (se llama al listar y al guardar). */
const limpiarVencidas = (empresaId, ahora = new Date()) => prisma.ventaEspera.deleteMany({ where: { empresaId, createdAt: { lt: new Date(ahora.getTime() - VENCE_DIAS * 86400000) } } });

/**
 * Guarda el carrito actual. `datos`: { lineas:[{productoId, varianteId?, cantidad, descuento?}], descuento?, clienteId?, clienteNombre?, etiqueta? }
 * Las líneas se validan contra la base (que sean de ESTE negocio) pero NO se comprueba el stock: es solo una reserva de intención.
 */
async function guardar(empresaId, usuario, datos) {
  if (!Array.isArray(datos.lineas) || !datos.lineas.length) throw new ErrorVenta('No hay nada para dejar en espera.');
  if (datos.lineas.length > V.MAX_LINEAS) throw new ErrorVenta(`Demasiados productos (máximo ${V.MAX_LINEAS}).`);
  const lineas = [];
  for (const l of datos.lineas) {
    const cantidad = Number(l.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > V.MAX_CANTIDAD) throw new ErrorVenta('Una de las cantidades no es válida.');
    const varianteId = l.varianteId ? Number(l.varianteId) : null;
    const ok = varianteId
      ? await prisma.variante.findFirst({ where: { id: varianteId, producto: { empresaId } }, select: { id: true } })
      : await prisma.producto.findFirst({ where: { id: Number(l.productoId), empresaId }, select: { id: true } });
    if (!ok) throw new ErrorVenta('Un producto de la venta no existe.');
    const descuento = l.descuento === undefined || l.descuento === '' || l.descuento === null ? 0 : Number(l.descuento);
    if (!Number.isFinite(descuento) || descuento < 0) throw new ErrorVenta('Un descuento no es válido.');
    lineas.push({ productoId: varianteId ? Number((await prisma.variante.findUnique({ where: { id: varianteId }, select: { productoId: true } })).productoId) : Number(l.productoId), varianteId, cantidad, descuento });
  }
  const descuentoGlobal = datos.descuento === undefined || datos.descuento === '' || datos.descuento === null ? 0 : Number(datos.descuento);
  if (!Number.isFinite(descuentoGlobal) || descuentoGlobal < 0) throw new ErrorVenta('El descuento no es válido.');
  let clienteId = null;
  if (datos.clienteId) {
    const c = await prisma.clienteFinal.findFirst({ where: { id: Number(datos.clienteId), empresaId }, select: { id: true } });
    if (c) clienteId = c.id;
  }
  await limpiarVencidas(empresaId);
  // Se cuenta y se crea en una transacción con bloqueo del negocio: dos cajeros guardando a la vez no pasan el tope.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    if ((await tx.ventaEspera.count({ where: { empresaId } })) >= MAX_EN_ESPERA) {
      throw new ErrorVenta(`Ya hay ${MAX_EN_ESPERA} ventas en espera. Retomá o borrá alguna antes de dejar otra.`);
    }
    return tx.ventaEspera.create({
      data: {
        empresaId, usuarioId: usuario.id, etiqueta: datos.etiqueta ? String(datos.etiqueta).trim().slice(0, 40) || null : null,
        lineas, descuento: descuentoGlobal, clienteId, clienteNombre: datos.clienteNombre ? String(datos.clienteNombre).trim().slice(0, 80) || null : null,
      },
    });
  });
}

/** Lista de ventas en espera (las más viejas primero), con cuántos productos y el total aproximado de hoy. */
async function listar(empresaId) {
  await limpiarVencidas(empresaId);
  const filas = await prisma.ventaEspera.findMany({ where: { empresaId }, orderBy: { id: 'asc' } });
  const usuarios = await prisma.usuario.findMany({ where: { id: { in: filas.map((f) => f.usuarioId).filter(Boolean) } }, select: { id: true, nombre: true } });
  const nombres = new Map(usuarios.map((u) => [u.id, u.nombre]));
  return filas.map((f) => ({
    id: f.id, etiqueta: f.etiqueta, clienteNombre: f.clienteNombre, creadaAt: f.createdAt, por: nombres.get(f.usuarioId) || null,
    productos: f.lineas.reduce((n, l) => n + l.cantidad, 0), lineas: f.lineas.length,
  }));
}

/**
 * Retoma una venta en espera: la devuelve como líneas listas para el carrito (precio y stock de HOY) y la borra.
 * @returns {{ lineas, descuento, clienteId, clienteNombre, etiqueta, avisos: string[] }}
 */
async function retomar(empresaId, id) {
  // Reclamo atómico: solo uno se la lleva.
  const fila = await prisma.$transaction(async (tx) => {
    const f = await tx.ventaEspera.findFirst({ where: { id: Number(id) || 0, empresaId } });
    if (!f) return null;
    const borradas = await tx.ventaEspera.deleteMany({ where: { id: f.id, empresaId } });
    return borradas.count === 1 ? f : null;
  });
  if (!fila) throw new ErrorVenta('Esa venta en espera ya no está (alguien la retomó o venció).');

  const lineas = []; const avisos = [];
  for (const l of fila.lineas) {
    let p; let v = null;
    if (l.varianteId) {
      v = await prisma.variante.findFirst({ where: { id: l.varianteId, activa: true, producto: { empresaId, activo: true } }, include: { producto: true } });
      p = v && v.producto;
    } else {
      p = await prisma.producto.findFirst({ where: { id: l.productoId, empresaId, activo: true }, include: { variantes: { where: { activa: true }, select: { id: true } } } });
      if (p && p.variantes.length) p = null; // ahora tiene opciones: hay que elegirla de nuevo
    }
    if (!p) { avisos.push('Un producto ya no está disponible y se sacó de la venta.'); continue; }
    const linea = lineaDe(p, v);
    if (linea.stock <= 0) { avisos.push(`"${linea.nombre}" ya no tiene stock y se sacó.`); continue; }
    const cantidad = Math.min(l.cantidad, linea.stock);
    if (cantidad < l.cantidad) avisos.push(`De "${linea.nombre}" solo quedan ${linea.stock} (tenías ${l.cantidad}).`);
    lineas.push({ ...linea, cantidad });
  }
  return { lineas, descuento: Number(fila.descuento), clienteId: fila.clienteId, clienteNombre: fila.clienteNombre, etiqueta: fila.etiqueta, avisos };
}

/** Borra una venta en espera (sin retomarla). */
async function eliminar(empresaId, id) {
  const r = await prisma.ventaEspera.deleteMany({ where: { id: Number(id) || 0, empresaId } });
  if (r.count === 0) throw new ErrorVenta('Esa venta en espera ya no está.');
}

module.exports = { MAX_EN_ESPERA, VENCE_DIAS, guardar, listar, retomar, eliminar, limpiarVencidas };
