'use strict';
// lib/services/cuentas.js
//
// CUENTAS: lo que consume un cliente en el local se junta en UNA cuenta y se cobra de una vez. Sirve para
//   - la CITA: se abre la cuenta con el servicio reservado, y en el local se le suman otros servicios o productos;
//   - el que llega sin cita (cuenta suelta con su nombre).
// (Modelo tomado del POS de la barbería: una cuenta es una "venta abierta" que se va armando y se cobra al final.)
//
// Reglas:
//   - Una cuenta NO toca stock ni caja hasta cobrarla. Al agregar un producto solo se valida que alcance; el descuento atómico
//     y condicionado ocurre al cobrar, en la misma transacción que crea la venta (si ya no alcanza, no se cobra nada).
//   - Los precios se guardan al agregar (si el catálogo cambia después, la cuenta no se mueve). El servidor recalcula el total al cobrar.
//   - Una cita tiene como mucho UNA cuenta viva (índice único en la base): dos personas que la abren a la vez no la duplican.
//   - Cobrar "reclama" la cuenta (ABIERTA → COBRADA) de forma atómica: no se cobra dos veces; idempotente por clave.
//   - Al cobrar, la cita pasa a COMPLETADA. Todo por empresa; el candado por empresa es el mismo de ventas, caja y compras.

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { prisma } = require('../db');
const stockSrv = require('./stock');
const auditoria = require('./auditoria');
const { sesionAbierta } = require('./caja');
const V = require('./ventaCalculo');
const T = require('./tiempo');

const { ErrorVenta } = V;
const MAX_LINEAS = 60;
const MAX_CANTIDAD = 1000;
const ESTADOS_CITA_COBRABLES = ['PENDIENTE', 'CONFIRMADA', 'COMPLETADA'];

class ErrorCuenta extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje);
    this.codigo = 'CUENTA';
    this.detalle = detalle;
  }
}

const atributosTexto = (a) => Object.values(a || {}).filter(Boolean).join(' ');
const nuevoToken = () => crypto.randomBytes(16).toString('base64url');
const codigoDe = (id) => `CU-${String(id).padStart(4, '0')}`;
const incluirItems = { items: { orderBy: { id: 'asc' } } };

const nombreLimpio = (v) => { const t = String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 80); return t || null; };
const cantidadValida = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_CANTIDAD) throw new ErrorCuenta('La cantidad tiene que ser un número entero mayor a 0.');
  return n;
};

async function cuentaAbierta(tx, empresaId, id) {
  const c = await tx.cuenta.findFirst({ where: { id: Number(id) || 0, empresaId }, include: incluirItems });
  if (!c) throw new ErrorCuenta('Esa cuenta no existe.');
  if (c.estado !== 'ABIERTA') throw new ErrorCuenta(`Esa cuenta ya está ${c.estado === 'COBRADA' ? 'cobrada' : 'cancelada'}.`);
  return c;
}
const total = (items) => items.reduce((t, i) => t + V.aCentavos(i.precioUnitario) * i.cantidad, 0);

// ------------------------------------------------------------------ abrir

/** Abre (o devuelve) la cuenta de una cita, con su servicio ya cargado. */
async function abrirDeCita(empresaId, usuario, citaId) {
  const existente = (estado) => prisma.cuenta.findFirst({ where: { empresaId, citaId: Number(citaId) || 0, estado } });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      const cita = await tx.cita.findFirst({ where: { id: Number(citaId) || 0, empresaId }, include: { servicio: true, cliente: { select: { id: true, nombre: true, nombrePerfil: true, telefono: true } } } });
      if (!cita) throw new ErrorCuenta('Esa cita no existe.');
      const viva = await tx.cuenta.findFirst({ where: { empresaId, citaId: cita.id, estado: { in: ['ABIERTA', 'COBRADA'] } } });
      if (viva) {
        if (viva.estado === 'COBRADA') throw new ErrorCuenta('Esa cita ya fue cobrada.');
        return viva;
      }
      if (!ESTADOS_CITA_COBRABLES.includes(cita.estado)) throw new ErrorCuenta('No se puede abrir la cuenta de una cita cancelada o a la que no vino.');
      const nombre = (cita.cliente.nombre || cita.cliente.nombrePerfil || cita.cliente.telefono || '').slice(0, 80) || null;
      const items = [];
      if (cita.servicio) {
        const precio = cita.servicio.precio;
        const porPersona = cita.servicio.usaPersonas ? Math.max(1, cita.personas) : 1;
        items.push({ tipo: 'SERVICIO', servicioId: cita.servicio.id, recursoId: cita.recursoId, nombre: cita.servicio.nombre.slice(0, 160), cantidad: porPersona, precioUnitario: precio !== null && precio !== undefined ? precio : 0, precioLibre: precio === null || precio === undefined });
      }
      return tx.cuenta.create({ data: { empresaId, citaId: cita.id, clienteId: cita.cliente.id, clienteNombre: nombre, usuarioId: usuario.id, items: { create: items } } });
    });
  } catch (err) {
    // Dos personas la abrieron a la vez: gana la primera y la otra entra a esa misma cuenta.
    if (err.code === 'P2002' || /cuentas_una_por_cita/.test(String(err.message))) {
      const ganadora = await existente('ABIERTA');
      if (ganadora) return ganadora;
    }
    throw err;
  }
}

