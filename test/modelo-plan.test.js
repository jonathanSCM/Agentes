// Pedido explicito del negocio: gpt-5.x NUNCA se usa, pase lo que pase -
// nunca desde el mapa por plan, y nunca aunque Plan.modeloIa en la base diga
// gpt-5.x (dato viejo real que tenia el plan PREMIUM antes de este fix).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { modeloParaPlan } = require('../lib/services/agente');

describe('modeloParaPlan - gpt-5.x nunca se usa', () => {
  test('plan PREMIUM sin modeloIa configurado usa gpt-4o (el mapa hardcodeado)', () => {
    assert.equal(modeloParaPlan('openai', { codigo: 'PREMIUM' }), 'gpt-4o');
  });

  test('BUG real: aunque Plan.modeloIa en la base diga gpt-5.x, se ignora y cae a gpt-4o', () => {
    assert.equal(modeloParaPlan('openai', { codigo: 'PREMIUM', modeloIa: 'gpt-5.2-chat-latest' }), 'gpt-4o');
    assert.equal(modeloParaPlan('openai', { codigo: 'PREMIUM', modeloIa: 'gpt-5-mini' }), 'gpt-4o');
  });

  test('un modeloIa configurado que NO sea gpt-5.x se sigue respetando (ej. gpt-4.1)', () => {
    assert.equal(modeloParaPlan('openai', { codigo: 'PRO', modeloIa: 'gpt-4.1' }), 'gpt-4.1');
  });

  test('plan PRO usa gpt-4o', () => {
    assert.equal(modeloParaPlan('openai', { codigo: 'PRO' }), 'gpt-4o');
  });

  test('sin plan (fallback), nunca cae en un gpt-5.x', () => {
    const modelo = modeloParaPlan('openai', null);
    assert.doesNotMatch(modelo, /^gpt-5/i);
  });
});
