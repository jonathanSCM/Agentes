// Códigos de barras: normalización, duplicados dentro de la empresa y búsqueda por lector.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const C = require('../lib/services/codigosBarras');

const SLUGS = ['test-barras-a', 'test-barras-b'];
let A; let B;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  A = (await prisma.empresa.create({ data: { nombre: 'A', slug: SLUGS[0] } })).id;
  B = (await prisma.empresa.create({ data: { nombre: 'B', slug: SLUGS[1] } })).id;
  await prisma.producto.create({ data: { empresaId: A, nombre: 'Gaseosa', precio: 10, stock: 5, codigoBarras: '7750001', sku: 'GAS-1' } });
  await prisma.producto.create({
    data: { empresaId: A, nombre: 'Polera', precio: 100, stock: 0, variantes: { create: [{ atributos: { Talla: 'M' }, stock: 3, codigoBarras: '7750002' }, { atributos: { Talla: 'L' }, stock: 2, codigoBarras: '7750003', activa: false }] } },
  });
  await prisma.producto.create({ data: { empresaId: A, nombre: 'Descontinuado', precio: 5, stock: 1, codigoBarras: '7750009', activo: false } });
  await prisma.producto.create({ data: { empresaId: B, nombre: 'Producto de B', precio: 10, stock: 5, codigoBarras: '7750001' } });
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
});

describe('normalizar', () => {
  test('recorta, saca caracteres de control y devuelve null si queda vacío', () => {
    assert.equal(C.normalizar('  7750001 \n'), '7750001');
    assert.equal(C.normalizar('77\u0000500'), '77500');
    assert.equal(C.normalizar('   '), null);
    assert.equal(C.normalizar(undefined), null);
    assert.equal(C.normalizar('x'.repeat(200)).length, C.MAX_LARGO);
  });
});

describe('duplicados', () => {
  test('un código ya usado por un producto o una variante de la empresa se rechaza', async () => {
    assert.match(await C.duplicado(A, '7750001'), /Gaseosa/);
    assert.match(await C.duplicado(A, '7750002'), /Polera/);
    assert.equal(await C.duplicado(A, '999'), null);
    assert.equal(await C.duplicado(A, ''), null);
  });
  test('al editar no choca contra uno mismo', async () => {
    const p = await prisma.producto.findFirst({ where: { empresaId: A, codigoBarras: '7750001' } });
    assert.equal(await C.duplicado(A, '7750001', { excluirProductoId: p.id }), null);
    const v = await prisma.variante.findFirst({ where: { codigoBarras: '7750002' } });
    assert.equal(await C.duplicado(A, '7750002', { excluirVarianteId: v.id }), null);
  });
  test('el mismo código en OTRA empresa es válido (cada negocio tiene su catálogo)', async () => {
    assert.equal(await C.duplicado(B, '7750002'), null);
    assert.match(await C.duplicado(B, '7750001'), /Producto de B/);
  });
});

describe('buscar (lector del punto de venta)', () => {
  test('encuentra por código de barras de producto, de variante y por SKU', async () => {
    assert.equal((await C.buscar(A, '7750001')).producto.nombre, 'Gaseosa');
    const v = await C.buscar(A, '7750002');
    assert.equal(v.producto.nombre, 'Polera');
    assert.deepEqual(v.variante.atributos, { Talla: 'M' });
    assert.equal((await C.buscar(A, 'GAS-1')).producto.nombre, 'Gaseosa');
  });
  test('no devuelve variantes ni productos inactivos, ni los de otra empresa, ni códigos que no existen', async () => {
    assert.equal(await C.buscar(A, '7750003'), null, 'variante inactiva');
    assert.equal(await C.buscar(A, '7750009'), null, 'producto inactivo');
    assert.equal((await C.buscar(B, '7750001')).producto.nombre, 'Producto de B');
    assert.equal(await C.buscar(B, '7750002'), null);
    assert.equal(await C.buscar(A, 'no-existe'), null);
    assert.equal(await C.buscar(A, ''), null);
  });
});
