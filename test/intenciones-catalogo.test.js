const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pareceQuererCatalogoCompleto: quiereVer } = require('../lib/services/agente');

test('pedidos cortos de ver el catálogo o sumar productos se reconocen', () => {
  for (const t of ['Mostrame qué tienes', 'que tienen?', 'Quiero añadir productos', 'agregar más cosas', 'quiero ver el catálogo', 'ver productos', 'qué hay']) {
    assert.equal(quiereVer(t), true, t);
  }
});

test('no se confunden con preguntas concretas ni con pedidos de compra', () => {
  for (const t of ['hola', 'Poleras', '¿Tienen la polera rayada?', 'que tienes en talla 42?', 'quiero 2 poleras', 'cuanto sale', 'Finalizar']) {
    assert.equal(quiereVer(t), false, t);
  }
});
