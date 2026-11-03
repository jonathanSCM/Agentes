// Frases del cliente que el codigo puede entender SIN IA (puro, sin DB ni red).
//
// Salieron de una conversacion real del piloto (3-nov) donde el bot, con el
// carrito en "3x", contestaba "esto es lo que llevas" a "solo quiero un par",
// no entendia "cancela" y, vaciado el carrito, se quedaba atascado en una
// categoria ante "quiero hacer una compra" o "algo para mi novia".
//
// Regla de diseño: solo se actua con frases CLARAS. Ante la duda no se
// intercepta (la IA lo resuelve como siempre): es peor cambiar algo del carrito
// por una mala lectura que dejar pasar una frase rara.

const NUMEROS = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const NUM = '(\\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿?¡!.,;:"“”()*]/g, ' ').replace(/\s+/g, ' ').trim();

function aNumero(token) {
  if (token == null) return null;
  const t = String(token).toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMEROS[t] != null ? NUMEROS[t] : null;
}

/**
 * ¿El cliente corrige la CANTIDAD de lo que lleva?
 *  - "solo quiero un par" / "solo uno" / "solo quiero 2" -> fijar esa cantidad
 *  - "marque 3 por casualidad ... quiero uno" -> fijar
 *  - "cambialo a 2" / "dejalo en 1" -> fijar
 *  - "quitame uno" / "saca 2" -> restar
 *
 * @returns {{tipo:'fijar'|'quitar', cantidad:number}|null}
 */
function detectarAjusteDeCantidad(texto) {
  const t = norm(texto);
  if (!t || t.length > 140) return null;

  // "solo quiero un par", "solo quiero 2", "yo solo necesito uno"
  let m = t.match(new RegExp(`\\b(?:solo|nomas|unicamente)\\s+(?:quiero|necesito|llevo|dame|me llevo|pido|compro)?\\s*${NUM}\\b(?:\\s+(?:par|pares|unidad|unidades|pieza|piezas))?`));
  if (m && aNumero(m[1]) != null && aNumero(m[1]) >= 1) return { tipo: 'fijar', cantidad: aNumero(m[1]) };

  // "un par nomas", "uno solo", "una sola"
  m = t.match(new RegExp(`^(?:quiero\\s+|dame\\s+|ponme\\s+)?${NUM}(?:\\s+(?:par|pares|unidad|unidades))?\\s+(?:nomas|no mas|solo|sola|solamente)$`));
  if (m && aNumero(m[1]) >= 1) return { tipo: 'fijar', cantidad: aNumero(m[1]) };

  // "cambialo a 2", "dejalo en 1", "ponlo en 2", "pon solo 1"
  m = t.match(new RegExp(`\\b(?:cambia(?:lo|la)?|ponlo|ponla|pon|dejalo|dejala|deja|ponme)\\s+(?:a|en|solo)?\\s*${NUM}(?:\\s+(?:par|pares|unidad|unidades))?$`));
  if (m && aNumero(m[1]) >= 1) return { tipo: 'fijar', cantidad: aNumero(m[1]) };

  // Se equivoco al marcar y dice cuantos quiere: "me marcaron 3x ... quiero 1"
  const culpa = /(marque|marcaron|marcado|puse|pusieron|por casualidad|de mas|me equivoque|equivoque|se me paso|me salieron|me salio|aparecen|aparece)/.test(t);
  if (culpa) {
    const nums = [...t.matchAll(new RegExp(`\\b${NUM}\\b`, 'g'))].map((x) => aNumero(x[1])).filter((n) => n != null && n >= 1);
    if (nums.length >= 2) return { tipo: 'fijar', cantidad: nums[nums.length - 1] };
  }

  // "quitame uno", "saca 2", "resta una"
  m = t.match(new RegExp(`^(?:quita|quitame|saca|sacame|resta|restame|elimina)\\s+${NUM}(?:\\s+(?:par|pares|unidad|unidades))?$`));
  if (m && aNumero(m[1]) >= 1) return { tipo: 'quitar', cantidad: aNumero(m[1]) };

  return null;
}

