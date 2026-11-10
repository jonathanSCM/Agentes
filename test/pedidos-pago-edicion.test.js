// Pedidos del bot: pago previo (QR/tarjeta) que no se cobra dos veces, y edición (sumar, quitar, cambiar) con stock exacto.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const PP = require('../lib/services/pedidosPago');
const ventas = require('../lib/services/ventas');
const caja = require('../lib/services/caja');

const SLUGS = ['test-pedpago-a', 'test-pedpago-b'];
let A; let B; let dueno; let remera; let gorra; let jean; let jeanV; let ajena;
const U = () => ({ id: dueno.id, rol: 'OWNER' });
const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.match(e.codigo, /PEDIDO|VENTA/); assert.match(e.message, patron); return true; });
const stockDe = async (id) => (await prisma.producto.findUnique({ where: { id } })).stock;
const efectivo = async () => (await caja.resumen((await caja.sesionAbierta(A.id)).id)).efectivoEsperadoCentavos;

// Un pedido como los que crea el bot: el stock ya se descontó al crearlo.
async function pedido(items, extra = {}) {
  const total = items.reduce((t, i) => t + i.precio * i.cantidad, 0);
  for (const i of items) await prisma.producto.update({ where: { id: i.producto.id }, data: { stock: { decrement: i.cantidad } } });
  return prisma.pedido.create({ data: { empresaId: A.id, total, estado: 'NUEVO', formaPago: 'QR', ...extra, items: { create: items.map((i) => ({ productoId: i.producto.id, nombre: i.producto.nombre, precio: i.precio, cantidad: i.cantidad })) } }, include: { items: true } });
}

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: 'pedpago@test.local' } });
  A = await prisma.empresa.create({ data: { nombre: 'Pedpago A', slug: SLUGS[0] } });
  B = await prisma.empresa.create({ data: { nombre: 'Pedpago B', slug: SLUGS[1] } });
  dueno = await prisma.usuario.create({ data: { empresaId: A.id, email: 'pedpago@test.local', nombre: 'Dueña', passwordHash: 'x', rol: 'OWNER' } });
  remera = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Remera', precio: 100, stock: 50 } });
  gorra = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Gorra', precio: 30, stock: 3 } });
  jean = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Jean', precio: 200, stock: 0 } });
  jeanV = await prisma.variante.create({ data: { productoId: jean.id, atributos: { Talla: '42' }, stock: 5 } });
  ajena = await prisma.producto.create({ data: { empresaId: B.id, nombre: 'Taza ajena', precio: 10, stock: 9 } });
  await caja.abrir(A.id, dueno.id, 100);
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: 'pedpago@test.local' } });
});

