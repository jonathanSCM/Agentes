// Resumen comercial: periodos en la zona del negocio, canales sin doble conteo, utilidad solo con costo.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const R = require('../lib/services/resumenComercial');

const SLUGS = ['test-resumen-a', 'test-resumen-b'];
// 10-nov-2026 11:00 en La Paz (UTC-4)
const AHORA = new Date('2026-11-10T15:00:00Z');
let A; let B; let tokenSeq = 0;

describe('periodos', () => {
  test('"hoy" empieza a medianoche de la zona del negocio, no del servidor', () => {
    const r = R.rangoDe('hoy', 'America/La_Paz', AHORA);
    assert.equal(r.desde.toISOString(), '2026-11-10T04:00:00.000Z');
    assert.equal(r.hasta.toISOString(), '2026-11-11T04:00:00.000Z');
    assert.equal(r.dias, 1);
  });

  test('7 días incluye hoy y el periodo anterior mide lo mismo', () => {
    const r = R.rangoDe('7d', 'America/La_Paz', AHORA);
    assert.equal(r.dias, 7);
    assert.equal(r.desde.toISOString(), '2026-11-04T04:00:00.000Z');
    assert.equal(r.anteriorHasta.getTime(), r.desde.getTime());
    assert.equal(r.hasta.getTime() - r.desde.getTime(), r.desde.getTime() - r.anteriorDesde.getTime());
  });

  test('"mes" arranca el día 1 y un periodo desconocido cae al de por defecto', () => {
    assert.equal(R.rangoDe('mes', 'America/La_Paz', AHORA).desde.toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(R.rangoDe('quien-sabe', 'America/La_Paz', AHORA).periodo, R.PERIODO_POR_DEFECTO);
  });

  test('variación contra el periodo anterior', () => {
    assert.equal(R.variacion(150, 100), 50);
    assert.equal(R.variacion(50, 100), -50);
    assert.equal(R.variacion(0, 0), 0);
    assert.equal(R.variacion(10, 0), null, 'sin base de comparación no se inventa un porcentaje');
  });
});

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug } });
  const cat = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'General' } });
  return { empresaId: e.id, categoriaId: cat.id, numero: 0 };
}
const producto = (ctx, nombre, precio, extra = {}) => prisma.producto.create({ data: { empresaId: ctx.empresaId, categoriaId: ctx.categoriaId, nombre, precio, stock: 10, ...extra } });

async function venta(ctx, { fecha, items, estado = 'COMPLETADA', pedidoId = null, pagos = [] }) {
  const total = items.reduce((s, i) => s + i.precio * i.cantidad, 0);
  ctx.numero += 1;
  return prisma.venta.create({
    data: {
      empresaId: ctx.empresaId, numero: ctx.numero, subtotal: total, total, estado, pedidoId,
      tokenRecibo: `tok-resumen-${Date.now()}-${tokenSeq += 1}`, createdAt: fecha,
      items: { create: items.map((i) => ({ productoId: i.productoId, nombre: i.nombre, cantidad: i.cantidad, precioUnitario: i.precio, total: i.precio * i.cantidad, costoUnitario: i.costo ?? null })) },
      pagos: { create: pagos.map((p) => ({ metodo: p.metodo, monto: p.monto })) },
    },
  });
}
const pedido = (ctx, { fecha, items, estado = 'NUEVO' }) => prisma.pedido.create({
  data: {
    empresaId: ctx.empresaId, estado, createdAt: fecha, total: items.reduce((s, i) => s + i.precio * i.cantidad, 0),
    items: { create: items.map((i) => ({ productoId: i.productoId, nombre: i.nombre, precio: i.precio, cantidad: i.cantidad })) },
  },
});

