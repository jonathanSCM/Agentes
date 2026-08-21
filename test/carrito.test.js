// El carrito de la conversacion: el cliente agrega, sigue mirando, agrega mas
// y al final se cierra todo junto. Antes el pedido se armaba de una sola vez y
// el modelo tenia que "acordarse" de los items.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  carritoDe, guardarCarrito, contextoSinCarrito,
  agregarItem, quitarItem, totalCarrito, resumenCarrito, itemsParaPedido,
} = require('../lib/services/carrito');

const bs = (m) => `Bs ${Number(m).toFixed(2)}`;
const item = (o) => ({ productoId: 1, varianteId: null, nombre: 'Zapa', precio: 100, cantidad: 1, ...o });

describe('carrito de la conversacion', () => {
  test('arranca vacio', () => {
    assert.deepEqual(carritoDe({}, 1), []);
    assert.deepEqual(carritoDe({ carrito: null }, 1), []);
  });

  test('el carrito de OTRA conversacion no se arrastra (el cliente que vuelve empieza limpio)', () => {
    const ctx = guardarCarrito({}, 10, [item({})]);
    assert.equal(carritoDe(ctx, 10).length, 1, 'en la misma conversacion sigue');
    assert.equal(carritoDe(ctx, 99).length, 0, 'en una conversacion nueva arranca vacio');
  });

  test('agregar el MISMO producto y variante suma cantidad', () => {
    let items = agregarItem([], item({ varianteId: 5 }));
    items = agregarItem(items, item({ varianteId: 5, cantidad: 2 }));
    assert.equal(items.length, 1);
    assert.equal(items[0].cantidad, 3);
  });

  test('la misma zapatilla en dos tallas son dos lineas distintas', () => {
    let items = agregarItem([], item({ varianteId: 5, nombre: 'Zapa talla 9' }));
    items = agregarItem(items, item({ varianteId: 6, nombre: 'Zapa talla 10' }));
    assert.equal(items.length, 2);
  });

  test('quitar saca solo esa variante', () => {
    const items = [item({ varianteId: 5 }), item({ varianteId: 6 })];
    assert.deepEqual(quitarItem(items, { productoId: 1, varianteId: 5 }).map((i) => i.varianteId), [6]);
  });

  test('el total suma precio por cantidad', () => {
    assert.equal(totalCarrito([item({ precio: 350, cantidad: 1 }), item({ varianteId: 2, precio: 379, cantidad: 2 })]), 1108);
  });

  test('el resumen se lee como se lo lee el bot al cliente', () => {
    const texto = resumenCarrito([item({ nombre: 'Ginger Tav', precio: 350 })], bs);
    assert.match(texto, /1x Ginger Tav — Bs 350\.00 c\/u/);
    assert.match(texto, /Total: Bs 350\.00/);
  });

  test('vacio lo dice, no devuelve una lista en blanco', () => {
    assert.match(resumenCarrito([], bs), /carrito esta vacio/i);
  });

  test('se traduce al formato que espera crear_pedido', () => {
    const items = [item({ varianteId: 5, cantidad: 2 })];
    assert.deepEqual(itemsParaPedido(items), [{ idProducto: 1, idVariante: 5, cantidad: 2, agregadoEn: null }]);
  });

  test('cuando el item trae agregadoEn, se conserva (para detectar items viejos al confirmar)', () => {
    const items = [item({ varianteId: 5, cantidad: 2, agregadoEn: '2026-01-01T00:00:00.000Z' })];
    assert.deepEqual(itemsParaPedido(items), [{ idProducto: 1, idVariante: 5, cantidad: 2, agregadoEn: '2026-01-01T00:00:00.000Z' }]);
  });

  test('despues de comprar, el carrito queda vacio', () => {
    const ctx = guardarCarrito({ otraCosa: 'x' }, 10, [item({})]);
    const limpio = contextoSinCarrito(ctx);
    assert.deepEqual(carritoDe(limpio, 10), []);
    assert.equal(limpio.otraCosa, 'x', 'no se lleva puesto el resto del contexto');
  });
});