/** Cuenta de alguien que llegó sin cita. */
async function abrirLibre(empresaId, usuario, { clienteNombre, clienteId = null } = {}) {
  let nombre = nombreLimpio(clienteNombre);
  let cid = null;
  if (clienteId) {
    const c = await prisma.clienteFinal.findFirst({ where: { id: Number(clienteId) || 0, empresaId }, select: { id: true, nombre: true, nombrePerfil: true, telefono: true } });
    if (!c) throw new ErrorCuenta('Ese cliente no existe.');
    cid = c.id; nombre = nombre || (c.nombre || c.nombrePerfil || c.telefono || '').slice(0, 80) || null;
  }
  if (!nombre) throw new ErrorCuenta('Escribí el nombre de quien llegó.');
  return prisma.cuenta.create({ data: { empresaId, clienteId: cid, clienteNombre: nombre, usuarioId: usuario.id } });
}

// ------------------------------------------------------------------ armar la cuenta

/** Suma un servicio de ESTE negocio. `recursoId` = quién lo hizo (opcional). */
async function agregarServicio(empresaId, usuario, cuentaId, { servicioId, cantidad = 1, recursoId = null }) {
  const n = cantidadValida(cantidad);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    const cuenta = await cuentaAbierta(tx, empresaId, cuentaId);
    if (cuenta.items.length >= MAX_LINEAS) throw new ErrorCuenta(`Demasiadas líneas (máximo ${MAX_LINEAS}).`);
    const s = await tx.servicio.findFirst({ where: { id: Number(servicioId) || 0, empresaId, activo: true } });
    if (!s) throw new ErrorCuenta('Ese servicio no existe o está desactivado.');
    let rid = null;
    if (recursoId) {
      const r = await tx.recurso.findFirst({ where: { id: Number(recursoId) || 0, empresaId, activo: true }, select: { id: true } });
      if (!r) throw new ErrorCuenta('Ese profesional no existe.');
      rid = r.id;
    }
    const libre = s.precio === null || s.precio === undefined;
    const igual = cuenta.items.find((i) => i.tipo === 'SERVICIO' && i.servicioId === s.id && (i.recursoId || null) === rid && !i.precioLibre && !libre);
    if (igual) return tx.cuentaItem.update({ where: { id: igual.id }, data: { cantidad: igual.cantidad + n } });
    return tx.cuentaItem.create({ data: { cuentaId: cuenta.id, tipo: 'SERVICIO', servicioId: s.id, recursoId: rid, nombre: s.nombre.slice(0, 160), cantidad: n, precioUnitario: libre ? 0 : s.precio, precioLibre: libre } });
  });
}

