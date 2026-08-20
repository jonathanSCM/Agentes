// Resumen real de una categoria para la tarjeta que manda el bot por
// WhatsApp: cantidad con stock, precio desde, y hasta 2 modelos reales.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resumenCategoria } = require('../lib/services/catalogo');

const producto = (o) => ({ id: 1, nombre: 'Producto', categoriaId: 1, precio: 100, stock: 5, variantes: [], ...o });

describe('resumenCategoria', () => {
  test('categoria sin ningun producto con stock: todo vacio, nunca inventa', () => {
    const productos = [producto({ id: 1, categoriaId: 1, stock: 0 })];
    assert.deepEqual(resumenCategoria(productos, 1), { cantidad: 0, precioDesde: null, destacados: [] });
  });

  test('un solo producto con stock: destacados tiene ese unico nombre, no se repite', () => {
    const productos = [producto({ id: 1, categoriaId: 1, nombre: 'Zapatilla A', precio: 300, stock: 5 })];
    const r = resumenCategoria(productos, 1);
    assert.equal(r.cantidad, 1);
    assert.equal(r.precioDesde, 300);
    assert.deepEqual(r.destacados, ['Zapatilla A']);
  });

  test('varios productos: precio desde es el minimo real, destacados son el mas barato y el de mas stock', () => {
    const productos = [
      producto({ id: 1, categoriaId: 1, nombre: 'Cara', precio: 500, stock: 20 }),
      producto({ id: 2, categoriaId: 1, nombre: 'Barata', precio: 200, stock: 2 }),
      producto({ id: 3, categoriaId: 1, nombre: 'Media', precio: 350, stock: 1 }),
    ];
    const r = resumenCategoria(productos, 1);
    assert.equal(r.cantidad, 3);
    assert.equal(r.precioDesde, 200);
    assert.deepEqual(r.destacados, ['Barata', 'Cara']);
  });

  test('ignora productos de OTRAS categorias y sin stock', () => {
    const productos = [
      producto({ id: 1, categoriaId: 1, nombre: 'De esta', precio: 100, stock: 3 }),
      producto({ id: 2, categoriaId: 2, nombre: 'De otra categoria', precio: 50, stock: 10 }),
      producto({ id: 3, categoriaId: 1, nombre: 'Agotada', precio: 10, stock: 0 }),
    ];
    const r = resumenCategoria(productos, 1);
    assert.equal(r.cantidad, 1);
    assert.equal(r.precioDesde, 100);
    assert.deepEqual(r.destacados, ['De esta']);
  });

  test('el stock de variantes cuenta para "mas stock", no el stock del producto base', () => {
    const productos = [
      producto({ id: 1, categoriaId: 1, nombre: 'Sin variantes, poco', precio: 150, stock: 1 }),
      producto({ id: 2, categoriaId: 1, nombre: 'Con variantes, mucho', precio: 200, stock: 0, variantes: [{ activa: true, stock: 5 }, { activa: true, stock: 8 }] }),
    ];
    const r = resumenCategoria(productos, 1);
    assert.equal(r.cantidad, 2);
    assert.deepEqual(r.destacados, ['Sin variantes, poco', 'Con variantes, mucho']);
  });

  describe('fotoDestacada - para la tarjeta de categoria cuando la tienda no cargo una foto propia', () => {
    test('usa la foto del producto mas barato si la tiene', () => {
      const productos = [
        producto({ id: 1, categoriaId: 1, nombre: 'Barata', precio: 100, stock: 5, fotos: ['barata.jpg'] }),
        producto({ id: 2, categoriaId: 1, nombre: 'Cara', precio: 500, stock: 5, fotos: ['cara.jpg'] }),
      ];
      const r = resumenCategoria(productos, 1);
      assert.equal(r.fotoDestacada, 'barata.jpg');
    });

    test('si el mas barato no tiene foto, usa la del de mas stock', () => {
      const productos = [
        producto({ id: 1, categoriaId: 1, nombre: 'Barata sin foto', precio: 100, stock: 1, fotos: [] }),
        producto({ id: 2, categoriaId: 1, nombre: 'Con mas stock', precio: 500, stock: 50, fotos: ['stock.jpg'] }),
      ];
      const r = resumenCategoria(productos, 1);
      assert.equal(r.fotoDestacada, 'stock.jpg');
    });

    test('si ningun destacado tiene foto, devuelve null (nunca inventa una URL)', () => {
      const productos = [producto({ id: 1, categoriaId: 1, nombre: 'Sin fotos', precio: 100, stock: 5, fotos: [] })];
      const r = resumenCategoria(productos, 1);
      assert.equal(r.fotoDestacada, null);
    });
  });
});
