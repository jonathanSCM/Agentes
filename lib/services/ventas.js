'use strict';
// lib/services/ventas.js
//
// VENTAS del mostrador (docs/11 F5). Reglas (de la auditoria de la barbería y de la regla de oro del
// producto: el backend decide):
//   - El servidor recalcula TODO desde los precios de la base. El navegador solo manda producto, opcion,
//     cantidad y descuentos; el cajero sale siempre de la sesion.
//   - Se necesita una caja abierta.
//   - El stock se descuenta de forma atomica en la MISMA transaccion (sin sobreventa).
//   - Idempotencia: la misma clave de cobro no crea dos ventas (doble clic, reintento por mala conexion).
//   - Anular: solo dueño/admin, solo con la caja de esa venta abierta, "reclamando" el cambio de estado de
//     forma atomica; devuelve el stock y deja el historial.

const crypto = require('crypto');
const { prisma } = require('../db');
const stockSrv = require('./stock');
const { sesionAbierta } = require('./caja');
const V = require('./ventaCalculo');

const { ErrorVenta } = V;
const ROLES_QUE_ANULAN = ['OWNER', 'ADMIN', 'PROSHOP_ADMIN'];

const atributosTexto = (a) => Object.values(a || {}).filter(Boolean).join(' ');
const nuevoToken = () => crypto.randomBytes(16).toString('base64url');

/** Lee de la base cada linea (producto/opcion de ESTA empresa), con su precio y costo reales. */
async function resolverLineas(tx, empresaId, lineas) {
  if (!Array.isArray(lineas) || !lineas.length) throw new ErrorVenta('Agregá al menos un producto.');
  if (lineas.length > V.MAX_LINEAS) throw new ErrorVenta(`Demasiados productos en una venta (máximo ${V.MAX_LINEAS}).`);
  const salida = [];
  for (const l of lineas) {
    const varianteId = l.varianteId ? Number(l.varianteId) : null;
    if (varianteId) {
      const v = await tx.variante.findFirst({ where: { id: varianteId, activa: true, producto: { empresaId, activo: true } }, include: { producto: true } });
      if (!v) throw new ErrorVenta('Un producto de la venta ya no está disponible.');
      const extra = atributosTexto(v.atributos);
      salida.push({
        productoId: v.productoId, varianteId: v.id, nombre: extra ? `${v.producto.nombre} (${extra})` : v.producto.nombre,
        precioUnitario: v.precio !== null && v.precio !== undefined ? v.precio : v.producto.precio,
        costoUnitario: v.costo !== null && v.costo !== undefined ? v.costo : v.producto.costo,
        cantidad: l.cantidad, descuento: l.descuento,
      });
      continue;
    }
    const p = await tx.producto.findFirst({ where: { id: Number(l.productoId), empresaId, activo: true }, include: { variantes: { where: { activa: true }, select: { id: true } } } });
    if (!p) throw new ErrorVenta('Un producto de la venta ya no está disponible.');
    if (p.variantes.length) throw new ErrorVenta(`Elegí la opción de "${p.nombre}" (talla, color, etc.).`);
    salida.push({ productoId: p.id, varianteId: null, nombre: p.nombre, precioUnitario: p.precio, costoUnitario: p.costo, cantidad: l.cantidad, descuento: l.descuento });
  }
  return salida;
}

const incluir = { items: true, pagos: true, cajero: { select: { nombre: true } } };

/**
 * Cobra una venta. `datos`: { lineas:[{productoId, varianteId?, cantidad, descuento?}], descuento?, pagos:[{metodo, monto, recibido?, referencia?}], clienteNombre?, claveIdempotencia? }
 * @returns {{ venta, repetida: boolean }}
 */
async function crear(empresaId, usuario, datos) {
  const clave = datos.claveIdempotencia ? String(datos.claveIdempotencia).slice(0, 80) : null;
  const existente = async () => (clave ? prisma.venta.findFirst({ where: { empresaId, claveIdempotencia: clave }, include: incluir }) : null);
  const yaHecha = await existente();
  if (yaHecha) return { venta: yaHecha, repetida: true };

  try {
    const venta = await prisma.$transaction(async (tx) => {
      // Un solo cobro a la vez por empresa: evita numeros repetidos y ordena las ventas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      const sesion = await sesionAbierta(empresaId, tx);
      if (!sesion) throw new ErrorVenta('Abrí la caja para poder vender.');

      const lineas = await resolverLineas(tx, empresaId, datos.lineas);
      const calculo = V.calcularVenta(lineas, datos.descuento);
      const pagos = V.validarPagos(calculo.totalCentavos, datos.pagos);

      const { _max } = await tx.venta.aggregate({ where: { empresaId }, _max: { numero: true } });
      const creada = await tx.venta.create({
        data: {
          empresaId, numero: (_max.numero || 0) + 1, sesionCajaId: sesion.id, cajeroId: usuario.id,
          clienteNombre: datos.clienteNombre ? String(datos.clienteNombre).trim().slice(0, 80) : null,
          subtotal: V.deCentavos(calculo.subtotalCentavos), descuento: V.deCentavos(calculo.descuentoCentavos), total: V.deCentavos(calculo.totalCentavos),
          claveIdempotencia: clave, tokenRecibo: nuevoToken(),
          items: {
            create: lineas.map((l, i) => ({
              productoId: l.productoId, varianteId: l.varianteId, nombre: l.nombre.slice(0, 160), cantidad: calculo.lineas[i].cantidad,
              precioUnitario: V.deCentavos(calculo.lineas[i].precioCentavos), descuento: V.deCentavos(calculo.lineas[i].descuentoCentavos),
              total: V.deCentavos(calculo.lineas[i].totalCentavos), costoUnitario: l.costoUnitario === null || l.costoUnitario === undefined ? null : Number(l.costoUnitario),
            })),
          },
          pagos: { create: pagos.map((p) => ({ metodo: p.metodo, monto: V.deCentavos(p.montoCentavos), recibido: V.deCentavos(p.recibidoCentavos), vuelto: V.deCentavos(p.vueltoCentavos), referencia: p.referencia })) },
        },
      });
      // Stock: atomico y condicionado. Si algo no alcanza, se deshace TODA la venta.
      await stockSrv.descontar(tx, {
        empresaId, tipo: 'VENTA', referenciaTipo: 'Venta', referenciaId: creada.id, usuarioId: usuario.id,
        lineas: lineas.map((l, i) => ({ productoId: l.productoId, varianteId: l.varianteId, cantidad: calculo.lineas[i].cantidad })),
      });
      return tx.venta.findUnique({ where: { id: creada.id }, include: incluir });
    });
    return { venta, repetida: false };
  } catch (err) {
    // Dos cobros simultaneos con la misma clave: gana uno, el otro devuelve esa misma venta.
    if (clave && (err.code === 'P2002' || /claveIdempotencia/.test(String(err.message)))) {
      const ganadora = await existente();
      if (ganadora) return { venta: ganadora, repetida: true };
    }
    throw err;
  }
}

