// Tests deterministas de las reglas de transicion de estado de pedidos (sin DB).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { transicionValida, requiereRestock, dentroDeVentana24h } = require('../lib/services/pedidos');

describe('transicionValida', () => {
  test('NUEVO puede pasar a CONFIRMADO', () => {
    assert.equal(transicionValida('NUEVO', 'CONFIRMADO'), true);
  });

  test('NUEVO puede pasar a CANCELADO', () => {
    assert.equal(transicionValida('NUEVO', 'CANCELADO'), true);
  });

  test('CONFIRMADO puede pasar a ENTREGADO', () => {
    assert.equal(transicionValida('CONFIRMADO', 'ENTREGADO'), true);
  });

  test('CONFIRMADO puede pasar a CANCELADO', () => {
    assert.equal(transicionValida('CONFIRMADO', 'CANCELADO'), true);
  });

  test('NUEVO NO puede saltar directo a ENTREGADO', () => {
    assert.equal(transicionValida('NUEVO', 'ENTREGADO'), false);
  });

  test('ENTREGADO es un estado final: no se puede cambiar a nada', () => {
    assert.equal(transicionValida('ENTREGADO', 'CANCELADO'), false);
    assert.equal(transicionValida('ENTREGADO', 'CONFIRMADO'), false);
    assert.equal(transicionValida('ENTREGADO', 'NUEVO'), false);
  });

  test('CANCELADO es un estado final: no se puede cambiar a nada', () => {
    assert.equal(transicionValida('CANCELADO', 'CONFIRMADO'), false);
    assert.equal(transicionValida('CANCELADO', 'ENTREGADO'), false);
    assert.equal(transicionValida('CANCELADO', 'NUEVO'), false);
  });

  test('un estado desconocido nunca es valido (no rompe, solo rechaza)', () => {
    assert.equal(transicionValida('ALGO_RARO', 'CONFIRMADO'), false);
  });
});

describe('requiereRestock', () => {
  test('cancelar un pedido NUEVO requiere devolver el stock', () => {
    assert.equal(requiereRestock('NUEVO', 'CANCELADO'), true);
  });

  test('cancelar un pedido CONFIRMADO requiere devolver el stock', () => {
    assert.equal(requiereRestock('CONFIRMADO', 'CANCELADO'), true);
  });

  test('confirmar un pedido (NUEVO -> CONFIRMADO) NO toca el stock (ya se descontó al crearlo)', () => {
    assert.equal(requiereRestock('NUEVO', 'CONFIRMADO'), false);
  });

  test('marcar como entregado NO toca el stock', () => {
    assert.equal(requiereRestock('CONFIRMADO', 'ENTREGADO'), false);
  });

  test('un pedido ya cancelado nunca vuelve a devolver stock (evita doble restock)', () => {
    assert.equal(requiereRestock('CANCELADO', 'CANCELADO'), false);
  });
});

describe('dentroDeVentana24h', () => {
  test('el cliente escribio hace 1 hora: esta dentro de la ventana', () => {
    const ahora = new Date('2026-08-14T12:00:00Z');
    const ultimoMensaje = new Date('2026-08-14T11:00:00Z');
    assert.equal(dentroDeVentana24h(ultimoMensaje, ahora), true);
  });

  test('el cliente escribio hace 25 horas: fuera de la ventana', () => {
    const ahora = new Date('2026-08-14T12:00:00Z');
    const ultimoMensaje = new Date('2026-08-13T11:00:00Z');
    assert.equal(dentroDeVentana24h(ultimoMensaje, ahora), false);
  });

  test('exactamente en el limite de 24h ya no cuenta como dentro (estricto)', () => {
    const ahora = new Date('2026-08-14T12:00:00Z');
    const ultimoMensaje = new Date('2026-08-13T12:00:00Z');
    assert.equal(dentroDeVentana24h(ultimoMensaje, ahora), false);
  });

  test('sin fecha de ultimo mensaje (nunca escribio), nunca esta dentro de la ventana', () => {
    assert.equal(dentroDeVentana24h(null), false);
  });
});
