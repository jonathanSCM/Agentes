// Stock unificado: descuento atómico (sin sobreventa), historial, aislamiento por empresa y restricciones de la base.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const S = require('../lib/services/stock');

const SLUGS = ['test-stock-a', 'test-stock-b'];
let A; let B;

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug } });
  const cat = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'Calzado' } });
  return { empresaId: e.id, categoriaId: cat.id };
}
const producto = (ctx, nombre, stock, extra = {}) => prisma.producto.create({ data: { empresaId: ctx.empresaId, categoriaId: ctx.categoriaId, nombre, precio: 100, stock, ...extra }, include: { variantes: true } });
const conTx = (fn) => prisma.$transaction(fn);
const stockDe = async (id) => (await prisma.producto.findUnique({ where: { id } })).stock;
const rechaza = (promesa, patron) => assert.rejects(promesa, (e) => { assert.equal(e.codigo, 'STOCK'); assert.match(e.message, patron); return true; });

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  A = await empresa(SLUGS[0]);
  B = await empresa(SLUGS[1]);
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
});

describe('descontar', () => {
  test('baja el stock y deja el movimiento con antes y después', async () => {
    const p = await producto(A, 'Zapatilla', 10);
    const [m] = await conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 3 }], tipo: 'PEDIDO', referenciaTipo: 'Pedido', referenciaId: 77 }));
    assert.equal(await stockDe(p.id), 7);
    assert.equal(m.cantidad, -3);
    assert.equal(m.stockAntes, 10);
    assert.equal(m.stockDespues, 7);
    assert.equal(m.tipo, 'PEDIDO');
    assert.equal(m.referenciaId, 77);
    assert.equal(m.nombre, 'Zapatilla');
  });

  test('con variantes descuenta de la variante y guarda su nombre', async () => {
    const p = await producto(A, 'Polera', 0, { variantes: { create: [{ atributos: { Talla: 'M', Color: 'Negro' }, stock: 4 }] } });
    const v = p.variantes[0];
    const [m] = await conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, varianteId: v.id, cantidad: 2 }] }));
    assert.equal((await prisma.variante.findUnique({ where: { id: v.id } })).stock, 2);
    assert.match(m.nombre, /^Polera \((Negro M|M Negro)\)$/);
  });

  test('si no alcanza, rechaza con el stock real y NO cambia nada (la transacción se deshace)', async () => {
    const p = await producto(A, 'Gorra', 2);
    const otro = await producto(A, 'Medias', 5);
    await rechaza(conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: otro.id, cantidad: 1 }, { productoId: p.id, cantidad: 3 }] })), /quedan 2/);
    assert.equal(await stockDe(p.id), 2);
    assert.equal(await stockDe(otro.id), 5, 'la línea anterior también se deshizo');
    assert.equal(await prisma.movimientoStock.count({ where: { productoId: { in: [p.id, otro.id] } } }), 0);
  });

  test('valida las cantidades: enteras, mayores a 0 y con tope', async () => {
    const p = await producto(A, 'Cinturón', 10);
    for (const cantidad of [0, -1, 1.5, NaN, 'abc', S.MAX_CANTIDAD + 1]) {
      await rechaza(conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad }] })), /entero mayor a 0/);
    }
    assert.equal(await stockDe(p.id), 10);
  });

  test('una empresa no puede mover el stock de otra', async () => {
    const p = await producto(B, 'Producto de B', 5);
    await rechaza(conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 1 }] })), /no existe/);
    assert.equal(await stockDe(p.id), 5);
  });
});

describe('la carrera por la última unidad', () => {
  test('20 ventas simultáneas por 5 unidades: pasan exactamente 5 y nunca hay sobreventa', async () => {
    const p = await producto(A, 'Última zapatilla', 5);
    const intentos = Array.from({ length: 20 }, (_, i) => conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 1 }], referenciaTipo: 'Prueba', referenciaId: i })));
    const resultados = await Promise.allSettled(intentos);
    const ok = resultados.filter((r) => r.status === 'fulfilled').length;
    const fallos = resultados.filter((r) => r.status === 'rejected');
    assert.equal(ok, 5);
    assert.equal(fallos.length, 15);
    assert.ok(fallos.every((f) => f.reason.codigo === 'STOCK'), 'todos los rechazos son por falta de stock');
    assert.equal(await stockDe(p.id), 0);
    assert.equal(await prisma.movimientoStock.count({ where: { productoId: p.id, tipo: 'PEDIDO' } }), 5);
  });

  test('dos pedidos con los mismos productos en distinto orden no se traban entre sí', async () => {
    const x = await producto(A, 'X', 10);
    const y = await producto(A, 'Y', 10);
    const orden1 = [{ productoId: x.id, cantidad: 1 }, { productoId: y.id, cantidad: 1 }];
    const orden2 = [{ productoId: y.id, cantidad: 1 }, { productoId: x.id, cantidad: 1 }];
    const lote = [];
    for (let i = 0; i < 10; i += 1) lote.push(conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: i % 2 ? orden1 : orden2 })));
    const r = await Promise.allSettled(lote);
    assert.equal(r.filter((q) => q.status === 'fulfilled').length, 10);
    assert.equal(await stockDe(x.id), 0);
    assert.equal(await stockDe(y.id), 0);
  });
});

