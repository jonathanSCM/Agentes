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

  test('modelo desconocido devuelve null, nunca inventa un costo', () => {
    assert.equal(costoUSD('gpt-5.2-chat-latest', { promptTokens: 100, completionTokens: 50 }), null);
  });

  test('sin argumentos de uso, no rompe (todo en 0)', () => {
    assert.equal(costoUSD('gpt-4o'), 0);
  });
});
