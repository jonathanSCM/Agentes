const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { detectarAjusteDeCantidad, quiereCancelar, detectarReinicio } = require('../lib/services/intencionesCarrito');

describe('detectarAjusteDeCantidad - el cliente corrige cuantos lleva', () => {
  test('las frases REALES de la conversacion del piloto (3-nov)', () => {
    assert.deepEqual(detectarAjusteDeCantidad('de me marcaron 3x yo solo quiero un par de zapatillas'), { tipo: 'fijar', cantidad: 1 });
    assert.deepEqual(detectarAjusteDeCantidad('solo quiero uno, marque 3 por casualidad'), { tipo: 'fijar', cantidad: 1 });
  });
  test('"solo ..." con cantidad', () => {
    assert.deepEqual(detectarAjusteDeCantidad('solo uno'), { tipo: 'fijar', cantidad: 1 });
    assert.deepEqual(detectarAjusteDeCantidad('Solo quiero 2'), { tipo: 'fijar', cantidad: 2 });
    assert.deepEqual(detectarAjusteDeCantidad('yo solo necesito una'), { tipo: 'fijar', cantidad: 1 });
    assert.deepEqual(detectarAjusteDeCantidad('solo quiero un par'), { tipo: 'fijar', cantidad: 1 });
  });
  test('"uno solo", "un par nomas"', () => {
    assert.deepEqual(detectarAjusteDeCantidad('un par nomas'), { tipo: 'fijar', cantidad: 1 });
    assert.deepEqual(detectarAjusteDeCantidad('uno solo'), { tipo: 'fijar', cantidad: 1 });
  });
  test('"dejalo en 1", "cambialo a 2"', () => {
    assert.deepEqual(detectarAjusteDeCantidad('dejalo en 1'), { tipo: 'fijar', cantidad: 1 });
    assert.deepEqual(detectarAjusteDeCantidad('cambialo a 2'), { tipo: 'fijar', cantidad: 2 });
  });
  test('se equivoco al marcar y dice cuantos quiere (usa el ultimo numero)', () => {
    assert.deepEqual(detectarAjusteDeCantidad('me marcaron 3 y quiero 1'), { tipo: 'fijar', cantidad: 1 });
  });
  test('restar: "quitame uno"', () => {
    assert.deepEqual(detectarAjusteDeCantidad('quitame uno'), { tipo: 'quitar', cantidad: 1 });
    assert.deepEqual(detectarAjusteDeCantidad('saca 2'), { tipo: 'quitar', cantidad: 2 });
  });
  test('NO intercepta frases que no son una correccion de cantidad', () => {
    for (const f of ['quiero 2 poleras', 'hola', 'que talla tienes?', 'solo quiero ver zapatillas', 'solo tengo 2 dias', 'quiero la talla 42', 'cuanto cuesta', 'tienes en talla 10?', 'solo tienes eso?']) {
      assert.equal(detectarAjusteDeCantidad(f), null, f);
    }
  });
  test('texto vacio o enorme no rompe', () => {
    assert.equal(detectarAjusteDeCantidad(''), null);
    assert.equal(detectarAjusteDeCantidad(undefined), null);
    assert.equal(detectarAjusteDeCantidad('solo uno '.repeat(40)), null);
  });
});

describe('quiereCancelar', () => {
  test('frases claras', () => {
    for (const f of ['cancela', 'Cancela', 'cancelar', 'cancela el pedido', 'cancela mi compra', 'vaciar carrito', 'vacia el carrito', 'ya no quiero nada', 'no quiero nada', 'olvidalo', 'quita todo', 'sacar todo']) {
      assert.equal(quiereCancelar(f), true, f);
    }
  });
  test('NO cancela por frases parecidas o con otro sentido', () => {
    for (const f of ['cancela la talla 42', 'no cancela nada', 'quiero cancelar el envio pero seguir comprando', 'quiero ver mas', 'no quiero esa, quiero otra', 'hola']) {
      assert.equal(quiereCancelar(f), false, f);
    }
  });
});

describe('detectarReinicio', () => {
  test('quiere empezar una compra', () => {
    assert.equal(detectarReinicio('quiero hacer una compra'), 'empezar');
    assert.equal(detectarReinicio('quiero comprar'), 'empezar');
    assert.equal(detectarReinicio('que venden?'), 'empezar');
    assert.equal(detectarReinicio('quiero ver los productos'), 'empezar');
  });
  test('regalo / pide recomendacion', () => {
    assert.equal(detectarReinicio('quiero comprar algo para mi novia que me recomiendas'), 'regalo');
    assert.equal(detectarReinicio('es un regalo'), 'regalo');
    assert.equal(detectarReinicio('que me sugieres?'), 'regalo');
  });
  test('"solo eso tienes?" y "que mas tienes?" piden ver todo', () => {
    assert.equal(detectarReinicio('solo eso tienes?'), 'mas');
    assert.equal(detectarReinicio('que mas tienes'), 'mas');
    assert.equal(detectarReinicio('no tienen mas?'), 'mas');
    assert.equal(detectarReinicio('hay otras cosas?'), 'mas');
  });
  test('"solo eso" a secas es el cliente DICIENDO que ya termino: no es una pregunta', () => {
    for (const f of ['solo eso', 'solo eso, gracias', 'solo eso nada mas', 'solo eso quiero']) {
      assert.equal(detectarReinicio(f), null, f);
    }
    assert.equal(detectarReinicio('solo eso?'), 'mas');
    assert.equal(detectarReinicio('solo eso tienes'), 'mas');
  });
  test('NO se dispara con preguntas de producto o ubicacion', () => {
    for (const f of ['hola', 'donde estan ubicados?', 'tienes mas tallas?', 'tienes en color negro', 'quiero comprar zapatillas', 'cuanto cuesta', 'que talla tienes?', 'que colores hay en esta']) {
      assert.equal(detectarReinicio(f), null, f);
    }
  });
});

const { quiereFinalizar } = require('../lib/services/intencionesCarrito');
describe('quiereFinalizar (incluye el boton "Finalizar en WhatsApp" de la web)', () => {
  test('frases claras', () => {
    for (const f of ['finalizar', 'Finalizar', 'quiero finalizar mi pedido', 'Quiero finalizar mi compra', 'terminar', 'cerrar mi pedido', 'ya quiero finalizar', 'quisiera finalizar']) {
      assert.equal(quiereFinalizar(f), true, f);
    }
  });
  test('NO se dispara con otras cosas', () => {
    for (const f of ['quiero ver mas', 'no quiero finalizar todavia', 'quiero otra zapatilla', 'cancela', 'finalizar el envio a domicilio?', 'hola']) {
      assert.equal(quiereFinalizar(f), false, f);
    }
  });
});
