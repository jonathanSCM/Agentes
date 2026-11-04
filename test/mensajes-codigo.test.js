// Red de seguridad del plan "la IA no escribe" (docs/10): los textos que ve el cliente
// salen del catálogo de mensajes, no de literales escritos en el flujo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', 'services', f), 'utf8');

test('el flujo de botones y el modo sin IA no tienen textos fijos para el cliente en responder(...)', () => {
  for (const f of ['flujoDeterminista.js', 'modoSinIA.js']) {
    const literales = leer(f).split('\n').map((l, i) => [l, i + 1]).filter(([l]) => /\bresponder\(\s*['"`]/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert.deepEqual(literales.map(([l, n]) => `${f}:${n} ${l.trim()}`), [], `${f}: usar mensajes.t('clave') en vez de un literal`);
  }
});

test('la guardia, las reglas y el aviso del carrito web usan el catálogo', () => {
  assert.doesNotMatch(leer('guardia.js'), /return ['"`]Por privacidad|Solo puedo ayudarte con lo que ofrece \$\{/);
  assert.doesNotMatch(leer('modoSinIA.js'), /podés pagar con|Todavía no tengo la dirección|Nuestro horario de atención:/);
  assert.doesNotMatch(leer('avisoCarritoWeb.js'), /Agregado a tu carrito\*\n\$\{/);
});

test('el mensaje de error técnico es el del catálogo', () => {
  const { respuestaErrorTecnico } = require('../lib/services/agente');
  assert.equal(respuestaErrorTecnico(), require('../lib/services/mensajes').porDefecto.t('error_tecnico'));
});