describe('pago previo', () => {
  test('un pedido pagado por QR no se cobra de nuevo: solo se entrega, sin mover el efectivo', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 2 }]);
    await PP.confirmarPago(A.id, U(), p.id, 'QR');
    const estado = PP.estadoDePago(await prisma.pedido.findUnique({ where: { id: p.id } }));
    assert.equal(estado.pagado, true);
    assert.equal(estado.saldoCentavos, 0);
    const e0 = await efectivo();
    await rechaza(ventas.cobrarPedido(A.id, U(), p.id, { pagos: [{ metodo: 'EFECTIVO', monto: 200, recibido: 200 }] }), /ya está pagado/);
    const { venta } = await ventas.cobrarPedido(A.id, U(), p.id, { pagos: [], claveIdempotencia: 'ent-1' });
    assert.equal(Number(venta.total), 200);
    assert.deepEqual(venta.pagos.map((x) => [x.metodo, Number(x.monto)]), [['QR', 200]]);
    assert.equal(await efectivo(), e0, 'el QR no entra a la caja de efectivo');
    assert.equal((await prisma.pedido.findUnique({ where: { id: p.id } })).estado, 'ENTREGADO');
    await rechaza(ventas.cobrarPedido(A.id, U(), p.id, { pagos: [] }), /ya está entregado/);
  });
  test('un pedido en efectivo se cobra normal y entra a la caja', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }], { formaPago: 'EFECTIVO' });
    const e0 = await efectivo();
    await ventas.cobrarPedido(A.id, U(), p.id, { pagos: [{ metodo: 'EFECTIVO', monto: 100, recibido: 100 }] });
    assert.equal(await efectivo(), e0 + 10000);
  });
  test('solo QR, tarjeta o transferencia; una sola vez; no en pedidos cerrados ni de otra empresa', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    await rechaza(PP.confirmarPago(A.id, U(), p.id, 'EFECTIVO'), /efectivo se cobra/);
    await PP.confirmarPago(A.id, U(), p.id, 'tarjeta');
    await rechaza(PP.confirmarPago(A.id, U(), p.id, 'QR'), /ya tiene un pago/);
    await rechaza(PP.confirmarPago(B.id, U(), p.id, 'QR'), /no existe/);
    await prisma.pedido.update({ where: { id: p.id }, data: { estado: 'CANCELADO' } });
    await rechaza(PP.quitarPago(A.id, U(), p.id), /cancelado/);
  });
  test('dos confirmaciones a la vez: solo una pasa', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    const rs = await Promise.allSettled([PP.confirmarPago(A.id, U(), p.id, 'QR'), PP.confirmarPago(A.id, U(), p.id, 'QR')]);
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  });
  test('quitar el pago deja el pedido por cobrar otra vez', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    await PP.confirmarPago(A.id, U(), p.id, 'QR');
    await PP.quitarPago(A.id, U(), p.id);
    assert.equal(PP.estadoDePago(await prisma.pedido.findUnique({ where: { id: p.id } })).saldoCentavos, 10000);
    await rechaza(PP.quitarPago(A.id, U(), p.id), /no tenía un pago/);
  });
});