describe('reponer y fijar', () => {
  test('reponer suma y registra; la cancelación devuelve lo que salió', async () => {
    const p = await producto(A, 'Bufanda', 5);
    await conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 2 }] }));
    const [m] = await conTx((tx) => S.reponer(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 2 }], tipo: 'CANCELACION_PEDIDO', referenciaTipo: 'Pedido', referenciaId: 9 }));
    assert.equal(await stockDe(p.id), 5);
    assert.equal(m.cantidad, 2);
    assert.equal(m.stockAntes, 3);
    assert.equal(m.stockDespues, 5);
  });

  test('fijar deja un valor exacto, registra la diferencia y no registra si no cambia', async () => {
    const p = await producto(A, 'Guantes', 10);
    const m = await conTx((tx) => S.fijar(tx, { empresaId: A.empresaId, productoId: p.id, stock: 4, nota: 'conteo' }));
    assert.equal(await stockDe(p.id), 4);
    assert.equal(m.cantidad, -6);
    assert.equal(m.tipo, 'AJUSTE');
    assert.equal(await conTx((tx) => S.fijar(tx, { empresaId: A.empresaId, productoId: p.id, stock: 4 })), null);
    await rechaza(conTx((tx) => S.fijar(tx, { empresaId: A.empresaId, productoId: p.id, stock: -1 })), /entero/);
  });

  test('stock inicial: registra con lo que nace el producto (y nada si nace en 0)', async () => {
    const con = await producto(A, 'Nuevo con stock', 8);
    const sin = await producto(A, 'Nuevo sin stock', 0);
    const m = await conTx((tx) => S.registrarInicial(tx, { empresaId: A.empresaId, productoId: con.id }));
    assert.equal(m.tipo, 'INICIAL');
    assert.equal(m.stockAntes, 0);
    assert.equal(m.stockDespues, 8);
    assert.equal(await conTx((tx) => S.registrarInicial(tx, { empresaId: A.empresaId, productoId: sin.id })), null);
  });
});

describe('historial y red de seguridad de la base', () => {
  test('el historial se lista por empresa, más nuevo primero, con filtros', async () => {
    const p = await producto(A, 'Para historial', 10);
    await conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 1 }] }));
    await conTx((tx) => S.reponer(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 1 }] }));
    const lista = await S.listarMovimientos(A.empresaId, { productoId: p.id });
    assert.deepEqual(lista.map((m) => m.tipo), ['CANCELACION_PEDIDO', 'PEDIDO']);
    assert.deepEqual((await S.listarMovimientos(A.empresaId, { productoId: p.id, tipo: 'PEDIDO' })).map((m) => m.tipo), ['PEDIDO']);
    assert.equal((await S.listarMovimientos(B.empresaId, { productoId: p.id })).length, 0, 'otra empresa no lo ve');
  });

  test('la base rechaza un stock negativo aunque falle el código', async () => {
    const p = await producto(A, 'Protegido', 1);
    await assert.rejects(prisma.$executeRaw`UPDATE "productos" SET "stock" = -1 WHERE "id" = ${p.id}`, /stock_no_negativo|check/i);
    assert.equal(await stockDe(p.id), 1);
  });

  test('si se borra el producto el historial se conserva con su nombre', async () => {
    const p = await producto(A, 'Se va a borrar', 3);
    await conTx((tx) => S.descontar(tx, { empresaId: A.empresaId, lineas: [{ productoId: p.id, cantidad: 1 }] }));
    await prisma.producto.delete({ where: { id: p.id } });
    const [m] = await prisma.movimientoStock.findMany({ where: { empresaId: A.empresaId, nombre: 'Se va a borrar' } });
    assert.equal(m.productoId, null);
    assert.equal(m.cantidad, -1);
  });
});
