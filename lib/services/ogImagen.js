// Imagenes de vista previa (Open Graph) del catalogo web.
//
// Cuando el cliente pega el link del catalogo en WhatsApp (o el bot se lo manda),
// WhatsApp arma una tarjeta con la imagen og:image. Las fotos de producto que
// suben los negocios pesan MB y no tienen la proporcion de una tarjeta:
// WhatsApp las descarta si pasan de ~300 KB o las recorta mal. Aca se generan
// imagenes de 1200x630 livianas (JPEG, decenas de KB) con la marca del negocio.
//
//  - portadaCatalogo: nombre del negocio + cantidad de productos + hasta 3 fotos.
//  - fotoProducto: la foto del producto centrada sobre su propio fondo difuminado.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ANCHO = 1200;
const ALTO = 630;
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRADAS = 200;
const MAX_BYTES_FOTO = 12 * 1024 * 1024;

const cache = new Map(); // clave -> { buf, hasta }

async function conCache(clave, fabricar, ahora = Date.now()) {
  const hit = cache.get(clave);
  if (hit && hit.hasta > ahora) return hit.buf;
  const buf = await fabricar();
  if (cache.size >= MAX_ENTRADAS) cache.delete(cache.keys().next().value);
  cache.set(clave, { buf, hasta: ahora + TTL_MS });
  return buf;
}

function escaparXml(texto) {
  return String(texto == null ? '' : texto).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** "#22c58b" -> color valido; cualquier otra cosa cae al verde de la marca. */
function colorValido(c, respaldo = '#22c58b') {
  return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : respaldo;
}

function oscurecer(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * factor)));
  const r = f((n >> 16) & 255); const g = f((n >> 8) & 255); const b = f(n & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Parte un texto en hasta `maxLineas` lineas de ~`maxChars` caracteres, sin cortar palabras. */
function partirEnLineas(texto, maxChars, maxLineas) {
  const palabras = String(texto || '').trim().split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = '';
  for (const p of palabras) {
    if ((actual + ' ' + p).trim().length > maxChars && actual) { lineas.push(actual); actual = p; } else { actual = (actual + ' ' + p).trim(); }
  }
  if (actual) lineas.push(actual);
  if (lineas.length > maxLineas) {
    const sobra = lineas.slice(maxLineas - 1).join(' ');
    return [...lineas.slice(0, maxLineas - 1), sobra.length > maxChars ? `${sobra.slice(0, maxChars - 1)}…` : sobra];
  }
  return lineas;
}

/**
 * Lee una foto: del disco si es una subida propia (/uploads/...), o por red con
 * limite de tiempo y de tamaño si es externa. null si no se puede (nunca rompe).
 */
async function leerFoto(url) {
  if (!url) return null;
  try {
    const texto = String(url);
    if (texto.includes('/uploads/')) {
      const archivo = path.basename(new URL(texto, 'http://local').pathname);
      const ruta = path.join(UPLOADS_DIR, archivo);
      return fs.existsSync(ruta) ? fs.readFileSync(ruta) : null;
    }
    if (!/^https?:\/\//i.test(texto)) return null;
    const resp = await fetch(texto, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length > MAX_BYTES_FOTO ? null : buf;
  } catch (_) {
    return null;
  }
}

async function jpeg(sharpObj) {
  return sharpObj.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

/** Foto de un producto en 1200x630: entera, centrada, sobre su propio fondo difuminado. */
async function fotoProducto(urlFoto) {
  const origen = await leerFoto(urlFoto);
  if (!origen) return null;
  try {
    const fondo = await sharp(origen).rotate().resize(ANCHO, ALTO, { fit: 'cover' }).blur(28).modulate({ brightness: 0.7 }).toBuffer();
    const frente = await sharp(origen).rotate().resize(ANCHO, ALTO, { fit: 'inside' }).toBuffer();
    return await jpeg(sharp(fondo).composite([{ input: frente, gravity: 'center' }]));
  } catch (_) {
    return null; // archivo que no es una imagen
  }
}

/** Portada del catalogo: marca del negocio, cuantos productos tiene y hasta 3 fotos reales. */
async function portadaCatalogo({ nombre, cantidad, colorPrimario, urlsFotos = [] }) {
  const c1 = colorValido(colorPrimario);
  const c2 = oscurecer(c1, 0.45);
  // El nombre tiene que caber en el panel oscuro de la izquierda (~540 px): se
  // prueba el tamaño mas grande que entre en 3 lineas (cada letra mide ~0,62 del tamaño).
  const candidatos = [[72, 11], [60, 14], [52, 16], [44, 19]];
  let tamano = 44;
  let lineasNombre = partirEnLineas(nombre || 'Catálogo', 19, 3);
  for (const [t, maxChars] of candidatos) {
    const lineas = partirEnLineas(nombre || 'Catálogo', maxChars, 4);
    if (lineas.length <= 3 && lineas.every((l) => l.length <= maxChars)) { tamano = t; lineasNombre = lineas; break; }
  }
  const texto = lineasNombre.map((l, i) => `<text x="64" y="${190 + i * (tamano + 8)}" font-size="${tamano}" font-weight="700" fill="#ffffff">${escaparXml(l)}</text>`).join('');
  const yPie = 190 + lineasNombre.length * (tamano + 8) + 20;
  const sub = cantidad > 0 ? `${cantidad} producto${cantidad === 1 ? '' : 's'} disponible${cantidad === 1 ? '' : 's'}` : 'Catálogo';
  const base = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO}" height="${ALTO}" font-family="DejaVu Sans, Arial, sans-serif">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="${ANCHO}" height="${ALTO}" fill="url(#g)"/>
    <rect x="0" y="0" width="600" height="${ALTO}" fill="#000000" fill-opacity="0.28"/>
    ${texto}
    <text x="64" y="${yPie + 30}" font-size="34" fill="#ffffff" fill-opacity="0.92">${escaparXml(sub)}</text>
    <text x="64" y="${ALTO - 48}" font-size="26" fill="#ffffff" fill-opacity="0.8">Ver catálogo →</text>
  </svg>`);

  const fotos = [];
  for (const url of urlsFotos.slice(0, 3)) {
    const buf = await leerFoto(url);
    if (buf) fotos.push(buf);
  }
  const mascara = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="176" height="300"><rect width="176" height="300" rx="20"/></svg>');
  const tarjetas = [];
  for (let i = 0; i < fotos.length; i += 1) {
    try {
      const redonda = await sharp(fotos[i]).rotate().resize(176, 300, { fit: 'cover' })
        .composite([{ input: mascara, blend: 'dest-in' }]).png().toBuffer();
      tarjetas.push({ input: redonda, left: 636 + i * 190, top: 165 + (i % 2 === 1 ? 24 : 0) });
    } catch (_) { /* esa foto no sirve: se salta */ }
  }
  return jpeg(sharp(base).composite(tarjetas));
}

function reiniciarCache() { cache.clear(); }

module.exports = { portadaCatalogo, fotoProducto, conCache, partirEnLineas, colorValido, oscurecer, escaparXml, reiniciarCache, ANCHO, ALTO };
