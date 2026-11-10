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
const auditoria = require('./auditoria');
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

/** Cliente de la venta (opcional): tiene que ser de ESTA empresa. Sin cliente, queda el nombre escrito a mano. */
async function clienteDeLaVenta(tx, empresaId, datos) {
  const texto = datos.clienteNombre ? String(datos.clienteNombre).trim().slice(0, 80) : null;
  if (!datos.clienteId) return { id: null, nombre: texto };
  const c = await tx.clienteFinal.findFirst({ where: { id: Number(datos.clienteId), empresaId }, select: { id: true, nombre: true, nombrePerfil: true, telefono: true } });
  if (!c) throw new ErrorVenta('Ese cliente no existe.');
  return { id: c.id, nombre: (c.nombre || c.nombrePerfil || c.telefono || texto || '').slice(0, 80) || null };
}

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

      const cliente = await clienteDeLaVenta(tx, empresaId, datos);
      const { _max } = await tx.venta.aggregate({ where: { empresaId }, _max: { numero: true } });
      const creada = await tx.venta.create({
        data: {
          empresaId, numero: (_max.numero || 0) + 1, sesionCajaId: sesion.id, cajeroId: usuario.id,
          clienteId: cliente.id, clienteNombre: cliente.nombre,
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
    if (venta.cambioDeVentaId) throw new ErrorVenta('Esa venta es un cambio de producto: no se puede anular. Si hace falta, registrá una devolución.');
    if (await tx.devolucion.count({ where: { ventaId: venta.id } })) {
      throw new ErrorVenta('Esa venta ya tiene devoluciones: no se puede anular. Devolvé lo que falte.');
    }
    if (!venta.sesionCaja || venta.sesionCaja.estado !== 'ABIERTA') {
      throw new ErrorVenta('La caja de esa venta ya está cerrada: no se puede anular. Registrá una devolución o un ajuste.');
    }
    const reclamo = await tx.venta.updateMany({
      where: { id: venta.id, empresaId, estado: 'COMPLETADA' },
      data: { estado: 'ANULADA', anuladaAt: new Date(), anuladaPorId: usuario.id, motivoAnulacion: texto },
    });
    if (reclamo.count === 0) throw new ErrorVenta('Esa venta ya fue anulada.');
    // Si la venta cobraba un pedido de WhatsApp, anularla cancela el pedido (el stock vuelve una sola vez, abajo).
    if (venta.pedidoId) await tx.pedido.updateMany({ where: { id: venta.pedidoId, empresaId, estado: 'ENTREGADO' }, data: { estado: 'CANCELADO' } });
    const lineas = venta.items.filter((i) => i.productoId || i.varianteId).map((i) => ({ productoId: i.productoId, varianteId: i.varianteId, cantidad: i.cantidad }));
    if (lineas.length) {
      await stockSrv.reponer(tx, { empresaId, lineas, tipo: 'ANULACION_VENTA', referenciaTipo: 'Venta', referenciaId: venta.id, usuarioId: usuario.id, nota: texto });
    }
    await auditoria.registrar(tx, {
      empresaId, actor: { id: usuario.id, rol: usuario.rol }, accion: 'VENTA_ANULADA', entidad: 'Venta', entidadId: venta.id,
      detalle: { numero: `V-${String(venta.numero).padStart(4, '0')}`, total: Number(venta.total), motivo: texto },
    });
    return tx.venta.findUnique({ where: { id: venta.id }, include: incluir });
  });
}

/**
 * Cobra en el mostrador un pedido que tomo el bot por WhatsApp.
 * El stock NO se vuelve a descontar (ya se desconto al crear el pedido) y los precios son los del pedido.
 * Se "reclama" el pedido (NUEVO/CONFIRMADO -> ENTREGADO) de forma atomica: no se cobra dos veces.
 * `datos`: { pagos, claveIdempotencia?, clienteNombre? }
 */
