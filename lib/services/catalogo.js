// Motor de busqueda del catalogo: filtros, orden de alternativas, paginacion
// y seleccion de fotos. Todo puro y determinista (sin DB ni red), para que se
// pueda testear sin levantar nada y sin depender de un proveedor de IA.
//
// Vive separado de agente.js a proposito: agente.js es "como se le habla al
// modelo", esto es "que existe de verdad en el inventario". La IA nunca
// decide nada de lo que se calcula aca (ver docs/02-motor-del-agente.md).

const PALABRAS_GENERICAS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'en', 'por', 'para', 'con', 'un', 'una', 'unos', 'unas', 'que',
]);

function palabrasClave(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 1 && !PALABRAS_GENERICAS.has(p));
}

function coincideTexto(valorLead, valorProducto) {
  if (!valorLead) return true;
  const clavesLead = palabrasClave(valorLead);
  const clavesProd = palabrasClave(valorProducto);
  if (!clavesLead.length) return true;
  return clavesLead.every((a) => clavesProd.some((b) => b.includes(a) || a.includes(b)));
}

function normalizarSimple(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// "L y XL", "S, M, L", "Negro/Azul" -> ["l","xl"] / ["s","m","l"] / ["negro","azul"].
// Deliberadamente simple (sin palabrasClave): tallas como "S"/"M"/"L" son de 1
// caracter y palabrasClave las descartaria por ser "muy cortas".
function tokensDeLista(texto) {
  return String(texto || '')
    .split(/,|\/|\by\b|\be\b/gi)
    .map((t) => normalizarSimple(t))
    .filter(Boolean);
}

const ORDEN_TALLAS = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];
function compararTallas(a, b) {
  const ia = ORDEN_TALLAS.indexOf(normalizarSimple(a));
  const ib = ORDEN_TALLAS.indexOf(normalizarSimple(b));
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return String(a).localeCompare(String(b), 'es', { numeric: true });
}

// ============================ Presupuesto ============================

