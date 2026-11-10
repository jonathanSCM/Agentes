// Subir fotos: una foto que YA es JPG se procesa igual que un PNG o un WebP (antes fallaba con "Cannot use same file for input and output").
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { convertirFotosAJpg } = require('../lib/services/fotosJpg');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-jpg-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const crear = async (nombre, formato, ancho = 80, alto = 40) => {
  const ruta = path.join(dir, nombre);
  await sharp({ create: { width: ancho, height: alto, channels: 3, background: '#2fe3a6' } })[formato]().toFile(ruta);
  return { filename: nombre, path: ruta };
};
const formatoDe = async (nombre) => (await sharp(path.join(dir, nombre)).metadata()).format;

describe('convertirFotosAJpg', () => {
  test('un JPG (mismo nombre de entrada y salida) se procesa sin error y queda como JPG', async () => {
    const f = await crear('foto-1.jpg', 'jpeg');
    assert.deepEqual(await convertirFotosAJpg([f], dir), ['foto-1.jpg']);
    assert.equal(await formatoDe('foto-1.jpg'), 'jpeg');
  });
  test('un JPEG con extensión .jpeg y un PNG pasan a .jpg y se borra el original', async () => {
    const a = await crear('foto-2.jpeg', 'jpeg');
    const b = await crear('foto-3.png', 'png');
    assert.deepEqual(await convertirFotosAJpg([a, b], dir), ['foto-2.jpg', 'foto-3.jpg']);
    assert.equal(fs.existsSync(a.path), false);
    assert.equal(fs.existsSync(b.path), false);
    assert.equal(await formatoDe('foto-2.jpg'), 'jpeg');
    assert.equal(await formatoDe('foto-3.jpg'), 'jpeg');
  });
  test('un WebP (que WhatsApp no acepta) queda en JPG', async () => {
    const w = await crear('foto-4.webp', 'webp');
    assert.deepEqual(await convertirFotosAJpg([w], dir), ['foto-4.jpg']);
    assert.equal(await formatoDe('foto-4.jpg'), 'jpeg');
  });
  test('varias fotos juntas, sin fotos o sin lista', async () => {
    const lote = [await crear('foto-5.jpg', 'jpeg'), await crear('foto-6.jpg', 'jpeg')];
    assert.deepEqual(await convertirFotosAJpg(lote, dir), ['foto-5.jpg', 'foto-6.jpg']);
    assert.deepEqual(await convertirFotosAJpg([], dir), []);
    assert.deepEqual(await convertirFotosAJpg(undefined, dir), []);
  });
  test('un archivo que no es una imagen falla con error (no deja basura a medias)', async () => {
    const ruta = path.join(dir, 'falso.jpg'); fs.writeFileSync(ruta, 'esto no es una imagen');
    await assert.rejects(convertirFotosAJpg([{ filename: 'falso.jpg', path: ruta }], dir));
  });
});
