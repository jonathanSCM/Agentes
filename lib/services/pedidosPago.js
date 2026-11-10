'use strict';
// lib/services/pedidosPago.js
//
// PAGO PREVIO y EDICIÓN de los pedidos que toma el bot por WhatsApp (antes de cobrarlos o entregarlos en el mostrador).
//
//   - Pago previo: el cliente eligió QR / tarjeta / transferencia. Hoy nada verifica el comprobante, así que lo CONFIRMA UNA PERSONA
//     con un botón. Un pedido con el pago confirmado no se vuelve a cobrar: en el mostrador solo se entrega (ventas.cobrarPedido).
//     El efectivo no se "confirma": se cobra en el mostrador (entra a la caja).
//   - Edición: se pueden sumar, quitar y cambiar cantidades mientras el pedido siga NUEVO o CONFIRMADO. El stock se ajusta con la diferencia
//     (el del pedido ya estaba reservado al crearlo), de forma atómica y en la misma transacción. Si el cliente ya pagó, el total no puede
//     quedar por debajo de lo pagado (la devolución de la diferencia se hace a mano, no se inventa dinero).
//   - Todo bajo el candado por empresa (el mismo de ventas y caja) y filtrado por empresa. Queda en la auditoría.

const { prisma } = require('../db');
const stockSrv = require('./stock');
const auditoria = require('./auditoria');
const { aCentavos, deCentavos } = require('./ventaCalculo');

const METODOS_PREVIOS = ['QR', 'TARJETA', 'TRANSFERENCIA'];
const ETIQUETAS = { QR: 'QR', TARJETA: 'tarjeta', TRANSFERENCIA: 'transferencia' };
const ABIERTOS = ['NUEVO', 'CONFIRMADO'];
const MAX_LINEAS = 100;
const MAX_CANTIDAD = 10000;
const MAX_TOTAL_CENTAVOS = 100000000 * 100;

class ErrorPedido extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje);
    this.codigo = 'PEDIDO';
    this.detalle = detalle;
  }
}

const atributosTexto = (a) => Object.values(a || {}).filter(Boolean).join(' ');
const actor = (u) => ({ id: u.id, rol: u.rol });

/** Cuánto pagó el cliente, cuánto falta y si ya está todo pago (en centavos: nunca decimales sueltos). */
function estadoDePago(pedido) {
  const total = aCentavos(pedido.total);
  const pagado = Math.min(aCentavos(pedido.pagadoMonto || 0), total);
  return { totalCentavos: total, pagadoCentavos: pagado, saldoCentavos: total - pagado, pagado: total > 0 && pagado >= total, parcial: pagado > 0 && pagado < total, metodo: pedido.pagoMetodo || null };
}

async function pedidoAbierto(tx, empresaId, id) {
  const pedido = await tx.pedido.findFirst({ where: { id: Number(id) || 0, empresaId }, include: { items: { orderBy: { id: 'asc' } } } });
  if (!pedido) throw new ErrorPedido('Ese pedido no existe.');
  if (!ABIERTOS.includes(pedido.estado)) throw new ErrorPedido(`Ese pedido ya está ${pedido.estado === 'ENTREGADO' ? 'entregado' : 'cancelado'}.`);
  return pedido;
}

// ------------------------------------------------------------------ pago previo

/** Confirma que el cliente ya pagó el pedido completo por QR, tarjeta o transferencia. */
async function confirmarPago(empresaId, usuario, pedidoId, metodo) {
  const m = String(metodo || '').toUpperCase();
  if (!METODOS_PREVIOS.includes(m)) throw new ErrorPedido('Elegí cómo pagó: QR, tarjeta o transferencia. El efectivo se cobra en el mostrador.');
  const pedido = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    const p = await pedidoAbierto(tx, empresaId, pedidoId);
    if (!p.items.length || aCentavos(p.total) <= 0) throw new ErrorPedido('Ese pedido no tiene nada para pagar.');
    if (aCentavos(p.pagadoMonto) > 0) throw new ErrorPedido('Ese pedido ya tiene un pago registrado.');
    // Reclamo: solo una persona lo confirma.
    const r = await tx.pedido.updateMany({ where: { id: p.id, empresaId, estado: { in: ABIERTOS }, pagadoMonto: 0 }, data: { pagadoMonto: p.total, pagoMetodo: m, pagadoAt: new Date() } });
    if (!r.count) throw new ErrorPedido('Ese pedido acaba de cambiar. Actualizá la pantalla.');
    return p;
  });
  await auditoria.registrarSinRiesgo({ empresaId, actor: actor(usuario), accion: 'PEDIDO_PAGO_CONFIRMADO', entidad: 'Pedido', entidadId: pedido.id, detalle: { total: Number(pedido.total), metodo: m } });
}

