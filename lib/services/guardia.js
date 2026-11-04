'use strict';
// lib/services/guardia.js
//
// Guardia del bot: que solo hable del negocio, no se deje manipular y no
// invente. Idea tomada de AgendaBot, adaptada a Proshop. Defensa en capas, la
// mayoría SIN IA (cuestan 0 tokens):
//
//   1. ENTRADA (código): intentos de cambiar las reglas del bot o sacarle sus
//      instrucciones, y pedidos claramente ajenos a una tienda. No llegan al
//      modelo: se contestan con una frase fija y quedan anotados.
//   2. SALIDA (código): a lo que escribe la IA se le revisa que no filtre
//      instrucciones internas ni nombres de herramientas, que no traiga código,
//      que no mande links ajenos al negocio y que no mencione montos que no
//      existen en el catálogo, el carrito ni lo que dijo el cliente.
//
// Política de Meta (2026): en la API de WhatsApp solo se permiten bots de un
// proceso de negocio, no "ChatGPT generales".

const { crearContexto } = require('./mensajes');

const normalizar = (texto) => ` ${String(texto || '')
  .slice(0, 2000)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ$%.,\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()} `;

// Intentos de cambiar el rol del bot o sacarle sus instrucciones.
const MANIPULACION = [
  / ignor\w* (todas? )?(tus |las |los |mis )?(anteriores )?(instrucciones|reglas|indicaciones|ordenes|restricciones) /,
  / olvid\w* (todo|todas? tus|tus) (instrucciones|reglas|indicaciones|restricciones)? ?/,
  / (system|sistema) prompt | prompt del sistema | tu prompt /,
  / (revela\w*|muestra\w*|muestrame|dime|escribe\w*|copia\w*|pasame|imprime|repite) (tu |tus |el |las |todas tus )?(prompt|instrucciones|reglas internas|configuracion interna) /,
  / (actua|actue|comportate|finge|haz de cuenta|pretende|haz como si) (como|que eres|ser|que sos) /,
  / (a partir de ahora|desde ahora) (eres|seras|vas a ser|sos|vas a actuar|responde\w*|actua\w*) /,
  / modo (desarrollador|developer|dios|admin|sin filtros|libre) /,
  / jailbreak | dan mode /,
  / sin (restricciones|filtros|limites) /,
];

// Pedir datos de OTROS clientes (privacidad): el bot nunca los tiene a mano ni los da.
const PRIVACIDAD = [
  / (datos|telefonos?|numeros?|direccion(es)?|nombres?|correos?|compras|pedidos) (de|del) (los |las )?(otros|demas|otras|otro|anteriores|ultimos) (clientes?|compradores?|personas?|usuarios?)/,
  / (otros|demas|anteriores) (clientes?|compradores?) .{0,30}(telefono|numero|direccion|nombre|datos|compras|pedidos)/,
  / (quien|quienes) (compro|compraron|pidio|pidieron|fue el que compro) /,
];

// Pedidos claramente ajenos a una tienda (conservador: lo dudoso lo resuelve la IA).
const AJENO = [
  / (escribe|escribeme|hazme|haz|dame|ayudame con|genera\w*|programa\w*|crea) (un |una |el |la )?(codigo|programa|script|funcion en|consulta sql|macro|pagina web|app) /,
  / (python|javascript|typescript|java script|sql|html|css|php) /,
  / (mi |una |la )?(tarea|deberes|ensayo|monografia) (de|del|sobre|para) /,
  / (traduce\w*|traduccion) (esto|al ingles|al espanol|este texto) /,
  / (escribe\w*|hazme|dame|cuentame) (un |una )?(poema|cuento|cancion|chiste|historia) /,
  / (bitcoin|criptomoneda\w*|trading|apuestas deportivas) /,
  / (chatgpt|gemini|copilot|openai) /,
  / quien (gano|va ganando) (el partido|las elecciones|el mundial) /,
];

/** { tema: 'manipulacion' | 'fuera_de_tema', motivo } o null. */
function evaluarEntrada(texto) {
  const t = normalizar(texto);
  if (MANIPULACION.some((re) => re.test(t))) return { tema: 'manipulacion', motivo: 'intento de cambiar las instrucciones del bot' };
  if (PRIVACIDAD.some((re) => re.test(t))) return { tema: 'privacidad', motivo: 'pidio datos de otros clientes' };
  if (AJENO.some((re) => re.test(t))) return { tema: 'fuera_de_tema', motivo: 'pedido ajeno al negocio' };
  return null;
}

/** Respuesta fija cuando el cliente se va del tema o intenta manipular al bot. */
function respuestaAlcance(empresa, tema, mensajes) {
  const m = mensajes || crearContexto({ negocio: { nombre: (empresa && (empresa.marca || empresa.nombre)) || 'la tienda' } });
  return m.t(tema === 'privacidad' ? 'alcance_privacidad' : tema === 'manipulacion' ? 'alcance_manipulacion' : 'alcance_fuera_de_tema');
}

// ------------------------------------------------------------------ salida