async function cobrarPedido(empresaId, usuario, pedidoId, datos = {}) {
  const clave = datos.claveIdempotencia ? String(datos.claveIdempotencia).slice(0, 80) : null;
  const existente = async () => (clave ? prisma.venta.findFirst({ where: { empresaId, claveIdempotencia: clave, pedidoId: Number(pedidoId) }, include: incluir }) : null);
  const yaHecha = await existente();
  if (yaHecha) return { venta: yaHecha, repetida: true };
  try {
    const venta = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      const sesion = await sesionAbierta(empresaId, tx);
      if (!sesion) throw new ErrorVenta('Abrí la caja para cobrar el pedido.');
      const pedido = await tx.pedido.findFirst({
        where: { id: Number(pedidoId), empresaId },
        include: { items: { include: { producto: { select: { costo: true } }, variante: { select: { costo: true } } } }, cliente: { select: { id: true } } },
      });
      if (!pedido) throw new ErrorVenta('Ese pedido no existe.');
      if (!['NUEVO', 'CONFIRMADO'].includes(pedido.estado)) throw new ErrorVenta(`Ese pedido ya está ${pedido.estado === 'ENTREGADO' ? 'entregado' : 'cancelado'}.`);
      if (!pedido.items.length) throw new ErrorVenta('Ese pedido no tiene productos.');
      const lineas = pedido.items.map((i) => ({ precioUnitario: i.precio, cantidad: i.cantidad }));
      const calculo = V.calcularVenta(lineas, 0);
      if (calculo.totalCentavos !== V.aCentavos(pedido.total)) throw new ErrorVenta('El total del pedido no coincide con sus productos. Revisalo antes de cobrar.');
      // Lo que el cliente ya pagó antes (QR, tarjeta o transferencia confirmados): NO se cobra de nuevo.
      // Se cobra solo el saldo (si el pedido se editó y creció) y la venta guarda los dos pagos.
      const previoCentavos = Math.min(V.aCentavos(pedido.pagadoMonto || 0), calculo.totalCentavos);
      const saldoCentavos = calculo.totalCentavos - previoCentavos;
      if (previoCentavos > 0 && !['QR', 'TARJETA', 'TRANSFERENCIA'].includes(pedido.pagoMetodo)) throw new ErrorVenta('El pago registrado de este pedido no es válido. Quitalo y volvé a cobrar.');
      if (saldoCentavos === 0 && previoCentavos > 0 && Array.isArray(datos.pagos) && datos.pagos.length) throw new ErrorVenta('Ese pedido ya está pagado: no se cobra de nuevo, solo se entrega.');
      const pagosNuevos = saldoCentavos > 0 ? V.validarPagos(saldoCentavos, datos.pagos) : [];
      const pagos = previoCentavos > 0
        ? [{ metodo: pedido.pagoMetodo, montoCentavos: previoCentavos, recibidoCentavos: previoCentavos, vueltoCentavos: 0, referencia: 'Pagado antes de retirar' }, ...pagosNuevos]
        : pagosNuevos;
      const reclamo = await tx.pedido.updateMany({ where: { id: pedido.id, empresaId, estado: { in: ['NUEVO', 'CONFIRMADO'] } }, data: { estado: 'ENTREGADO' } });
      if (reclamo.count === 0) throw new ErrorVenta('Ese pedido acaba de cambiar de estado. Actualizá la pantalla.');
      const cliente = await clienteDeLaVenta(tx, empresaId, { clienteId: pedido.clienteId, clienteNombre: datos.clienteNombre });
      const { _max } = await tx.venta.aggregate({ where: { empresaId }, _max: { numero: true } });
      const costoDe = (i) => {
        const c = i.variante && i.variante.costo !== null && i.variante.costo !== undefined ? i.variante.costo : (i.producto ? i.producto.costo : null);
        return c === null || c === undefined ? null : Number(c);
      };
      const creada = await tx.venta.create({
        data: {
          empresaId, numero: (_max.numero || 0) + 1, sesionCajaId: sesion.id, cajeroId: usuario.id, pedidoId: pedido.id,
          clienteId: cliente.id, clienteNombre: cliente.nombre,
          subtotal: V.deCentavos(calculo.subtotalCentavos), descuento: 0, total: V.deCentavos(calculo.totalCentavos),
          claveIdempotencia: clave, tokenRecibo: nuevoToken(),
          items: {
            create: pedido.items.map((i, k) => ({
              productoId: i.productoId, varianteId: i.varianteId, nombre: i.nombre.slice(0, 160), cantidad: i.cantidad,
              precioUnitario: V.deCentavos(calculo.lineas[k].precioCentavos), descuento: 0, total: V.deCentavos(calculo.lineas[k].totalCentavos), costoUnitario: costoDe(i),
            })),
          },
          pagos: { create: pagos.map((p) => ({ metodo: p.metodo, monto: V.deCentavos(p.montoCentavos), recibido: V.deCentavos(p.recibidoCentavos), vuelto: V.deCentavos(p.vueltoCentavos), referencia: p.referencia })) },
        },
      });
      return tx.venta.findUnique({ where: { id: creada.id }, include: incluir });
    });
    return { venta, repetida: false };
  } catch (err) {
    if (clave && (err.code === 'P2002' || /claveIdempotencia|pedidoId/.test(String(err.message)))) {
      const ganadora = await existente();
      if (ganadora) return { venta: ganadora, repetida: true };
    }
    throw err;
  }
}