function parsePrecio(texto) {
  if (texto === null || texto === undefined) return null;
  const t = String(texto).toLowerCase();
  const m = t.replace(/[.,](?=\d{3}\b)/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  let monto = Number(m[0]);
  if (/\d\s*(k\b|mil\b)/.test(t)) monto *= 1000;
  const moneda = /\b(bs|bob|boliviano)/.test(t) ? 'bs' : /(usd|\$us|us\$|\$|dolar)/.test(t) ? 'usd' : null;
  return { monto, moneda };
}

const TOLERANCIA_PRESUPUESTO = 1.3;
const TOPE_PRESUPUESTO = 1.5;

function estadoPresupuesto(leadPresupuesto, precioProducto) {
  const presupuesto = parsePrecio(leadPresupuesto);
  const precio = parsePrecio(String(precioProducto));
  if (!presupuesto || !precio || !presupuesto.monto || !precio.monto) return 'dentro';
  if (presupuesto.moneda && precio.moneda && presupuesto.moneda !== precio.moneda) return 'dentro';
  return compararContraTope(presupuesto.monto, precio.monto);
}

function compararContraTope(maximo, precio) {
  if (precio > maximo * TOPE_PRESUPUESTO) return 'fuera_de_presupuesto';
  if (precio > maximo * TOLERANCIA_PRESUPUESTO) return 'excedido';
  return 'dentro';
}

// Rango numerico ya interpretado del lead. Prefiere las columnas numericas
// (ClienteFinal.presupuestoMin/Max, que el backend calcula una sola vez) y
// cae al texto libre solo si todavia no se interpretaron.
function rangoPresupuesto(lead = {}) {
  const min = lead.presupuestoMin != null ? Number(lead.presupuestoMin) : null;
  const max = lead.presupuestoMax != null ? Number(lead.presupuestoMax) : null;
  if (min != null || max != null) return { min, max };
  const parseado = parsePrecio(lead.presupuesto);
  return { min: null, max: parseado ? parseado.monto : null };
}

// Interpreta el texto libre del cliente a un rango numerico. Soporta
// "hasta 500", "entre 300 y 500", "300-500" y "unos 400".
function interpretarPresupuesto(texto) {
  if (!texto) return { min: null, max: null };
  const t = String(texto).toLowerCase();
  const rango = t.match(/(\d+(?:[.,]\d+)?)\s*(?:-|a|hasta|y)\s*(\d+(?:[.,]\d+)?)/);
  if (rango) {
    const a = parsePrecio(rango[1]);
    const b = parsePrecio(rango[2]);
    if (a && b) return { min: Math.min(a.monto, b.monto), max: Math.max(a.monto, b.monto) };
  }
  const uno = parsePrecio(t);
  if (!uno) return { min: null, max: null };
  return { min: null, max: uno.monto };
}

function estadoPresupuestoDeLead(lead = {}, precioProducto) {
  const { max } = rangoPresupuesto(lead);
  if (max == null) return 'dentro';
  const precio = parsePrecio(String(precioProducto));
  if (!precio || !precio.monto) return 'dentro';
  return compararContraTope(max, precio.monto);
}

// ============================ Coincidencias de producto ============================

// Texto libre de un producto (nombre + caracteristicas + descripcion + sus
// atributos propios: marca, material, voltaje, lo que sea + los atributos de
// sus variantes activas: talla, color, etc.) para poder matchear marca/talla/
// color contra lo que el cliente pidio, ya que esos datos no siempre son un
// campo estructurado propio del producto.
function textoCompletoProducto(p) {
  const atributosProducto = Object.values(p.atributos || {}).join(' ');
  const atributosVariantes = (p.variantes || [])
    .filter((v) => v.activa)
    .map((v) => Object.values(v.atributos || {}).join(' '))
    .join(' ');
  return `${p.nombre} ${(p.caracteristicas || []).join(' ')} ${p.descripcion || ''} ${atributosProducto} ${atributosVariantes}`;
}

function coincideAtributo(valorLead, p) {
  if (!valorLead) return true;
  return coincideTexto(valorLead, textoCompletoProducto(p));
}

// Valor de un atributo con nombre exacto, mirando primero el producto y
// despues sus variantes activas. Devuelve null si ese producto no tiene ese
// atributo cargado en ningun lado.
function valorDeAtributo(p, nombre) {
  const clave = normalizarSimple(nombre);
  const enProducto = Object.entries(p.atributos || {}).find(([k]) => normalizarSimple(k) === clave);
  if (enProducto) return String(enProducto[1]);
  const valores = [];
  for (const v of (p.variantes || []).filter((v) => v.activa)) {
    const enVariante = Object.entries(v.atributos || {}).find(([k]) => normalizarSimple(k) === clave);
    if (enVariante) valores.push(String(enVariante[1]));
  }
  return valores.length ? valores.join(', ') : null;
}

/**
 * Palabras que significan lo mismo pero cada negocio escribe distinto. Sin
 * esto, un producto etiquetado "Masculino" quedaba invisible para el cliente
 * que dijo "hombre" - paso en produccion: de 4 zapatillas cargadas el bot
 * solo reconocia 1 y le juraba al cliente que era el unico modelo.
 *
 * No es logica de rubro: es vocabulario del idioma. Cada fila es un grupo de
 * equivalentes; agregar un sinonimo nuevo es sumar una palabra a su fila.
 */
const EQUIVALENCIAS = [
  ['hombre', 'masculino', 'varon', 'caballero', 'masculina', 'hombres', 'h', 'm'],
  ['mujer', 'femenino', 'dama', 'señora', 'femenina', 'mujeres', 'f'],
  ['niño', 'infantil', 'nino', 'kids', 'niños', 'ninos'],
  ['niña', 'nina', 'niñas', 'ninas'],
  ['unisex', 'ambos', 'todos'],
];

// "masculino" -> el grupo al que pertenece. Se arma una sola vez.
const GRUPO_DE_PALABRA = new Map();
for (const grupo of EQUIVALENCIAS) {
  // "m" y "h" son ambiguas ("m" podria ser mujer): solo valen dentro de su
  // grupo si la otra punta tambien es corta, asi que se guardan igual pero
  // la comparacion exige que AMBOS lados caigan en el mismo grupo.
  for (const palabra of grupo) GRUPO_DE_PALABRA.set(palabra, grupo[0]);
}

/**
 * Raiz de una palabra, sin plural ni terminacion de genero.
 *
 * "blancas" y "blanco" son el mismo color, pero comparados como texto no
 * coinciden: el cliente escribe "blancas" (zapatillas) y el catalogo dice
 * "blanco". Eso hacia que el bot no encontrara el color pedido y terminara
 * mandando la foto de otro - bug real reportado con capturas.
 */
function raizDePalabra(palabra) {
  let t = normalizarSimple(palabra);
  if (t.length > 4 && t.endsWith('es')) t = t.slice(0, -2); // grises -> gris
  else if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1); // blancas -> blanca
  if (t.length > 3 && /[ao]$/.test(t)) t = t.slice(0, -1); // blanca/blanco -> blanc
  return t;
}

