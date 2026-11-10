'use strict';
// lib/services/compras.js
//
// COMPRAS A PROVEEDORES (POS P3): se registra la mercadería que llega, suma al stock (movimiento COMPRA en el
// historial), actualiza el último costo del producto y deja la compra pagada o por pagar.
//
// Reglas (mismas que las ventas):
//   - Dinero en CENTAVOS ENTEROS; el servidor recalcula todo, el navegador solo manda producto, cantidad y costo.
//   - Todo en UNA transacción con el candado por empresa (el mismo que las ventas y la caja): si algo falla no
//     queda nada a medias (ni stock sumado, ni caja movida).
//   - Idempotencia: la misma clave no crea dos compras (doble clic, reintento).
//   - Pagar y anular se "reclaman" con un UPDATE condicionado: dos clics a la vez no pagan ni anulan dos veces.
//   - Anular devuelve el stock con el descuento atómico: si parte de la mercadería ya se vendió, NO se puede anular.
//   - Todo filtrado por empresa. Solo dueño y administrador.

const { prisma } = require('../db');
const stockSrv = require('./stock');
const caja = require('./caja');
const auditoria = require('./auditoria');
const { aCentavos, deCentavos } = require('./ventaCalculo');

const ROLES = ['OWNER', 'ADMIN'];
const MAX_LINEAS = 100;
const MAX_CANTIDAD = 100000;
const MAX_COSTO_CENTAVOS = 100000 * 100;
const MAX_TOTAL_CENTAVOS = 100000000 * 100;
const PAGOS = ['PENDIENTE', 'EFECTIVO_CAJA', 'OTRO'];
const ETIQUETAS_PAGO = { EFECTIVO_CAJA: 'Efectivo de la caja', OTRO: 'Transferencia u otro medio' };

class ErrorCompra extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje);
    this.codigo = 'COMPRA';
    this.detalle = detalle;
  }
}

const exigirRol = (usuario) => {
  if (!usuario || !ROLES.includes(usuario.rol)) throw new ErrorCompra('Solo el dueño o un administrador puede manejar las compras.');
};
const texto = (v, max) => { const t = String(v === undefined || v === null ? '' : v).trim().slice(0, max); return t || null; };
const codigoDe = (numero) => `C-${String(numero).padStart(4, '0')}`;
const atributosTexto = (a) => Object.values(a || {}).filter(Boolean).join(' ');

// ------------------------------------------------------------------ proveedores

async function listarProveedores(empresaId, { incluirInactivos = true } = {}) {
  const proveedores = await prisma.proveedor.findMany({ where: { empresaId, ...(incluirInactivos ? {} : { activo: true }) }, orderBy: [{ activo: 'desc' }, { nombre: 'asc' }] });
  // Cuanto se le compro y cuanto se le debe a cada uno (las anuladas no cuentan).
  const filas = await prisma.compra.groupBy({ by: ['proveedorId', 'pagoEstado'], where: { empresaId, estado: 'RECIBIDA', proveedorId: { not: null } }, _sum: { total: true }, _count: { _all: true } });
  const por = new Map();
  for (const f of filas) {
    const x = por.get(f.proveedorId) || { comprado: 0, deuda: 0, compras: 0 };
    x.comprado += Number(f._sum.total || 0);
    x.compras += f._count._all;
    if (f.pagoEstado === 'PENDIENTE') x.deuda += Number(f._sum.total || 0);
    por.set(f.proveedorId, x);
  }
  return proveedores.map((p) => ({ ...p, ...(por.get(p.id) || { comprado: 0, deuda: 0, compras: 0 }) }));
}