/** Suma un producto (u opción) de ESTE negocio. Solo valida que alcance el stock; se descuenta al cobrar. */
async function agregarProducto(empresaId, usuario, cuentaId, { productoId, varianteId = null, cantidad = 1 }) {
  const n = cantidadValida(cantidad);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    const cuenta = await cuentaAbierta(tx, empresaId, cuentaId);
    if (cuenta.items.length >= MAX_LINEAS) throw new ErrorCuenta(`Demasiadas líneas (máximo ${MAX_LINEAS}).`);
    let destino;
    if (varianteId) {
      const v = await tx.variante.findFirst({ where: { id: Number(varianteId) || 0, activa: true, producto: { empresaId, activo: true } }, include: { producto: true } });
      if (!v) throw new ErrorCuenta('Ese producto ya no está disponible.');
      const extra = atributosTexto(v.atributos);
      destino = { productoId: v.productoId, varianteId: v.id, nombre: extra ? `${v.producto.nombre} (${extra})` : v.producto.nombre, precio: v.precio !== null ? v.precio : v.producto.precio, stock: v.stock };
    } else {
      const p = await tx.producto.findFirst({ where: { id: Number(productoId) || 0, empresaId, activo: true }, include: { variantes: { where: { activa: true }, select: { id: true } } } });
      if (!p) throw new ErrorCuenta('Ese producto ya no está disponible.');
      if (p.variantes.length) throw new ErrorCuenta(`Elegí la opción de ${p.nombre} (talla, color…).`);
      destino = { productoId: p.id, varianteId: null, nombre: p.nombre, precio: p.precio, stock: p.stock };
    }
    const igual = cuenta.items.find((i) => i.tipo === 'PRODUCTO' && i.productoId === destino.productoId && (i.varianteId || null) === destino.varianteId);
    const nuevaCantidad = (igual ? igual.cantidad : 0) + n;
    if (nuevaCantidad > destino.stock) throw new ErrorCuenta(`No hay stock suficiente de ${destino.nombre}: quedan ${destino.stock}.`);
    if (igual) return tx.cuentaItem.update({ where: { id: igual.id }, data: { cantidad: nuevaCantidad } });
    return tx.cuentaItem.create({ data: { cuentaId: cuenta.id, tipo: 'PRODUCTO', productoId: destino.productoId, varianteId: destino.varianteId, nombre: destino.nombre.slice(0, 160), cantidad: n, precioUnitario: destino.precio } });
  });
}

/** Cambia la cantidad de una línea (0 la quita). */
async function cambiarCantidad(empresaId, usuario, cuentaId, itemId, cantidad) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CANTIDAD) throw new ErrorCuenta('La cantidad tiene que ser un número entero, 0 o más.');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    const cuenta = await cuentaAbierta(tx, empresaId, cuentaId);
    const item = cuenta.items.find((i) => i.id === Number(itemId));
    if (!item) throw new ErrorCuenta('Esa línea ya no está en la cuenta.');
    if (n === 0) { await tx.cuentaItem.delete({ where: { id: item.id } }); return null; }
    if (item.tipo === 'PRODUCTO') {
      const fila = item.varianteId ? await tx.variante.findUnique({ where: { id: item.varianteId }, select: { stock: true } }) : await tx.producto.findFirst({ where: { id: item.productoId, empresaId }, select: { stock: true } });
      if (!fila) throw new ErrorCuenta('Ese producto ya no está disponible: quitalo de la cuenta.');
      if (n > fila.stock) throw new ErrorCuenta(`No hay stock suficiente de ${item.nombre}: quedan ${fila.stock}.`);
    }
    return tx.cuentaItem.update({ where: { id: item.id }, data: { cantidad: n } });
  });
}

/** Precio de un servicio que no tenía precio cargado (solo esas líneas se pueden escribir a mano). */
async function ponerPrecio(empresaId, usuario, cuentaId, itemId, precio) {
  const c = V.aCentavos(precio);
  if (!Number.isFinite(c) || c < 0 || c > 100000 * 100) throw new ErrorCuenta('El precio tiene que ser un número de 0 o más.');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    const cuenta = await cuentaAbierta(tx, empresaId, cuentaId);
    const item = cuenta.items.find((i) => i.id === Number(itemId));
    if (!item) throw new ErrorCuenta('Esa línea ya no está en la cuenta.');
    if (!item.precioLibre) throw new ErrorCuenta('El precio de este servicio sale del catálogo: se cambia en Servicios.');
    return tx.cuentaItem.update({ where: { id: item.id }, data: { precioUnitario: V.deCentavos(c) } });
  });
}

/** Cancela una cuenta abierta (no se cobró nada; la cita queda libre para abrir otra). */
async function cancelar(empresaId, usuario, cuentaId, motivo) {
  const razon = nombreLimpio(motivo);
  const r = await prisma.cuenta.updateMany({ where: { id: Number(cuentaId) || 0, empresaId, estado: 'ABIERTA' }, data: { estado: 'CANCELADA', motivoCancelacion: razon } });
  if (!r.count) throw new ErrorCuenta('Esa cuenta ya no está abierta.');
  await auditoria.registrarSinRiesgo({ empresaId, actor: { id: usuario.id, rol: usuario.rol }, accion: 'CUENTA_CANCELADA', entidad: 'Cuenta', entidadId: Number(cuentaId), detalle: { numero: codigoDe(cuentaId), motivo: razon } });
}

// ------------------------------------------------------------------ cobrar