// Raices de un valor que puede tener varias palabras ("Rosa palo", "Blanco nube").
function raicesDeValor(valor) {
  return new Set(
    normalizarSimple(valor)
      .split(/[\s/-]+/)
      .filter((w) => w.length > 1)
      .map(raizDePalabra),
  );
}

/**
 * ¿"Masculino" y "hombre" son lo mismo? ¿Y "blancas" y "Blanco nube"?
 *
 * Tres pasadas, de la mas exacta a la mas laxa:
 *  1. igualdad literal;
 *  2. grupo de equivalencia (hombre/masculino/varon);
 *  3. raices en comun, para plural y genero ("blancas" ≈ "Blanco nube").
 */
function valoresEquivalentes(valorLead, valorProducto) {
  const a = normalizarSimple(valorLead);
  const b = normalizarSimple(valorProducto);
  if (a === b) return true;

  const grupoA = GRUPO_DE_PALABRA.get(a);
  const grupoB = GRUPO_DE_PALABRA.get(b);
  if (grupoA && grupoB) return grupoA === grupoB;

  const raicesA = raicesDeValor(valorLead);
  const raicesB = raicesDeValor(valorProducto);
  for (const r of raicesA) if (raicesB.has(r)) return true;

  return coincideTexto(valorLead, valorProducto);
}

/**
 * Filtra por los atributos que el cliente ya definio (Genero, Uso, etc.,
 * guardados en ClienteFinal.atributosLead).
 *
 * Criterio deliberado: si el producto TIENE ese atributo cargado, tiene que
 * coincidir (un cliente que pidio ropa de hombre no puede recibir ropa de
 * mujer). Si el producto NO lo tiene cargado, no se lo excluye - no hay dato
 * que lo contradiga, y descartarlo esconderia inventario real solo por estar
 * mal etiquetado. Esos productos igual rankean mas abajo (ver scoreProducto).
 *
 * Un producto puede declarar varios valores ("Genero: Hombre, Mujer"): alcanza
 * con que UNO coincida.
 */
/**
 * Busca por NOMBRE en todo el catalogo, ignorando los filtros de la
 * conversacion. Cuando el cliente nombra algo puntual ("¿tenes las Tekkira
 * Cup?") merece saber si existe o no, no si calza con el color que pidio tres
 * mensajes atras.
 *
 * Existe porque en produccion el bot le dijo a un cliente que no tenian una
 * zapatilla que estaba cargada con stock 10: no la veia porque el bloque de
 * resultados venia filtrado por genero.
 *
 * Tolerante a como escribe la gente: alcanza con que una palabra significativa
 * del nombre coincida ("tekkira" encuentra "ZAPATILLAS TEKKIRA CUP").
 */
function buscarPorNombre(productos, nombre) {
  const buscado = String(nombre || '').trim();
  if (!buscado) return { conStock: [], agotados: [] };

  const claves = palabrasClave(buscado).filter((k) => k.length > 2);

  // Se puntua por cuantas palabras del pedido aparecen en el nombre y se
  // queda solo con los mejores. Sin esto, buscar "ZAPATILLAS TEKKIRA CUP"
  // devolvia tambien "ZAPATILLAS GINGER TAV" (comparten "zapatillas") y el
  // bot terminaba nombrandole al cliente un producto que no pidio.
  const puntuados = (productos || []).map((p) => {
    const suNombre = normalizarSimple(p.nombre);
    const puntaje = claves.length
      ? claves.filter((k) => suNombre.includes(k)).length
      : (suNombre.includes(normalizarSimple(buscado)) ? 1 : 0);
    return { p, puntaje };
  }).filter((x) => x.puntaje > 0);

  const mejor = Math.max(0, ...puntuados.map((x) => x.puntaje));
  const encontrados = puntuados.filter((x) => x.puntaje === mejor).map((x) => x.p);

  return {
    conStock: encontrados.filter((p) => tieneStock(p)),
    agotados: encontrados.filter((p) => !tieneStock(p)),
  };
}

