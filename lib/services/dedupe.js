// Deduplicacion de eventos entrantes (ej. el reenvio de un webhook de Meta
// con el mismo message id). En memoria: sirve con una sola instancia del
// servidor y se pierde al reiniciar, que es aceptable porque Meta reintenta
// a los pocos segundos/minutos, no dias despues.
//
// Puro (sin DB ni red): el tiempo se inyecta para poder testearlo.

const TTL_MS = 60 * 60 * 1000; // 1 h
const MAX_IDS = 5000;

const vistos = new Map(); // id -> timestamp en que se vio por primera vez

function purgar(ahora) {
  for (const [id, ts] of vistos) {
    if (ahora - ts > TTL_MS) vistos.delete(id);
    else break; // el Map conserva el orden de insercion: el resto es mas nuevo
  }
  while (vistos.size > MAX_IDS) vistos.delete(vistos.keys().next().value);
}

/**
 * Devuelve true si este id ya se habia visto (y todavia no vencio), false si
 * es la primera vez (lo registra). Sin id no se puede deduplicar: false.
 */
function yaProcesado(id, ahora = Date.now()) {
  if (!id) return false;
  purgar(ahora);
  if (vistos.has(id)) return true;
  vistos.set(id, ahora);
  return false;
}

function reiniciar() {
  vistos.clear();
}

module.exports = { yaProcesado, reiniciar, TTL_MS, MAX_IDS };