/**
 * Cobra la cuenta: crea UNA venta con todas las líneas (servicios y productos), descuenta el stock de los productos, suma a la caja
 * lo cobrado en efectivo y completa la cita. `datos`: { pagos:[{metodo, monto, recibido?}], claveIdempotencia? }
 * @returns {{ venta, repetida: boolean }}
 */
async function cobrar(empresaId, usuario, cuentaId, datos = {}) {
  const clave = datos.claveIdempotencia ? String(datos.claveIdempotencia).slice(0, 80) : null;
  const incluir = { items: true, pagos: true, cajero: { select: { nombre: true } } };
  const existente = async () => (clave ? prisma.venta.findFirst({ where: { empresaId, claveIdempotencia: clave }, include: incluir }) : null);
  const yaHecha = await existente();
  if (yaHecha) return { venta: yaHecha, repetida: true };
  try {
    const venta = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      const sesion = await sesionAbierta(empresaId, tx);
      if (!sesion) throw new ErrorVenta('Abrí la caja para cobrar la cuenta.');
      const cuenta = await cuentaAbierta(tx, empresaId, cuentaId);
      if (!cuenta.items.length) throw new ErrorCuenta('La cuenta no tiene nada para cobrar.');
      const calculo = V.calcularVenta(cuenta.items.map((i) => ({ precioUnitario: i.precioUnitario, cantidad: i.cantidad })), 0);
      if (calculo.totalCentavos <= 0) throw new ErrorCuenta('El total de la cuenta es 0: ponele precio a los servicios que no lo tienen.');
      const pagos = V.validarPagos(calculo.totalCentavos, datos.pagos);
      // Reclamo atómico: una sola persona cobra la cuenta.
      const reclamo = await tx.cuenta.updateMany({ where: { id: cuenta.id, empresaId, estado: 'ABIERTA' }, data: { estado: 'COBRADA', cobradaAt: new Date() } });
      if (!reclamo.count) throw new ErrorCuenta('Esa cuenta acaba de cambiar. Actualizá la pantalla.');

      // Costo de los productos (para el margen) al momento de vender.
      const costos = new Map();
      for (const i of cuenta.items.filter((x) => x.tipo === 'PRODUCTO')) {
        const fila = i.varianteId
          ? await tx.variante.findUnique({ where: { id: i.varianteId }, select: { costo: true, producto: { select: { costo: true } } } })
          : await tx.producto.findFirst({ where: { id: i.productoId, empresaId }, select: { costo: true } });
        const c = fila ? (fila.costo !== null && fila.costo !== undefined ? fila.costo : (fila.producto ? fila.producto.costo : null)) : null;
        costos.set(i.id, c === null || c === undefined ? null : Number(c));
      }
      const { _max } = await tx.venta.aggregate({ where: { empresaId }, _max: { numero: true } });
      const creada = await tx.venta.create({
        data: {
          empresaId, numero: (_max.numero || 0) + 1, sesionCajaId: sesion.id, cajeroId: usuario.id, clienteId: cuenta.clienteId, clienteNombre: cuenta.clienteNombre,
          subtotal: V.deCentavos(calculo.subtotalCentavos), descuento: 0, total: V.deCentavos(calculo.totalCentavos), claveIdempotencia: clave, tokenRecibo: nuevoToken(),
          items: {
            create: cuenta.items.map((i, k) => ({
              productoId: i.productoId, varianteId: i.varianteId, servicioId: i.servicioId, nombre: i.nombre.slice(0, 160), cantidad: i.cantidad,
              precioUnitario: V.deCentavos(calculo.lineas[k].precioCentavos), descuento: 0, total: V.deCentavos(calculo.lineas[k].totalCentavos), costoUnitario: costos.has(i.id) ? costos.get(i.id) : null,
            })),
          },
          pagos: { create: pagos.map((p) => ({ metodo: p.metodo, monto: V.deCentavos(p.montoCentavos), recibido: V.deCentavos(p.recibidoCentavos), vuelto: V.deCentavos(p.vueltoCentavos), referencia: p.referencia })) },
        },
      });
      // Stock de los productos: atómico y condicionado; si ya no alcanza, se deshace TODO (la cuenta sigue abierta).
      const lineasStock = cuenta.items.filter((i) => i.tipo === 'PRODUCTO').map((i) => ({ productoId: i.productoId, varianteId: i.varianteId, cantidad: i.cantidad }));
      if (lineasStock.length) await stockSrv.descontar(tx, { empresaId, lineas: lineasStock, tipo: 'VENTA', referenciaTipo: 'Venta', referenciaId: creada.id, usuarioId: usuario.id, nota: `Cuenta ${codigoDe(cuenta.id)}` });
      await tx.cuenta.update({ where: { id: cuenta.id }, data: { ventaId: creada.id } });
      if (cuenta.citaId) await tx.cita.updateMany({ where: { id: cuenta.citaId, empresaId, estado: { in: ['PENDIENTE', 'CONFIRMADA'] } }, data: { estado: 'COMPLETADA' } });
      return tx.venta.findUnique({ where: { id: creada.id }, include: incluir });
    });
    return { venta, repetida: false };
  } catch (err) {
    if (clave && (err.code === 'P2002' || /claveIdempotencia/.test(String(err.message)))) {
      const ganadora = await existente();
      if (ganadora) return { venta: ganadora, repetida: true };
    }
    if (err.codigo === 'STOCK') throw new ErrorCuenta(err.message);
    throw err;
  }
}