function datosProveedor(d) {
  const nombre = texto(d && d.nombre, 80);
  if (!nombre || nombre.length < 2) throw new ErrorCompra('Escribí el nombre del proveedor.');
  const email = texto(d.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErrorCompra('El correo no parece válido.');
  return { nombre, contacto: texto(d.contacto, 80), telefono: texto(d.telefono, 30), email, notas: texto(d.notas, 300) };
}

async function nombreLibre(empresaId, nombre, exceptoId = null) {
  const otro = await prisma.proveedor.findFirst({ where: { empresaId, nombre: { equals: nombre, mode: 'insensitive' }, ...(exceptoId ? { id: { not: exceptoId } } : {}) } });
  if (otro) throw new ErrorCompra('Ya tenés un proveedor con ese nombre.');
}

async function crearProveedor(empresaId, usuario, datos) {
  exigirRol(usuario);
  const d = datosProveedor(datos);
  await nombreLibre(empresaId, d.nombre);
  return prisma.proveedor.create({ data: { empresaId, ...d } });
}

async function actualizarProveedor(empresaId, usuario, id, datos) {
  exigirRol(usuario);
  const d = datosProveedor(datos);
  const actual = await prisma.proveedor.findFirst({ where: { id: Number(id) || 0, empresaId } });
  if (!actual) throw new ErrorCompra('Ese proveedor no existe.');
  await nombreLibre(empresaId, d.nombre, actual.id);
  // El nombre en las compras viejas queda como estaba cuando se compró (es historia).
  return prisma.proveedor.update({ where: { id: actual.id }, data: d });
}

async function cambiarEstadoProveedor(empresaId, usuario, id, activo) {
  exigirRol(usuario);
  const r = await prisma.proveedor.updateMany({ where: { id: Number(id) || 0, empresaId }, data: { activo: Boolean(activo) } });
  if (!r.count) throw new ErrorCompra('Ese proveedor no existe.');
}

// ------------------------------------------------------------------ buscar mercadería

/** Productos y opciones de ESTA empresa para armar una compra. A diferencia del mostrador, incluye los que están sin stock. */
async function buscarMercaderia(empresaId, q) {
  const t = String(q || '').trim().slice(0, 80);
  const productos = await prisma.producto.findMany({
    where: { empresaId, activo: true, ...(t ? { OR: [{ nombre: { contains: t, mode: 'insensitive' } }, { sku: { contains: t, mode: 'insensitive' } }, { codigoBarras: t }, { variantes: { some: { OR: [{ sku: { contains: t, mode: 'insensitive' } }, { codigoBarras: t }] } } }] } : {}) },
    include: { variantes: { where: { activa: true }, orderBy: { id: 'asc' } } },
    orderBy: { nombre: 'asc' }, take: 30,
  });
  const filas = [];
  for (const p of productos) {
    if (p.variantes.length) {
      for (const v of p.variantes) {
        const extra = atributosTexto(v.atributos);
        filas.push({ productoId: p.id, varianteId: v.id, nombre: extra ? `${p.nombre} (${extra})` : p.nombre, sku: v.sku || p.sku || '', stock: v.stock, costo: v.costo !== null ? Number(v.costo) : (p.costo !== null ? Number(p.costo) : null) });
      }
    } else {
      filas.push({ productoId: p.id, varianteId: null, nombre: p.nombre, sku: p.sku || '', stock: p.stock, costo: p.costo !== null ? Number(p.costo) : null });
    }
  }
  return filas.slice(0, 40);
}

// ------------------------------------------------------------------ crear

async function resolverItems(tx, empresaId, items) {
  if (!Array.isArray(items) || !items.length) throw new ErrorCompra('Agregá al menos un producto.');
  if (items.length > MAX_LINEAS) throw new ErrorCompra(`Demasiados productos (máximo ${MAX_LINEAS}).`);
  const vistos = new Set();
  const salida = [];
  for (const it of items) {
    const cantidad = Number(it.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > MAX_CANTIDAD) throw new ErrorCompra('La cantidad tiene que ser un número entero mayor a 0.');
    const costo = aCentavos(it.costo);
    if (!Number.isFinite(costo) || costo < 0 || costo > MAX_COSTO_CENTAVOS) throw new ErrorCompra('El costo de cada producto tiene que ser un número de 0 o más.');
    const varianteId = it.varianteId ? Number(it.varianteId) : null;
    const productoId = Number(it.productoId);
    let destino;
    if (varianteId) {
      const v = await tx.variante.findFirst({ where: { id: varianteId, producto: { empresaId } }, include: { producto: { select: { id: true, nombre: true } } } });
      if (!v) throw new ErrorCompra('Uno de los productos ya no existe.');
      const extra = atributosTexto(v.atributos);
      destino = { productoId: v.productoId, varianteId: v.id, nombre: extra ? `${v.producto.nombre} (${extra})` : v.producto.nombre };
    } else {
      const p = Number.isInteger(productoId) ? await tx.producto.findFirst({ where: { id: productoId, empresaId } }) : null;
      if (!p) throw new ErrorCompra('Uno de los productos ya no existe.');
      destino = { productoId: p.id, varianteId: null, nombre: p.nombre };
    }
    const llave = `${destino.productoId}:${destino.varianteId || 0}`;
    if (vistos.has(llave)) throw new ErrorCompra(`${destino.nombre} está repetido: sumá las cantidades en una sola línea.`);
    vistos.add(llave);
    salida.push({ ...destino, cantidad, costoCentavos: costo, totalCentavos: costo * cantidad });
  }
  return salida;
}

/** Saca efectivo de la caja abierta (dentro de la transacción de la compra). */
async function pagarDeLaCaja(tx, empresaId, usuario, centavos, nota) {
  const sesion = await caja.sesionAbierta(empresaId, tx);
  if (!sesion) throw new ErrorCompra('Para pagar de la caja, primero abrila. O elegí otro medio de pago.');
  const r = await caja.resumen(sesion.id);
  if (centavos > r.efectivoEsperadoCentavos) throw new ErrorCompra(`No hay tanto efectivo en la caja (hay ${(r.efectivoEsperadoCentavos / 100).toFixed(2)}).`);
  await tx.movimientoCaja.create({ data: { sesionId: sesion.id, tipo: 'SALIDA', monto: deCentavos(centavos), nota: nota.slice(0, 200), usuarioId: usuario.id } });
}

/**
 * Registra una compra. `datos`: { proveedorId?, referencia?, items:[{productoId, varianteId?, cantidad, costo}], pago: PENDIENTE|EFECTIVO_CAJA|OTRO, notas?, claveIdempotencia? }
 * @returns {{ compra, repetida: boolean }}
 */
async function crear(empresaId, usuario, datos) {
  exigirRol(usuario);
  const pago = PAGOS.includes(String(datos.pago)) ? String(datos.pago) : 'PENDIENTE';
  const clave = datos.claveIdempotencia ? String(datos.claveIdempotencia).slice(0, 80) : null;
  const incluir = { items: { orderBy: { id: 'asc' } }, proveedor: { select: { id: true, nombre: true } } };
  const existente = async () => (clave ? prisma.compra.findFirst({ where: { empresaId, claveIdempotencia: clave }, include: incluir }) : null);
  const yaHecha = await existente();
  if (yaHecha) return { compra: yaHecha, repetida: true };

  try {
    const compra = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      let proveedor = null;
      if (datos.proveedorId) {
        proveedor = await tx.proveedor.findFirst({ where: { id: Number(datos.proveedorId) || 0, empresaId, activo: true } });
        if (!proveedor) throw new ErrorCompra('Ese proveedor no existe o está desactivado.');
      }
      const lineas = await resolverItems(tx, empresaId, datos.items);
      const totalCentavos = lineas.reduce((t, l) => t + l.totalCentavos, 0);
      if (totalCentavos > MAX_TOTAL_CENTAVOS) throw new ErrorCompra('El total de la compra es demasiado grande.');
      const { _max } = await tx.compra.aggregate({ where: { empresaId }, _max: { numero: true } });
      const numero = (_max.numero || 0) + 1;
      const pagada = pago !== 'PENDIENTE';
      if (pago === 'EFECTIVO_CAJA') await pagarDeLaCaja(tx, empresaId, usuario, totalCentavos, `Compra ${codigoDe(numero)}${proveedor ? ` a ${proveedor.nombre}` : ''}`);
      const creada = await tx.compra.create({
        data: {
          empresaId, numero, proveedorId: proveedor ? proveedor.id : null, proveedorNombre: proveedor ? proveedor.nombre : null,
          referencia: texto(datos.referencia, 60), total: deCentavos(totalCentavos), pagoEstado: pagada ? 'PAGADA' : 'PENDIENTE',
          pagoMetodo: pagada ? pago : null, pagadaAt: pagada ? new Date() : null, notas: texto(datos.notas, 300), claveIdempotencia: clave, usuarioId: usuario.id,
          items: { create: lineas.map((l) => ({ productoId: l.productoId, varianteId: l.varianteId, nombre: l.nombre.slice(0, 160), cantidad: l.cantidad, costoUnitario: deCentavos(l.costoCentavos), total: deCentavos(l.totalCentavos) })) },
        },
      });
      await stockSrv.reponer(tx, {
        empresaId, tipo: 'COMPRA', referenciaTipo: 'Compra', referenciaId: creada.id, usuarioId: usuario.id, nota: proveedor ? `Proveedor: ${proveedor.nombre}` : null,
        lineas: lineas.map((l) => ({ productoId: l.productoId, varianteId: l.varianteId, cantidad: l.cantidad })),
      });
      // El costo del producto pasa a ser el de esta compra (último costo): así el margen del mostrador es real.
      for (const l of lineas) {
        if (l.varianteId) await tx.variante.update({ where: { id: l.varianteId }, data: { costo: deCentavos(l.costoCentavos) } });
        else await tx.producto.update({ where: { id: l.productoId }, data: { costo: deCentavos(l.costoCentavos) } });
      }
      return tx.compra.findUnique({ where: { id: creada.id }, include: incluir });
    });
    await auditoria.registrarSinRiesgo({ empresaId, actor: { id: usuario.id, rol: usuario.rol }, accion: 'COMPRA_REGISTRADA', entidad: 'Compra', entidadId: compra.id, detalle: { numero: codigoDe(compra.numero), proveedor: compra.proveedorNombre, total: Number(compra.total), pago } });
    return { compra, repetida: false };
  } catch (err) {
    if (clave && (err.code === 'P2002' || /claveIdempotencia/.test(String(err.message)))) {
      const ganadora = await existente();
      if (ganadora) return { compra: ganadora, repetida: true };
    }
    if (err.codigo === 'STOCK') throw new ErrorCompra(err.message);
    throw err;
  }
}

