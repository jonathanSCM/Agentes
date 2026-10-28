const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parsearVariantesJson, sinLasExistentes, claveDeAtributos, MAX_VARIANTES } = require('../lib/services/variantesForm');

describe('parsearVariantesJson - variantes del formulario guiado', () => {
  test('vacio o ausente: sin variantes y sin error', () => {
    assert.deepEqual(parsearVariantesJson(undefined), { ok: true, variantes: [] });
    assert.deepEqual(parsearVariantesJson(''), { ok: true, variantes: [] });
    assert.deepEqual(parsearVariantesJson('[]'), { ok: true, variantes: [] });
  });

  test('arma variantes con stock y precio normalizados', () => {
    const r = parsearVariantesJson(JSON.stringify([
      { atributos: { Talla: ' 42 ', Color: 'Negro' }, stock: '5', precio: '99.5' },
      { atributos: { Talla: '43', Color: 'Negro' }, stock: 2, precio: '' },
    ]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.variantes, [
      { atributos: { Talla: '42', Color: 'Negro' }, stock: 5, precio: 99.5 },
      { atributos: { Talla: '43', Color: 'Negro' }, stock: 2, precio: null },
    ]);
  });

  test('stock negativo o basura queda en 0, precio invalido en null', () => {
    const r = parsearVariantesJson(JSON.stringify([
      { atributos: { Talla: 'M' }, stock: '-4', precio: 'abc' },
      { atributos: { Talla: 'L' }, stock: 'x', precio: '-1' },
    ]));
    assert.deepEqual(r.variantes.map((v) => [v.stock, v.precio]), [[0, null], [0, null]]);
  });

  test('ignora filas sin atributos y atributos con clave o valor vacio', () => {
    const r = parsearVariantesJson(JSON.stringify([
      { atributos: {}, stock: 3 },
      { atributos: { Talla: '', Color: 'Rojo' }, stock: 1 },
      { stock: 9 },
    ]));
    assert.deepEqual(r.variantes, [{ atributos: { Color: 'Rojo' }, stock: 1, precio: null }]);
  });

  test('descarta repetidas aunque cambie el orden o las mayusculas', () => {
    const r = parsearVariantesJson(JSON.stringify([
      { atributos: { Talla: '42', Color: 'Negro' }, stock: 1 },
      { atributos: { color: 'negro', talla: '42' }, stock: 7 },
    ]));
    assert.equal(r.variantes.length, 1);
    assert.equal(r.variantes[0].stock, 1);
  });

  test('JSON roto o que no es lista: error legible, no excepcion', () => {
    assert.equal(parsearVariantesJson('{no es json').ok, false);
    assert.equal(parsearVariantesJson('{"a":1}').ok, false);
    assert.match(parsearVariantesJson('{no es json').error, /variantes/);
  });

  test(`mas de ${MAX_VARIANTES} combinaciones se rechaza`, () => {
    const muchas = Array.from({ length: MAX_VARIANTES + 1 }, (_, i) => ({ atributos: { Talla: String(i) }, stock: 1 }));
    const r = parsearVariantesJson(JSON.stringify(muchas));
    assert.equal(r.ok, false);
    assert.match(r.error, /demasiadas/);
  });

  test('una variante con demasiadas opciones se rechaza', () => {
    const atributos = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6', g: '7' };
    assert.equal(parsearVariantesJson(JSON.stringify([{ atributos, stock: 1 }])).ok, false);
  });

  test('recorta claves y valores largos', () => {
    const r = parsearVariantesJson(JSON.stringify([{ atributos: { ['k'.repeat(100)]: 'v'.repeat(300) }, stock: 1 }]));
    const [clave, valor] = Object.entries(r.variantes[0].atributos)[0];
    assert.equal(clave.length, 60);
    assert.equal(valor.length, 120);
  });
});

describe('sinLasExistentes', () => {
  test('saca las combinaciones que el producto ya tiene', () => {
    const nuevas = [
      { atributos: { Talla: '42', Color: 'Negro' }, stock: 1, precio: null },
      { atributos: { Talla: '43', Color: 'Negro' }, stock: 1, precio: null },
    ];
    const existentes = [{ atributos: { color: 'NEGRO', talla: '42' } }];
    const r = sinLasExistentes(nuevas, existentes);
    assert.equal(r.length, 1);
    assert.equal(r[0].atributos.Talla, '43');
  });

  test('sin existentes devuelve todas', () => {
    assert.equal(sinLasExistentes([{ atributos: { Talla: 'M' } }], undefined).length, 1);
  });
});

describe('claveDeAtributos', () => {
  test('no depende del orden ni de mayusculas', () => {
    assert.equal(claveDeAtributos({ Talla: '42', Color: 'Negro' }), claveDeAtributos({ color: 'negro', talla: '42' }));
  });
});