describe('editar un pedido', () => {
  test('sumar un producto baja el stock; quitar y bajar cantidad lo devuelven; el total se recalcula', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 2 }]);
    const r0 = await stockDe(remera.id); const g0 = await stockDe(gorra.id);
    const it = p.items[0];
    const r = await PP.editar(A.id, U(), p.id, { items: [{ itemId: it.id, cantidad: 1 }, { productoId: gorra.id, cantidad: 2 }] });
    assert.equal(r.totalAntes, 200);
    assert.equal(r.totalDespues, 160);
    assert.equal(await stockDe(remera.id), r0 + 1, 'devolvió una remera');
    assert.equal(await stockDe(gorra.id), g0 - 2, 'reservó dos gorras');
    assert.equal(Number((await prisma.pedido.findUnique({ where: { id: p.id } })).total), 160);
    const movs = await prisma.movimientoStock.findMany({ where: { empresaId: A.id, referenciaTipo: 'Pedido', referenciaId: p.id } });
    assert.equal(movs.length, 2);
    // Ahora se quita la remera por completo.
    const itemRemera = (await prisma.pedidoItem.findMany({ where: { pedidoId: p.id } })).find((i) => i.productoId === remera.id);
    await PP.editar(A.id, U(), p.id, { items: [{ itemId: itemRemera.id, cantidad: 0 }, { itemId: (await prisma.pedidoItem.findFirst({ where: { pedidoId: p.id, productoId: gorra.id } })).id, cantidad: 2 }] });
    assert.equal(await stockDe(remera.id), r0 + 2);
    assert.equal(Number((await prisma.pedido.findUnique({ where: { id: p.id } })).total), 60);
  });
  test('sin stock suficiente no cambia nada (ni el stock ni el pedido)', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    const g0 = await stockDe(gorra.id); const r0 = await stockDe(remera.id);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 3 }, { productoId: gorra.id, cantidad: g0 + 5 }] }), /No hay stock/);
    assert.equal(await stockDe(gorra.id), g0);
    assert.equal(await stockDe(remera.id), r0);
    assert.equal(Number((await prisma.pedido.findUnique({ where: { id: p.id } })).total), 100);
  });
  test('un producto con opciones pide la opción; la opción suma al stock de esa opción', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1 }, { productoId: jean.id, cantidad: 1 }] }), /Elegí la opción/);
    await PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1 }, { productoId: jean.id, varianteId: jeanV.id, cantidad: 2 }] });
    assert.equal((await prisma.variante.findUnique({ where: { id: jeanV.id } })).stock, 3);
    const nuevo = await prisma.pedidoItem.findFirst({ where: { pedidoId: p.id, varianteId: jeanV.id } });
    assert.match(nuevo.nombre, /Jean \(42\)/);
    assert.equal(Number((await prisma.pedido.findUnique({ where: { id: p.id } })).total), 500);
  });
  test('valida: vacío, cantidades raras, producto de otra empresa, línea ajena', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    const otro = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 0 }] }), /sin productos/);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1.5 }] }), /entero/);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: -1 }] }), /entero/);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1 }, { productoId: ajena.id, cantidad: 1 }] }), /ya no está disponible/);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: otro.items[0].id, cantidad: 1 }] }), /ya no existe/);
    await rechaza(PP.editar(B.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1 }] }), /no existe/);
    assert.equal(await stockDe(ajena.id), 9);
  });
  test('un pedido entregado o cancelado no se edita', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    await prisma.pedido.update({ where: { id: p.id }, data: { estado: 'ENTREGADO' } });
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 2 }] }), /ya está entregado/);
  });
  test('pedido ya pagado: no puede quedar por debajo de lo pagado; si sube, se cobra solo la diferencia', async () => {
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 2 }]);
    await PP.confirmarPago(A.id, U(), p.id, 'QR');
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1 }] }), /ya pagó 200.00/);
    await PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 2 }, { productoId: gorra.id, cantidad: 1 }] });
    const est = PP.estadoDePago(await prisma.pedido.findUnique({ where: { id: p.id } }));
    assert.equal(est.parcial, true);
    assert.equal(est.saldoCentavos, 3000);
    const e0 = await efectivo();
    await rechaza(ventas.cobrarPedido(A.id, U(), p.id, { pagos: [{ metodo: 'EFECTIVO', monto: 230, recibido: 230 }] }), /suman|total|falta|más/i);
    const { venta } = await ventas.cobrarPedido(A.id, U(), p.id, { pagos: [{ metodo: 'EFECTIVO', monto: 30, recibido: 50 }] });
    assert.equal(Number(venta.total), 230);
    assert.deepEqual(venta.pagos.map((x) => [x.metodo, Number(x.monto)]), [['QR', 200], ['EFECTIVO', 30]]);
    assert.equal(await efectivo(), e0 + 3000, 'a la caja solo entra la diferencia en efectivo');
  });
  test('dos ediciones a la vez por el último producto: una sola pasa y el stock nunca queda negativo', async () => {
    const solo = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Ultima', precio: 10, stock: 1 } });
    const p1 = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    const p2 = await pedido([{ producto: remera, precio: 100, cantidad: 1 }]);
    const rs = await Promise.allSettled([
      PP.editar(A.id, U(), p1.id, { items: [{ itemId: p1.items[0].id, cantidad: 1 }, { productoId: solo.id, cantidad: 1 }] }),
      PP.editar(A.id, U(), p2.id, { items: [{ itemId: p2.items[0].id, cantidad: 1 }, { productoId: solo.id, cantidad: 1 }] }),
    ]);
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await stockDe(solo.id), 0);
  });
  test('si el producto se borró del catálogo la línea solo se puede quitar', async () => {
    const efimero = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Efímero', precio: 5, stock: 5 } });
    const p = await pedido([{ producto: remera, precio: 100, cantidad: 1 }, { producto: efimero, precio: 5, cantidad: 1 }]);
    await prisma.producto.delete({ where: { id: efimero.id } });
    const it = (await prisma.pedidoItem.findMany({ where: { pedidoId: p.id } })).find((i) => i.nombre === 'Efímero');
    assert.equal(it.productoId, null);
    await rechaza(PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1 }, { itemId: it.id, cantidad: 3 }] }), /solo se puede quitar/);
    await PP.editar(A.id, U(), p.id, { items: [{ itemId: p.items[0].id, cantidad: 1 }, { itemId: it.id, cantidad: 0 }] });
    assert.equal(Number((await prisma.pedido.findUnique({ where: { id: p.id } })).total), 100);
  });
});
