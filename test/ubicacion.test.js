// Resuelve un link de Google Maps pegado como texto a coordenadas reales.
// Nunca inventa nada: sin link, con link roto, o si la red falla, devuelve
// null y listo.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolverCoordenadas, extraerCoordenadas, extraerUrlDeMaps } = require('../lib/services/ubicacion');

describe('extraerUrlDeMaps', () => {
  test('encuentra un link acortado dentro de una frase', () => {
    assert.equal(
      extraerUrlDeMaps('mi ubicacion es https://maps.app.goo.gl/dKW6ue86pc53L7bbA gracias'),
      'https://maps.app.goo.gl/dKW6ue86pc53L7bbA'
    );
  });

  test('sin ningun link, devuelve null', () => {
    assert.equal(extraerUrlDeMaps('mi direccion es Av Siempre Viva 123'), null);
    assert.equal(extraerUrlDeMaps(''), null);
    assert.equal(extraerUrlDeMaps(null), null);
  });

  test('no confunde un link de otra pagina con uno de Maps', () => {
    assert.equal(extraerUrlDeMaps('mirá esto https://www.instagram.com/algo'), null);
  });

  // Bug real probando en vivo: "maps.google.com" (sin "www", sin "/maps" en
  // la ruta - dominio de toda la vida, distinto de "google.com/maps") no
  // matcheaba ningun patron. El cliente mandaba el link, el bot le seguia
  // preguntando el nombre como si lo hubiera aceptado, y recien en
  // confirmar_pedido le avisaba que "la ubicacion no es valida" - confuso,
  // porque el bot ya habia avanzado varios mensajes despues.
  test('reconoce "maps.google.com" (dominio distinto de "google.com/maps")', () => {
    assert.equal(
      extraerUrlDeMaps('https://maps.google.com/?q=-17.783327,-63.182140'),
      'https://maps.google.com/?q=-17.783327,-63.182140'
    );
  });
});

describe('extraerCoordenadas', () => {
  test('formato /search/lat,+lng (el que devuelve Google al resolver un link acortado)', () => {
    const url = 'https://www.google.com/maps/search/-17.767619,+-63.181035?entry=tts';
    assert.deepEqual(extraerCoordenadas(url), { lat: -17.767619, lng: -63.181035 });
  });

  test('formato @lat,lng (centro del mapa)', () => {
    const url = 'https://www.google.com/maps/@-17.783,-63.182,15z';
    assert.deepEqual(extraerCoordenadas(url), { lat: -17.783, lng: -63.182 });
  });

  test('formato ?q=lat,lng', () => {
    const url = 'https://www.google.com/maps?q=-17.783,-63.182';
    assert.deepEqual(extraerCoordenadas(url), { lat: -17.783, lng: -63.182 });
  });

  test('una URL sin ninguna coordenada real (ej. un link a un lugar por nombre) devuelve null', () => {
    assert.equal(extraerCoordenadas('https://www.google.com/maps/place/Cafe+Central'), null);
  });

  test('rechaza numeros fuera de rango de lat/lng (no confunde cualquier numero con coordenadas)', () => {
    assert.equal(extraerCoordenadas('https://www.google.com/maps/@999.9,999.9,15z'), null);
  });
});

describe('resolverCoordenadas', () => {
  test('sin ningun link en el texto, devuelve null sin tocar la red', async () => {
    assert.equal(await resolverCoordenadas('mi direccion es Av Siempre Viva 123'), null);
  });

  test('un link largo con coordenadas ya visibles se resuelve sin red', async () => {
    const r = await resolverCoordenadas('https://www.google.com/maps/@-17.783,-63.182,15z');
    assert.deepEqual(r, { lat: -17.783, lng: -63.182 });
  });

  test('un link de "maps.google.com" con ?q= se resuelve sin red', async () => {
    const r = await resolverCoordenadas('https://maps.google.com/?q=-17.783327,-63.182140');
    assert.deepEqual(r, { lat: -17.783327, lng: -63.18214 });
  });

  test('un link acortado que no existe nunca revienta, devuelve null', async () => {
    const r = await resolverCoordenadas('https://maps.app.goo.gl/esto-no-existe-de-verdad-123456789xyz');
    assert.equal(r, null);
  });

  // Contra la red real de Google, una sola vez: confirma que el resolver
  // funciona de verdad con el tipo de link que manda un cliente real
  // (comparte "por WhatsApp" desde la app de Maps -> queda acortado).
  test('un link acortado real de Google se resuelve a coordenadas reales', { timeout: 10000 }, async () => {
    const r = await resolverCoordenadas('Aca mi ubicacion: https://maps.app.goo.gl/dKW6ue86pc53L7bbA');
    assert.ok(r, 'deberia resolver a coordenadas reales');
    assert.equal(Math.round(r.lat), -18);
    assert.equal(Math.round(r.lng), -63);
  });
});