/** Deshace un pago confirmado por error (mientras el pedido siga abierto). */
async function quitarPago(empresaId, usuario, pedidoId) {
  const pedido = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    const p = await pedidoAbierto(tx, empresaId, pedidoId);
    const r = await tx.pedido.updateMany({ where: { id: p.id, empresaId, estado: { in: ABIERTOS }, pagadoMonto: { gt: 0 } }, data: { pagadoMonto: 0, pagoMetodo: null, pagadoAt: null } });
    if (!r.count) throw new ErrorPedido('Ese pedido no tenía un pago registrado.');
    return p;
  });
  await auditoria.registrarSinRiesgo({ empresaId, actor: actor(usuario), accion: 'PEDIDO_PAGO_QUITADO', entidad: 'Pedido', entidadId: pedido.id, detalle: { monto: Number(pedido.pagadoMonto), metodo: pedido.pagoMetodo } });
}

// ------------------------------------------------------------------ editar

/** Destino (producto u opción) de ESTA empresa con su precio actual. */
async function resolverNuevo(tx, empresaId, it) {
  const varianteId = it.varianteId ? Number(it.varianteId) : null;
  if (varianteId) {
    const v = await tx.variante.findFirst({ where: { id: varianteId, activa: true, producto: { empresaId, activo: true } }, include: { producto: true } });
    if (!v) throw new ErrorPedido('Uno de los productos ya no está disponible.');
    const extra = atributosTexto(v.atributos);
    return { productoId: v.productoId, varianteId: v.id, nombre: extra ? `${v.producto.nombre} (${extra})` : v.producto.nombre, precio: v.precio !== null ? v.precio : v.producto.precio };
  }
  const productoId = Number(it.productoId);
  const p = Number.isInteger(productoId) ? await tx.producto.findFirst({ where: { id: productoId, empresaId, activo: true }, include: { variantes: { where: { activa: true }, select: { id: true } } } }) : null;
  if (!p) throw new ErrorPedido('Uno de los productos ya no está disponible.');
  if (p.variantes.length) throw new ErrorPedido(`Elegí la opción de ${p.nombre} (talla, color…).`);
  return { productoId: p.id, varianteId: null, nombre: p.nombre, precio: p.precio };
}

const llaveDe = (x) => `${x.productoId || 0}:${x.varianteId || 0}`;

/**
 * Edita un pedido abierto. `cambios.items` es la lista FINAL: [{ itemId?, productoId?, varianteId?, cantidad }].
 *  - con itemId: línea que ya estaba (cantidad 0 = quitarla); sin itemId: producto nuevo (se suma si ya estaba).
 *  - lo que no aparece en la lista se quita.
 * @returns {{ pedido, totalAntes, totalDespues }}
 */
