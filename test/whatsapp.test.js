// Tests puros de lib/services/whatsapp.js: no pegan a la red real, mockean
// global.fetch para verificar el body exacto que se manda a la Graph API.
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

const { marcarLeidoYEscribiendo, enviarBotones } = require('../lib/services/whatsapp');

// crypto.js exige una clave real para descifrar - se usa una conexion con un
// tokenCifrado armado con la misma funcion de cifrado, para no depender de
// datos de una base real.
const { cifrar } = require('../lib/crypto');

function conexionDePrueba() {
  return { phoneNumberId: '123456', tokenCifrado: cifrar('token-de-prueba') };
}

describe('marcarLeidoYEscribiendo', () => {
  test('arma el body exacto que pide la Graph API (leido + typing_indicator)', async () => {
    let bodyRecibido = null;
    let urlRecibida = null;
    global.fetch = mock.fn(async (url, opts) => {
      urlRecibida = url;
      bodyRecibido = JSON.parse(opts.body);
      return { ok: true, json: async () => ({}) };
    });

    const resultado = await marcarLeidoYEscribiendo(conexionDePrueba(), 'wamid.ABC123');

    assert.equal(resultado.ok, true);
    assert.match(urlRecibida, /\/123456\/messages$/);
    assert.deepEqual(bodyRecibido, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.ABC123',
      typing_indicator: { type: 'text' },
    });
  });

  test('si la API devuelve error, no revienta: devuelve ok:false con el mensaje', async () => {
    global.fetch = mock.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Token invalido' } }),
    }));

    const resultado = await marcarLeidoYEscribiendo(conexionDePrueba(), 'wamid.ABC123');

    assert.equal(resultado.ok, false);
    assert.equal(resultado.error, 'Token invalido');
  });

  test('si fetch tira una excepcion de red, no revienta: devuelve ok:false', async () => {
    global.fetch = mock.fn(async () => { throw new Error('ECONNRESET'); });

    const resultado = await marcarLeidoYEscribiendo(conexionDePrueba(), 'wamid.ABC123');

    assert.equal(resultado.ok, false);
    assert.equal(resultado.error, 'ECONNRESET');
  });

  test('sin conexion, sin credenciales o sin messageId, no intenta llamar a la red', async () => {
    global.fetch = mock.fn(async () => { throw new Error('no deberia llamarse'); });

    assert.equal((await marcarLeidoYEscribiendo(null, 'wamid.ABC123')).ok, false);
    assert.equal((await marcarLeidoYEscribiendo({ phoneNumberId: '1' }, 'wamid.ABC123')).ok, false);
    assert.equal((await marcarLeidoYEscribiendo(conexionDePrueba(), null)).ok, false);
    assert.equal(global.fetch.mock.callCount(), 0);
  });
});

describe('enviarBotones', () => {
  test('arma el body exacto de un mensaje interactivo tipo boton', async () => {
    let bodyRecibido = null;
    global.fetch = mock.fn(async (url, opts) => {
      bodyRecibido = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }) };
    });

    const resultado = await enviarBotones(conexionDePrueba(), '59171234567', '¿Cómo preferís pagar?', [
      { id: 'QR', titulo: 'QR' },
      { id: 'EFECTIVO', titulo: 'Efectivo' },
    ]);

    assert.equal(resultado.ok, true);
    assert.equal(resultado.id, 'wamid.OUT1');
    assert.deepEqual(bodyRecibido, {
      messaging_product: 'whatsapp',
      to: '59171234567',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Cómo preferís pagar?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'QR', title: 'QR' } },
            { type: 'reply', reply: { id: 'EFECTIVO', title: 'Efectivo' } },
          ],
        },
      },
    });
  });

  test('rechaza mas de 3 botones sin llamar a la red (limite real de WhatsApp)', async () => {
    global.fetch = mock.fn(async () => { throw new Error('no deberia llamarse'); });

    const resultado = await enviarBotones(conexionDePrueba(), '591712345', 'Elegi una', [
      { id: 'A', titulo: 'A' }, { id: 'B', titulo: 'B' }, { id: 'C', titulo: 'C' }, { id: 'D', titulo: 'D' },
    ]);

    assert.equal(resultado.ok, false);
    assert.equal(global.fetch.mock.callCount(), 0);
  });

  test('rechaza una lista vacia de botones sin llamar a la red', async () => {
    global.fetch = mock.fn(async () => { throw new Error('no deberia llamarse'); });

    const resultado = await enviarBotones(conexionDePrueba(), '591712345', 'Elegi una', []);

    assert.equal(resultado.ok, false);
    assert.equal(global.fetch.mock.callCount(), 0);
  });

  test('si la API devuelve error, no revienta: devuelve ok:false con el mensaje', async () => {
    global.fetch = mock.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Numero invalido' } }),
    }));

    const resultado = await enviarBotones(conexionDePrueba(), '591712345', 'Elegi una', [{ id: 'QR', titulo: 'QR' }]);

    assert.equal(resultado.ok, false);
    assert.equal(resultado.error, 'Numero invalido');
  });
});
