// Convierte un link de Google Maps (pegado como texto por el cliente, no
// compartido como ubicacion nativa de WhatsApp) en coordenadas reales.
//
// Por que existe: ClienteFinal.ubicacionLat/Lng solo se llenaban cuando el
// cliente compartia su pin en vivo por WhatsApp (ver server.js, webhook). Si
// en cambio pegaba un link de Google Maps como texto -lo mas comun cuando
// escribe desde la app de Maps y comparte "por WhatsApp" con el share sheet-
// ese link se guardaba como texto suelto y nunca se convertia en mapa. Bug
// real reportado: el cliente mando "https://maps.app.goo.gl/..." y nunca
// aparecio ningun mapa en el panel.
//
// Nunca inventa nada: si no hay link, si la red falla, si el formato no
// matchea ninguno de los que usa Google de verdad, o tarda demasiado,
// devuelve null y el sistema sigue mostrando el texto/link original tal
// cual - jamas un mapa con una coordenada inventada.

const TIMEOUT_MS = 5000;

// Patrones reales de Google Maps con coordenadas en la URL, en el orden que
// mas probablemente aparezcan. Probados contra links de verdad, no supuestos:
// "https://maps.app.goo.gl/xxx" (acortado, share sheet del celular) resuelve
// a algo como ".../maps/search/-17.767619,+-63.181035?entry=tts...".
const PATRONES_COORDENADAS = [
  /\/search\/(-?\d+\.\d+),\+?\s*(-?\d+\.\d+)/, // link de "compartir ubicacion" (el caso mas comun)
  /@(-?\d+\.\d+),(-?\d+\.\d+)/, // centro del mapa al compartir una vista
  /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/, // ?q=lat,lng
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, // formato interno del embed de Google
];

function extraerCoordenadas(url) {
  for (const patron of PATRONES_COORDENADAS) {
    const m = url.match(patron);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

// Busca la primera URL de Google Maps (larga o acortada) dentro de un texto
// libre - el cliente suele mandarla junto con otra frase ("mi ubicacion es
// https://maps.app.goo.gl/xxx, gracias").
function extraerUrlDeMaps(texto) {
  const m = String(texto || '').match(/https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.com\/maps)\S*/i);
  return m ? m[0] : null;
}

/**
 * Resuelve un texto que puede contener un link de Google Maps a
 * coordenadas reales. Nunca tira excepcion - siempre devuelve
 * {lat, lng} o null.
 */
async function resolverCoordenadas(texto) {
  const url = extraerUrlDeMaps(texto);
  if (!url) return null;

  // Si ya son coordenadas visibles en el link tal como vino (un link largo
  // que el cliente pego directo, sin acortar), no hace falta red.
  const directo = extraerCoordenadas(url);
  if (directo) return directo;

  // Si no, es un link acortado (maps.app.goo.gl / goo.gl/maps): hay que
  // seguirlo para llegar a la URL real con las coordenadas.
  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(url, { redirect: 'follow', signal: controlador.signal });
    return extraerCoordenadas(respuesta.url || '');
  } catch {
    return null;
  } finally {
    // Si fetch tira una excepcion de red (no un abort), el timeout de arriba
    // se quedaba pendiente sin cancelar - un timer colgado de mas, chico
    // pero innecesario. Se limpia siempre, salga como salga.
    clearTimeout(timeout);
  }
}

module.exports = { resolverCoordenadas, extraerCoordenadas, extraerUrlDeMaps };