function coincideAtributosLead(p, lead = {}) {
  const atributos = lead.atributosLead || {};
  for (const [nombre, valor] of Object.entries(atributos)) {
    if (!valor) continue;
    const valorProducto = valorDeAtributo(p, nombre);
    if (valorProducto === null) continue;
    const delProducto = String(valorProducto).split(',').map((v) => v.trim()).filter(Boolean);
    const delCliente = String(valor).split(',').map((v) => v.trim()).filter(Boolean);

    // "Unisex" (o "ambos", "todos") sirve para cualquiera: un producto marcado
    // asi le vale al que pidio de hombre Y al que pidio de mujer. Sin esto
    // quedaba invisible para los dos - paso en produccion con una zapatilla
    // que tenia stock y el bot juraba no tenerla.
    if (delProducto.some((vp) => GRUPO_DE_PALABRA.get(normalizarSimple(vp)) === 'unisex')) continue;

    const hayCoincidencia = delCliente.some((vc) => delProducto.some((vp) => valoresEquivalentes(vc, vp)));
    if (!hayCoincidencia) return false;
  }
  return true;
}

function scoreProducto(p, lead = {}) {
  let score = 0;
  if (lead.categoriaInteres && coincideTexto(lead.categoriaInteres, p.categoria?.nombre || '')) score += 3;
  if (estadoPresupuestoDeLead(lead, p.precio) === 'dentro' && rangoPresupuesto(lead).max != null) score += 2;
  if (lead.marca && coincideAtributo(lead.marca, p)) score += 2;
  if (lead.talla && coincideAtributo(lead.talla, p)) score += 2;
  if (lead.color && coincideAtributo(lead.color, p)) score += 2;
  // Un producto que declara el atributo pedido (Genero: Hombre) vale mas que
  // uno que simplemente no lo tiene cargado y pasa el filtro por omision.
  for (const [nombre, valor] of Object.entries(lead.atributosLead || {})) {
    if (valor && valorDeAtributo(p, nombre) !== null) score += 1;
  }
  if (p.stock > 3) score += 1;
  if (lead.observaciones) {
    const clavesProd = new Set(palabrasClave(textoCompletoProducto(p)));
    for (const clave of palabrasClave(lead.observaciones)) {
      if ([...clavesProd].some((c) => c.includes(clave) || clave.includes(c))) score += 1;
    }
  }
  return score;
}

// Un producto tiene stock si el tiene stock propio, O si tiene alguna
// variante activa con stock. Un producto con variantes normalmente deja su
// propio stock en 0 (el stock real vive en cada variante), asi que revisar
// solo p.stock lo descartaria siempre por error.
function tieneStock(p) {
  if (p.stock > 0) return true;
  return (p.variantes || []).some((v) => v.activa && v.stock > 0);
}

/**
 * Filtro base del catalogo.
 *
 * Siempre estrictos (nunca se relajan): stock, descartados por el cliente,
 * categoria y los atributos ya definidos del lead (Genero y compañia).
 * Relajables por opcion, en el orden que define buscarConFallback: color,
 * marca, presupuesto y talla.
 *
 * Por defecto color y marca NO son filtros duros (solo suman puntaje): son
 * preferencias, y el orden de alternativas del documento los relaja recien
 * en el paso 2 y 3. Se endurecen con estrictoColor/estrictoMarca.
 */
function buscarProductosFiltrados(productos, lead = {}, opciones = {}) {
  const {
    ignorarPresupuesto = false,
    ignorarCategoria = false,
    ignorarTalla = false,
    estrictoColor = false,
    estrictoMarca = false,
  } = opciones;
  const descartados = new Set(lead.productosDescartados || []);

  return productos
    .filter((p) => {
      if (!tieneStock(p)) return false;
      if (descartados.has(p.id)) return false;
      if (
        !ignorarCategoria &&
        !coincideTexto(lead.categoriaInteres, p.categoria?.nombre || '') &&
        !coincideTexto(lead.categoriaInteres, p.nombre || '') &&
        !coincideTexto(lead.categoriaInteres, p.descripcion || '')
      )
        return false;

      // El genero (y cualquier otro atributo que el cliente ya definio) es un
      // filtro principal: nunca se relaja, ni como ultimo recurso.
      if (!coincideAtributosLead(p, lead)) return false;

      const estado = estadoPresupuestoDeLead(lead, p.precio);
      if (estado === 'fuera_de_presupuesto') return false;
      if (!ignorarPresupuesto && estado === 'excedido') return false;

      // La talla es funcional (si no calza, no sirve), asi que se filtra
      // estricto - a diferencia de marca/color que solo suman puntaje en el
      // orden (preferencias, no requisitos duros), la talla solo se relaja
      // explicitamente como ultimo recurso.
      if (!ignorarTalla && lead.talla && !coincideAtributo(lead.talla, p)) return false;
      if (estrictoColor && lead.color && !coincideAtributo(lead.color, p)) return false;
      if (estrictoMarca && lead.marca && !coincideAtributo(lead.marca, p)) return false;

      return true;
    })
    .sort((a, b) => scoreProducto(b, lead) - scoreProducto(a, lead));
}

