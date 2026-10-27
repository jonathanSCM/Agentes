const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { yaProcesado, reiniciar, TTL_MS, MAX_IDS } = require('../lib/services/dedupe');

describe('yaProcesado - deduplicacion de mensajes del webhook', () => {
  beforeEach(() => reiniciar());

  test('la primera vez no es duplicado, la segunda si', () => {
    assert.equal(yaProcesado('wamid.A', 1000), false);
    assert.equal(yaProcesado('wamid.A', 2000), true);
  });

  test('ids distintos no se pisan', () => {
    assert.equal(yaProcesado('wamid.A', 1000), false);
    assert.equal(yaProcesado('wamid.B', 1000), false);
  });

  test('pasado el TTL el id se olvida y vuelve a procesarse', () => {
    assert.equal(yaProcesado('wamid.A', 1000), false);
    assert.equal(yaProcesado('wamid.A', 1000 + TTL_MS + 1), false);
  });

  test('sin id no se puede deduplicar: nunca lo descarta', () => {
    assert.equal(yaProcesado(undefined, 1000), false);
    assert.equal(yaProcesado(null, 1000), false);
    assert.equal(yaProcesado('', 1000), false);
  });

  test('el tamaño esta acotado: los ids mas viejos se descartan primero', () => {
    for (let i = 0; i < MAX_IDS + 10; i += 1) yaProcesado(`wamid.${i}`, 1000);
    assert.equal(yaProcesado('wamid.0', 1000), false, 'el mas viejo ya fue expulsado');
    assert.equal(yaProcesado(`wamid.${MAX_IDS + 9}`, 1000), true, 'el mas nuevo sigue');
  });
});
