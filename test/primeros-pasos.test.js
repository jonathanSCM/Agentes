const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { pasosIniciales } = require('../lib/services/primerosPasos');

describe('pasosIniciales - primeros pasos de un negocio nuevo', () => {
  test('negocio recien creado: ningun paso hecho y el primero es agregar producto', () => {
    const r = pasosIniciales({ productos: 0, whatsappConectado: false, agenteActivo: false });
    assert.equal(r.hechos, 0);
    assert.equal(r.total, 3);
    assert.equal(r.completo, false);
    assert.equal(r.siguiente.clave, 'producto');
    assert.equal(r.siguiente.href, '/panel/productos/nuevo');
  });

  test('cada paso se marca solo cuando de verdad esta hecho', () => {
    const r = pasosIniciales({ productos: 3, whatsappConectado: false, agenteActivo: false });
    assert.deepEqual(r.pasos.map((p) => p.hecho), [true, false, false]);
    assert.equal(r.siguiente.clave, 'whatsapp');
  });

  test('el siguiente es el primer pendiente aunque haya otros hechos despues', () => {
    const r = pasosIniciales({ productos: 0, whatsappConectado: true, agenteActivo: true });
    assert.equal(r.hechos, 2);
    assert.equal(r.siguiente.clave, 'producto');
  });

  test('todo hecho: completo y sin siguiente', () => {
    const r = pasosIniciales({ productos: 1, whatsappConectado: true, agenteActivo: true });
    assert.equal(r.completo, true);
    assert.equal(r.siguiente, null);
  });
});