// Orden de busqueda de alternativas cuando no hay coincidencia exacta. Es el
// del documento del negocio: primero lo exacto, y despues se afloja UN filtro
// por vez, del menos importante al mas importante, avisando siempre cual se
// aflojo. Nunca se afloja la categoria ni el genero: eso seria cambiarle el
// pedido al cliente, no darle una alternativa.
const ESCALONES = [
  { filtro: null, opciones: { estrictoColor: true, estrictoMarca: true } },
  { filtro: 'color', opciones: { estrictoMarca: true } },
  { filtro: 'marca', opciones: {} },
  { filtro: 'presupuesto', opciones: { ignorarPresupuesto: true } },
  { filtro: 'talla', opciones: { ignorarPresupuesto: true, ignorarTalla: true } },
];

/**
 * Busca aplicando la cascada de alternativas.
 *
 * @returns {{resultados: Array, total: number, relajado: string|null}}
 *   relajado = que filtro hubo que aflojar para encontrar algo (null si el
 *   resultado es exacto). El bot tiene que decirselo al cliente y PREGUNTARLE
 *   antes de mostrar, nunca aflojar en silencio.
 */
function buscarConFallback(productos, lead = {}) {
  // Lo mas amplio que se puede ofrecer sin traicionar lo que el cliente pidio:
  // se aflojan color, marca, presupuesto y talla, pero NUNCA la categoria ni
  // sus atributos (genero). Sirve para saber que MAS existe cuando el cliente
  // dice "no quiero esas, mostrame otras".
  const amplio = buscarProductosFiltrados(productos, lead, { ignorarPresupuesto: true, ignorarTalla: true });

  for (const escalon of ESCALONES) {
    // Un filtro que el cliente nunca definio no se puede "relajar": saltear
    // ese escalon evita anunciar que se aflojo algo que no existia.
    if (escalon.filtro === 'color' && !lead.color) continue;
    if (escalon.filtro === 'marca' && !lead.marca) continue;
    if (escalon.filtro === 'presupuesto' && rangoPresupuesto(lead).max == null) continue;
    if (escalon.filtro === 'talla' && !lead.talla) continue;

    const resultados = buscarProductosFiltrados(productos, lead, escalon.opciones);
    if (resultados.length) {
      // La cascada corta en el primer escalon con resultados, y eso escondia
      // el resto: si UN producto calzaba exacto, los que estaban a un color de
      // distancia no se veian nunca y el bot juraba que no habia mas. Ahora se
      // devuelven aparte, para poder ofrecerlos cuando el cliente pide otras.
      const ids = new Set(resultados.map((p) => p.id));
      return {
        resultados,
        total: resultados.length,
        relajado: escalon.filtro,
        adicionales: amplio.filter((p) => !ids.has(p.id)),
      };
    }
  }
  return { resultados: [], total: 0, relajado: null, adicionales: amplio };
}

// Cuantas opciones ve el cliente por vez. El documento pide 2-3 para no
// saturar el chat; mostrar mas no es "ser generoso", es volver ilegible la
// conversacion. Lo que NUNCA puede pasar es que el bot crea que estas son
// todas las que existen: para eso esta "total" y "restantes" (ver paginar).
const RESULTADOS_POR_PAGINA = 3;

/**
 * Separa el resultado completo en "lo que se muestra ahora" y "lo que queda".
 *
 * @param {Array} resultados  resultado completo de la busqueda
 * @param {number[]} yaMostrados  ids que este cliente ya vio en esta conversacion
 * @returns {{pagina: Array, total: number, yaVistos: number, restantes: number, hayMas: boolean}}
 */
function paginar(resultados, yaMostrados = [], porPagina = RESULTADOS_POR_PAGINA) {
  const vistos = new Set(yaMostrados);
  const pendientes = resultados.filter((p) => !vistos.has(p.id));
  const pagina = pendientes.slice(0, porPagina);
  return {
    pagina,
    total: resultados.length,
    yaVistos: resultados.length - pendientes.length,
    restantes: pendientes.length - pagina.length,
    hayMas: pendientes.length > pagina.length,
  };
}

// ============================ Menu de categorias ============================