/** Cuantas unidades de cada linea de una venta ya se devolvieron, y cuanto dinero. */
async function devueltoDe(tx, ventaId) {
  const [porItem, total] = await Promise.all([
    tx.devolucionItem.groupBy({ by: ['ventaItemId'], where: { devolucion: { ventaId } }, _sum: { cantidad: true } }),
    tx.devolucion.aggregate({ where: { ventaId }, _sum: { monto: true } }),
  ]);
  return { porItem: new Map(porItem.map((x) => [x.ventaItemId, x._sum.cantidad || 0])), centavos: V.aCentavos(total._sum.monto || 0) };
}

/**
 * Devuelve (total o parcialmente) productos de una venta cobrada.
 * `datos`: { items:[{ventaItemId, cantidad}], metodo, motivo, repone? }
 * Reglas: solo dueño/admin; hace falta una caja abierta (de ahi sale el dinero); nunca se devuelve mas de lo
 * vendido ni mas de lo que pago el cliente; una devolucion en efectivo no puede dejar la caja en negativo;
 * los productos vuelven al stock salvo que se indique lo contrario.
 */
async function devolverEnTx(tx, empresaId, usuario, ventaId, { items, metodo, motivo, repone }) {
  // Bloquea la venta mientras se devuelve: dos devoluciones a la vez no pueden pasarse de lo vendido.
  await tx.$queryRaw`SELECT id FROM ventas WHERE id = ${Number(ventaId)} AND "empresaId" = ${empresaId} FOR UPDATE`;
  const venta = await tx.venta.findFirst({ where: { id: Number(ventaId), empresaId }, include: { items: true } });
  if (!venta) throw new ErrorVenta('Esa venta no existe.');
  if (venta.estado !== 'COMPLETADA') throw new ErrorVenta('Esa venta está anulada: no se puede devolver.');
  const sesion = await sesionAbierta(empresaId, tx);
  if (!sesion) throw new ErrorVenta('Abrí la caja para registrar la devolución.');
  const previo = await devueltoDe(tx, venta.id);
  const calculo = V.calcularDevolucion({
    // En una venta que fue un CAMBIO el cliente pagó solo la diferencia: se devuelve como máximo lo que pagó.
    totalVentaCentavos: V.aCentavos(venta.total) - V.aCentavos(venta.creditoCambio || 0), devueltoAntesCentavos: previo.centavos,
    items: venta.items.map((i) => ({ id: i.id, nombre: i.nombre, cantidad: i.cantidad, totalCentavos: V.aCentavos(i.total), devueltas: previo.porItem.get(i.id) || 0 })),
  }, items);
  if (metodo === 'EFECTIVO') {
    const r = await require('./caja').resumen(sesion.id);
    if (calculo.montoCentavos > r.efectivoEsperadoCentavos) {
      throw new ErrorVenta(`No hay tanto efectivo en la caja para devolver (hay ${V.formatoMonto(r.efectivoEsperadoCentavos)}). Devolvé por otro medio o registrá una entrada.`);
    }
  }
  const devolucion = await tx.devolucion.create({
    data: {
      empresaId, ventaId: venta.id, sesionCajaId: sesion.id, usuarioId: usuario.id, metodo, repone, motivo, monto: V.deCentavos(calculo.montoCentavos),
      items: { create: calculo.lineas.map((l) => ({ ventaItemId: l.ventaItemId, cantidad: l.cantidad, monto: V.deCentavos(l.montoCentavos) })) },
    },
    include: { items: true },
  });
  if (repone) {
    const lineas = calculo.lineas
      .map((l) => ({ item: venta.items.find((i) => i.id === l.ventaItemId), cantidad: l.cantidad }))
      .filter((x) => x.item.productoId || x.item.varianteId)
      .map((x) => ({ productoId: x.item.productoId, varianteId: x.item.varianteId, cantidad: x.cantidad }));
    if (lineas.length) await stockSrv.reponer(tx, { empresaId, lineas, tipo: 'DEVOLUCION_VENTA', referenciaTipo: 'Venta', referenciaId: venta.id, usuarioId: usuario.id, nota: motivo });
  }
  await auditoria.registrar(tx, {
    empresaId, actor: { id: usuario.id, rol: usuario.rol }, accion: 'DEVOLUCION_REGISTRADA', entidad: 'Venta', entidadId: venta.id,
    detalle: { numero: `V-${String(venta.numero).padStart(4, '0')}`, monto: Number(devolucion.monto), metodo, repone, motivo, completa: calculo.completa },
  });
  return { devolucion, calculo, venta, sesion };
}

