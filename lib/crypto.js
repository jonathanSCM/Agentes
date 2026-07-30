// Cifrado simetrico para guardar secretos (como el token de WhatsApp) en la BD.
// Usa AES-256-GCM con una clave derivada de APP_ENCRYPTION_KEY del .env.
require('dotenv').config();
const crypto = require('crypto');

// Deriva una clave de 32 bytes a partir de la variable de entorno.
// Si no esta configurada, usa una de desarrollo (NO usar en produccion).
const SECRETO = process.env.APP_ENCRYPTION_KEY || 'clave-de-desarrollo-cambia-esto-en-produccion';
const CLAVE = crypto.createHash('sha256').update(String(SECRETO)).digest(); // 32 bytes

function cifrar(texto) {
  if (texto == null || texto === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CLAVE, iv);
  const enc = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // formato: iv.tag.datos (todo en base64)
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function descifrar(cifrado) {
  if (!cifrado) return null;
  try {
    const [ivB64, tagB64, datosB64] = String(cifrado).split('.');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const datos = Buffer.from(datosB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', CLAVE, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(datos), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

// Muestra solo los ultimos 4 caracteres de un secreto (para la UI).
function enmascarar(texto, visibles = 4) {
  if (!texto) return '';
  const s = String(texto);
  if (s.length <= visibles) return '•'.repeat(s.length);
  return '•'.repeat(Math.min(12, s.length - visibles)) + s.slice(-visibles);
}

module.exports = { cifrar, descifrar, enmascarar };