// Texto de las instrucciones internas y nombres de herramientas: nunca deben llegar al cliente.
const FUGA = /(REGLA ANTI-INVENTO|SI NO SABES ALGO, DECILO|USA LISTAS SOLO PARA OPCIONES|CIERRE SIN INSISTIR|RECORDATORIO DEL SISTEMA|ATENCION CRITICA DEL INVENTARIO|REGLA DURA DEL NEGOCIO|TOOL_(SUCCESS|FAILED)|system prompt|prompt del sistema|mis instrucciones (son|dicen|me piden))/i;
const HERRAMIENTAS = /\b(actualizar_datos_lead|mostrar_productos|ver_mas_productos|enviar_fotos_producto|buscar_producto|agregar_al_carrito|ver_carrito|quitar_del_carrito|cambiar_cantidad_carrito|confirmar_pedido|crear_pedido|derivar_a_asesor|mostrar_categorias|mostrar_tarjeta_categoria)\b/;

const HOSTS_BASE = ['wa.me', 'api.whatsapp.com', 'maps.google.com', 'www.google.com', 'google.com', 'maps.app.goo.gl', 'goo.gl', 'g.page'];

function hostDe(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

/**
 * Hosts permitidos en los links de la respuesta: los del propio sistema (la
 * URL desde la que se atiende, PUBLIC_URL), los típicos de WhatsApp/Maps y los
 * que el negocio escribió en su FAQ, conocimiento o dirección.
 */
function hostsPermitidos({ baseUrl, textoDelNegocio = '' } = {}) {
  const hosts = new Set(HOSTS_BASE);
  for (const u of [baseUrl, process.env.PUBLIC_URL, process.env.APP_URL, process.env.APP_BASE_URL]) {
    const h = u && hostDe(u);
    if (h) hosts.add(h);
  }
  for (const u of String(textoDelNegocio).match(/https?:\/\/[^\s)]+/g) || []) {
    const h = hostDe(u);
    if (h) hosts.add(h);
  }
  return hosts;
}

// ---- montos ----
const MONTO = /(?:Bs\.?|US\$|\$|USD|BOB)\s?(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s?(?:Bs\b|bolivianos|d[oó]lares)/gi;
const numero = (s) => Number(String(s).replace(',', '.'));

function montosDe(texto) {
  return [...String(texto || '').matchAll(MONTO)].map((m) => numero(m[1] || m[2])).filter(Number.isFinite);
}

/** Todos los números sueltos de un texto (lo que dijo el cliente, la FAQ...). */
function numerosDe(texto) {
  return (String(texto || '').match(/\d+(?:[.,]\d+)?/g) || []).map(numero).filter(Number.isFinite);
}

/**
 * Conjunto de montos que la IA PUEDE mencionar: precios del catálogo (y de sus
 * variantes), múltiplos de 1 a 20 unidades, sumas de dos precios, totales del
 * carrito y de los pedidos recientes, y cualquier número que ya haya dicho el
 * cliente, el negocio (FAQ) o el propio bot antes.
 */
function montosPermitidos({ precios = [], extras = [] } = {}) {
  const p = [...new Set(precios.filter((x) => Number.isFinite(x) && x > 0))];
  const set = new Set();
  const add = (n) => set.add(Math.round(n * 100) / 100);
  for (const x of p) for (let q = 1; q <= 20; q += 1) add(x * q);
  if (p.length <= 120) for (let i = 0; i < p.length; i += 1) for (let j = i + 1; j < p.length; j += 1) add(p[i] + p[j]);
  for (const e of extras) if (Number.isFinite(e)) add(e);
  return set;
}

/**
 * Problemas de lo que escribió la IA (vacío = ok).
 *   permitidos: Set de montos (ver montosPermitidos). null = no revisar montos.
 */
function auditarSalida(texto, { baseUrl, textoDelNegocio = '', permitidos = null } = {}) {
  const problemas = [];
  const t = String(texto || '');
  if (FUGA.test(t)) problemas.push('filtró instrucciones internas');
  if (HERRAMIENTAS.test(t)) problemas.push('mencionó el nombre de una herramienta interna');
  if (/```/.test(t)) problemas.push('escribió un bloque de código');
  const hosts = hostsPermitidos({ baseUrl, textoDelNegocio });
  const raros = (t.match(/https?:\/\/[^\s)*_]+/g) || []).filter((u) => !hosts.has(hostDe(u)));
  if (raros.length) problemas.push(`incluyó links que no son del negocio (${raros.join(', ')})`);
  if (permitidos) {
    const malos = montosDe(t).filter((m) => !permitidos.has(Math.round(m * 100) / 100));
    if (malos.length) problemas.push(`mencionó montos que no existen (${[...new Set(malos)].join(', ')})`);
  }
  return problemas;
}

/** Lo que se le dice al cliente cuando la respuesta de la IA no pasó la revisión. */
function respuestaSegura(empresa, problemas = [], mensajes) {
  const m = mensajes || crearContexto({ negocio: { nombre: (empresa && (empresa.marca || empresa.nombre)) || 'la tienda' } });
  const soloMontos = problemas.length > 0 && problemas.every((p) => p.startsWith('mencionó montos'));
  if (soloMontos) {
    return m.t('precio_equivocado');
  }
  return respuestaAlcance(empresa, 'fuera_de_tema', m);
}

module.exports = {
  evaluarEntrada, respuestaAlcance, auditarSalida, respuestaSegura,
  hostsPermitidos, montosDe, numerosDe, montosPermitidos, normalizar,
};