/**
 * Arma el menu de dos niveles a partir del catalogo YA cargado (cada producto
 * trae su categoria y el rubro padre de esa categoria).
 *
 * Solo aparecen rubros y subcategorias que tienen productos con stock Y que
 * calzan con lo que el cliente ya dijo (genero, etc.): un menu de venta no
 * puede ofrecer una puerta que no lleva a ningun lado.
 *
 * @returns {Array<{id, nombre, orden, productos, subcategorias: Array}>}
 */
function arbolDeCategorias(productos = [], lead = {}) {
  const rubros = new Map();

  const asegurarRubro = (cat) => {
    if (!rubros.has(cat.id)) {
      rubros.set(cat.id, { id: cat.id, nombre: cat.nombre, orden: cat.orden ?? 0, productos: 0, subcategorias: new Map() });
    }
    return rubros.get(cat.id);
  };

  for (const p of productos) {
    if (!p.categoria || !tieneStock(p)) continue;
    // Respeta lo que el cliente ya dijo: si busca ropa de hombre, el menu no
    // le ofrece "Vestidos" porque en ese rubro no hay nada para el. Un rubro
    // sin nada que ofrecerle simplemente no aparece.
    if (!coincideAtributosLead(p, lead)) continue;
    const cat = p.categoria;

    if (cat.padre) {
      const rubro = asegurarRubro(cat.padre);
      if (!rubro.subcategorias.has(cat.id)) {
        rubro.subcategorias.set(cat.id, { id: cat.id, nombre: cat.nombre, orden: cat.orden ?? 0, productos: 0 });
      }
      rubro.subcategorias.get(cat.id).productos += 1;
      rubro.productos += 1;
    } else {
      // Categoria de primer nivel que guarda productos directamente (un rubro
      // que el negocio decidio no subdividir).
      asegurarRubro(cat).productos += 1;
    }
  }

  const porOrden = (a, b) => (a.orden - b.orden) || a.nombre.localeCompare(b.nombre, 'es');
  return [...rubros.values()]
    .map((r) => ({ ...r, subcategorias: [...r.subcategorias.values()].sort(porOrden) }))
    .sort(porOrden);
}

// Las subcategorias con stock de un rubro puntual (vacio si no se subdivide).
function subcategoriasDe(productos, categoriaId, lead = {}) {
  const rubro = arbolDeCategorias(productos, lead).find((r) => r.id === categoriaId);
  return rubro ? rubro.subcategorias : [];
}

// Cuantos valores se listan por atributo. Mas que esto no es una opcion para
// elegir, es otro muro de texto.
const MAX_OPCIONES_POR_ATRIBUTO = 8;

/**
 * Que valores EXISTEN de verdad, con stock, en lo que el cliente esta mirando.
 *
 * Existe porque el bot preguntaba "¿que color preferis?" sin decir cuales hay,
 * y cuando el cliente respondia "no se que colores tenes" se lo devolvia como
 * pregunta. El sistema conoce los colores reales: hay que pasarselos.
 *
 * @param {Array} productos  el universo a mirar (ya filtrado por categoria)
 * @returns {Object} { Color: ['Negro','Blanco'], Talla: ['40','41'], ... }
 */
function opcionesDisponibles(productos = []) {
  const porAtributo = new Map();

  const sumar = (clave, valor) => {
    if (!clave || valor === undefined || valor === null || valor === '') return;
    const nombre = String(clave).trim();
    if (!porAtributo.has(nombre)) porAtributo.set(nombre, new Set());
    // Un atributo puede guardar varios valores separados por coma
    // ("Ocasion: Diario, Salida"). Si no se separan, "Diario, Salida" y
    // "Salida, Diario" cuentan como dos opciones distintas y la lista se
    // llena de repetidos.
    for (const parte of String(valor).split(',')) {
      const limpio = parte.trim();
      if (limpio) porAtributo.get(nombre).add(limpio);
    }
  };

  for (const p of productos) {
    if (!tieneStock(p)) continue;
    for (const [k, v] of Object.entries(p.atributos || {})) sumar(k, v);
    for (const variante of (p.variantes || []).filter((v) => v.activa && v.stock > 0)) {
      for (const [k, v] of Object.entries(variante.atributos || {})) sumar(k, v);
    }
  }

  const salida = {};
  for (const [nombre, valores] of porAtributo) {
    const lista = [...valores];
    // Las tallas van en orden logico (S, M, L / 38, 39, 40), no alfabetico.
    lista.sort(/talla/i.test(nombre) ? compararTallas : (a, b) => a.localeCompare(b, 'es', { numeric: true }));
    salida[nombre] = lista.slice(0, MAX_OPCIONES_POR_ATRIBUTO);
  }
  return salida;
}

