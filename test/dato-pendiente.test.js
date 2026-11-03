const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { preguntaDeDatoPendiente, datoPendienteParaMostrar } = require('../lib/services/agente');

describe('preguntaDeDatoPendiente - la pregunta cerrada que destraba un dato', () => {
  test('con dos o mas opciones reales las nombra', () => {
    const q = preguntaDeDatoPendiente({ atributo: 'Genero', opciones: ['Hombre', 'Mujer', 'Unisex'], inicial: true }, 'Poleras');
    assert.match(q, /poleras/);
    assert.match(q, /Hombre o de Mujer/);
    assert.doesNotMatch(q, /Unisex/, 'ofrece solo dos para no abrumar');
  });

  test('sin opciones claras pide confirmar el dato por su nombre', () => {
    const q = preguntaDeDatoPendiente({ atributo: 'Genero', opciones: ['Unico'], inicial: true }, 'Poleras');
    assert.match(q, /confirm[aá]s genero/i);
  });

  test('sin categoria usa una frase generica', () => {
    const q = preguntaDeDatoPendiente({ atributo: 'Talla', opciones: [], inicial: false }, null);
    assert.match(q, /^Para mostrarte opciones/);
  });
});

describe('datoPendienteParaMostrar', () => {
  test('sin preguntas iniciales ni atributos obligatorios no hay nada pendiente', () => {
    assert.equal(datoPendienteParaMostrar({ preguntasIniciales: [] }, { contexto: {} }, [], null), null);
    assert.equal(datoPendienteParaMostrar(null, {}, [], null), null);
  });
});