function datosDeDevolucion(usuario, datos, { aceptaCambio = false } = {}) {
  if (!ROLES_QUE_ANULAN.includes(usuario.rol)) throw new ErrorVenta('Solo el dueño o un administrador puede registrar una devolución o un cambio.');
  const motivo = String(datos.motivo || '').trim().slice(0, 200);
  if (motivo.length < 5) throw new ErrorVenta('Escribí el motivo (mínimo 5 letras).');
  const metodo = aceptaCambio ? 'CAMBIO' : String(datos.metodo || '').toUpperCase();
  if (!aceptaCambio && !V.METODOS.includes(metodo)) throw new ErrorVenta('Elegí cómo se le devuelve el dinero al cliente.');
  const repone = datos.repone === undefined ? true : (datos.repone === true || datos.repone === 'true' || datos.repone === '1' || datos.repone === 'on');
  return { items: datos.items, metodo, motivo, repone };
}

async function devolver(empresaId, usuario, ventaId, datos = {}) {
  const d = datosDeDevolucion(usuario, datos);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
    return (await devolverEnTx(tx, empresaId, usuario, ventaId, d)).devolucion;
  });
}

/**
 * CAMBIO de producto: el cliente devuelve productos de una venta y se lleva otros, en UNA sola operación (todo o nada).
 * `datos`: { items:[{ventaItemId, cantidad}], motivo, repone?, lineas:[{productoId, varianteId?, cantidad, descuento?}], descuento?, pagos?, clienteNombre?, claveIdempotencia? }
 *   - Lo devuelto (a lo que pagó el cliente, con su parte del descuento) es el CREDITO del cambio y no mueve dinero.
 *   - Si lo nuevo vale MÁS, el cliente paga la diferencia (los pagos deben sumar exactamente eso).
 *   - Si lo nuevo vale MENOS, la diferencia se le devuelve en EFECTIVO (sale de la caja, que no puede quedar en negativo).
 *   - La venta nueva guarda su crédito y de qué venta viene; un cambio no se anula (se corrige con una devolución).
 * @returns {{ venta, devolucion, aDevolver, repetida }}
 */