async function editar(empresaId, usuario, pedidoId, cambios = {}) {
  const lista = Array.isArray(cambios.items) ? cambios.items : [];
  if (lista.length > MAX_LINEAS) throw new ErrorPedido(`Demasiados productos (máximo ${MAX_LINEAS}).`);
  let resultado;
  try {
    resultado = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      const inicial = await pedidoAbierto(tx, empresaId, pedidoId);
      // Se toma la fila del pedido primero: una cancelación o entrega a la vez espera acá y ve el resultado ya editado.
      const toma = await tx.pedido.updateMany({ where: { id: inicial.id, empresaId, estado: { in: ABIERTOS } }, data: { total: inicial.total } });
      if (!toma.count) throw new ErrorPedido('Ese pedido acaba de cambiar. Actualizá la pantalla.');
      const pedido = await pedidoAbierto(tx, empresaId, pedidoId);
      const totalAntes = aCentavos(pedido.total);
      const porId = new Map(pedido.items.map((i) => [i.id, i]));

      // Estado final deseado por línea.
      const finales = new Map(); // llave -> { item?, destino, cantidad, precio, nombre }
      const quitar = [];
      const vistos = new Set();
      for (const it of lista) {
        const cantidad = Number(it.cantidad);
        if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > MAX_CANTIDAD) throw new ErrorPedido('La cantidad tiene que ser un número entero, 0 o más.');
        if (it.itemId) {
          const item = porId.get(Number(it.itemId));
          if (!item) throw new ErrorPedido('Una línea del pedido ya no existe. Actualizá la pantalla.');
          if (vistos.has(item.id)) throw new ErrorPedido('Una línea está repetida.');
          vistos.add(item.id);
          if (cantidad === 0) { quitar.push(item); continue; }
          if (!item.productoId && !item.varianteId && cantidad !== item.cantidad) throw new ErrorPedido(`${item.nombre} ya no está en el catálogo: solo se puede quitar.`);
          const k = item.productoId || item.varianteId ? llaveDe(item) : `linea:${item.id}`;
          const previo = finales.get(k);
          if (previo) previo.cantidad += cantidad;
          else finales.set(k, { item, productoId: item.productoId, varianteId: item.varianteId, cantidad, precio: item.precio, nombre: item.nombre });
        } else if (cantidad > 0) {
          const d = await resolverNuevo(tx, empresaId, it);
          const k = llaveDe(d);
          const previo = finales.get(k);
          if (previo) previo.cantidad += cantidad;
          else finales.set(k, { item: null, ...d, cantidad });
        }
      }
      for (const item of pedido.items) if (!vistos.has(item.id)) quitar.push(item);
      // Dos líneas existentes del mismo producto que se juntaron: la segunda se quita.
      const conservadas = new Set([...finales.values()].filter((f) => f.item).map((f) => f.item.id));
      for (const item of pedido.items) if (!conservadas.has(item.id) && !quitar.includes(item)) quitar.push(item);

      if (!finales.size) throw new ErrorPedido('Un pedido sin productos no tiene sentido: cancelalo desde Pedidos.');
      const totalDespues = [...finales.values()].reduce((t, f) => t + aCentavos(f.precio) * f.cantidad, 0);
      if (totalDespues > MAX_TOTAL_CENTAVOS) throw new ErrorPedido('El total del pedido es demasiado grande.');
      const pagado = aCentavos(pedido.pagadoMonto);
      if (pagado > totalDespues) throw new ErrorPedido(`El cliente ya pagó ${(pagado / 100).toFixed(2)}: el pedido no puede quedar en menos. Devolvé la diferencia a mano o dejá ese monto.`);

      // Stock: solo la DIFERENCIA (lo que ya tenía el pedido está reservado).
      const sube = []; const baja = [];
      const delta = new Map(); // llave -> { productoId, varianteId, d }
      const sumar = (x, d) => { if (!x.productoId && !x.varianteId) return; const k = llaveDe(x); const e = delta.get(k) || { productoId: x.productoId, varianteId: x.varianteId, d: 0 }; e.d += d; delta.set(k, e); };
      for (const item of quitar) sumar(item, -item.cantidad);
      for (const f of finales.values()) sumar(f, f.cantidad - (f.item ? f.item.cantidad : 0));
      for (const e of delta.values()) { if (e.d > 0) sube.push({ productoId: e.productoId, varianteId: e.varianteId, cantidad: e.d }); else if (e.d < 0) baja.push({ productoId: e.productoId, varianteId: e.varianteId, cantidad: -e.d }); }
      if (sube.length) await stockSrv.descontar(tx, { empresaId, lineas: sube, tipo: 'PEDIDO', referenciaTipo: 'Pedido', referenciaId: pedido.id, usuarioId: usuario.id, nota: 'Pedido editado: se agregó' });
      if (baja.length) await stockSrv.reponer(tx, { empresaId, lineas: baja, tipo: 'CANCELACION_PEDIDO', referenciaTipo: 'Pedido', referenciaId: pedido.id, usuarioId: usuario.id, nota: 'Pedido editado: se quitó' });

      if (quitar.length) await tx.pedidoItem.deleteMany({ where: { id: { in: quitar.map((q) => q.id) }, pedidoId: pedido.id } });
      for (const f of finales.values()) {
        if (f.item) { if (f.cantidad !== f.item.cantidad) await tx.pedidoItem.update({ where: { id: f.item.id }, data: { cantidad: f.cantidad } }); }
        else await tx.pedidoItem.create({ data: { pedidoId: pedido.id, productoId: f.productoId, varianteId: f.varianteId, nombre: f.nombre.slice(0, 160), precio: f.precio, cantidad: f.cantidad } });
      }
      await tx.pedido.update({ where: { id: pedido.id }, data: { total: deCentavos(totalDespues) } });
      const nuevo = await tx.pedido.findUnique({ where: { id: pedido.id }, include: { items: { orderBy: { id: 'asc' } } } });
      return { pedido: nuevo, totalAntes: totalAntes / 100, totalDespues: totalDespues / 100, quitadas: quitar.length, lineas: finales.size };
    });
  } catch (err) {
    if (err.codigo === 'STOCK') throw new ErrorPedido(err.message);
    throw err;
  }
  await auditoria.registrarSinRiesgo({ empresaId, actor: actor(usuario), accion: 'PEDIDO_EDITADO', entidad: 'Pedido', entidadId: resultado.pedido.id, detalle: { antes: resultado.totalAntes, despues: resultado.totalDespues, lineas: resultado.lineas } });
  return resultado;
}

module.exports = { ErrorPedido, METODOS_PREVIOS, ETIQUETAS, ABIERTOS, estadoDePago, confirmarPago, quitarPago, editar };