// ------------------------------------------------------------------ pagar y anular

/** Paga una compra que estaba por pagar. */
async function pagar(empresaId, usuario, compraId, metodo) {
  exigirRol(usuario);
  const m = ['EFECTIVO_CAJA', 'OTRO'].includes(String(metodo)) ? String(metodo) : null;
  if (!m) throw new ErrorCompra('Elegí cómo la pagaste.');
  const compra = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    const c = await tx.compra.findFirst({ where: { id: Number(compraId) || 0, empresaId } });
    if (!c) throw new ErrorCompra('Esa compra no existe.');
    if (c.estado !== 'RECIBIDA') throw new ErrorCompra('Esa compra está anulada.');
    // Reclamo: solo una persona la marca como pagada.
    const r = await tx.compra.updateMany({ where: { id: c.id, empresaId, estado: 'RECIBIDA', pagoEstado: 'PENDIENTE' }, data: { pagoEstado: 'PAGADA', pagoMetodo: m, pagadaAt: new Date() } });
    if (!r.count) throw new ErrorCompra('Esa compra ya está pagada.');
    if (m === 'EFECTIVO_CAJA') await pagarDeLaCaja(tx, empresaId, usuario, aCentavos(c.total), `Pago de compra ${codigoDe(c.numero)}${c.proveedorNombre ? ` a ${c.proveedorNombre}` : ''}`);
    return c;
  });
  await auditoria.registrarSinRiesgo({ empresaId, actor: { id: usuario.id, rol: usuario.rol }, accion: 'COMPRA_PAGADA', entidad: 'Compra', entidadId: compra.id, detalle: { numero: codigoDe(compra.numero), total: Number(compra.total), metodo: m } });
}

