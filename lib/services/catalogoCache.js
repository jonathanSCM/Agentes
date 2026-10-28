// Cache en memoria del catalogo publico (/catalogo/:slug), por empresa.
//
// El listado carga TODO el catalogo (productos + variantes + categorias) en
// cada visita. Una promo con muchas visitas pegaba a Postgres una vez por
// visita. Aca se guarda el resultado ya armado unos segundos y se invalida
// apenas cambia algo (ver los puntos de invalidacion en server.js y agente.js).
//
// Solo cachea el LISTADO. El stock real se sigue validando contra Postgres al
// agregar al carrito y al confirmar un pedido: lo peor que puede pasar por
// esta cache es que el listado muestre un numero con unos segundos de atraso.
//
// Limitacion: vive en la memoria del proceso (instancia unica, igual que
// dedupe.js). Con varias instancias cada una tendria su copia y la
// invalidacion solo llegaria a la que recibio el cambio; el TTL corto acota
// el atraso. Si se escala a mas de una instancia hay que pasar esto a Redis.

const TTL_MS = Number(process.env.CATALOGO_CACHE_TTL_MS || 45 * 1000);
const MAX_ENTRADAS = 500;

const entradas = new Map(); // slug -> { valor, vence, empresaId }
const enVuelo = new Map(); // slug -> Promise (evita N cargas simultaneas del mismo catalogo)
// Sube con cada invalidacion: una carga que empezo ANTES de invalidar no puede
// guardar su resultado (seria justo el dato viejo que se queria descartar).
let version = 0;

/**
 * Devuelve el catalogo de `slug` desde la cache, o lo carga con `cargar()`.
 * `cargar` debe devolver `{ empresaId, ... }` o null si el slug no existe
 * (null no se cachea: un slug inventado no debe llenar la memoria).
 */
async function obtenerCatalogo(slug, cargar, ahora = Date.now()) {
  const guardada = entradas.get(slug);
  if (guardada && guardada.vence > ahora) return guardada.valor;

  const pendiente = enVuelo.get(slug);
  if (pendiente) return pendiente;

  const versionAlEmpezar = version;
  const carga = (async () => {
    try {
      const valor = await cargar();
      if (valor && versionAlEmpezar === version) {
        if (entradas.size >= MAX_ENTRADAS) entradas.delete(entradas.keys().next().value);
        entradas.set(slug, { valor, vence: ahora + TTL_MS, empresaId: valor.empresaId });
      }
      return valor;
    } finally {
      if (enVuelo.get(slug) === carga) enVuelo.delete(slug);
    }
  })();
  enVuelo.set(slug, carga);
  return carga;
}

/** Descarta lo guardado de una empresa (cambio de productos, stock, categorias, config...). */
function invalidarEmpresa(empresaId) {
  version += 1;
  for (const [slug, e] of entradas) if (e.empresaId === empresaId) entradas.delete(slug);
  enVuelo.clear();
}

/** Descarta todo (cambios desde el admin: marca, slug, moneda de cualquier empresa). */
function invalidarTodo() {
  version += 1;
  entradas.clear();
  enVuelo.clear();
}

function reiniciar() {
  invalidarTodo();
}

module.exports = { obtenerCatalogo, invalidarEmpresa, invalidarTodo, reiniciar, TTL_MS, MAX_ENTRADAS };