/**
 * Cuantos caracteres tiene que tener una palabra suelta del mensaje del
 * cliente para que se la compare contra un valor del catalogo. Existe por las
 * equivalencias de 1 letra ("m" y "h" valen por "hombre"): sin este piso, una
 * "m" perdida en cualquier frase resolveria el Genero sola.
 */
const MIN_LARGO_TOKEN_ATRIBUTO = 3;

/**
 * Los valores que ese atributo tiene DE VERDAD en el catalogo, buscando el
 * nombre sin importar mayusculas ni tildes ("Género" encuentra "Genero").
 *
 * Cada negocio escribe el nombre del atributo a mano en el panel, asi que
 * "Genero", "Género" y "GENERO" tienen que resolver al mismo lugar.
 */
function valoresRealesDeAtributo(productos = [], nombreAtributo) {
  const buscado = normalizarSimple(nombreAtributo);
  if (!buscado) return [];
  const opciones = opcionesDisponibles(productos);
  for (const [nombre, valores] of Object.entries(opciones)) {
    if (normalizarSimple(nombre) === buscado) return valores;
  }
  return [];
}

/**
 * Resuelve, EN CODIGO, que valor real del catalogo dijo el cliente para un
 * atributo dado. "hombre" -> "Hombre"; "para caballero" -> "Masculino".
 *
 * Existe por un bucle real en produccion: la tienda pedia el Genero antes de
 * mostrar nada, el cliente contestaba "hombre" tres veces, y como el unico
 * camino para guardarlo era que el modelo llamara a actualizar_datos_lead
 * (cosa que no siempre hace), el dato nunca quedaba guardado y el bot volvia
 * a preguntar lo mismo con otras palabras hasta que el cliente se iba.
 *
 * Devuelve el valor tal como esta escrito en el catalogo (no como lo escribio
 * el cliente): asi el filtrado posterior compara contra el dato real.
 */
function resolverValorDeAtributo(texto, nombreAtributo, productos = []) {
  const valores = valoresRealesDeAtributo(productos, nombreAtributo);
  if (!valores.length) return null;

  const limpio = normalizarSimple(texto);
  if (!limpio) return null;

  // 1) El valor aparece literal en la frase ("es para hombre", "modelo unisex").
  for (const valor of valores) {
    const v = normalizarSimple(valor);
    if (v.length >= MIN_LARGO_TOKEN_ATRIBUTO && new RegExp(`(^|[^a-z0-9ñ])${v}([^a-z0-9ñ]|$)`).test(limpio)) {
      return valor;
    }
  }

  // 2) Alguna palabra del mensaje es equivalente al valor ("caballero" ~ "Masculino").
  //
  // Se usa palabrasClave y no un split crudo: hay que sacar los conectores
  // ("para", "de", "con"). valoresEquivalentes termina en coincideTexto, que
  // por diseño devuelve true cuando el lado del cliente no tiene ninguna
  // palabra util - un "para" suelto matcheaba contra CUALQUIER valor. Con eso,
  // el cliente contestaba "para mi" y el sistema le asignaba Genero: Hombre.
  const tokens = palabrasClave(limpio).filter((t) => t.length >= MIN_LARGO_TOKEN_ATRIBUTO);
  if (!tokens.length) return null;
  for (const valor of valores) {
    if (tokens.some((t) => valoresEquivalentes(t, valor))) return valor;
  }

  return null;
}

/**
 * "cualquiera", "me da igual", "el que sea"...
 *
 * El cliente que contesta esto YA contesto: dijo que no tiene preferencia. Sin
 * reconocerlo, el sistema lo trataba como si no hubiera dicho nada y le volvia
 * a pedir el mismo dato ("no, tenes que escoger un color antes de seguir"),
 * dejandolo trabado sin ver un solo producto. Reportado por el negocio.
 *
 * Deliberadamente NO incluye "no se" ni "no tengo idea": eso es un cliente
 * perdido que necesita que le muestren opciones para poder elegir, no uno que
 * renuncia a elegir. La diferencia importa para el texto que le contesta el bot.
 */
const SIN_PREFERENCIA = [
  /\bcualquier\w*\b/,
  /\b(me\s+)?da\s+(igual|lo\s+mismo)\b/,
  /\bindistinto\b/,
  /\bno\s+(me\s+)?importa\b/,
  /\bno\s+tengo\s+preferencia\b/,
  /\b(el|la|lo)\s+que\s+(sea|tengas|haya|quieras)\b/,
  /\bel?\s*que\s+vos\s+(quieras|elijas)\b/,
  /\bvos\s+(eleg|decid)\w*\b/,
  /\bcomo\s+(vos\s+)?quieras\b/,
];