/** Anula una compra: devuelve el stock (si ya se vendió parte, no se puede) y, si salió de la caja, el efectivo. */
async function anular(empresaId, usuario, compraId, motivo) {
  exigirRol(usuario);
  const razon = texto(motivo, 200);
  if (!razon || razon.length < 3) throw new ErrorCompra('Escribí el motivo de la anulación.');
  let compra;
  try {
    compra = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      const c = await tx.compra.findFirst({ where: { id: Number(compraId) || 0, empresaId }, include: { items: true } });
      if (!c) throw new ErrorCompra('Esa compra no existe.');
      const r = await tx.compra.updateMany({ where: { id: c.id, empresaId, estado: 'RECIBIDA' }, data: { estado: 'ANULADA', anuladaAt: new Date(), anuladaPorId: usuario.id, motivoAnulacion: razon } });
      if (!r.count) throw new ErrorCompra('Esa compra ya estaba anulada.');
      await stockSrv.descontar(tx, {
        empresaId, tipo: 'ANULACION_COMPRA', referenciaTipo: 'Compra', referenciaId: c.id, usuarioId: usuario.id, nota: razon,
        lineas: c.items.map((i) => ({ productoId: i.productoId, varianteId: i.varianteId, cantidad: i.cantidad })),
      });
      if (c.pagoEstado === 'PAGADA' && c.pagoMetodo === 'EFECTIVO_CAJA') {
        const sesion = await caja.sesionAbierta(empresaId, tx);
        if (!sesion) throw new ErrorCompra('Esa compra se pagó con efectivo de la caja. Abrí la caja para registrar que vuelve el dinero y anulala de nuevo.');
        await tx.movimientoCaja.create({ data: { sesionId: sesion.id, tipo: 'ENTRADA', monto: c.total, nota: `Anulación de compra ${codigoDe(c.numero)}`.slice(0, 200), usuarioId: usuario.id } });
      }
      return c;
    });
  } catch (err) {
    if (err.codigo === 'STOCK') throw new ErrorCompra(`No se puede anular: ya salió parte de esa mercadería. ${err.message}`);
    throw err;
  }
  await auditoria.registrarSinRiesgo({ empresaId, actor: { id: usuario.id, rol: usuario.rol }, accion: 'COMPRA_ANULADA', entidad: 'Compra', entidadId: compra.id, detalle: { numero: codigoDe(compra.numero), total: Number(compra.total), motivo: razon } });
}