// ------------------------------------------------------------------ consultas

async function detalle(empresaId, id) {
  const c = await prisma.cuenta.findFirst({ where: { id: Number(id) || 0, empresaId }, include: incluirItems });
  if (!c) return null;
  const cita = c.citaId ? await prisma.cita.findFirst({ where: { id: c.citaId, empresaId }, include: { servicio: { select: { nombre: true } }, recurso: { select: { nombre: true } } } }) : null;
  return { ...c, codigo: codigoDe(c.id), totalCentavos: total(c.items), cita };
}

async function listarAbiertas(empresaId) {
  const cuentas = await prisma.cuenta.findMany({ where: { empresaId, estado: 'ABIERTA' }, include: incluirItems, orderBy: { createdAt: 'asc' } });
  return cuentas.map((c) => ({ ...c, codigo: codigoDe(c.id), totalCentavos: total(c.items) }));
}

/** Citas de HOY (hora del negocio) que todavía se pueden cobrar y no tienen cuenta. */
async function citasDeHoySinCuenta(empresa) {
  const zona = empresa.zonaHoraria;
  const hoy = T.hoy(zona);
  const citas = await prisma.cita.findMany({
    where: { empresaId: empresa.id, estado: { in: ESTADOS_CITA_COBRABLES }, inicio: { gte: T.aInstante(hoy, '00:00', zona), lt: T.aInstante(T.sumarDias(hoy, 1), '00:00', zona) } },
    include: { cliente: { select: { nombre: true, nombrePerfil: true, telefono: true } }, servicio: { select: { nombre: true, precio: true } }, recurso: { select: { nombre: true } } },
    orderBy: [{ inicio: 'asc' }, { id: 'asc' }],
  });
  if (!citas.length) return [];
  const vivas = await prisma.cuenta.findMany({ where: { empresaId: empresa.id, citaId: { in: citas.map((c) => c.id) }, estado: { in: ['ABIERTA', 'COBRADA'] } }, select: { citaId: true } });
  const conCuenta = new Set(vivas.map((v) => v.citaId));
  return citas.filter((c) => !conCuenta.has(c.id)).map((c) => ({
    id: c.id, estado: c.estado, hora: DateTime.fromJSDate(c.inicio, { zone: zona }).toFormat('HH:mm'), cliente: c.cliente.nombre || c.cliente.nombrePerfil || c.cliente.telefono,
    servicio: c.servicio ? c.servicio.nombre : 'Servicio eliminado', precio: c.servicio && c.servicio.precio !== null ? Number(c.servicio.precio) : null, recurso: c.recurso ? c.recurso.nombre : null,
  }));
}

/** Servicios activos y profesionales para el selector de la cuenta. */
async function catalogoParaCuenta(empresaId) {
  const [servicios, profesionales] = await Promise.all([
    prisma.servicio.findMany({ where: { empresaId, activo: true }, orderBy: [{ orden: 'asc' }, { nombre: 'asc' }], select: { id: true, nombre: true, precio: true } }),
    prisma.recurso.findMany({ where: { empresaId, activo: true }, orderBy: { nombre: 'asc' }, select: { id: true, nombre: true } }),
  ]);
  return { servicios: servicios.map((s) => ({ id: s.id, nombre: s.nombre, precio: s.precio !== null ? Number(s.precio) : null })), profesionales };
}

module.exports = {
  ErrorCuenta, codigoDe, abrirDeCita, abrirLibre, agregarServicio, agregarProducto, cambiarCantidad, ponerPrecio, cancelar, cobrar,
  detalle, listarAbiertas, citasDeHoySinCuenta, catalogoParaCuenta,
};