describe('resumen contra la base', () => {
  let camisa; let gorra; let cobrado;
  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
    A = await empresa(SLUGS[0]);
    B = await empresa(SLUGS[1]);
    camisa = await producto(A, 'Camisa', 100, { costo: 60 });
    gorra = await producto(A, 'Gorra', 50); // sin costo cargado

    // Mostrador, hoy (22:00 en La Paz = 02:00 UTC del día siguiente: debe contar como HOY).
    await venta(A, { fecha: new Date('2026-11-11T02:00:00Z'), items: [{ productoId: camisa.id, nombre: 'Camisa', cantidad: 2, precio: 100, costo: 60 }], pagos: [{ metodo: 'EFECTIVO', monto: 200 }] });
    await venta(A, { fecha: new Date('2026-11-10T14:00:00Z'), items: [{ productoId: gorra.id, nombre: 'Gorra', cantidad: 1, precio: 50 }], pagos: [{ metodo: 'QR', monto: 50 }] });
    // Anulada: no cuenta.
    await venta(A, { fecha: new Date('2026-11-10T14:30:00Z'), estado: 'ANULADA', items: [{ productoId: camisa.id, nombre: 'Camisa', cantidad: 5, precio: 100, costo: 60 }] });
    // Pedido por WhatsApp sin cobrar en el mostrador, hoy.
    await pedido(A, { fecha: new Date('2026-11-10T13:00:00Z'), items: [{ productoId: camisa.id, nombre: 'Camisa', cantidad: 1, precio: 100 }] });
    // Pedido cancelado: no cuenta.
    await pedido(A, { fecha: new Date('2026-11-10T13:10:00Z'), estado: 'CANCELADO', items: [{ productoId: camisa.id, nombre: 'Camisa', cantidad: 9, precio: 100 }] });
    // Pedido que se cobró en el mostrador: debe contar UNA vez (la venta).
    cobrado = await pedido(A, { fecha: new Date('2026-11-10T12:00:00Z'), items: [{ productoId: gorra.id, nombre: 'Gorra', cantidad: 2, precio: 50 }] });
    await venta(A, { fecha: new Date('2026-11-10T12:30:00Z'), pedidoId: cobrado.id, items: [{ productoId: gorra.id, nombre: 'Gorra', cantidad: 2, precio: 50 }], pagos: [{ metodo: 'TRANSFERENCIA', monto: 100 }] });
    // Del periodo anterior (hace 8 días).
    await venta(A, { fecha: new Date('2026-11-02T15:00:00Z'), items: [{ productoId: camisa.id, nombre: 'Camisa', cantidad: 1, precio: 100, costo: 60 }] });
    // Otra empresa: no debe aparecer.
    const otro = await producto(B, 'Ajeno', 999);
    await venta(B, { fecha: AHORA, items: [{ productoId: otro.id, nombre: 'Ajeno', cantidad: 1, precio: 999 }] });
  });
  after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

  test('suma los dos canales una sola vez y deja afuera anuladas y canceladas', async () => {
    const r = await R.resumen(A.empresaId, 'hoy', { ahora: AHORA });
    // mostrador: 200 + 50 + 100 (el pedido cobrado) = 350 ; whatsapp: 100
    assert.equal(r.canal.mostrador.ingresos, 350);
    assert.equal(r.canal.mostrador.ventas, 3);
    assert.equal(r.canal.whatsapp.ingresos, 100);
    assert.equal(r.canal.whatsapp.ventas, 1);
    assert.equal(r.ingresos, 450);
    assert.equal(r.ventas, 4);
    assert.equal(r.ticketPromedio, 112.5);
    assert.equal(r.ventasAnuladas, 1);
  });

  test('la utilidad solo cuenta lo que tiene costo y avisa cuánto quedó sin costo', async () => {
    const r = await R.resumen(A.empresaId, 'hoy', { ahora: AHORA });
    // Camisa mostrador: 200 - 120 = 80 ; Camisa WhatsApp usa el costo del producto: 100 - 60 = 40
    assert.equal(r.utilidad, 120);
    assert.equal(r.sinCosto, 150, 'las gorras (50 + 100) no tienen costo');
    assert.equal(r.margen, Math.round((120 / 300) * 1000) / 10);
  });

  test('sin ningún costo cargado no se inventa utilidad', async () => {
    const r = await R.resumen(B.empresaId, 'hoy', { ahora: AHORA });
    assert.equal(r.utilidad, null);
    assert.equal(r.margen, null);
    assert.equal(r.ingresos, 999);
  });

  test('compara con el periodo anterior y no mezcla empresas', async () => {
    const r = await R.resumen(A.empresaId, '7d', { ahora: AHORA });
    assert.equal(r.ingresos, 450);
    assert.equal(r.vsAnterior.ingresos, 350, '450 contra 100 del periodo anterior = +350 %');
    assert.ok(!r.masVendidos.some((p) => p.nombre === 'Ajeno'));
  });

  test('cobros por método, más vendidos y pedidos por cobrar', async () => {
    const r = await R.resumen(A.empresaId, 'hoy', { ahora: AHORA });
    assert.deepEqual(r.porMetodo.map((p) => p.metodo).sort(), ['EFECTIVO', 'QR', 'TRANSFERENCIA']);
    assert.equal(r.masVendidos[0].nombre, 'Camisa');
    assert.equal(r.masVendidos[0].unidades, 3);
    assert.equal(r.masVendidos[0].utilidad, 120);
    assert.equal(r.masVendidos.find((p) => p.nombre === 'Gorra').utilidad, null);
    assert.equal(r.porCobrar.pedidos, 2, 'el nuevo y el que se cobró en el mostrador siguen sin entregar');
  });

  test('una devolución resta lo vendido y la utilidad, sin contar como una venta más', async () => {
    const v = await prisma.venta.findFirst({ where: { empresaId: A.empresaId, estado: 'COMPLETADA', items: { some: { nombre: 'Camisa', cantidad: 2 } } }, include: { items: true } });
    await prisma.devolucion.create({
      data: {
        empresaId: A.empresaId, ventaId: v.id, metodo: 'EFECTIVO', monto: 100, repone: true, motivo: 'talla equivocada', createdAt: new Date('2026-11-10T16:00:00Z'),
        items: { create: [{ ventaItemId: v.items[0].id, cantidad: 1, monto: 100 }] },
      },
    });
    const r = await R.resumen(A.empresaId, 'hoy', { ahora: new Date('2026-11-10T17:00:00Z') });
    assert.equal(r.ingresos, 350, '450 − 100 devueltos');
    assert.equal(r.ventas, 4, 'la devolución no es una venta más');
    assert.equal(r.canal.mostrador.ingresos, 250);
    assert.equal(r.utilidad, 120 - 40, 'se resta la ganancia de esa unidad (100 de ingreso − 60 de costo)');
    assert.equal(r.masVendidos.find((p) => p.nombre === 'Camisa').unidades, 2, 'de 3 camisas vendidas, 1 volvió');
  });

  test('la serie diaria cubre todos los días del periodo y el Excel trae una fila por línea', async () => {
    const r = await R.resumen(A.empresaId, '7d', { ahora: AHORA });
    assert.equal(r.serie.length, 7);
    assert.equal(r.serie[r.serie.length - 1].total, 350, '450 vendidos − 100 devueltos');
    const { filas } = await R.filasParaExcel(A.empresaId, 'hoy', { ahora: AHORA });
    assert.equal(filas.length, 5, '4 líneas vendidas + 1 devuelta');
    assert.ok(filas.some((f) => f.cantidad === -1 && f.ingreso === -100), 'la devolución sale como línea negativa');
    assert.ok(filas.some((f) => f.canal === 'WhatsApp' && f.referencia.startsWith('Pedido #')));
    assert.ok(filas.some((f) => /^V-\d{4}$/.test(f.referencia)));
    assert.ok(filas.every((f) => !f.referencia.includes('Ajeno')));
  });
});
