// Tests deterministas de la resolucion de precio por pais (sin DB, sin red).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { precioPlanParaPais, precioPaqueteParaPais, simboloMoneda } = require('../lib/services/precios');

function plan(overrides) {
  return {
    mensualidadBs: 490,
    implementacionBs: 900,
    primerPagoBs: 1390,
    mensualidadUsd: null,
    implementacionUsd: null,
    primerPagoUsd: null,
    ...overrides,
  };
}

function paquete(overrides) {
  return {
    precioUsd: 66,
    costoUnitarioUsd: 0.066,
    ...overrides,
  };
}

describe('precioPlanParaPais', () => {
  test('con precio propio del pais, usa ese precio y esa moneda (override exacto)', () => {
    const preciosPais = [
      { pais: 'PE', moneda: 'PEN', mensualidad: 180, implementacion: 300, primerPago: 480 },
    ];
    const resultado = precioPlanParaPais(plan({}), 'PE', preciosPais);
    assert.deepEqual(resultado, { mensualidad: 180, implementacion: 300, primerPago: 480, moneda: 'PEN' });
  });

  test('sin override para el pais, pero con default en USD cargado, usa el default en USD', () => {
    const resultado = precioPlanParaPais(
      plan({ mensualidadUsd: 70, implementacionUsd: 130, primerPagoUsd: 200 }),
      'AR',
      [],
    );
    assert.deepEqual(resultado, { mensualidad: 70, implementacion: 130, primerPago: 200, moneda: 'USD' });
  });

  test('sin override y sin default en USD, cae al precio historico en bolivianos (comportamiento actual sin cambios)', () => {
    const resultado = precioPlanParaPais(plan({}), 'AR', []);
    assert.deepEqual(resultado, { mensualidad: 490, implementacion: 900, primerPago: 1390, moneda: 'BOB' });
  });

  test('pais null (no se pudo detectar) tambien cae al fallback, nunca rompe', () => {
    const resultado = precioPlanParaPais(plan({ mensualidadUsd: 70, implementacionUsd: 130, primerPagoUsd: 200 }), null, []);
    assert.equal(resultado.moneda, 'USD');
  });

  test('el override de un pais NO afecta a otro pais distinto', () => {
    const preciosPais = [{ pais: 'PE', moneda: 'PEN', mensualidad: 180, implementacion: 300, primerPago: 480 }];
    const resultado = precioPlanParaPais(plan({}), 'BO', preciosPais);
    assert.equal(resultado.moneda, 'BOB');
  });
});

describe('precioPaqueteParaPais', () => {
  test('con precio propio del pais, usa ese precio', () => {
    const preciosPais = [{ pais: 'PE', moneda: 'PEN', precio: 240, costoUnitario: 0.24 }];
    const resultado = precioPaqueteParaPais(paquete({}), 'PE', preciosPais);
    assert.deepEqual(resultado, { precio: 240, costoUnitario: 0.24, moneda: 'PEN' });
  });

  test('sin override, cae al default en USD (paquete.precioUsd ya era el default historico)', () => {
    const resultado = precioPaqueteParaPais(paquete({}), 'AR', []);
    assert.deepEqual(resultado, { precio: 66, costoUnitario: 0.066, moneda: 'USD' });
  });
});

describe('simboloMoneda', () => {
  test('monedas conocidas devuelven su simbolo', () => {
    assert.equal(simboloMoneda('BOB'), 'Bs');
    assert.equal(simboloMoneda('USD'), 'US$');
    assert.equal(simboloMoneda('PEN'), 'S/');
  });

  test('una moneda no mapeada nunca rompe: se muestra el codigo tal cual', () => {
    assert.equal(simboloMoneda('ARS'), 'ARS');
  });
});
