// Chat del panel: archivos y ubicaciones que manda un humano (reglas puras + el cuerpo exacto que se manda a WhatsApp).
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../lib/services/chatHumano');
const { enviarMedia, enviarUbicacion } = require('../lib/services/whatsapp');
const { cifrar } = require('../lib/crypto');

const MB = 1024 * 1024;
const conexion = () => ({ phoneNumberId: '123456', tokenCifrado: cifrar('token-de-prueba') });
const rechaza = (fn, patron) => assert.throws(fn, (e) => { assert.equal(e.codigo, 'CHAT'); assert.match(e.message, patron); return true; });

describe('qué archivos se pueden mandar', () => {
  test('clasifica por extensión sin importar mayúsculas', () => {
    assert.deepEqual(C.clasificarArchivo({ nombre: 'Foto.JPG', bytes: 1000 }), { tipo: 'imagen', waTipo: 'image', ext: 'jpg', nombre: 'Foto.JPG' });
    assert.equal(C.clasificarArchivo({ nombre: 'catalogo.pdf', bytes: 5 * MB }).waTipo, 'document');
    assert.equal(C.clasificarArchivo({ nombre: 'v.mp4', bytes: 10 * MB }).tipo, 'video');
    assert.equal(C.clasificarArchivo({ nombre: 'nota.ogg', bytes: 1000 }).tipo, 'audio');
    assert.equal(C.clasificarArchivo({ nombre: 'lista.xlsx', bytes: 1000 }).tipo, 'documento');
  });
  test('rechaza lo que un navegador podría ejecutar o que no se conoce', () => {
    for (const n of ['pagina.html', 'dibujo.svg', 'script.js', 'virus.exe', 'sin-extension', 'doble.pdf.html', 'archivo.php']) {
      rechaza(() => C.clasificarArchivo({ nombre: n, bytes: 1000 }), /no se puede enviar/);
    }
  });
  test('respeta los límites reales de WhatsApp: 5 MB en fotos, 16 MB en el resto; nada vacío', () => {
    rechaza(() => C.clasificarArchivo({ nombre: 'f.jpg', bytes: 6 * MB }), /muy pesado/);
    assert.equal(C.clasificarArchivo({ nombre: 'f.jpg', bytes: 5 * MB }).tipo, 'imagen');
    rechaza(() => C.clasificarArchivo({ nombre: 'v.mp4', bytes: 17 * MB }), /muy pesado/);
    rechaza(() => C.clasificarArchivo({ nombre: 'v.mp4', bytes: 0 }), /vacío/);
    rechaza(() => C.clasificarArchivo({ nombre: 'v.mp4', bytes: 'abc' }), /vacío/);
  });
  test('el nombre que se muestra no trae carpetas ni caracteres raros', () => {
    assert.equal(C.nombreVisible('C:\\Users\\Ana\\Desktop\\precios.pdf'), 'precios.pdf');
    assert.equal(C.nombreVisible('../../etc/passwd'), 'passwd');
    assert.equal(C.nombreVisible('a\u0000b\nc.pdf'), 'abc.pdf');
    assert.equal(C.nombreVisible(''), 'archivo');
    assert.ok(C.nombreVisible('x'.repeat(500) + '.pdf').length <= 120);
  });
});

