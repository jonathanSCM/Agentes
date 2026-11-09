// POS fase 2: devoluciones, cobro de pedidos de WhatsApp en el mostrador, cliente en la venta.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const Caja = require('../lib/services/caja');
const Ventas = require('../lib/services/ventas');
const V = require('../lib/services/ventaCalculo');

describe('calcularDevolucion (puro)', () => {
  const venta = (extra = {}) => ({
    totalVentaCentavos: 10000, devueltoAntesCentavos: 0,
    items: [{ id: 1, nombre: 'A', cantidad: 3, totalCentavos: 6000, devueltas: 0 }, { id: 2, nombre: 'B', cantidad: 1, totalCentavos: 4000, devueltas: 0 }],
    ...extra,
  });

  test('devolver una unidad de una línea sin descuento general', () => {
    const r = V.calcularDevolucion(venta(), [{ ventaItemId: 1, cantidad: 1 }]);
    assert.equal(r.montoCentavos, 2000);
    assert.equal(r.completa, false);
  });

  test('el descuento general se reparte en proporción', () => {
    const r = V.calcularDevolucion(venta({ totalVentaCentavos: 9000 }), [{ ventaItemId: 2, cantidad: 1 }]);
    assert.equal(r.montoCentavos, 3600, '4000 de 10000 → 40 % de 9000');
  });

  test('devolver todo cierra EXACTO con lo que pagó el cliente (sin perder centavos)', () => {
    const v = { totalVentaCentavos: 1000, devueltoAntesCentavos: 0, items: [{ id: 1, nombre: 'A', cantidad: 3, totalCentavos: 1000, devueltas: 0 }] };
    const una = V.calcularDevolucion(v, [{ ventaItemId: 1, cantidad: 1 }]);
    const dos = V.calcularDevolucion({ ...v, devueltoAntesCentavos: una.montoCentavos, items: [{ ...v.items[0], devueltas: 1 }] }, [{ ventaItemId: 1, cantidad: 1 }]);
    const tres = V.calcularDevolucion({ ...v, devueltoAntesCentavos: una.montoCentavos + dos.montoCentavos, items: [{ ...v.items[0], devueltas: 2 }] }, [{ ventaItemId: 1, cantidad: 1 }]);
    assert.equal(una.montoCentavos + dos.montoCentavos + tres.montoCentavos, 1000);
    assert.equal(tres.completa, true);
  });

  test('rechaza cantidades inválidas, de más, repetidas o de otra venta', () => {
    const malo = (pedido, patron) => assert.throws(() => V.calcularDevolucion(venta(), pedido), patron);
    malo([], /Elegí qué productos/);
    malo([{ ventaItemId: 1, cantidad: 4 }], /Solo se pueden devolver 3/);
    malo([{ ventaItemId: 1, cantidad: 0 }], /entero mayor a 0/);
    malo([{ ventaItemId: 1, cantidad: 1.5 }], /entero mayor a 0/);
    malo([{ ventaItemId: 99, cantidad: 1 }], /no pertenece/);
    malo([{ ventaItemId: 1, cantidad: 1 }, { ventaItemId: 1, cantidad: 1 }], /repetido/);
  });

  test('una línea ya devuelta por completo no se devuelve otra vez', () => {
    const v = venta({ devueltoAntesCentavos: 4000, items: [{ id: 1, nombre: 'A', cantidad: 3, totalCentavos: 6000, devueltas: 0 }, { id: 2, nombre: 'B', cantidad: 1, totalCentavos: 4000, devueltas: 1 }] });
    assert.throws(() => V.calcularDevolucion(v, [{ ventaItemId: 2, cantidad: 1 }]), /ya fue devuelto por completo/);
  });

  test('el efectivo esperado resta las devoluciones en efectivo', () => {
    assert.equal(V.efectivoEsperado({ inicialCentavos: 10000, cobrosEfectivoCentavos: 5000, devolucionesEfectivoCentavos: 2000 }), 13000);
  });
});