// ------------------------------------------------------------------ consultas

async function listar(empresaId, { estado = null, pago = null, proveedorId = null, limite = 200 } = {}) {
  return prisma.compra.findMany({
    where: {
      empresaId, ...(estado ? { estado } : {}), ...(pago ? { pagoEstado: pago, estado: 'RECIBIDA' } : {}), ...(proveedorId ? { proveedorId: Number(proveedorId) } : {}),
    },
    include: { usuario: { select: { nombre: true } }, _count: { select: { items: true } } },
    orderBy: { createdAt: 'desc' }, take: Math.min(Number(limite) || 200, 500),
  });
}

async function detalle(empresaId, id) {
  return prisma.compra.findFirst({ where: { id: Number(id) || 0, empresaId }, include: { items: { orderBy: { id: 'asc' } }, usuario: { select: { nombre: true } }, proveedor: { select: { id: true, nombre: true, telefono: true } } } });
}

/** Cuánto se compró y cuánto se debe (las anuladas no cuentan). */
async function totales(empresaId) {
  const filas = await prisma.compra.groupBy({ by: ['pagoEstado'], where: { empresaId, estado: 'RECIBIDA' }, _sum: { total: true }, _count: { _all: true } });
  const x = { compras: 0, comprado: 0, deuda: 0, porPagar: 0 };
  for (const f of filas) {
    x.compras += f._count._all; x.comprado += Number(f._sum.total || 0);
    if (f.pagoEstado === 'PENDIENTE') { x.deuda += Number(f._sum.total || 0); x.porPagar += f._count._all; }
  }
  return x;
}

module.exports = {
  ErrorCompra, ROLES, PAGOS, ETIQUETAS_PAGO, codigoDe,
  listarProveedores, crearProveedor, actualizarProveedor, cambiarEstadoProveedor, buscarMercaderia,
  crear, pagar, anular, listar, detalle, totales,
};
