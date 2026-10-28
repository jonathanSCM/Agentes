const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { propositoDeLaVuelta } = require('../lib/services/agente');

describe('propositoDeLaVuelta - para que sirvio cada llamada a la IA', () => {
  test('la primera llamada del turno es "respuesta"', () => {
    assert.equal(propositoDeLaVuelta(0, []), 'respuesta');
    // aunque el turno ya traiga un aviso del sistema (carrito web), sigue siendo la primera
    assert.equal(propositoDeLaVuelta(0, [{ role: 'user', content: 'RECORDATORIO DEL SISTEMA ...' }]), 'respuesta');
  });

  test('despues de ejecutar una funcion es "tras_herramienta", no un reintento', () => {
    const turno = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'mostrar_productos' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'TOOL_SUCCESS' },
    ];
    assert.equal(propositoDeLaVuelta(1, turno), 'tras_herramienta');
  });

  test('despues de un RECORDATORIO DEL SISTEMA es "reintento_forzado"', () => {
    const turno = [
      { role: 'assistant', content: 'Te muestro estas opciones' },
      { role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): ...' },
    ];
    assert.equal(propositoDeLaVuelta(1, turno), 'reintento_forzado');
  });

  test('funcion y luego correccion en la misma vuelta: manda lo ultimo que paso', () => {
    const turno = [
      { role: 'tool', tool_call_id: 'a', content: 'TOOL_SUCCESS' },
      { role: 'assistant', content: 'listo' },
      { role: 'user', content: 'RECORDATORIO DEL SISTEMA ...' },
    ];
    assert.equal(propositoDeLaVuelta(2, turno), 'reintento_forzado');
  });

  test('sin historial en una vuelta posterior cae en reintento (valor seguro)', () => {
    assert.equal(propositoDeLaVuelta(1, undefined), 'reintento_forzado');
    assert.equal(propositoDeLaVuelta(2, []), 'reintento_forzado');
  });
});
