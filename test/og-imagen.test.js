const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const og = require('../lib/services/ogImagen');

describe('ogImagen - vista previa liviana del catalogo', () => {
  test('la portada es un JPEG de 1200x630 y pesa menos de 300 KB (limite practico de WhatsApp)', async () => {
    const buf = await og.portadaCatalogo({ nombre: 'Tienda Demo de Zapatillas y Ropa', cantidad: 35, colorPrimario: '#6d28d9', urlsFotos: [] });
    const meta = await sharp(buf).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.deepEqual([meta.width, meta.height], [1200, 630]);
    assert.ok(buf.length < 300 * 1024, `pesa ${Math.round(buf.length / 1024)} KB`);
  });

  test('con nombres cortos, larguisimos, con tildes y caracteres de XML no se rompe', async () => {
    for (const nombre of ['Pro', 'Distribuidora Internacional de Calzado Deportivo Mayorista del Oriente Boliviano', 'Ñandú & Hijos <Moda> "Chic"', '', null]) {
      const buf = await og.portadaCatalogo({ nombre, cantidad: 0, colorPrimario: 'rojo-invalido', urlsFotos: ['http://x/uploads/no-existe.jpg', null] });
      assert.equal((await sharp(buf).metadata()).width, 1200, String(nombre));
    }
  });

  test('una foto que no existe o no es imagen da null (nunca rompe la pagina)', async () => {
    assert.equal(await og.fotoProducto('http://x/uploads/no-existe-nunca.jpg'), null);
    assert.equal(await og.fotoProducto(null), null);
    assert.equal(await og.fotoProducto('ftp://raro/foto.jpg'), null);
  });
});

describe('ogImagen - utilidades', () => {
  test('partirEnLineas no corta palabras y respeta el maximo de lineas', () => {
    assert.deepEqual(og.partirEnLineas('Tienda Demo de Zapatillas y Ropa', 15, 3), ['Tienda Demo de', 'Zapatillas y', 'Ropa']);
    const largo = og.partirEnLineas('uno dos tres cuatro cinco seis siete ocho nueve diez', 8, 3);
    assert.equal(largo.length, 3);
  });
  test('colorValido solo acepta #rrggbb', () => {
    assert.equal(og.colorValido('#6D28D9'), '#6D28D9');
    assert.equal(og.colorValido('red'), '#22c58b');
    assert.equal(og.colorValido(undefined), '#22c58b');
  });
  test('escaparXml neutraliza < > & y comillas', () => {
    assert.equal(og.escaparXml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  });
  test('la cache reutiliza el resultado hasta que vence', async () => {
    og.reiniciarCache();
    let n = 0;
    const fabricar = async () => { n += 1; return Buffer.from('x'); };
    await og.conCache('k', fabricar, 1000);
    await og.conCache('k', fabricar, 2000);
    assert.equal(n, 1);
    await og.conCache('k', fabricar, 1000 + 60 * 60 * 1000 + 1);
    assert.equal(n, 2);
  });
});