async function cambiar(empresaId, usuario, ventaId, datos = {}) {
  const d = datosDeDevolucion(usuario, datos, { aceptaCambio: true });
  const clave = datos.claveIdempotencia ? String(datos.claveIdempotencia).slice(0, 80) : null;
  const existente = async () => (clave ? prisma.venta.findFirst({ where: { empresaId, claveIdempotencia: clave }, include: incluir }) : null);
  const yaHecha = await existente();
  if (yaHecha) return { venta: yaHecha, devolucion: null, aDevolver: 0, repetida: true };
  try {
    const r = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${empresaId})`;
      const { devolucion, calculo, venta: original, sesion } = await devolverEnTx(tx, empresaId, usuario, ventaId, d);
      const credito = calculo.montoCentavos;

      const lineas = await resolverLineas(tx, empresaId, datos.lineas);
      const calc = V.calcularVenta(lineas, datos.descuento);
      const usado = Math.min(credito, calc.totalCentavos);
      const aCobrar = calc.totalCentavos - usado;
      const aDevolver = credito - usado;
      const pagos = aCobrar > 0 ? V.validarPagos(aCobrar, datos.pagos) : [];
      if (aCobrar === 0 && Array.isArray(datos.pagos) && datos.pagos.length) throw new ErrorVenta('Lo que se lleva está cubierto por lo que devuelve: no hay nada que cobrar.');

      if (aDevolver > 0) {
        const r = await require('./caja').resumen(sesion.id);
        if (aDevolver > r.efectivoEsperadoCentavos) throw new ErrorVenta(`Hay que devolverle ${V.formatoMonto(aDevolver)} en efectivo y en la caja hay ${V.formatoMonto(r.efectivoEsperadoCentavos)}. Registrá una entrada de efectivo o llevá más productos.`);
        await tx.movimientoCaja.create({ data: { sesionId: sesion.id, tipo: 'SALIDA', monto: V.deCentavos(aDevolver), nota: `Cambio de V-${String(original.numero).padStart(4, '0')}: diferencia devuelta`, usuarioId: usuario.id } });
      }

      const cliente = await clienteDeLaVenta(tx, empresaId, { clienteId: original.clienteId, clienteNombre: datos.clienteNombre || original.clienteNombre });
      const { _max } = await tx.venta.aggregate({ where: { empresaId }, _max: { numero: true } });
      const creada = await tx.venta.create({
        data: {
          empresaId, numero: (_max.numero || 0) + 1, sesionCajaId: sesion.id, cajeroId: usuario.id, clienteId: cliente.id, clienteNombre: cliente.nombre,
          subtotal: V.deCentavos(calc.subtotalCentavos), descuento: V.deCentavos(calc.descuentoCentavos), total: V.deCentavos(calc.totalCentavos),
          creditoCambio: V.deCentavos(usado), cambioDeVentaId: original.id, claveIdempotencia: clave, tokenRecibo: nuevoToken(),
          items: {
            create: lineas.map((l, i) => ({
              productoId: l.productoId, varianteId: l.varianteId, nombre: l.nombre.slice(0, 160), cantidad: calc.lineas[i].cantidad,
              precioUnitario: V.deCentavos(calc.lineas[i].precioCentavos), descuento: V.deCentavos(calc.lineas[i].descuentoCentavos),
              total: V.deCentavos(calc.lineas[i].totalCentavos), costoUnitario: l.costoUnitario === null || l.costoUnitario === undefined ? null : Number(l.costoUnitario),
            })),
          },
          pagos: { create: pagos.map((p) => ({ metodo: p.metodo, monto: V.deCentavos(p.montoCentavos), recibido: V.deCentavos(p.recibidoCentavos), vuelto: V.deCentavos(p.vueltoCentavos), referencia: p.referencia })) },
        },
      });
      // Lo devuelto ya volvio al stock (arriba); ahora sale lo nuevo, de forma atomica y condicionada.
      await stockSrv.descontar(tx, {
        empresaId, tipo: 'VENTA', referenciaTipo: 'Venta', referenciaId: creada.id, usuarioId: usuario.id,
        lineas: lineas.map((l, i) => ({ productoId: l.productoId, varianteId: l.varianteId, cantidad: calc.lineas[i].cantidad })),
      });
      return { venta: await tx.venta.findUnique({ where: { id: creada.id }, include: incluir }), devolucion, aDevolver };
    });
    return { ...r, aDevolver: r.aDevolver / 100, repetida: false };
  } catch (err) {
    if (clave && (err.code === 'P2002' || /claveIdempotencia/.test(String(err.message)))) {
      const ganadora = await existente();
      if (ganadora) return { venta: ganadora, devolucion: null, aDevolver: 0, repetida: true };
    }
    throw err;
  }
}

/**
 * Cuánto valen (a lo que pagó el cliente) los productos que quiere devolver en un cambio, y qué quedó por devolver de esa venta.
 * Solo calcula: no cambia nada. Es lo que la pantalla muestra como "crédito" antes de cobrar.
 */
async function calcularCredito(empresaId, ventaId, items) {
  const venta = await prisma.venta.findFirst({ where: { id: Number(ventaId) || 0, empresaId }, include: { items: true } });
  if (!venta) throw new ErrorVenta('Esa venta no existe.');
  if (venta.estado !== 'COMPLETADA') throw new ErrorVenta('Esa venta está anulada: no se puede cambiar.');
  const previo = await devueltoDe(prisma, venta.id);
  const calculo = V.calcularDevolucion({
    totalVentaCentavos: V.aCentavos(venta.total) - V.aCentavos(venta.creditoCambio || 0), devueltoAntesCentavos: previo.centavos,
    items: venta.items.map((i) => ({ id: i.id, nombre: i.nombre, cantidad: i.cantidad, totalCentavos: V.aCentavos(i.total), devueltas: previo.porItem.get(i.id) || 0 })),
  }, items);
  return { creditoCentavos: calculo.montoCentavos };
}

/** Lo que de una venta todavía se puede devolver o cambiar (para armar la pantalla de cambio). */
async function pendientesDeCambio(empresaId, ventaId) {
  const venta = await prisma.venta.findFirst({ where: { id: Number(ventaId) || 0, empresaId }, include: { items: true } });
  if (!venta || venta.estado !== 'COMPLETADA') return null;
  const previo = await devueltoDe(prisma, venta.id);
  return {
    id: venta.id, numero: venta.numero, esCambio: Boolean(venta.cambioDeVentaId),
    items: venta.items.map((i) => ({ id: i.id, nombre: i.nombre, quedan: i.cantidad - (previo.porItem.get(i.id) || 0) })).filter((i) => i.quedan > 0),
  };
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

const detalle = (empresaId, id) => prisma.venta.findFirst({ where: { id: Number(id), empresaId }, include: { ...incluir, anuladaPor: { select: { nombre: true } }, sesionCaja: true, devoluciones: { include: { items: true }, orderBy: { id: 'asc' } } } });

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

module.exports = { ErrorVenta, ROLES_QUE_ANULAN, crear, cobrarPedido, anular, devolver, cambiar, calcularCredito, pendientesDeCambio, devueltoDe, listar, detalle, reciboPorToken };