/** Anula una venta: solo dueño/admin y solo si la caja de esa venta sigue abierta. */
async function anular(empresaId, usuario, ventaId, motivo) {
  if (!ROLES_QUE_ANULAN.includes(usuario.rol)) throw new ErrorVenta('Solo el dueño o un administrador puede anular una venta.');
  const texto = String(motivo || '').trim().slice(0, 200);
  if (texto.length < 5) throw new ErrorVenta('Escribí el motivo de la anulación (mínimo 5 letras).');
  return prisma.$transaction(async (tx) => {
    const venta = await tx.venta.findFirst({ where: { id: Number(ventaId), empresaId }, include: { items: true, sesionCaja: true } });
    if (!venta) throw new ErrorVenta('Esa venta no existe.');
    if (venta.estado === 'ANULADA') throw new ErrorVenta('Esa venta ya fue anulada.');
    if (!venta.sesionCaja || venta.sesionCaja.estado !== 'ABIERTA') {
      throw new ErrorVenta('La caja de esa venta ya está cerrada: no se puede anular. Registrá una devolución o un ajuste.');
    }
    const reclamo = await tx.venta.updateMany({
      where: { id: venta.id, empresaId, estado: 'COMPLETADA' },
      data: { estado: 'ANULADA', anuladaAt: new Date(), anuladaPorId: usuario.id, motivoAnulacion: texto },
    });
    if (reclamo.count === 0) throw new ErrorVenta('Esa venta ya fue anulada.');
    const lineas = venta.items.filter((i) => i.productoId || i.varianteId).map((i) => ({ productoId: i.productoId, varianteId: i.varianteId, cantidad: i.cantidad }));
    if (lineas.length) {
      await stockSrv.reponer(tx, { empresaId, lineas, tipo: 'ANULACION_VENTA', referenciaTipo: 'Venta', referenciaId: venta.id, usuarioId: usuario.id, nota: texto });
    }
    return tx.venta.findUnique({ where: { id: venta.id }, include: incluir });
  });
}

/** Lista de ventas (mas nuevas primero), con filtros. */
function listar(empresaId, { desde = null, hasta = null, estado = null, sesionId = null, limite = 100 } = {}) {
  return prisma.venta.findMany({
    where: {
      empresaId,
      ...(estado && ['COMPLETADA', 'ANULADA'].includes(estado) ? { estado } : {}),
      ...(sesionId ? { sesionCajaId: Number(sesionId) } : {}),
      ...(desde || hasta ? { createdAt: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lt: hasta } : {}) } } : {}),
    },
    include: { pagos: true, cajero: { select: { nombre: true } } },
    orderBy: { id: 'desc' },
    take: Math.min(Number(limite) || 100, 500),
  });
}

const detalle = (empresaId, id) => prisma.venta.findFirst({ where: { id: Number(id), empresaId }, include: { ...incluir, anuladaPor: { select: { nombre: true } }, sesionCaja: true } });

/** Datos del recibo publico (sin login): solo se entra con el token. */
async function reciboPorToken(token) {
  const t = String(token || '');
  if (t.length < 16 || t.length > 64) return null;
  const venta = await prisma.venta.findUnique({ where: { tokenRecibo: t }, include: incluir });
  if (!venta) return null;
  const [empresa, agente] = await Promise.all([
    prisma.empresa.findUnique({ where: { id: venta.empresaId }, select: { nombre: true, marca: true, moneda: true } }),
    prisma.agente.findFirst({ where: { empresaId: venta.empresaId }, include: { config: { select: { direccionTienda: true } } } }),
  ]);
  return { venta, empresa, direccion: agente && agente.config ? agente.config.direccionTienda : null };
}

module.exports = { ErrorVenta, ROLES_QUE_ANULAN, crear, anular, listar, detalle, reciboPorToken };
