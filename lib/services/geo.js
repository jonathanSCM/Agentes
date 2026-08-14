// Deteccion de pais por IP, usando una base de datos local (geoip-lite) en
// vez de un servicio externo por HTTP: no depende de que un tercero este
// funcionando, sin limite de consultas, resuelve del lado del servidor antes
// de armar el HTML (sin parpadeo de precio ni scripts de terceros).
const geoip = require('geoip-lite');

// Devuelve el codigo de pais ISO 3166-1 alpha-2 (ej "BO", "PE"), o null si no
// se pudo resolver (IP privada/localhost, rango no mapeado, etc). Un null se
// trata igual que "pais sin precio configurado" en lib/services/precios.js.
function detectarPais(ip) {
  if (!ip) return null;
  // req.ip a veces viene con el prefijo IPv4-mapeado-en-IPv6 ("::ffff:1.2.3.4").
  const limpio = String(ip).replace(/^::ffff:/, '');
  const info = geoip.lookup(limpio);
  return info && info.country ? info.country : null;
}

module.exports = { detectarPais };
