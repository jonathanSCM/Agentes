const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ajustesDeModeloOpenAI, modeloParaPlan } = require('../lib/services/agente');

describe('ajustesDeModeloOpenAI - parametros por modelo (gpt-6-luna verificado contra la API real)', () => {
  test('gpt-6-luna: max_completion_tokens y razonamiento apagado (sin eso la API rechaza las tools)', () => {
    const a = ajustesDeModeloOpenAI('gpt-6-luna');
    assert.equal(a.campoTokens, 'max_completion_tokens');
    assert.equal(a.reasoningEffort, 'none');
    assert.equal(a.aceptaTemperature, true);
  });

  test('toda la familia gpt-6 (sol, terra, astra, 6.1) recibe el mismo trato', () => {
    for (const m of ['gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra']) {
      const a = ajustesDeModeloOpenAI(m);
      assert.equal(a.campoTokens, 'max_completion_tokens', m);
      assert.equal(a.reasoningEffort, 'none', m);
    }
  });

  test('gpt-4o y gpt-4o-mini no cambian: max_tokens, sin reasoning_effort', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini']) {
      const a = ajustesDeModeloOpenAI(m);
      assert.equal(a.campoTokens, 'max_tokens', m);
      assert.equal(a.reasoningEffort, null, m);
      assert.equal(a.aceptaTemperature, true, m);
    }
  });

  test('gpt-5 usa max_completion_tokens pero no recibe reasoning_effort', () => {
    const a = ajustesDeModeloOpenAI('gpt-5-mini');
    assert.equal(a.campoTokens, 'max_completion_tokens');
    assert.equal(a.reasoningEffort, null);
  });

  test('la serie "o" no acepta temperature', () => {
    assert.equal(ajustesDeModeloOpenAI('o3-mini').aceptaTemperature, false);
  });
});

describe('modeloParaPlan con gpt-6-luna', () => {
  test('un plan configurado con gpt-6-luna lo usa tal cual', () => {
    assert.equal(modeloParaPlan('openai', { codigo: 'PRO', modeloIa: 'gpt-6-luna' }), 'gpt-6-luna');
  });

  test('la regla del negocio "nunca gpt-5.x" sigue en pie', () => {
    assert.notEqual(modeloParaPlan('openai', { codigo: 'PRO', modeloIa: 'gpt-5.2' }), 'gpt-5.2');
  });

  test('un plan sin modelo propio sigue usando el mapa de siempre', () => {
    assert.equal(modeloParaPlan('openai', { codigo: 'PRO', modeloIa: null }), 'gpt-4o');
  });
});
