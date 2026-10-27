// Tests puros de lib/services/whatsapp.js: no pegan a la red real, mockean
// global.fetch para verificar el body exacto que se manda a la Graph API.
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

const { marcarLeidoYEscribiendo, enviarBotones, enviarLista, enviarSolicitudUbicacion, textoDeLista } = require('../lib/services/whatsapp');

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

describe('enviarLista', () => {
  const lista = {
    boton: 'Ver categorías',
    secciones: [{ titulo: 'Categorías', filas: [
      { id: 'rubro:1', titulo: 'Calzado', descripcion: '3 modelos' },
      { id: 'rubro:2', titulo: 'Pantalones' },
    ] }],
  };

  test('arma el body exacto de un mensaje interactivo tipo lista', async () => {
    let bodyRecibido = null;
    global.fetch = mock.fn(async (url, opts) => {
      bodyRecibido = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.LISTA1' }] }) };
    });

    const resultado = await enviarLista(conexionDePrueba(), '+591 7123-4567', 'Esto es lo que tenemos', lista);

    assert.equal(resultado.ok, true);
    assert.equal(resultado.id, 'wamid.LISTA1');
    assert.deepEqual(bodyRecibido, {
      messaging_product: 'whatsapp',
      to: '59171234567',
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Esto es lo que tenemos' },
        action: {
          button: 'Ver categorías',
          sections: [{ title: 'Categorías', rows: [
            { id: 'rubro:1', title: 'Calzado', description: '3 modelos' },
            { id: 'rubro:2', title: 'Pantalones' },
          ] }],
        },
      },
    });
  });

  test('recorta los textos a los limites reales de WhatsApp', async () => {
    let body = null;
    global.fetch = mock.fn(async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({}) }; });
    await enviarLista(conexionDePrueba(), '591712345', 'x'.repeat(2000), {
      boton: 'B'.repeat(50),
      secciones: [{ titulo: 'T'.repeat(50), filas: [{ id: 'i'.repeat(300), titulo: 'F'.repeat(50), descripcion: 'D'.repeat(200) }] }],
    });
    const i = body.interactive;
    assert.equal(i.body.text.length, 1024);
    assert.equal(i.action.button.length, 20);
    assert.equal(i.action.sections[0].title.length, 24);
    assert.equal(i.action.sections[0].rows[0].id.length, 200);
    assert.equal(i.action.sections[0].rows[0].title.length, 24);
    assert.equal(i.action.sections[0].rows[0].description.length, 72);
  });

  test('rechaza 0 o mas de 10 filas sin llamar a la red', async () => {
    global.fetch = mock.fn(async () => { throw new Error('no deberia llamarse'); });
    const filas = Array.from({ length: 11 }, (_, n) => ({ id: `r:${n}`, titulo: `Fila ${n}` }));
    assert.equal((await enviarLista(conexionDePrueba(), '591712345', 'x', { secciones: [{ titulo: 'a', filas }] })).ok, false);
    assert.equal((await enviarLista(conexionDePrueba(), '591712345', 'x', { secciones: [] })).ok, false);
    assert.equal(global.fetch.mock.callCount(), 0);
  });

  test('si la API devuelve error, no revienta: devuelve ok:false con el mensaje', async () => {
    global.fetch = mock.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Parametro invalido' } }) }));
    const resultado = await enviarLista(conexionDePrueba(), '591712345', 'x', lista);
    assert.equal(resultado.ok, false);
    assert.equal(resultado.error, 'Parametro invalido');
  });
});

describe('enviarSolicitudUbicacion', () => {
  test('arma el body del mensaje location_request_message', async () => {
    let body = null;
    global.fetch = mock.fn(async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.UBI' }] }) }; });
    const resultado = await enviarSolicitudUbicacion(conexionDePrueba(), '59171234567', 'Compartí tu ubicación');
    assert.equal(resultado.ok, true);
    assert.deepEqual(body.interactive, {
      type: 'location_request_message',
      body: { text: 'Compartí tu ubicación' },
      action: { name: 'send_location' },
    });
  });

  test('sin credenciales no llama a la red', async () => {
    global.fetch = mock.fn(async () => { throw new Error('no deberia llamarse'); });
    assert.equal((await enviarSolicitudUbicacion({}, '591712345', 'x')).ok, false);
    assert.equal(global.fetch.mock.callCount(), 0);
  });
});

describe('textoDeLista', () => {
  test('arma el respaldo en texto numerado con todas las filas de todas las secciones', () => {
    const texto = textoDeLista('Esto es lo que tenemos', {
      secciones: [{ titulo: 'A', filas: [{ id: '1', titulo: 'Calzado' }] }, { titulo: 'B', filas: [{ id: '2', titulo: 'Pantalones' }] }],
    });
    assert.equal(texto, 'Esto es lo que tenemos\n1. Calzado\n2. Pantalones');
  });
});
