'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearContexto } = require('../lib/services/mensajes');
const tp = require('../lib/services/turnoPrefab');

const ctx = crearContexto({ negocio: { nombre: 'Proshop' }, moneda: 'BOB' });
const productos = [
  { id: 1, nombre: 'Zapatilla Runner', precio: 300, stock: 2, atributos: { material: 'cuero' }, descripcion: 'Liviana' },
  { id: 2, nombre: 'Bota Trail', precio: 450, stock: 0, atributos: {} },
];
const elegibles = tp.mensajesElegibles(ctx);
const base = { ctx, productos, elegibles, config: { faq: [{ pregunta: 'Garantía', respuesta: 'Hay 30 días.' }], aceptaQr: true, aceptaEfectivo: true } };

test('solo se ofrecen mensajes de Conversación/Información, nunca los de sistema', () => {
  const claves = elegibles.map((e) => e.clave);
  assert.ok(claves.includes('producto_precio') && claves.includes('saludo'));
  assert.ok(!claves.includes('error_tecnico') && !claves.includes('pago_sin_datos'));
});

test('la herramienta responder limita la clave a una lista cerrada', () => {
  const t = tp.herramientaResponder(elegibles);
  assert.deepEqual(t.function.parameters.properties.mensaje.enum, elegibles.map((e) => e.clave));
});

test('precio y stock salen del sistema, no de la IA', () => {
  const r = tp.resolverEleccion({ mensaje: 'producto_precio', producto_id: 1, precio: 1 }, base);
  assert.equal(r.ok, true);
  assert.match(r.texto, /Zapatilla Runner/);
  assert.match(r.texto, /300\.00/);
  const s = tp.resolverEleccion({ mensaje: 'producto_sin_stock', producto_id: 1 }, base);
  assert.match(s.texto, /quedan 2/);
});

test('clave inventada o producto inexistente se rechazan', () => {
  assert.equal(tp.resolverEleccion({ mensaje: 'texto_libre' }, base).ok, false);
  assert.equal(tp.resolverEleccion({ mensaje: 'producto_precio', producto_id: 999 }, base).motivo, 'producto_invalido');
  assert.equal(tp.resolverEleccion({ mensaje: 'error_tecnico' }, base).ok, false);
});

test('dato de producto: existe, o cae al mensaje de "no lo tengo cargado"', () => {
  assert.match(tp.resolverEleccion({ mensaje: 'producto_dato', producto_id: 1, atributo: 'Material' }, base).texto, /cuero/);
  assert.match(tp.resolverEleccion({ mensaje: 'producto_dato', producto_id: 1, atributo: 'garantia' }, base).texto, /no lo tengo cargado/);
});

test('faq: solo respuestas que el negocio cargó', () => {
  assert.match(tp.resolverEleccion({ mensaje: 'faq_respuesta', faq_id: 1 }, base).texto, /30 días/);
  assert.equal(tp.resolverEleccion({ mensaje: 'faq_respuesta', faq_id: 7 }, base).ok, false);
});

test('info del negocio sin dato cargado no se inventa: ofrece asesor', () => {
  assert.match(tp.resolverEleccion({ mensaje: 'horario_info' }, base).texto, /asesor/);
  assert.match(tp.resolverEleccion({ mensaje: 'direccion_tienda' }, base).texto, /asesor|dirección/i);
  assert.match(tp.resolverEleccion({ mensaje: 'pago_formas' }, base).texto, /QR/);
});

test('el system compacto lista claves y productos, sin textos para copiar', () => {
  const s = tp.armarSystem({ empresa: { nombre: 'Proshop' }, elegibles, candidatos: productos, config: base.config }).texto;
  assert.match(s, /producto_precio/);
  assert.match(s, /\[1\] Zapatilla Runner/);
  assert.ok(s.length < 6000, `system demasiado largo: ${s.length}`);
});

test('no se afirma lo que los datos no respaldan (agotado, ya en el carrito, variantes)', () => {
  assert.equal(tp.resolverEleccion({ mensaje: 'producto_agotado', producto_id: 1 }, base).motivo, 'el_producto_tiene_stock');
  assert.match(tp.resolverEleccion({ mensaje: 'producto_agotado', producto_id: 2 }, base).texto, /agotado/);
  assert.equal(tp.resolverEleccion({ mensaje: 'ya_en_carrito', producto_id: 1 }, base).motivo, 'el_producto_no_esta_en_el_carrito');
  assert.match(tp.resolverEleccion({ mensaje: 'ya_en_carrito', producto_id: 1 }, { ...base, carrito: [{ productoId: 1 }] }).texto, /ya está en tu carrito/);
  assert.equal(tp.resolverEleccion({ mensaje: 'pedir_variante', producto_id: 1, falta: 'la talla' }, base).motivo, 'el_producto_no_tiene_variantes');
});

test('el stock cuenta las variantes (un producto con stock 0 propio pero variantes con stock NO esta agotado)', () => {
  const conVariantes = { id: 5, nombre: 'Zapatilla V', precio: 100, stock: 0, variantes: [{ activa: true, stock: 3, atributos: { Talla: '42' } }] };
  assert.equal(tp.stockTotal(conVariantes), 3);
  const r = tp.resolverEleccion({ mensaje: 'producto_agotado', producto_id: 5 }, { ...base, productos: [conVariantes] });
  assert.equal(r.ok, false);
});

test('si se mostró UNA sola tarjeta, el mensaje nombra ese producto aunque la IA elija el genérico', () => {
  const r = tp.resolverEleccion({ mensaje: 'productos_mostrados' }, { ...base, mostrados: [1, 1] });
  assert.match(r.texto, /Zapatilla Runner/);
  const varios = tp.resolverEleccion({ mensaje: 'productos_mostrados' }, { ...base, mostrados: [1, 2] });
  assert.match(varios.texto, /2 opción/);
});