const SLUGS = ['test-pos2-a', 'test-pos2-b'];
let A; let B;
const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.match(e.message, patron); return true; });
let seq = 0;
const clave = () => `p2-${Date.now()}-${seq += 1}`;
const stockDe = async (id) => (await prisma.producto.findUnique({ where: { id } })).stock;

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug } });
  const cat = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'General' } });
  const dueno = await prisma.usuario.create({ data: { empresaId: e.id, email: `${slug}-dueno@test.local`, passwordHash: 'x', nombre: 'Dueña', rol: 'OWNER' } });
  const caj = await prisma.usuario.create({ data: { empresaId: e.id, email: `${slug}-caja@test.local`, passwordHash: 'x', nombre: 'Cajero', rol: 'CAJERO' } });
  return { empresaId: e.id, categoriaId: cat.id, dueno: { id: dueno.id, rol: 'OWNER' }, cajero: { id: caj.id, rol: 'CAJERO' } };
}
const producto = (ctx, nombre, precio, stock, extra = {}) => prisma.producto.create({ data: { empresaId: ctx.empresaId, categoriaId: ctx.categoriaId, nombre, precio, stock, ...extra } });
const vender = (ctx, lineas, pagos, extra = {}) => Ventas.crear(ctx.empresaId, ctx.dueno, { lineas, pagos, claveIdempotencia: clave(), ...extra });
const efectivo = (monto) => [{ metodo: 'EFECTIVO', monto }];

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: SLUGS.flatMap((s) => [`${s}-dueno@test.local`, `${s}-caja@test.local`]) } } });
  A = await empresa(SLUGS[0]);
  B = await empresa(SLUGS[1]);
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: SLUGS.flatMap((s) => [`${s}-dueno@test.local`, `${s}-caja@test.local`]) } } });
});
beforeEach(async () => {
  await prisma.sesionCaja.updateMany({ where: { empresaId: { in: [A.empresaId, B.empresaId] }, estado: 'ABIERTA' }, data: { estado: 'CERRADA', cerradaAt: new Date() } });
});

describe('devoluciones', () => {
  test('devuelve parte de una venta: stock vuelve, la caja resta el efectivo y queda auditado', async () => {
    const p = await producto(A, 'Camisa', 100, 10);
    await Caja.abrir(A.empresaId, A.dueno.id, 0);
    const { venta } = await vender(A, [{ productoId: p.id, cantidad: 3 }], efectivo(300));
    assert.equal(await stockDe(p.id), 7);
    const d = await Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 2 }], metodo: 'EFECTIVO', motivo: 'talla equivocada' });
    assert.equal(Number(d.monto), 200);
    assert.equal(await stockDe(p.id), 9);
    const sesion = await Caja.sesionAbierta(A.empresaId);
    const r = await Caja.resumen(sesion.id);
    assert.equal(r.efectivoEsperadoCentavos, 10000, '300 cobrados − 200 devueltos');
    assert.equal(r.devolucionesCentavos, 20000);
    const mov = await prisma.movimientoStock.findFirst({ where: { empresaId: A.empresaId, tipo: 'DEVOLUCION_VENTA' } });
    assert.equal(mov.cantidad, 2);
    assert.equal(await prisma.auditoria.count({ where: { empresaId: A.empresaId, accion: 'DEVOLUCION_REGISTRADA' } }), 1);
  });

  test('no se puede devolver más de lo vendido, ni sumando varias devoluciones', async () => {
    const p = await producto(A, 'Gorra', 50, 5);
    await Caja.abrir(A.empresaId, A.dueno.id, 100);
    const { venta } = await vender(A, [{ productoId: p.id, cantidad: 2 }], efectivo(100));
    const item = venta.items[0].id;
    await Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: item, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'no le gustó' });
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: item, cantidad: 2 }], metodo: 'EFECTIVO', motivo: 'no le gustó' }), /Solo se pueden devolver 1/);
    await Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: item, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'la otra también' });
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: item, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'una más' }), /ya fue devuelto por completo/);
    assert.equal(await stockDe(p.id), 5);
  });

  test('dos devoluciones simultáneas de la misma unidad: solo una pasa', async () => {
    const p = await producto(A, 'Medias', 20, 10);
    await Caja.abrir(A.empresaId, A.dueno.id, 100);
    const { venta } = await vender(A, [{ productoId: p.id, cantidad: 1 }], efectivo(20));
    const pedido = () => Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'doble clic' });
    const r = await Promise.allSettled([pedido(), pedido(), pedido()]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await stockDe(p.id), 10, 'el stock vuelve una sola vez');
    assert.equal(await prisma.devolucion.count({ where: { ventaId: venta.id } }), 1);
  });

  test('reglas: solo dueño/admin, caja abierta, motivo, venta no anulada y dinero suficiente en caja', async () => {
    const p = await producto(A, 'Polera', 100, 10);
    await Caja.abrir(A.empresaId, A.dueno.id, 0);
    const { venta } = await vender(A, [{ productoId: p.id, cantidad: 1 }], [{ metodo: 'QR', monto: 100 }]);
    const base = { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'cambio de opinión' };
    await rechaza(Ventas.devolver(A.empresaId, A.cajero, venta.id, base), /Solo el dueño/);
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, venta.id, { ...base, motivo: 'x' }), /motivo/);
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, venta.id, { ...base, metodo: 'CHEQUE' }), /cómo se le devuelve/);
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, venta.id, base), /No hay tanto efectivo/);
    const ok = await Ventas.devolver(A.empresaId, A.dueno, venta.id, { ...base, metodo: 'QR' });
    assert.equal(ok.metodo, 'QR');
    const r = await Caja.resumen((await Caja.sesionAbierta(A.empresaId)).id);
    assert.equal(r.efectivoEsperadoCentavos, 0, 'devolver por QR no toca el efectivo');
    await prisma.sesionCaja.updateMany({ where: { empresaId: A.empresaId, estado: 'ABIERTA' }, data: { estado: 'CERRADA', cerradaAt: new Date() } });
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, venta.id, base), /Abrí la caja/);
  });

  test('sin reponer al stock (producto dañado) el stock no cambia', async () => {
    const p = await producto(A, 'Taza', 30, 4);
    await Caja.abrir(A.empresaId, A.dueno.id, 50);
    const { venta } = await vender(A, [{ productoId: p.id, cantidad: 1 }], efectivo(30));
    await Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'llegó rota', repone: false });
    assert.equal(await stockDe(p.id), 3);
  });

  test('una venta con devoluciones ya no se puede anular, y una anulada no se devuelve', async () => {
    const p = await producto(A, 'Buzo', 80, 6);
    await Caja.abrir(A.empresaId, A.dueno.id, 100);
    const { venta } = await vender(A, [{ productoId: p.id, cantidad: 2 }], efectivo(160));
    await Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'una sola' });
    await rechaza(Ventas.anular(A.empresaId, A.dueno, venta.id, 'quiero anularla'), /ya tiene devoluciones/);
    const { venta: otra } = await vender(A, [{ productoId: p.id, cantidad: 1 }], efectivo(80));
    await Ventas.anular(A.empresaId, A.dueno, otra.id, 'me equivoqué');
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, otra.id, { items: [{ ventaItemId: otra.items[0].id, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'sobre anulada' }), /anulada/);
  });

  test('no se devuelve una venta de otra empresa', async () => {
    const p = await producto(B, 'Ajeno', 10, 5);
    await Caja.abrir(B.empresaId, B.dueno.id, 10);
    const { venta } = await vender(B, [{ productoId: p.id, cantidad: 1 }], efectivo(10));
    await Caja.abrir(A.empresaId, A.dueno.id, 10);
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'intento ajeno' }), /no existe/);
  });
});