describe('ubicaciones', () => {
  test('por coordenadas, con nombre y dirección opcionales', async () => {
    const u = await C.normalizarUbicacion({ lat: '-17.78', lng: '-63.18', nombre: '  Mi   local ', direccion: 'Av. Arce 100' });
    assert.deepEqual(u, { lat: -17.78, lng: -63.18, nombre: 'Mi local', direccion: 'Av. Arce 100' });
  });
  test('rechaza coordenadas inválidas o fuera de rango', async () => {
    for (const d of [{ lat: 'x', lng: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, {}]) {
      await assert.rejects(C.normalizarUbicacion(d), (e) => e.codigo === 'CHAT' && /no es válida/.test(e.message));
    }
  });
  test('desde un link de Google Maps (resuelto) o avisa si no se pudo', async () => {
    const u = await C.normalizarUbicacion({ enlace: 'https://www.google.com/maps/@-17.77,-63.18,15z' }, null, async () => ({ lat: -17.77, lng: -63.18 }));
    assert.deepEqual([u.lat, u.lng], [-17.77, -63.18]);
    await assert.rejects(C.normalizarUbicacion({ enlace: 'https://ejemplo.com' }, null, async () => null), /No pude sacar la ubicación/);
  });
  test('la ubicación del local sale de la configuración; sin cargar, lo explica', async () => {
    const u = await C.normalizarUbicacion({ tienda: true }, { lat: -17.5, lng: -63.2, direccion: 'Calle 1' });
    assert.deepEqual([u.lat, u.lng, u.direccion], [-17.5, -63.2, 'Calle 1']);
    await assert.rejects(C.normalizarUbicacion({ tienda: true }, { lat: null, lng: null }), /Configuración/);
    await assert.rejects(C.normalizarUbicacion({ tienda: true }, null), /Configuración/);
  });
  test('el link de Maps de una ubicación', () => {
    assert.equal(C.mapsUrl(-17.5, -63.2), 'https://www.google.com/maps?q=-17.5,-63.2');
  });
});

describe('errores de WhatsApp en palabras del usuario', () => {
  test('la ventana de 24 horas se explica; lo demás pasa tal cual', () => {
    assert.match(C.mensajeDeError('Re-engagement message', 131047), /24 horas/);
    assert.match(C.mensajeDeError('Message failed to send because more than 24 hours have passed'), /24 horas/);
    assert.equal(C.mensajeDeError('Algo raro'), 'Algo raro');
    assert.match(C.mensajeDeError(''), /rechazó/);
  });
});

describe('enviarMedia y enviarUbicacion', () => {
  const capturar = () => { const r = {}; global.fetch = mock.fn(async (url, opts) => { r.url = url; r.body = JSON.parse(opts.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; }); return r; };

  test('documento: link, nombre del archivo y descripción', async () => {
    const r = capturar();
    const out = await enviarMedia(conexion(), '+591 7000-0000', 'document', { url: 'https://x.test/uploads/a.pdf', filename: 'Lista de precios.pdf', caption: 'Te paso los precios' });
    assert.deepEqual(out, { ok: true, id: 'wamid.1' });
    assert.match(r.url, /\/123456\/messages$/);
    assert.deepEqual(r.body, { messaging_product: 'whatsapp', to: '59170000000', type: 'document', document: { link: 'https://x.test/uploads/a.pdf', caption: 'Te paso los precios', filename: 'Lista de precios.pdf' } });
  });
  test('imagen y video llevan descripción; el audio no', async () => {
    const r = capturar();
    await enviarMedia(conexion(), '59170000000', 'image', { url: 'https://x.test/a.jpg', caption: 'Hola' });
    assert.deepEqual(r.body.image, { link: 'https://x.test/a.jpg', caption: 'Hola' });
    await enviarMedia(conexion(), '59170000000', 'audio', { url: 'https://x.test/a.ogg', caption: 'no va' });
    assert.deepEqual(r.body.audio, { link: 'https://x.test/a.ogg' });
    await enviarMedia(conexion(), '59170000000', 'video', { url: 'https://x.test/a.mp4' });
    assert.deepEqual(r.body.video, { link: 'https://x.test/a.mp4' });
  });
  test('rechaza tipos raros y links que no son públicos, sin llamar a la red', async () => {
    const f = mock.fn(); global.fetch = f;
    assert.equal((await enviarMedia(conexion(), '1', 'sticker', { url: 'https://x.test/a' })).ok, false);
    assert.equal((await enviarMedia(conexion(), '1', 'image', { url: 'file:///etc/passwd' })).ok, false);
    assert.equal((await enviarMedia(conexion(), '1', 'image', {})).ok, false);
    assert.equal(f.mock.callCount(), 0);
  });
  test('ubicación: arma el mensaje location exacto', async () => {
    const r = capturar();
    await enviarUbicacion(conexion(), '59170000000', { lat: -17.78, lng: -63.18, nombre: 'Mi local', direccion: 'Av. Arce 100' });
    assert.deepEqual(r.body, { messaging_product: 'whatsapp', to: '59170000000', type: 'location', location: { latitude: -17.78, longitude: -63.18, name: 'Mi local', address: 'Av. Arce 100' } });
    await enviarUbicacion(conexion(), '59170000000', { lat: 1, lng: 2 });
    assert.deepEqual(r.body.location, { latitude: 1, longitude: 2 });
  });
  test('ubicación inválida o sin credenciales: no llama a la red', async () => {
    const f = mock.fn(); global.fetch = f;
    assert.equal((await enviarUbicacion(conexion(), '1', { lat: 200, lng: 0 })).ok, false);
    assert.equal((await enviarUbicacion({}, '1', { lat: 1, lng: 1 })).ok, false);
    assert.equal(f.mock.callCount(), 0);
  });
  test('si la API devuelve error, no revienta y trae el código', async () => {
    global.fetch = mock.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Re-engagement message', code: 131047 } }) }));
    const out = await enviarMedia(conexion(), '1', 'image', { url: 'https://x.test/a.jpg' });
    assert.deepEqual(out, { ok: false, error: 'Re-engagement message', codigo: 131047 });
  });
});
