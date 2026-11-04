'use strict';
// lib/services/referencias.js
//
// "La más barata", "la negra", "la de 650", "la segunda": el cliente se refiere
// a una de las opciones que YA se le mostraron. Se resuelve en código, sin IA:
// el modelo no tiene que adivinar cuál era, y si dos opciones calzan se le
// PREGUNTA cuál en vez de elegir una (idea tomada de AgendaBot, referenciaAItem).
//
//   resolverReferencia(texto, mostrados) ->
//     { producto }                     una sola opción calza
//     { ambiguos: [productos] }        varias calzan: hay que preguntar
//     null                             no es una referencia a lo mostrado
//
// mostrados: productos (con variantes) en el orden en que se mostraron; se
// miran como mucho los ultimos 3 (la tanda de tarjetas mas reciente).

const norm = (s) => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;

// "negra" / "negro" / "negros" -> "negr"; "blanca" -> "blanc". Deliberadamente simple.
const raiz = (w) => (w.length >= 5 ? w.replace(/(as|os|a|o|es|s)$/, '') : w);

const RELLENO = new Set([
  'gusta', 'gusto', 'interesa', 'interesan', 'encanta', 'quiero', 'esa', 'ese', 'esta', 'este', 'aquella', 'aquel', 'que', 'con', 'mas', 'menos', 'opcion',
  'una', 'uno', 'unas', 'unos', 'por', 'favor', 'las', 'los', 'del', 'pero', 'tiene', 'ver', 'verla', 'verlo', 'llevo', 'llevar', 'comprar', 'compro',
  'primera', 'primero', 'segunda', 'segundo', 'tercera', 'tercero', 'ultima', 'ultimo', 'barata', 'barato', 'cara', 'caro', 'economica', 'economico',
]);

const ORDINALES = { primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, ultima: -1, ultimo: -1 };

// Frases que indican "me refiero a una de las que me mostraste".
const PISTA = / (la|el|esa|ese|esta|este|aquella|aquel) (de|del|que|con|en|mas|menos) | me (gusta|gusto|interesa|interesan|encanta) | quiero (la|el|esa|ese|esta|este) | (llevo|compro|quiero llevar|me quedo con) (la|el|esa|ese) /;
const SUPERLATIVO = / (la|el)? ?(mas|menos) (barat[oa]|economic[oa]|car[oa])/;

function precioDe(p) {
  return Number(p.precio);
}

// Palabras "del producto" para distinguirlo de los otros: nombre, categoria y
// valores de sus variantes (color, talla...).
function palabrasDe(p) {
  const valores = [];
  for (const v of p.variantes || []) for (const val of Object.values(v.atributos || {})) valores.push(String(val));
  const texto = `${p.nombre || ''} ${(p.categoria && p.categoria.nombre) || ''} ${valores.join(' ')}`;
  return new Set(norm(texto).trim().split(' ').filter((w) => w.length >= 2).map(raiz));
}

function resolverReferencia(texto, mostradosTodos = []) {
  const mostrados = mostradosTodos.slice(-3);
  if (mostrados.length < 2) return null;
  const t = norm(texto);
  if (t.trim().length > 140) return null;

  const supl = t.match(SUPERLATIVO);
  const ord = t.match(/ (primer[ao]?|segund[ao]|tercer[ao]?|ultim[ao]) /);
  const numeroEnFrase = t.match(/ (?:la|el|opcion|numero|nro) (\d) /);
  if (!PISTA.test(t) && !supl && !ord && !numeroEnFrase) return null;

  // 1) Superlativos por precio
  if (supl) {
    // "mas cara" y "menos barata" = la de mayor precio; "mas barata" y "menos cara" = la de menor precio.
    const caro = /mas car[oa]|menos (barat|economic)/.test(supl[0]);
    const precios = mostrados.map(precioDe);
    if (precios.every(Number.isFinite)) {
      const objetivo = caro ? Math.max(...precios) : Math.min(...precios);
      const idx = precios.map((p, i) => (p === objetivo ? i : -1)).filter((i) => i >= 0);
      return idx.length === 1 ? { producto: mostrados[idx[0]] } : { ambiguos: idx.map((i) => mostrados[i]) };
    }
  }

  // 2) Posicion: "la segunda", "la 2"
  const n = numeroEnFrase ? Number(numeroEnFrase[1]) : ord ? ORDINALES[ord[1]] || ORDINALES[`${ord[1].replace(/[ao]$/, '')}a`] : null;
  if (n) {
    const i = n === -1 ? mostrados.length - 1 : n - 1;
    if (i >= 0 && i < mostrados.length) return { producto: mostrados[i] };
  }

  // 3) Por lo que lo distingue: color, talla, modelo, precio ("la negra", "la de 650")
  const conjuntos = mostrados.map(palabrasDe);
  const comunes = new Set([...conjuntos[0]].filter((w) => conjuntos.every((s) => s.has(w))));
  const montos = (String(texto).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => Number(x.replace(',', '.')));
  const palabras = [...new Set(t.trim().split(' ').map(raiz))].filter((w) => w.length >= 3 && !RELLENO.has(w) && !comunes.has(w));
  const puntajes = mostrados.map((p, i) => {
    let puntos = palabras.filter((w) => [...conjuntos[i]].some((x) => !comunes.has(x) && (x === w || (w.length >= 4 && x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))))).length;
    if (montos.includes(precioDe(p))) puntos += 2;
    return puntos;
  });
  const max = Math.max(...puntajes);
  if (!max) return null;
  const mejores = puntajes.map((p, i) => (p === max ? i : -1)).filter((i) => i >= 0);
  return mejores.length === 1 ? { producto: mostrados[mejores[0]] } : { ambiguos: mejores.map((i) => mostrados[i]) };
}

/** Pregunta cerrada para cuando dos o mas opciones calzan ("1) ... 2) ..."), que resolverSeleccionMenu entiende. */
function preguntaDeAclaracion(ambiguos, formatearPrecio) {
  const lineas = ambiguos.map((p, i) => `${i + 1}) ${p.nombre}${formatearPrecio ? ` — ${formatearPrecio(precioDe(p))}` : ''}`);
  return `¿Cuál de estas?\n${lineas.join('\n')}\nRespondé con el número o el nombre 🙂`;
}

module.exports = { resolverReferencia, preguntaDeAclaracion };
