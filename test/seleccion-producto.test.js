const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { opcionesDeSeleccion, resolverSeleccion, textoDeSeleccion } = require('../lib/services/seleccionProducto');
const { agregarItem, quitarItem, itemsParaPedido } = require('../lib/services/carrito');

const tekkira = { id: 169, variantes: [], atributos: { Color: 'Blanco nube', Talla: '8,9,9.5,10,10.5', Genero: 'Unisex' } };

describe('opcionesDeSeleccion', () => {
  test('lee Talla y Color del producto (sin importar mayusculas) y separa por coma', () => {
    const o = opcionesDeSeleccion({ variantes: [], atributos: { talla: ' 8, 9 ,10', COLOR: 'Rojo' } });
    assert.deepEqual(o, [{ nombre: 'Talla', valores: ['8', '9', '10'] }, { nombre: 'Color', valores: ['Rojo'] }]);
  });
  test('un producto CON variantes no usa esto', () => {
    assert.deepEqual(opcionesDeSeleccion({ variantes: [{ id: 1 }], atributos: { Talla: '8,9' } }), []);
  });
  test('sin talla ni color no hay opciones', () => {
    assert.deepEqual(opcionesDeSeleccion({ variantes: [], atributos: { Marca: 'Nike' } }), []);
    assert.deepEqual(opcionesDeSeleccion(null), []);
  });
});

describe('resolverSeleccion', () => {
  test('talla valida + color unico: seleccion completa', () => {
    const r = resolverSeleccion(tekkira, { talla: '10' });
    assert.deepEqual(r.seleccion, { Talla: '10', Color: 'Blanco nube' });
    assert.equal(r.texto, 'Talla: 10, Color: Blanco nube');
    assert.deepEqual(r.faltan, []);
  });
  test('sin talla: falta la talla (el color unico no cuenta como faltante)', () => {
    const r = resolverSeleccion(tekkira, {});
    assert.deepEqual(r.faltan.map((o) => o.nombre), ['Talla']);
  });
  test('compara sin importar mayusculas ni tildes', () => {
    const r = resolverSeleccion({ variantes: [], atributos: { Color: 'Azul,Verde' } }, { color: 'VERDE' });
    assert.equal(r.seleccion.Color, 'Verde');
    assert.equal(resolverSeleccion({ variantes: [], atributos: { Color: 'Café,Negro' } }, { color: 'cafe' }).seleccion.Color, 'Café');
  });
  test('valores que no son del producto se ignoran', () => {
    assert.equal(resolverSeleccion(tekkira, { talla: 'XL' }).faltan.length, 1);
    assert.equal(resolverSeleccion(tekkira, { talla: '9' }).seleccion.Talla, '9');
  });
  test('producto sin opciones: nada que elegir', () => {
    const r = resolverSeleccion({ variantes: [], atributos: {} }, { talla: '10' });
    assert.equal(r.seleccion, null);
    assert.equal(r.texto, '');
    assert.deepEqual(r.faltan, []);
  });
  test('textoDeSeleccion siempre en el mismo orden', () => {
    assert.equal(textoDeSeleccion({ Color: 'Rojo', Talla: 'M' }), 'Talla: M, Color: Rojo');
    assert.equal(textoDeSeleccion(null), '');
  });
});

describe('carrito con seleccion', () => {
  const base = { productoId: 169, varianteId: null, nombre: 'TEKKIRA', precio: 303, cantidad: 1 };

  test('elegir talla completa la linea sin talla que habia (no suma una unidad)', () => {
    const r = agregarItem([base], { ...base, nombre: 'TEKKIRA (Talla: 10)', seleccion: 'Talla: 10' });
    assert.equal(r.length, 1);
    assert.equal(r[0].cantidad, 1);
    assert.equal(r[0].seleccion, 'Talla: 10');
    assert.equal(r[0].nombre, 'TEKKIRA (Talla: 10)');
  });
  test('la misma seleccion otra vez si suma cantidad', () => {
    const l = { ...base, seleccion: 'Talla: 10' };
    assert.equal(agregarItem([l], { ...l }).length, 1);
    assert.equal(agregarItem([l], { ...l })[0].cantidad, 2);
  });
  test('otra seleccion es otra linea', () => {
    const r = agregarItem([{ ...base, seleccion: 'Talla: 10' }], { ...base, seleccion: 'Talla: 9' });
    assert.equal(r.length, 2);
  });
  test('sin seleccion en ninguna: se comporta como siempre (suma)', () => {
    const r = agregarItem([base], { ...base });
    assert.equal(r.length, 1);
    assert.equal(r[0].cantidad, 2);
  });
  test('quitarItem saca todas las lineas de ese producto, tengan o no seleccion', () => {
    const r = quitarItem([{ ...base, seleccion: 'Talla: 10' }, { ...base, seleccion: 'Talla: 9' }, { ...base, productoId: 7 }], { productoId: 169 });
    assert.equal(r.length, 1);
    assert.equal(r[0].productoId, 7);
  });
  test('itemsParaPedido lleva la seleccion', () => {
    const r = itemsParaPedido([{ ...base, seleccion: 'Talla: 10' }, base]);
    assert.equal(r[0].seleccion, 'Talla: 10');
    assert.equal(r[1].seleccion, null);
  });
});

const { separarOpcionesDeAtributos, esClaveDeOpcion } = require('../lib/services/seleccionProducto');

describe('separarOpcionesDeAtributos - talla/color son variantes, no datos sueltos', () => {
  test('separa Talla y Color del resto, con sus valores', () => {
    const r = separarOpcionesDeAtributos({ Color: 'Blanco nube', Talla: '8,9,9.5,10,10.5', Genero: 'Unisex', Marca: 'Lotto' });
    assert.deepEqual(r.opciones, [{ nombre: 'Talla', valores: ['8', '9', '9.5', '10', '10.5'] }, { nombre: 'Color', valores: ['Blanco nube'] }]);
    assert.deepEqual(r.resto, { Genero: 'Unisex', Marca: 'Lotto' });
  });
  test('no distingue mayusculas ni espacios en el nombre', () => {
    assert.equal(esClaveDeOpcion(' talla '), true);
    assert.equal(esClaveDeOpcion('COLOR'), true);
    assert.equal(esClaveDeOpcion('Tallas'), false);
    assert.equal(esClaveDeOpcion('Marca'), false);
  });
  test('sin atributos devuelve vacio', () => {
    assert.deepEqual(separarOpcionesDeAtributos(null), { opciones: [], resto: {} });
  });
});
