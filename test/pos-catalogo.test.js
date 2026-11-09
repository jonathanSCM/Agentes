// Buscador del punto de venta: nombre, SKU, código de barras exacto (lector) y opciones.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const C = require('../lib/services/posCatalogo');

const SLUGS = ['test-poscat-a', 'test-poscat-b'];
let A; let B;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  A = (await prisma.empresa.create({ data: { nombre: 'A', slug: SLUGS[0] } })).id;
  B = (await prisma.empresa.create({ data: { nombre: 'B', slug: SLUGS[1] } })).id;
  await prisma.producto.create({ data: { empresaId: A, nombre: 'Gaseosa Cola', precio: 8, stock: 10, codigoBarras: '7751000', sku: 'COLA-1' } });
  await prisma.producto.create({ data: { empresaId: A, nombre: 'Agotado', precio: 5, stock: 0, codigoBarras: '7751001' } });
  await prisma.producto.create({
    data: { empresaId: A, nombre: 'Polera Rayada', precio: 100, stock: 0, codigoBarras: '7751002', variantes: { create: [{ atributos: { Talla: 'M' }, stock: 3, precio: 110, codigoBarras: '7751003' }, { atributos: { Talla: 'L' }, stock: 0 }] } },
  });
  await prisma.producto.create({ data: { empresaId: A, nombre: 'Oculto', precio: 5, stock: 5, activo: false } });
  await prisma.producto.create({ data: { empresaId: B, nombre: 'Gaseosa de B', precio: 8, stock: 5, codigoBarras: '7751000' } });
});
after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

describe('lector de códigos', () => {
  test('un código exacto devuelve la línea lista para el carrito', async () => {
    const r = await C.buscar(A, '7751000');
    assert.equal(r.exacto.nombre, 'Gaseosa Cola');
    assert.equal(r.exacto.precio, 8);
    assert.equal(r.exacto.varianteId, null);
    assert.equal((await C.buscar(A, 'COLA-1')).exacto.productoId, r.exacto.productoId, 'también por SKU exacto');
  });

  test('el código de una opción trae esa opción con su precio y stock', async () => {
    const r = await C.buscar(A, '7751003');
    assert.equal(r.exacto.nombre, 'Polera Rayada (M)');
    assert.equal(r.exacto.precio, 110);
    assert.equal(r.exacto.stock, 3);
    assert.ok(r.exacto.varianteId);
  });

  test('si se escanea el producto con opciones (sin opción), hay que elegir: devuelve la ficha', async () => {
    const r = await C.buscar(A, '7751002');
    assert.equal(r.exacto, null);
    assert.equal(r.productos[0].nombre, 'Polera Rayada');
    assert.equal(r.productos[0].variantes.length, 2);
  });

  test('un código de algo sin stock no se agrega y avisa cuál es', async () => {
    const r = await C.buscar(A, '7751001');
    assert.equal(r.exacto, null);
    assert.equal(r.sinStock, 'Agotado');
  });

  test('un código de otra empresa o de un producto inactivo no aparece', async () => {
    assert.equal((await C.buscar(B, '7751002')).exacto, null);
    assert.equal((await C.buscar(A, 'zzz-no-existe')).productos.length, 0);
  });
});

describe('búsqueda por texto', () => {
  test('por nombre parcial sin importar mayúsculas, con stock total sumando opciones', async () => {
    const r = await C.buscar(A, 'poler');
    assert.equal(r.productos.length, 1);
    assert.equal(r.productos[0].stock, 3);
    assert.equal(r.productos[0].tieneVariantes, true);
    assert.deepEqual(r.productos[0].variantes.map((v) => v.etiqueta), ['M', 'L']);
    assert.equal(r.productos[0].variantes[0].precio, 110);
    assert.equal(r.productos[0].variantes[1].precio, 100, 'sin precio propio usa el del producto');
  });

  test('sin texto lista los productos activos; nunca los inactivos ni los de otra empresa', async () => {
    const r = await C.buscar(A, '');
    const nombres = r.productos.map((p) => p.nombre);
    assert.ok(nombres.includes('Gaseosa Cola') && nombres.includes('Polera Rayada'));
    assert.ok(!nombres.includes('Oculto') && !nombres.includes('Gaseosa de B'));
  });
});
