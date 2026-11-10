'use strict';
// lib/services/fotosJpg.js
//
// Pasa las fotos subidas a JPG (enderezadas según la orientación de la cámara). WhatsApp no acepta WebP y el catálogo guarda todo en JPG.
//
// Bug real (nov 2026): si el archivo YA era .jpg, la salida tenía el mismo nombre que la entrada y la librería de imágenes
// (sharp 0.35) lo rechaza con "Cannot use same file for input and output": no dejaba subir fotos JPG. Ahora se procesa
// en memoria y recién después se escribe el resultado, así el nombre de salida puede ser igual al de entrada.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * @param {Array<{ filename: string, path: string }>} files  archivos de multer (ya guardados en `dir`)
 * @param {string} dir  carpeta de subidas
 * @returns {Promise<string[]>}  nombres de los JPG resultantes
 */
async function convertirFotosAJpg(files, dir) {
  const nombres = [];
  for (const file of files || []) {
    const nombreJpg = `${path.parse(file.filename).name}.jpg`;
    const rutaJpg = path.join(dir, nombreJpg);
    // Se lee el archivo a memoria primero: así no queda abierto (en Windows impediría escribir encima).
    const original = await fs.promises.readFile(file.path);
    const datos = await sharp(original).rotate().jpeg({ quality: 85 }).toBuffer();
    await fs.promises.writeFile(rutaJpg, datos);
    if (file.path !== rutaJpg) await fs.promises.unlink(file.path).catch(() => {});
    nombres.push(nombreJpg);
  }
  return nombres;
}

module.exports = { convertirFotosAJpg };