describe('cobrar un pedido de WhatsApp en el mostrador', () => {
  const pedidoDe = (ctx, items, extra = {}) => prisma.pedido.create({
    data: {
      empresaId: ctx.empresaId, estado: 'NUEVO', total: items.reduce((s, i) => s + i.precio * i.cantidad, 0), ...extra,
      items: { create: items.map((i) => ({ productoId: i.productoId, nombre: i.nombre, precio: i.precio, cantidad: i.cantidad })) },
    },
  });

  test('cobra sin volver a descontar stock, deja el pedido entregado y lo liga a la venta', async () => {
    const p = await producto(A, 'Chompa', 150, 8, { costo: 90 });
    const pedido = await pedidoDe(A, [{ productoId: p.id, nombre: 'Chompa', precio: 150, cantidad: 2 }]);
    await Caja.abrir(A.empresaId, A.dueno.id, 0);
    const { venta } = await Ventas.cobrarPedido(A.empresaId, A.cajero, pedido.id, { pagos: [{ metodo: 'QR', monto: 300 }], claveIdempotencia: clave() });
    assert.equal(venta.pedidoId, pedido.id);
    assert.equal(Number(venta.total), 300);
    assert.equal(Number(venta.items[0].costoUnitario), 90);
    assert.equal(await stockDe(p.id), 8, 'el stock ya se había descontado al crear el pedido: no se toca');
    assert.equal((await prisma.pedido.findUnique({ where: { id: pedido.id } })).estado, 'ENTREGADO');
  });

  test('doble clic con la misma clave y cobros simultáneos: una sola venta', async () => {
    const p = await producto(A, 'Short', 60, 5);
    const pedido = await pedidoDe(A, [{ productoId: p.id, nombre: 'Short', precio: 60, cantidad: 1 }]);
    await Caja.abrir(A.empresaId, A.dueno.id, 0);
    const k = clave();
    const cobrar = (kk) => Ventas.cobrarPedido(A.empresaId, A.cajero, pedido.id, { pagos: efectivo(60), claveIdempotencia: kk });
    const r = await Promise.allSettled([cobrar(k), cobrar(k), cobrar(clave())]);
    assert.ok(r.filter((x) => x.status === 'fulfilled').length >= 1);
    assert.equal(await prisma.venta.count({ where: { pedidoId: pedido.id } }), 1);
    const otra = await cobrar(k);
    assert.equal(otra.repetida, true);
  });

  test('un pedido entregado o cancelado no se cobra, y los pagos tienen que sumar el total', async () => {
    const p = await producto(A, 'Falda', 70, 5);
    const entregado = await pedidoDe(A, [{ productoId: p.id, nombre: 'Falda', precio: 70, cantidad: 1 }], { estado: 'ENTREGADO' });
    const cancelado = await pedidoDe(A, [{ productoId: p.id, nombre: 'Falda', precio: 70, cantidad: 1 }], { estado: 'CANCELADO' });
    const vivo = await pedidoDe(A, [{ productoId: p.id, nombre: 'Falda', precio: 70, cantidad: 1 }], { estado: 'CONFIRMADO' });
    await Caja.abrir(A.empresaId, A.dueno.id, 0);
    await rechaza(Ventas.cobrarPedido(A.empresaId, A.cajero, entregado.id, { pagos: efectivo(70) }), /entregado/);
    await rechaza(Ventas.cobrarPedido(A.empresaId, A.cajero, cancelado.id, { pagos: efectivo(70) }), /cancelado/);
    await rechaza(Ventas.cobrarPedido(A.empresaId, A.cajero, vivo.id, { pagos: efectivo(10) }), /Falta cobrar/);
    assert.equal((await prisma.pedido.findUnique({ where: { id: vivo.id } })).estado, 'CONFIRMADO', 'un pago inválido no cambia el pedido');
  });

  test('necesita caja abierta y no cobra pedidos de otra empresa', async () => {
    const p = await producto(A, 'Pollera', 90, 5);
    const pedido = await pedidoDe(A, [{ productoId: p.id, nombre: 'Pollera', precio: 90, cantidad: 1 }]);
    await rechaza(Ventas.cobrarPedido(A.empresaId, A.cajero, pedido.id, { pagos: efectivo(90) }), /Abrí la caja/);
    await Caja.abrir(B.empresaId, B.dueno.id, 0);
    await rechaza(Ventas.cobrarPedido(B.empresaId, B.dueno, pedido.id, { pagos: efectivo(90) }), /no existe/);
  });

  test('anular esa venta cancela el pedido y el stock vuelve una sola vez', async () => {
    const p = await producto(A, 'Saco', 200, 5);
    const pedido = await pedidoDe(A, [{ productoId: p.id, nombre: 'Saco', precio: 200, cantidad: 1 }]);
    await prisma.producto.update({ where: { id: p.id }, data: { stock: 4 } }); // el bot ya descontó 1
    await Caja.abrir(A.empresaId, A.dueno.id, 0);
    const { venta } = await Ventas.cobrarPedido(A.empresaId, A.cajero, pedido.id, { pagos: efectivo(200), claveIdempotencia: clave() });
    await Ventas.anular(A.empresaId, A.dueno, venta.id, 'el cliente no lo quiso');
    assert.equal(await stockDe(p.id), 5);
    assert.equal((await prisma.pedido.findUnique({ where: { id: pedido.id } })).estado, 'CANCELADO');
  });
});

describe('cliente en la venta', () => {
  test('se liga un cliente de la empresa; uno ajeno se rechaza', async () => {
    const p = await producto(A, 'Pantalón', 120, 5);
    const c = await prisma.clienteFinal.create({ data: { empresaId: A.empresaId, nombre: 'Ana Rojas', telefono: '59170000001' } });
    const ajeno = await prisma.clienteFinal.create({ data: { empresaId: B.empresaId, nombre: 'Otro', telefono: '59170000002' } });
    await Caja.abrir(A.empresaId, A.dueno.id, 0);
    const { venta } = await vender(A, [{ productoId: p.id, cantidad: 1 }], efectivo(120), { clienteId: c.id });
    assert.equal(venta.clienteId, c.id);
    assert.equal(venta.clienteNombre, 'Ana Rojas');
    await rechaza(vender(A, [{ productoId: p.id, cantidad: 1 }], efectivo(120), { clienteId: ajeno.id }), /no existe/);
  });
});