function expresaSinPreferencia(texto) {
  const limpio = normalizarSimple(texto);
  if (!limpio) return false;
  return SIN_PREFERENCIA.some((re) => re.test(limpio));
}

// ============================ Fotos ============================

function coloresDeVariantes(p) {
  const conFoto = new Set();
  const sinFoto = new Set();
  for (const v of (p.variantes || []).filter((v) => v.activa)) {
    const color = v.atributos?.Color;
    if (!color) continue;
    if (v.fotos?.length) conFoto.add(color);
    else sinFoto.add(color);
  }
  // Un color con fotos en alguna variante cuenta como "con foto" aunque otra
  // talla del mismo color no las tenga cargadas.
  for (const c of conFoto) sinFoto.delete(c);
  return { conFoto: [...conFoto], sinFoto: [...sinFoto] };
}

/**
 * Decide QUE foto mandar y, sobre todo, si esa foto representa de verdad el
 * color que pidio el cliente.
 *
 * Nunca se hace pasar la foto de un color por otro: si el cliente pidio gris
 * y solo hay foto del blanco, se devuelve la del blanco pero marcada como
 * referencial (esDelColorPedido: false, colorDeLaFoto: 'Blanco') para que el
 * bot lo diga explicitamente. La talla no influye a proposito: las fotos se
 * comparten entre tallas de un mismo color por diseño.
 *
 * @returns {{url: string|null, colorDeLaFoto: string|null, esDelColorPedido: boolean,
 *            colorPedido: string|null, coloresConFoto: string[], coloresSinFoto: string[]}}
 */
function fotoParaMostrar(p, lead = {}) {
  const { conFoto, sinFoto } = coloresDeVariantes(p);
  const base = { coloresConFoto: conFoto, coloresSinFoto: sinFoto, colorPedido: lead.color || null };

  const coloresPedidos = tokensDeLista(lead.color);
  if (coloresPedidos.length) {
    const variantes = (p.variantes || []).filter((v) => v.activa && v.fotos?.length);
    // TODAS las variantes de ese color, no solo la primera: un mismo color
    // suele estar repartido en varias tallas y cada una puede aportar fotos
    // distintas del mismo par.
    const delColor = variantes.filter((v) => coloresPedidos.some((c) => valoresEquivalentes(c, v.atributos?.Color || '')));
    if (delColor.length) {
      const urls = [...new Set(delColor.flatMap((v) => v.fotos))];
      return { ...base, url: urls[0], urls, colorDeLaFoto: delColor[0].atributos?.Color || null, esDelColorPedido: true };
    }
    // Pidio un color puntual y no hay foto de ESE color. NO se manda la de
    // otro por las suyas: mandarle una zapatilla negra a quien pidio blancas
    // es peor que no mandar nada (paso en produccion). Se devuelve sin foto,
    // pero se informa cual se podria ofrecer COMO REFERENCIA si el cliente
    // acepta - que es lo que pide el punto 22 del documento del negocio.
    const referencia = variantes[0];
    return {
      ...base,
      url: null,
      urls: [],
      colorDeLaFoto: null,
      esDelColorPedido: false,
      referenciaDisponible: referencia ? (referencia.atributos?.Color || null) : null,
    };
  }

  // Sin color pedido no hay nada que aclarar: la foto generica es correcta.
  return {
    ...base,
    url: p.fotos?.length ? p.fotos[0] : null,
    urls: [...(p.fotos || [])],
    colorDeLaFoto: null,
    esDelColorPedido: true,
  };
}

module.exports = {
  palabrasClave, coincideTexto, normalizarSimple, tokensDeLista, compararTallas,
  parsePrecio, estadoPresupuesto, estadoPresupuestoDeLead, rangoPresupuesto, interpretarPresupuesto,
  textoCompletoProducto, coincideAtributo, valorDeAtributo, coincideAtributosLead, buscarPorNombre,
  scoreProducto, tieneStock, valoresEquivalentes, raizDePalabra,
  buscarProductosFiltrados, buscarConFallback, paginar, fotoParaMostrar, coloresDeVariantes,
  arbolDeCategorias, subcategoriasDe, opcionesDisponibles,
  valoresRealesDeAtributo, resolverValorDeAtributo, expresaSinPreferencia,
  RESULTADOS_POR_PAGINA, TOLERANCIA_PRESUPUESTO, TOPE_PRESUPUESTO,
};
