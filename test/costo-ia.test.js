const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { costoUSD } = require('../lib/services/costoIA');

describe('costoUSD', () => {
  test('gpt-4o sin cache: 1000 prompt + 500 completion', () => {
    const costo = costoUSD('gpt-4o', { promptTokens: 1000, completionTokens: 500 });
    // (1000 * 2.50 + 500 * 10.00) / 1e6
    assert.equal(costo, (1000 * 2.50 + 500 * 10.00) / 1_000_000);
  });

  test('gpt-4o-mini con la mitad de los tokens cacheados', () => {
    const costo = costoUSD('gpt-4o-mini', { promptTokens: 2000, cachedTokens: 1000, completionTokens: 200 });
    // 1000 no cacheados a input, 1000 cacheados a cachedInput
    const esperado = (1000 * 0.15 + 1000 * 0.075 + 200 * 0.60) / 1_000_000;
    assert.equal(costo, esperado);
  });

  test('gpt-6-luna: $0,10 entrada y $0,50 salida por millon (cache sin descuento conocido = techo)', () => {
    const costo = costoUSD('gpt-6-luna', { promptTokens: 7000, cachedTokens: 5000, completionTokens: 40 });
    assert.equal(costo, (2000 * 0.10 + 5000 * 0.10 + 40 * 0.50) / 1_000_000);
    // una llamada tipica del bot (7.000 de prompt) cuesta una fraccion de centavo
    assert.ok(costo < 0.001);
  });

  test('gpt-6-luna cuesta unas 25 veces menos en entrada que gpt-4o', () => {
    const luna = costoUSD('gpt-6-luna', { promptTokens: 1_000_000 });
    const g4o = costoUSD('gpt-4o', { promptTokens: 1_000_000 });
    assert.equal(Math.round(g4o / luna), 25);
  });

  test('modelo desconocido devuelve null, nunca inventa un costo', () => {
    assert.equal(costoUSD('gpt-5.2-chat-latest', { promptTokens: 100, completionTokens: 50 }), null);
  });

  test('sin argumentos de uso, no rompe (todo en 0)', () => {
    assert.equal(costoUSD('gpt-4o'), 0);
  });
});