/**
 * ¿Quiere cerrar la compra? ("finalizar", "quiero finalizar mi pedido": es lo que
 * manda el boton "Finalizar en WhatsApp" de la web). Solo frases enteras.
 */
function quiereFinalizar(texto) {
  const t = norm(texto);
  if (!t || t.length > 60) return false;
  return /^(?:(?:ya |ahora )?quiero |quisiera |me gustaria )?(?:finalizar|terminar|cerrar|concretar|completar)(?: mi| la| el| esta| ese| esa)?(?: compra| pedido| orden)?(?: por favor| porfa)?$/.test(t);
}

/**
 * ¿Quiere cancelar / vaciar lo que lleva? Solo frases enteras y claras.
 * @returns {boolean}
 */
function quiereCancelar(texto) {
  const t = norm(texto);
  if (!t || t.length > 60) return false;
  return /^(?:(?:ya |mejor )?no quiero nada|ya no quiero(?: nada)?|olvidalo|olvidalo todo|dejalo asi|cancela(?:lo|r)?(?: todo)?|cancela(?:r)?(?: el| mi| la| esta)? (?:pedido|compra|orden|carrito)|(?:vacia|vaciar|borra|borrar|elimina|eliminar)(?: el| mi)? carrito|(?:saca|sacar|quita|quitar) todo|sacalo todo|quitalo todo)$/.test(t);
}

/**
 * ¿Quiere empezar de nuevo, ver todo lo que hay o pide ayuda para elegir?
 * @returns {'regalo'|'empezar'|'mas'|null}
 */
function detectarReinicio(texto) {
  const t = norm(texto);
  if (!t || t.length > 120) return null;
  if (/\b(regalo|regalar|para mi (novia|novio|esposa|esposo|mama|papa|hijo|hija|hermano|hermana|amigo|amiga|pareja|jefe|abuela|abuelo)|me recomiendas|que me recomiendas|me recomienda|me sugieres|que me sugieres|me aconsejas|recomiendame|sugiereme|recomendacion|que recomiendas)\b/.test(t)) return 'regalo';
  if (/^(?:quiero|quisiera|queria|me gustaria|necesito|deseo|voy a|vamos a|quiero hacer|quisiera hacer|me gustaria hacer)\s+(?:hacer\s+)?(?:una\s+|otra\s+)?(?:compra|comprar|pedido|pedir)(?: algo)?$/.test(t)
    || /^(?:quiero|quisiera|me gustaria)\s+ver\s+(?:los\s+|sus\s+)?(?:productos|catalogo|el catalogo|que tienen|que hay|lo que tienen)$/.test(t)) return 'empezar';
  if (/\b(?:que|cuales|cuantas?) (?:productos |cosas |categorias )?(?:venden|tienen|hay|ofrecen)\b/.test(t) && !/\b(talla|color|colores|tallas)\b/.test(t)) return 'empezar';
  // "solo eso" a secas lo dice quien YA termino ("solo eso, gracias"): solo es
  // pregunta si trae el verbo ("solo eso tienes") o un signo de pregunta.
  const preguntaSoloEso = /\bsolo (?:eso|esto|esas|esos)\s+(?:tienes|tienen|hay|venden|ofreces|ofrecen|manejan|manejas)\b/.test(t)
    || (/\?/.test(String(texto)) && /^solo (?:eso|esto|esas|esos)$/.test(t));
  if (preguntaSoloEso
    || /\b(?:que|y que) mas (?:tienes|tienen|hay|venden|ofrecen)\b/.test(t)
    || /\bno (?:tienes|tienen|hay) mas\b/.test(t)
    || /\botr[ao]s? (?:cosas?|categorias?|productos?)\b/.test(t)) return 'mas';
  return null;
}

module.exports = { detectarAjusteDeCantidad, quiereCancelar, quiereFinalizar, detectarReinicio, aNumero, norm };
