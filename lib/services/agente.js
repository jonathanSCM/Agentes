// Cerebro del agente de ventas.
//
// Soporta dos proveedores de IA y elige automaticamente segun las claves del .env:
//   1. OpenAI     -> si existe OPENAI_API_KEY      (modelo por defecto: gpt-4o-mini)
//   2. Anthropic  -> si existe ANTHROPIC_API_KEY   (modelo segun el plan)
//   3. Modo demo  -> si no hay ninguna clave (responde con reglas simples)
//
// Motor de ventas real (no solo un chat con el catalogo pegado en el prompt):
// el modelo NUNCA decide que productos existen o cuales mostrar por su cuenta,
// solo ve el resultado ya filtrado en codigo (buscarProductosFiltrados). Usa
// function-calling (tools) para actualizar el estado del cliente, mostrar
// productos como tarjetas con foto real por WhatsApp, y crear el pedido -
// validando stock, nombre y direccion de entrega antes de confirmar.
require('dotenv').config();

const { prisma } = require('../db');
const wa = require('./whatsapp');
const { emitMensaje } = require('./realtime');
const { simboloMoneda } = require('./precios');
const {
  palabrasClave, coincideTexto, normalizarSimple, tokensDeLista, compararTallas,
  parsePrecio, estadoPresupuesto, rangoPresupuesto, interpretarPresupuesto,
  textoCompletoProducto, coincideAtributo, valorDeAtributo,
  scoreProducto, tieneStock,
  buscarProductosFiltrados, buscarConFallback, paginar, fotoParaMostrar,
  arbolDeCategorias, subcategoriasDe,
  RESULTADOS_POR_PAGINA,
} = require('./catalogo');

// Cuantas tarjetas se pueden mandar de una sola vez. Coincide con el tamaño
// de pagina: el cliente ve pocas opciones muy relevantes por vez, y si hay
// mas el bot se lo dice y las ofrece (nunca se esconde inventario, pero
// tampoco se vuelca el catalogo entero en el chat).
const MAX_PRODUCTOS_A_MOSTRAR = RESULTADOS_POR_PAGINA;

// Cuantos atributos RECOMENDADOS se le sugieren al modelo por vez. No es un
// limite de configuracion (el negocio puede marcar los que quiera): es para
// que el prompt no se convierta en un checklist de 8 preguntas, que es
// exactamente el interrogatorio que el negocio no quiere.
const MAX_ATRIBUTOS_SUGERIDOS = 3;

// Tope DURO de imagenes que se le mandan al cliente en un mismo turno, sin
// importar cuantas herramientas llame el modelo. Cada tarjeta ya lleva una
// sola foto, asi que con el tope de resultados por pagina alcanzaria; esto es
// el cinturon de seguridad para que nunca se le llene el chat de fotos
// (paso en produccion con el limite viejo de 20 productos).
const MAX_FOTOS_POR_TURNO = 3;

// Como se escribe un precio: SIEMPRE con la moneda real que configuro el
// negocio. La IA no elige el simbolo ni lo convierte (regla del documento:
// "la moneda debe venir del backend").
function formatearPrecio(monto, moneda) {
  return `${simboloMoneda(moneda || 'BOB')} ${Number(monto).toFixed(2)}`;
}

// ============================ Logs estructurados ============================
// Cada etapa del pipeline deja una linea propia, con la misma clave de
// correlacion (telefonoCliente), para que si algo falla desarrollo pueda ver
// exactamente en que paso ocurrio: interpretacion, memoria, busqueda, db,
// llamada de herramienta, proveedor de IA, WhatsApp o generacion de texto.
function logEtapa(etapa, telefonoCliente, datos = {}) {
  try {
    console.log(`[AGENTE:${etapa}] tel=${telefonoCliente}`, JSON.stringify(datos));
  } catch (_) {
    console.log(`[AGENTE:${etapa}] tel=${telefonoCliente}`);
  }
}

function logErrorEtapa(etapa, telefonoCliente, err) {
  console.error(`[AGENTE:${etapa}:ERROR] tel=${telefonoCliente} ${err && err.message ? err.message : err}`);
}

// Mensaje honesto para cuando algo tecnico falla de verdad (consulta al
// catalogo, o el proveedor de IA). NUNCA se reemplaza por una respuesta que
// "adivine" disponibilidad: mejor decir que hubo un problema tecnico que
// inventar informacion comercial. Esto es intencionalmente distinto del modo
// demo (activado cuando no hay API key configurada, que es un modo de
// prueba conocido, no un error).
function respuestaErrorTecnico() {
  return 'No pude consultar la disponibilidad en este momento. Prefiero no darte información incorrecta. ¿Querés que vuelva a intentar en un momento?';
}

// Modelos por defecto de cada proveedor (se pueden cambiar por variables de entorno)
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_MODEL_DEFAULT = 'claude-haiku-4-5';

// Mapa de modelos por plan: mejor plan -> mejor modelo.
const MODELOS_POR_PLAN = {
  openai: {
    GRATIS: 'gpt-4o-mini',
    STANDARD: 'gpt-4.1-mini',
    PRO: 'gpt-4o',
    PREMIUM: 'gpt-5.2-chat-latest',
  },
  anthropic: {
    GRATIS: 'claude-haiku-4-5',
    STANDARD: 'claude-haiku-4-5',
    PRO: 'claude-sonnet-5',
    PREMIUM: 'claude-opus-4-8',
  },
};

function modeloParaPlan(proveedor, plan) {
  const configurado = plan && plan.modeloIa;
  const codigo = plan && plan.codigo;
  if (proveedor === 'openai') {
    if (configurado && /^gpt/i.test(configurado)) return configurado;
    return MODELOS_POR_PLAN.openai[codigo] || OPENAI_MODEL_DEFAULT;
  }
  if (configurado && /^claude/i.test(configurado)) return configurado;
  return MODELOS_POR_PLAN.anthropic[codigo] || ANTHROPIC_MODEL_DEFAULT;
}

function proveedorActivo() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'demo';
}

let openaiClient = null;
function getOpenAI() {
  if (openaiClient) return openaiClient;
  const OpenAI = require('openai');
  openaiClient = new OpenAI();
  return openaiClient;
}

let anthropicClient = null;
function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  const Anthropic = require('@anthropic-ai/sdk');
  anthropicClient = new Anthropic();
  return anthropicClient;
}

// ============================ TOOLS (function calling) ============================
// Definidas en formato OpenAI; toolsParaAnthropic() las convierte al formato
// de Anthropic (input_schema) para que ambos proveedores compartan una sola
// fuente de verdad.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'actualizar_datos_lead',
      description: 'Guarda o actualiza los datos del cliente a medida que se obtienen en la conversacion. Llamar cada vez que el usuario entregue un dato nuevo.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          categoriaInteres: { type: 'string', description: "La categoria de producto con las palabras EXACTAS que uso el cliente. NUNCA la traduzcas ni la reemplaces por otra: el buscador interno necesita las palabras literales del cliente. NUNCA la cambies a otra categoria distinta solo porque no encontraste coincidencias exactas: la categoria se mantiene hasta que el cliente mismo diga que quiere ver otra cosa." },
          presupuesto: { type: 'string' },
          cantidad: { type: 'string', description: 'Cuantas unidades quiere el cliente.' },
          marca: { type: 'string', description: 'Marca preferida, si el cliente la menciono.' },
          talla: { type: 'string', description: 'Talla/tamaño que busca, si lo menciono.' },
          color: { type: 'string', description: 'Color preferido, si lo menciono.' },
          direccionEntrega: { type: 'string' },
          tipoEntrega: { type: 'string', enum: ['domicilio', 'recojo'], description: 'Como recibe el pedido: "domicilio" (hay que pedirle la direccion o su ubicacion) o "recojo" (pasa a buscarlo por la tienda). Ofrecele SOLO los tipos de entrega reales de esta tienda (ver bloque de arriba).' },
          formaPago: { type: 'string', enum: ['qr', 'efectivo', 'tarjeta'], description: 'Como va a pagar el cliente. Ofrecele SOLO las formas de pago reales de esta tienda (ver bloque de arriba), nunca otras.' },
          observaciones: { type: 'string' },
          nivelInteres: { type: 'string', enum: ['frio', 'tibio', 'caliente'] },
          estadoConversacion: {
            type: 'string',
            enum: ['explorando', 'buscando_producto', 'comparando', 'interesado', 'intencion_de_compra', 'listo_para_comprar'],
            description: 'En que etapa de decision de compra esta el cliente ahora mismo. Actualizalo cada vez que cambie de etapa: explorando (recien empieza, sin pedir nada concreto), buscando_producto (ya dijo que categoria/caracteristicas busca), comparando (esta viendo varias opciones mostradas), interesado (mostro interes claro en una en particular), intencion_de_compra (dijo que quiere comprar/apartar), listo_para_comprar (ya dio los datos y falta solo confirmar).',
          },
          productoFavoritoId: { type: 'integer', description: 'ID EXACTO del producto que el cliente eligio como su preferido cuando lo diga explicitamente (ej: "me gusta el segundo", "esa quiero", "la negra me convence"). A partir de ahi el sistema deja de sugerir otras opciones y se enfoca en cerrar la venta de este producto - no lo llenes si el cliente todavia esta comparando sin decidirse.' },
          varianteFavoritaId: { type: 'integer', description: 'ID EXACTO de la variante (talla+color concretos) que eligio, cuando ya se decidio por una combinacion puntual. Es lo que despues se vende de verdad.' },
          productosDescartadosIds: { type: 'array', items: { type: 'integer' }, description: 'IDs de productos que el cliente dijo explicitamente que NO le interesan (ej: "esa no me gusta", "el primero no"), para no volver a ofrecerselos.' },
          atributosCategoria: { type: 'object', description: 'Atributos que pidio el bloque de "datos que faltan" y NO son ya un campo propio (ej: {"Genero":"Hombre","Uso":"Running"}). Talla/color/marca van en sus propios parametros de arriba, no aca.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mostrar_productos',
      description: 'Presenta productos al cliente como tarjetas visuales (foto + ficha con precio, stock y detalles). SIEMPRE que vayas a mostrar uno o mas productos del bloque de resultados, llama esta funcion con sus IDs en vez de describirlos en texto. Usa los IDs del bloque de resultados actual: el sistema ya eligio cuales corresponden mostrar ahora (son pocos a proposito, para no saturar el chat). Si hay mas resultados, se muestran despues con ver_mas_productos, nunca todos de golpe.',
      parameters: {
        type: 'object',
        properties: {
          idsProductos: { type: 'array', items: { type: 'integer' }, description: 'IDs exactos de los productos del bloque de resultados actual.' },
        },
        required: ['idsProductos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_mas_productos',
      description: 'Muestra el siguiente grupo de resultados de la MISMA busqueda, cuando el cliente pide ver otras opciones ("¿tenes otros modelos?", "mostrame mas", "que mas hay"). El sistema sabe cuales ya vio y cuales faltan: no hace falta que le pases nada. Nunca le digas al cliente que no hay mas sin haber llamado a esto primero.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_fotos_producto',
      description: 'Envia las fotos de un producto especifico por WhatsApp cuando el cliente pide ver fotos o imagenes de un producto. El sistema elige la foto del color que pidio el cliente y te avisa si esa foto es del color exacto o solo referencial de otro color.',
      parameters: {
        type: 'object',
        properties: { idProducto: { type: 'integer' } },
        required: ['idProducto'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_pedido',
      description: 'Arma el resumen exacto del pedido (productos, variante, cantidad, precios reales, total, entrega y forma de pago) para leerselo al cliente ANTES de crear nada. Es obligatorio llamarla antes de crear_pedido: el sistema no deja crear un pedido que el cliente no confirmo. Si falta algun dato, te dice cual pedir.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Los mismos productos y cantidades que despues iran en crear_pedido.',
            items: {
              type: 'object',
              properties: {
                idProducto: { type: 'integer' },
                idVariante: { type: 'integer', description: 'ID EXACTO de la variante elegida, obligatorio si el producto tiene variantes.' },
                cantidad: { type: 'integer' },
              },
              required: ['idProducto', 'cantidad'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crear_pedido',
      description: 'Crea el pedido DESPUES de que el cliente dijo que si al resumen que le leiste con confirmar_pedido. Requiere nombre, tipo de entrega (y direccion si es a domicilio) y forma de pago ya guardados via actualizar_datos_lead. El sistema revalida stock y precio antes de confirmar. Registra la forma de pago elegida pero no procesa ningun cobro: eso lo coordina un asesor humano por fuera del bot.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Productos a comprar, con su cantidad.',
            items: {
              type: 'object',
              properties: {
                idProducto: { type: 'integer' },
                idVariante: { type: 'integer', description: 'Si ese producto tiene variantes (talla/color/etc.), el ID EXACTO de la variante que eligio el cliente. Obligatorio cuando el producto tiene variantes: si el cliente todavia no eligio cual, preguntaselo antes de llamar a esta funcion.' },
                cantidad: { type: 'integer' },
              },
              required: ['idProducto', 'cantidad'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'derivar_a_asesor',
      description: "Deriva la conversacion a un asesor humano. Usarla cuando el cliente lo pide explicitamente, esta claramente molesto tras varios intentos, o cuando detectes alguna de estas situaciones donde un vendedor humano puede cerrar mejor que vos: pedido mayorista o por volumen grande, compra de monto alto, negociacion especial de precio, solicitud de descuento fuera de lo que vos podes ofrecer, un problema o reclamo que no podes resolver, una condicion comercial especial (credito, factura, convenio), o un cliente que se identifica como empresa. NUNCA derivar por preguntas normales de precio, stock o forma de pago que si podes responder vos con la info disponible.",
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string' },
          tipo: {
            type: 'string',
            enum: ['solicitud_expresa', 'cliente_molesto', 'pedido_mayorista', 'compra_alto_valor', 'negociacion_especial', 'descuento_fuera_de_regla', 'problema_no_resuelto', 'condicion_comercial_especial', 'cliente_empresarial'],
            description: 'Motivo de la derivacion, para que el equipo priorice.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mostrar_categorias',
      description: "Le muestra al cliente QUE VENDE la tienda, cuando pide 'el catalogo', 'que tienen', 'todos los productos', 'tus categorias' o algo generico parecido. El sistema arma la lista real: los rubros si todavia no eligio ninguno, o los tipos dentro del rubro que eligio. NUNCA armes vos esa lista de memoria ni mandes un link: llama a esta funcion.",
      parameters: { type: 'object', properties: {} },
    },
  },
];

function toolsParaAnthropic(tools) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ============================ Motor de busqueda (anti-alucinacion) ============================
// El modelo NUNCA inventa productos: buscarProductosFiltrados() filtra en
// codigo por categoria y presupuesto, con stock > 0. El modelo solo ve el
// resultado (max. 3) ya calculado en el system prompt.

// Extraccion determinista de filtros del mensaje del cliente, EN CODIGO. El
// modelo deberia llamar a actualizar_datos_lead, pero en la practica a veces
// no lo hace y responde con el estado viejo. Esto detecta categoria (contra
// las categorias reales del catalogo, y contra nombres de producto como
// respaldo) y cantidad directamente del texto, antes de armar el prompt.
function extraerFiltros(texto, productos = []) {
  const norm = ' ' + (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() + ' ';
  const cambios = {};

  let mejorCategoria = null;
  let mejorCategoriaId = null;
  let mejorPuntaje = 0;
  // Mapa nombre->id de las categorias reales (relacion Categoria), para poder
  // guardar tambien el id resuelto y no solo el texto (el id es lo que se usa
  // despues para saber que atributos son obligatorios en esa categoria).
  const categoriasUnicas = new Map();
  for (const p of productos) {
    if (!p.categoria) continue;
    categoriasUnicas.set(p.categoria.nombre, p.categoria.id);
    // Tambien el rubro padre: el cliente puede decir "prendas de abajo" y no
    // "jeans". Si nombra el rubro, el bot le ofrece los tipos que hay adentro.
    if (p.categoria.padre) categoriasUnicas.set(p.categoria.padre.nombre, p.categoria.padre.id);
  }
  for (const [nombre, id] of categoriasUnicas) {
    const claves = palabrasClave(nombre);
    if (!claves.length) continue;
    const presentes = claves.filter((c) => norm.includes(` ${c} `) || norm.includes(`${c} `)).length;
    if (presentes === claves.length && presentes > mejorPuntaje) {
      mejorCategoria = nombre;
      mejorCategoriaId = id;
      mejorPuntaje = presentes;
    }
  }
  if (!mejorCategoria) {
    for (const p of productos) {
      if (!p.categoria) continue;
      const claves = palabrasClave(p.nombre).filter((c) => c.length > 3);
      const presentes = claves.filter((c) => norm.includes(c)).length;
      if (presentes > mejorPuntaje) {
        mejorCategoria = p.categoria.nombre;
        mejorCategoriaId = p.categoria.id;
        mejorPuntaje = presentes;
      }
    }
  }
  if (mejorCategoria) {
    cambios.categoriaInteres = mejorCategoria;
    cambios.categoriaId = mejorCategoriaId;
  }

  const cant = norm.match(/\b(\d+)\s*(unidades?|piezas?|und\.?)\b/);
  if (cant) cambios.cantidad = cant[1];

  const talla = extraerTallaDelTexto(texto, productos);
  if (talla) cambios.talla = talla;

  return cambios;
}

// Conectores comunes de 1-2 letras que NUNCA deben confundirse con una talla
// (aunque el catalogo tuviera una talla de 1 letra rara).
const CONECTORES_NO_TALLA = new Set(['y', 'o', 'a', 'e', 'u', 'de', 'el', 'la', 'en', 'un', 'al']);

// Detecta tallas reales del catalogo mencionadas en el texto del cliente
// ("busco en talla L y XL" -> "L, XL"). Deliberadamente NO usa palabrasClave
// (que descarta palabras de 1 letra como "S"/"M"/"L", justo los codigos de
// talla mas comunes en ropa) - usa borde de palabra real para no matchear
// "S" dentro de "casacas" por accidente.
function extraerTallaDelTexto(texto, productos = []) {
  const tallasCatalogo = new Set();
  for (const p of productos) {
    for (const v of p.variantes || []) {
      if (v.atributos?.Talla) tallasCatalogo.add(String(v.atributos.Talla));
    }
  }
  if (!tallasCatalogo.size) return null;
  const normTexto = ` ${normalizarSimple(texto)} `;
  const encontradas = [...tallasCatalogo].filter((t) => {
    const tokenNorm = normalizarSimple(t);
    if (CONECTORES_NO_TALLA.has(tokenNorm)) return false;
    const escapado = tokenNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9ñ])${escapado}([^a-z0-9ñ]|$)`, 'i');
    return re.test(normTexto);
  });
  return encontradas.length ? encontradas.join(', ') : null;
}

// Cuando el cliente responde solo con un numero ("1", "2") a algo que el
// agente ofrecio, el codigo no sabe que significa ese numero. Busca en el
// ULTIMO mensaje del agente algo con forma "1. Texto" o "1) Texto" (en su
// propia linea o todo seguido en el mismo parrafo) y devuelve el texto de esa
// opcion, para poder correr la extraccion de filtros sobre ese texto real.
function resolverSeleccionMenu(texto, ultimoMensajeAgente) {
  const m = String(texto || '').trim().match(/^(?:opcion\s+|la\s+|el\s+)?(\d{1,2})$/i);
  if (!m || !ultimoMensajeAgente) return null;
  const numero = m[1];

  const opciones = [...String(ultimoMensajeAgente).matchAll(/(\d{1,2})[.)]\s*([^\d]+?)(?=(?:\s\d{1,2}[.)]\s)|$)/g)];
  for (const op of opciones) {
    if (op[1] === numero) return op[2].trim().replace(/[.,;:]+$/, '');
  }
  return null;
}

function resumenInventario(productos) {
  const conStock = productos.filter((p) => tieneStock(p));
  const contar = (lista) => {
    const c = {};
    for (const p of lista) {
      const v = (p.categoria?.nombre || '').trim();
      if (v) c[v] = (c[v] || 0) + 1;
    }
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  };

  if (conStock.length === 0) {
    return 'ATENCION CRITICA DEL INVENTARIO: NO hay NINGUN producto con stock disponible en todo el catalogo. Dile al cliente con transparencia que por el momento no hay stock, y ofrece derivar_a_asesor para que le avisen cuando haya reposicion.';
  }

  const categorias = contar(conStock).map(([c, n]) => `${c} (${n})`).join(', ') || 'ninguna';
  return `INVENTARIO REAL DISPONIBLE (conteo exacto calculado por el sistema, uso interno tuyo): hay stock en ${categorias}.
Esto es SOLO para que sepas que existe realmente antes de mencionarlo, NUNCA para recitarlo como una lista o menu. Si lo que pide el cliente no calza con nada de esto, decilo con naturalidad como lo haria un vendedor real ("de eso no manejamos, pero tenemos...") y mencioná en la misma frase, como al pasar, 1 o 2 cosas de las que SI hay que puedan servirle - nunca listes todas las categorias de un tirón ni uses numeritos para esto.`;
}

function formatearAtributosVariante(atributos) {
  return Object.entries(atributos || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
}

function formatearProductos(productos, moneda) {
  return productos
    .map((p) => {
      const caract = p.caracteristicas?.length ? ` - Caracteristicas: ${p.caracteristicas.join(', ')}` : '';
      const atributosTexto = Object.entries(p.atributos || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      const atrib = atributosTexto ? ` - ${atributosTexto}` : '';
      const base = `- [ID ${p.id}] ${p.nombre} - Categoria: ${p.categoria?.nombre || 'General'} - Precio: ${formatearPrecio(p.precio, moneda)} - Stock: ${p.stock}${atrib}${caract} - ${p.descripcion || ''}`;
      const variantes = (p.variantes || []).filter((v) => v.activa);
      if (!variantes.length) return base;
      const lineasVariantes = variantes
        .map((v) => `  · [Variante ID ${v.id}] ${formatearAtributosVariante(v.atributos)} - Precio: ${formatearPrecio(v.precio ?? p.precio, moneda)} - Stock: ${v.stock}`)
        .join('\n');
      return `${base}\n  Este producto tiene variantes (talla/color/etc.). Si el cliente quiere comprarlo, preguntale cual de estas elige ANTES de crear el pedido, y usa el ID de variante exacto en crear_pedido:\n${lineasVariantes}`;
    })
    .join('\n');
}

/**
 * ¿Ya se sabe lo suficiente como para buscar en el catalogo?
 *
 * No alcanza con la categoria: si esa categoria tiene atributos marcados
 * OBLIGATORIO (ej. Genero en una tienda de ropa), hay que saberlos ANTES de
 * mostrar nada. Esta es la idea central del documento del negocio: el bot no
 * arranca mostrando productos, primero entiende que quiere comprar la persona.
 *
 * La categoria llega como objeto (con sus atributos) desde construirSystem;
 * si no se la pasan, se comporta como antes (solo exige categoria).
 */
function filtrosCompletos(lead = {}, categoria = null) {
  if (!lead.categoriaInteres) return false;
  return atributosFaltantes(categoria, lead, 'OBLIGATORIO').length === 0;
}

// Todos los productos que de verdad son candidatos para este cliente en esta
// busqueda (incluyendo los que aparecen relajando un filtro). Se usa para
// validar en codigo que un ID que manda el modelo tenga algo que ver con la
// conversacion real - no para decidir que se muestra (eso lo hace la pagina
// actual, ver seccionProductos).
//
// IMPORTANTE: la categoria y el genero NUNCA se relajan (ver buscarConFallback).
function productosCandidatosAMostrar(productos, lead = {}, categoria = null) {
  if (!filtrosCompletos(lead, categoria)) return [];
  return buscarConFallback(productos, lead).resultados;
}

// Texto que le explica al modelo que filtro hubo que aflojar para encontrar
// algo. Nunca se afloja en silencio: el cliente tiene que enterarse y decidir.
const NOMBRE_FILTRO_RELAJADO = {
  color: 'el color',
  marca: 'la marca',
  presupuesto: 'el presupuesto',
  talla: 'la talla',
};

function seccionProductos(productos, lead = {}, categoria = null, moneda = 'BOB') {
  if (!lead.categoriaInteres) {
    return 'Todavia no sabes que anda buscando el cliente (no es que no haya stock, es que aun no lo dijo). NUNCA digas que "no hay productos" en este punto ni menciones ninguno todavia: segui la charla con naturalidad hasta entender que necesita, preguntando como lo haria una persona, no con un menu de categorias.';
  }

  // Si el cliente ya eligio un favorito, el motor deja de buscar
  // alternativas: se enfoca solo en cerrar la venta de ese producto (punto
  // 12: "no debe volver a mostrar los otros salvo que el cliente cambie de
  // opinion"). Ignora presupuesto/categoria para esta busqueda puntual
  // porque el cliente ya decidio, no esta comparando.
  if (lead.productoFavoritoId) {
    const favorito = productos.find((p) => p.id === lead.productoFavoritoId);
    if (favorito && tieneStock(favorito)) {
      return `El cliente YA ELIGIO este producto como su favorito, dejo de comparar (estado: ${lead.estadoConversacion || 'INTERESADO'}). Este es el UNICO producto en el que te enfocas ahora, no le ofrezcas mas alternativas ni lo distraigas con otras opciones (salvo que el cliente diga explicitamente que cambio de opinion o quiere ver otra cosa):\n${formatearProductos([favorito], moneda)}\n\nSi todavia no le mostraste la tarjeta en este chat, llama a mostrar_productos con este ID. Tu enfoque ahora es resolver sus dudas puntuales sobre ESTE producto y conducirlo a confirmar el pedido (nombre + tipo de entrega + forma de pago).`;
    }
  }

  // GATE DE RUBRO: el cliente nombro un rubro que se divide en tipos
  // ("quiero pantalones" cuando el rubro es "Prendas de abajo"). Mostrarle los
  // 35 productos del rubro entero no le sirve: primero elige el tipo. Igual
  // que con los atributos obligatorios, no se le pasa ningun producto al
  // modelo, porque si los ve los muestra.
  if (categoria && !categoria.padreId) {
    const subcategorias = subcategoriasDe(productos, categoria.id);
    if (subcategorias.length) {
      const lista = subcategorias.map((s, i) => `${i + 1}. ${s.nombre}`).join('\n');
      return `El cliente esta en el rubro "${categoria.nombre}", que se divide en estos tipos (reales, con stock):\n${lista}\n\nTODAVIA NO le muestres productos: son ${subcategorias.reduce((n, s) => n + s.productos, 0)} en todo el rubro y mostrarlos asi no le sirve. Pasale la lista tal cual, numerada, una por linea, y preguntale cual quiere ver. Cuando elija uno, ahi si aparecen los productos de ese tipo.`;
    }
  }

  // GATE: falta informacion obligatoria de esta categoria. No se le pasa
  // ningun producto al modelo todavia - si los ve, los muestra igual (paso
  // en produccion), asi que la unica forma confiable de que primero pregunte
  // es que el bloque de resultados no exista.
  const faltantes = atributosFaltantes(categoria, lead, 'OBLIGATORIO');
  if (faltantes.length) {
    return `TODAVIA NO PODES MOSTRAR PRODUCTOS de "${lead.categoriaInteres}": falta saber ${faltantes.join(' y ')}. Esta tienda marco eso como imprescindible para recomendar bien en esta categoria.
En ESTE mensaje preguntá UNA sola cosa: "${faltantes[0]}". Nada de listas con viñetas ni dos preguntas juntas${faltantes.length > 1 ? ' (lo que falte se lo preguntas en el mensaje siguiente)' : ''}. Guardalo con actualizar_datos_lead.
No hay bloque de resultados en este turno a proposito: no menciones ningun producto, no digas que "tenemos varias opciones", y no digas que vas a buscar. Tampoco digas que "no hay" (si hay, todavia no sabes cual le sirve).`;
  }

  const { resultados, relajado } = buscarConFallback(productos, lead);
  if (!resultados.length) {
    return `NINGUN producto de la categoria "${lead.categoriaInteres}" calza con lo que pidio, ni aflojando color, marca, presupuesto o talla (total_matches = 0). PROHIBIDO ofrecer productos de otra categoria por tu cuenta (nunca saltes de categoria automaticamente, aunque coincidan en presupuesto). Se transparente: decile que por ahora no tenes eso exacto en esa categoria, ofrece derivar_a_asesor para que le avisen cuando haya reposicion, o pregunta si le interesa ver otra categoria distinta (solo si EL lo pide, vos no se la ofrezcas de prepo).`;
  }

  const yaEnviadas = (lead.contexto && lead.contexto.fotosEnviadas) || [];
  const { pagina, total, yaVistos, restantes, hayMas } = paginar(resultados, yaEnviadas);

  // Se relajo un filtro: NO se muestra nada todavia, primero se le pregunta
  // al cliente si acepta ampliar la busqueda (punto 12 del documento).
  if (relajado) {
    const preguntado = (lead.contexto || {}).relajadoPreguntado;
    const yaPreguntado = preguntado && preguntado.filtro === relajado;
    if (!yaPreguntado) {
      return `No hay ninguna coincidencia EXACTA con lo que pidio. Aflojando ${NOMBRE_FILTRO_RELAJADO[relajado]} si aparecen ${total} opcion(es) real(es). Estas son (no inventes otras):\n${formatearProductos(pagina, moneda)}\n\nNO las muestres todavia con mostrar_productos. Primero DECILE claramente que no encontraste lo exacto y que estas son parecidas pero con ${NOMBRE_FILTRO_RELAJADO[relajado]} distinto, y PREGUNTALE si quiere verlas. Recien cuando el cliente diga que si, llama a mostrar_productos (el sistema te va a dejar). Revisa el historial: si ya se lo preguntaste y ya te dijo que si, mostraselas ahora.`;
    }
  }

  if (!pagina.length) {
    // Ya vio TODOS los resultados reales de esta busqueda. Antes el bot decia
    // "esas son todas" sin saberlo; ahora lo sabe de verdad porque el total
    // lo calcula el backend.
    return `Resultados de la busqueda (los mismos de antes, YA SE LOS MOSTRASTE a este cliente en esta conversacion - mira el historial, ya tienen tarjeta con foto):\n${formatearProductos(resultados, moneda)}\n\ntotal_matches = ${total}, ya vistos = ${yaVistos}, quedan por mostrar = 0.
NO vuelvas a llamar mostrar_productos con estos IDs, ya los tiene. Estas son TODAS las opciones reales que hay en esta categoria/talla/presupuesto por ahora, no hay mas para mostrar.
Si el cliente pregunta "que mas tienes" o similar, decile con naturalidad que esas son las que hay y ofrecele ajustar algo (otra talla, otro color, otra categoria) SOLO si viene al caso. PROHIBIDO insistir para que compre: nada de "¿alguna te convencio?", "¿cual te gusto?", "¿hacemos el pedido?" ni resumenes del estilo "ya te mostre todo lo que tenemos". Ya vio las opciones; si quiere avanzar lo va a decir el.`;
  }

  return `Resultados de la busqueda (ya filtrados por categoria, genero, talla y presupuesto pedidos, son los UNICOS productos reales que puedes mencionar, NUNCA inventes otros):\n${formatearProductos(pagina, moneda)}\n\ntotal_matches = ${total} (encontrados de verdad en el catalogo), ya vistos por el cliente = ${yaVistos}, en este bloque = ${pagina.length}, quedan sin mostrar = ${restantes}.
Muestrale los de este bloque llamando a mostrar_productos UNA SOLA VEZ, con los IDs de TODOS los de esta lista juntos en el mismo array - el sistema manda una tarjeta con foto y ficha por cada uno. PROHIBIDO nombrar, describir o comparar en tu texto ningun producto (ni "tambien tenemos...", ni resumirlos): si esta en la lista, va en la tarjeta, nunca en tu texto. Tu texto de esta vuelta es SOLO una reaccion corta + pregunta de cierre.
${hayMas
  ? `HAY MAS OPCIONES REALES QUE ESTAS: encontre ${total} en total y le estas mostrando ${pagina.length} para no llenarle el chat. JAMAS le digas que "esas son todas" ni que "no hay mas". Si pregunta si tenes otros modelos, decile que si (quedan ${restantes}) y llama a ver_mas_productos para mostrarle las siguientes.`
  : `Estas ${total === pagina.length ? 'son TODAS' : 'son las ultimas'} las opciones reales que hay para lo que pidio: si pregunta por mas, podes decirle con confianza que no quedan otras en esta busqueda (el sistema ya conto el total).`}

ADVERTENCIA SOBRE EL HISTORIAL: si en mensajes anteriores dijiste que "no habia productos disponibles" en esta categoria, eso quedo OBSOLETO. El bloque de arriba es la UNICA verdad actual del inventario. Corrigete con naturalidad y muestra los productos.`;
}

function nombreValido(nombre) {
  if (!nombre) return false;
  const limpio = String(nombre).trim();
  if (limpio.length < 2) return false;
  if (!/[a-zA-ZñÑáéíóúÁÉÍÓÚ]{2,}/.test(limpio)) return false;
  if (/^(cliente|usuario|hola|si|no|nn|xx)$/i.test(limpio)) return false;
  return true;
}

// La ficha que ve el CLIENTE por WhatsApp: solo lo que le sirve para decidir
// (precio, marca, material si los hay, tallas/colores reales agrupados por
// talla en vez de una linea por cada combinacion). Categoria, tipo, corte,
// estilo, genero, ocasion, temporada son datos internos para que la IA
// filtre/recomiende (ver textoCompletoProducto/scoreProducto), no le
// interesan al cliente en la tarjeta y solo suman ruido.
// Detecta cuando el modelo escribio una lista de productos con precio como
// texto plano en vez de llamar mostrar_productos (regla ya prohibida en el
// prompt, esto es el backstop en codigo). Exige VARIOS precios Y varias
// marcas de lista/vinieta en el mismo texto para evitar falsos positivos
// con un mensaje normal que solo menciona un precio de pasada.
function pareceListadoDeProductosEnTexto(texto) {
  if (!texto) return false;
  const precios = (texto.match(/\d+[.,]\d{2}\b/g) || []).length;
  const itemsDeLista = (texto.match(/^\s*(\d+[.)]|-|·)\s/gm) || []).length;
  return precios >= 2 && itemsDeLista >= 2;
}

/**
 * Detecta que el modelo mando VARIAS preguntas en un mismo mensaje (el
 * "interrogatorio" que el negocio no quiere). Paso en produccion: el bot
 * pidio marca, ocasion y talla juntas, en una lista con viñetas.
 *
 * Se cuentan solo los cierres de pregunta: dos o mas en un mismo mensaje ya
 * es un formulario. Un mensaje normal de venta tiene una sola.
 */
function pareceInterrogatorio(texto) {
  if (!texto) return false;
  return (String(texto).match(/\?/g) || []).length >= 2;
}

/**
 * Detecta que el modelo prometio buscar en vez de mostrar ("dame un momento",
 * "voy a buscar"). Es un mensaje que deja al cliente esperando algo que nunca
 * llega, porque el turno termina ahi.
 */
function pareceAnuncioDeBusqueda(texto) {
  if (!texto) return false;
  const t = normalizarSimple(texto);
  return /(dame un momento|un momentito|ya te (muestro|paso|busco|env[ií]o)|voy a (buscar|revisar|ver|mostrarte|consultar)|estoy buscando|permiteme (un|revisar)|enseguida te)/.test(t);
}

/**
 * Que tiene que aclararle el bot al cliente sobre la foto que se acaba de
 * enviar. Puro a proposito: es la regla mas delicada del documento del
 * negocio ("nunca uses una foto de otro color como si fuera el color
 * pedido") y tiene que poder testearse sin WhatsApp ni base de datos.
 *
 * @param {object} producto
 * @param {object} foto  resultado de fotoParaMostrar()
 * @returns {string[]}  avisos que el modelo DEBE trasladarle al cliente
 */
function avisosDeFoto(producto, foto) {
  const avisos = [];
  if (!foto.url) {
    avisos.push(`"${producto.nombre}" no tiene ninguna foto cargada: se envio solo la ficha en texto. No digas que le mandaste una foto.`);
    return avisos;
  }
  if (!foto.esDelColorPedido) {
    avisos.push(foto.colorDeLaFoto
      ? `OJO con "${producto.nombre}": el cliente pidio ${foto.colorPedido} y NO hay foto cargada de ese color. La foto que se envio es del color ${foto.colorDeLaFoto}. Decile explicitamente que la foto es solo de referencia y que del ${foto.colorPedido} todavia no tenes imagen, aunque SI hay stock. Nunca la presentes como si fuera ${foto.colorPedido}.`
      : `OJO con "${producto.nombre}": no hay foto propia del color ${foto.colorPedido}; la imagen enviada es generica del producto. Aclaraselo al cliente.`);
  }
  if (foto.coloresSinFoto.length) {
    avisos.push(`Colores de "${producto.nombre}" CON foto: ${foto.coloresConFoto.join(', ') || 'ninguno'}. SIN foto cargada: ${foto.coloresSinFoto.join(', ')} (hay stock, pero no imagen). Si el cliente pregunta por alguno de esos, decile la verdad en vez de mandarle otro color.`);
  }
  return avisos;
}

/**
 * Que se le responde al modelo despues de intentar mandar las tarjetas.
 *
 * La regla del documento es que la IA no puede afirmar que hizo algo si el
 * sistema no confirmo que ocurrio: por eso el resultado siempre arranca con
 * TOOL_SUCCESS o TOOL_FAILED segun lo que paso DE VERDAD con el envio.
 */
function resultadoDeEnvio({ enviados = 0, fallidos = [], avisos = [], resumen = '', total = 0, quedan = 0 }) {
  if (!enviados) {
    return `TOOL_FAILED: no se pudo enviar ninguna tarjeta por WhatsApp${fallidos.length ? ` (${fallidos.join('; ')})` : ''}. NO le digas al cliente que le mandaste algo, porque no le llego: avisale con honestidad que hubo un problema tecnico y que lo intentas de nuevo en un momento.`;
  }
  return `TOOL_SUCCESS: se le mostraron al cliente ${enviados} producto(s) como tarjeta(s) con foto y ficha: ${resumen}.${fallidos.length ? ` NO se pudieron enviar: ${fallidos.join('; ')} - no menciones esos como enviados.` : ''}
${avisos.length ? `\nAVISOS QUE TENES QUE TRASLADARLE AL CLIENTE:\n- ${avisos.join('\n- ')}\n` : ''}
total_matches = ${total}, quedan sin mostrar = ${quedan}. ${quedan ? `Si pregunta por mas modelos, decile que SI hay (${quedan} mas) y llama a ver_mas_productos.` : 'Ya vio todas las opciones reales de esta busqueda: si pregunta por mas, podes decirle con seguridad que no quedan otras.'}
NO repitas los datos de la ficha en texto. Tu texto ahora: UNA linea corta y natural, nada mas. NO lo presiones para que compre, NO le preguntes si alguna lo convencio, NO le pidas que elija. Acaba de recibir las tarjetas: dejalo mirar tranquilo. Si necesita algo, te va a escribir el.`;
}

function fichaProducto(p, lead = {}, moneda = 'BOB') {
  const lineas = [`· *Precio*: ${formatearPrecio(p.precio, moneda)}`];
  const atributos = p.atributos || {};
  if (atributos.Marca) lineas.push(`· *Marca*: ${atributos.Marca}`);
  if (atributos.Material) lineas.push(`· *Material*: ${atributos.Material}`);

  const variantes = (p.variantes || []).filter((v) => v.activa && v.stock > 0);
  if (variantes.length) {
    // Si el cliente ya dijo que talla/color busca, la tarjeta muestra solo
    // eso (no las 15-20 combinaciones del producto completo). Si el filtro
    // no deja nada (pidio algo que no calza exacto), se muestran todas para
    // no dejar la tarjeta vacia.
    const tallasPedidas = tokensDeLista(lead.talla);
    const coloresPedidos = tokensDeLista(lead.color);
    let filtradas = variantes;
    if (tallasPedidas.length) {
      filtradas = filtradas.filter((v) => tallasPedidas.includes(normalizarSimple(v.atributos?.Talla)));
    }
    if (coloresPedidos.length) {
      filtradas = filtradas.filter((v) => coloresPedidos.some((c) => normalizarSimple(v.atributos?.Color).includes(c)));
    }
    const aMostrar = filtradas.length ? filtradas : variantes;

    // Agrupadas por talla (una linea por talla con sus colores), no una
    // linea por cada combinacion talla+color: mucho mas facil de leer.
    const porTalla = new Map();
    for (const v of aMostrar) {
      const talla = v.atributos?.Talla || 'Unica';
      if (!porTalla.has(talla)) porTalla.set(talla, []);
      if (v.atributos?.Color) porTalla.get(talla).push(v.atributos.Color);
    }
    const entradasPorTalla = [...porTalla.entries()].sort((a, b) => compararTallas(a[0], b[0]));
    // Si TODAS las tallas vienen en exactamente los mismos colores (muy
    // comun: el mismo modelo en varias tallas), una linea por talla es puro
    // ruido repetido - se colapsa en una sola linea con el rango de tallas.
    const firmaColores = (colores) => [...colores].sort().join('|');
    const mismosColoresEnTodas = entradasPorTalla.length > 1
      && entradasPorTalla.every(([, colores]) => firmaColores(colores) === firmaColores(entradasPorTalla[0][1]));
    const lineasVariantes = mismosColoresEnTodas
      ? `· Tallas ${entradasPorTalla.map(([talla]) => talla).join(', ')}: ${entradasPorTalla[0][1].length ? entradasPorTalla[0][1].join(', ') : 'disponible'}`
      : entradasPorTalla
        .map(([talla, colores]) => `· Talla ${talla}: ${colores.length ? colores.join(', ') : 'disponible'}`)
        .join('\n');
    lineas.push(`\n*Tallas y colores disponibles*:\n${lineasVariantes}`);
  } else {
    lineas.push(`· *Disponibilidad*: ${p.stock > 0 ? (p.stock <= 3 ? `¡Ultimas ${p.stock} unidades!` : `${p.stock} en stock`) : 'Agotado'}`);
  }
  if (p.caracteristicas?.length) lineas.push(`\n${p.caracteristicas.map((c) => `✔️ ${c}`).join('\n')}`);
  if (p.descripcion) lineas.push(`\n${p.descripcion}`);
  return `*${p.nombre}*\n\n${lineas.join('\n')}`;
}

function datosConocidosDelLead(lead = {}) {
  const campos = [
    ['Categoria de interes', lead.categoriaInteres],
    ['Cantidad deseada', lead.cantidad],
    ['Presupuesto', lead.presupuesto],
    ['Marca preferida', lead.marca],
    ['Talla', lead.talla],
    ['Color preferido', lead.color],
    ['Direccion de entrega', lead.direccionEntrega],
    ['Otras observaciones', lead.observaciones],
    ['Producto favorito (ID)', lead.productoFavoritoId],
    ['Etapa de la conversacion', lead.estadoConversacion],
    ...Object.entries(lead.atributosLead || {}).map(([k, v]) => [k, v]),
  ].filter(([, valor]) => valor);
  if (!campos.length) return 'Todavia no se sabe nada del cliente, esta es la primera vez que pregunta o recien empieza la conversacion.';
  return campos.map(([etiqueta, valor]) => `- ${etiqueta}: ${valor}`).join('\n');
}

/**
 * Atributos que la categoria del cliente pide en cierto nivel y todavia no se
 * saben (ni como campo propio del lead - talla/color/marca - ni guardados en
 * atributosLead).
 *
 * A diferencia de la validacion del formulario de productos (que solo mira
 * los de nivel producto), aca SI cuentan los de nivel variante: la talla es
 * justamente el caso tipico de dato que hay que preguntar antes de
 * recomendar, y vive en la variante.
 *
 * @param {string} nivel  'OBLIGATORIO' (bloquea mostrar productos) o
 *                        'RECOMENDADO' (se pregunta, pero no bloquea).
 */
const ATRIBUTO_A_CAMPO_PROPIO = { talla: 'talla', color: 'color', marca: 'marca' };
function atributosFaltantes(categoria, lead = {}, nivel = 'OBLIGATORIO') {
  if (!categoria || !categoria.atributos) return [];
  const atributosLead = lead.atributosLead || {};
  return categoria.atributos
    .filter((a) => a.nivel === nivel)
    .filter((a) => {
      const campoPropio = ATRIBUTO_A_CAMPO_PROPIO[a.nombre.toLowerCase()];
      if (campoPropio) return !lead[campoPropio];
      return !atributosLead[a.nombre];
    })
    .map((a) => a.nombre);
}

// La categoria real (con sus atributos) que se resolvio para este cliente.
// Sale del catalogo ya cargado, no de una consulta nueva.
//
// Busca en los dos niveles: los productos cuelgan de las hojas, asi que un
// RUBRO solo aparece como el "padre" de la categoria de un producto. Sin mirar
// ahi, un cliente parado en "Prendas de abajo" quedaba sin categoria resuelta
// y se salteaba el paso de elegir el tipo.
function categoriaDelLead(productos, lead = {}) {
  if (!lead.categoriaId) return null;
  for (const p of productos) {
    if (p.categoria?.id === lead.categoriaId) return p.categoria;
    if (p.categoria?.padre?.id === lead.categoriaId) return p.categoria.padre;
  }
  return null;
}

/**
 * Que hay que soltar cuando el cliente cambia de categoria ("mejor quiero
 * zapatillas urbanas").
 *
 * Lo que sigue siendo valido se mantiene (genero, talla, presupuesto, nombre,
 * direccion): el documento pide explicitamente NO reiniciar la conversacion.
 * Lo que apuntaba a la categoria vieja deja de tener sentido y se limpia, o el
 * bot sigue intentando cerrar la venta de un producto que el cliente descarto.
 */
function limpiezaPorCambioDeCategoria(clienteFinal, productos, categoriaIdNueva) {
  const categoriaNueva = productos.find((p) => p.categoria?.id === categoriaIdNueva)?.categoria;
  const nombresValidos = new Set((categoriaNueva?.atributos || []).map((a) => a.nombre));
  const atributosConservados = {};
  for (const [k, v] of Object.entries(clienteFinal.atributosLead || {})) {
    if (nombresValidos.has(k)) atributosConservados[k] = v;
  }
  return {
    productoFavoritoId: null,
    varianteFavoritaId: null,
    productosDescartados: [],
    atributosLead: atributosConservados,
    contexto: { ...(clienteFinal.contexto || {}), relajadoPreguntado: null, resumenConfirmado: null },
  };
}

// Construye el prompt de sistema con la identidad del negocio y su catalogo.
// sinHerramientas=true se usa SOLO en la ultima vuelta del loop de tools,
// cuando ya no puede llamar mas funciones y tiene que redactar el mensaje
// final: ahi se refuerza con mas fuerza la regla anti-invento, porque es el
// momento de mas riesgo de que "complete" la respuesta con datos inventados.
// esPrimerMensaje=true cuando el cliente todavia no tiene historial: el bot
// debe tomar la iniciativa y presentarse, no esperar pasivamente.
function construirSystem(empresa, productos, config, lead = {}, sinHerramientas = false, esPrimerMensaje = false, nombreAgente = '') {
  const marca = empresa.marca || empresa.nombre;
  const tono = (config && config.tono) || 'cordial y profesional';
  const extra = (config && config.instrucciones) || '';
  const bienvenida = (config && config.mensajeBienvenida) || '';
  const metodosPago = [];
  if (config && config.aceptaQr) metodosPago.push('QR');
  if (!config || config.aceptaEfectivo !== false) metodosPago.push('efectivo');
  if (config && config.aceptaTarjeta) metodosPago.push('tarjeta');
  // Primer nivel del menu (rubros), no las hojas: es lo que el cliente ve
  // cuando pregunta que vende la tienda.
  const arbol = arbolDeCategorias(productos);
  const categoriasReales = arbol.map((r) => r.nombre);
  // Categoria real que ya se resolvio para este cliente (ver extraerFiltros /
  // actualizar_datos_lead) - de ahi sale que atributos obligatorios faltan.
  const categoriaActual = categoriaDelLead(productos, lead);
  const faltantes = atributosFaltantes(categoriaActual, lead, 'OBLIGATORIO');
  // Los recomendados no bloquean, pero listarle 8 al modelo lo empuja a
  // interrogar al cliente (el catalogo real tiene categorias con 8 atributos
  // marcados). Se le muestran solo los primeros por orden: son sugerencias
  // para que la charla fluya, no un checklist.
  const recomendados = atributosFaltantes(categoriaActual, lead, 'RECOMENDADO').slice(0, MAX_ATRIBUTOS_SUGERIDOS);
  const moneda = empresa.moneda || 'BOB';
  const entregas = ['a domicilio'];
  if (config && config.direccionTienda) entregas.push('retiro en la tienda');
  const identidad = nombreAgente ? `Te llamas ${nombreAgente} y sos` : 'Eres';

  return `${identidad} la persona que atiende el WhatsApp de "${marca}". No eres un bot de formulario ni un menu de opciones: sos un vendedor de carne y hueso, con buena onda, que charla con el cliente como charlaria cualquier vendedor bueno en una tienda real. Es una conversacion real con un cliente real, no una demo.${nombreAgente ? ` Si te preguntan tu nombre, respondé que te llamas ${nombreAgente}.` : ''}

COMO SUENA UN VENDEDOR HUMANO (esto es lo mas importante de todo este mensaje):
- Habla natural, como si tipeara rapido en el celular: frases cortas, tono ${tono}, nada de sonar como un catalogo leido en voz alta.
- EMOJIS CON MODERACION: 1 emoji por mensaje esta bien cuando aporta calidez (un saludo, un cierre, una buena noticia); en mensajes con mas contenido podes usar 2 como mucho. Nunca mas de 2, y nunca los pongas si el mensaje es serio (un reclamo, un problema de stock). Si dudas, poné menos.
- NUNCA reciten los datos del cliente ni las reglas internas ("ya tengo tu categoria de interes guardada", "procesando tu solicitud"). Eso rompe la ilusion de estar hablando con una persona.
- Variá como saludás y como preguntás: si repetís la misma frase que ya usaste antes en la conversacion, suena a bot. Cada mensaje se siente escrito en el momento, pensando en lo que el cliente acaba de decir.
- USA LISTAS SOLO PARA OPCIONES, NUNCA PARA PREGUNTAS: una lista esta bien para enumerar categorias reales, formas de pago o pasos de la entrega (cosas entre las que el cliente elige). JAMAS uses una lista para hacer varias preguntas seguidas: eso convierte el chat en un formulario. Las preguntas van sueltas, de a una, redactadas como las diria una persona.
- UNA SOLA PREGUNTA POR MENSAJE. Esto es una regla dura, no una sugerencia. PROHIBIDO mandar dos preguntas en el mismo mensaje, y mucho mas prohibido mandarlas como lista con viñetas ("¿Que marca? ¿Que ocasion? ¿Que talla?"). Eso es un formulario, no una conversacion, y espanta al cliente. Si necesitas dos datos, preguntas uno, esperas la respuesta, y recien despues el otro.
- SE DIRECTO, NO CURIOSO: tu objetivo es mostrarle productos lo antes posible, no conocerlo. En cuanto tengas lo imprescindible, MOSTRA. Nunca sigas preguntando para "afinar la busqueda" o "entender mejor": si ya podes mostrar, mostra. El cliente prefiere ver 3 opciones y descartar, antes que contestar un cuestionario.
- NUNCA ANUNCIES QUE VAS A BUSCAR. Prohibido "dame un momento", "voy a revisar", "ya te muestro", "estoy buscando opciones". Vos no tardas: llamas a la herramienta y las tarjetas salen en el mismo mensaje. Un mensaje que promete algo y no lo entrega deja al cliente esperando de gusto.
- NUNCA digas que "tenemos varias opciones" sin mostrarlas en ese mismo turno. Si hay opciones, se muestran; si no las mostraste, no las anuncies.

${esPrimerMensaje ? `ESTE ES EL PRIMER MENSAJE DE LA CONVERSACION - TOMA LA INICIATIVA (obligatorio): no respondas solo con algo generico tipo "¿en que puedo ayudarte?". Presentate brevemente: quien sos${nombreAgente ? ` (te llamas ${nombreAgente})` : ''}, de que tienda, que vende la tienda en general (mira las categorias reales de abajo), y como podes ayudar.${bienvenida ? ` El negocio configuro este mensaje de bienvenida como punto de partida: "${bienvenida}" - usalo como base/inspiracion de tu primer mensaje (podes adaptarlo un poco para que fluya natural), no lo ignores.` : ''} Ejemplo del tono esperado si no tenes una bienvenida configurada (adaptalo, no lo copies literal):
"¡Hola! Soy${nombreAgente ? ` ${nombreAgente}` : ''}, el asistente de ventas de ${marca}. Tenemos ${categoriasReales.length ? categoriasReales.slice(0, 3).join(', ') : 'varios productos'}. Te puedo ayudar a encontrar justo lo que buscas. ¿Que andas necesitando?"
Que el cliente entienda de entrada que puede hacer el agente, sin sonar a discurso leido.` : `COMO ARRANCA LA CONVERSACION (si ya hay historial previo, esto no aplica): si el cliente recien saluda sin decir que busca ("hola", "buenas"), saluda con calidez y preguntale de forma abierta y natural que anda buscando (variá la frase, no uses siempre la misma).`}
SI EL CLIENTE PREGUNTA QUE TENES / QUE VENDES / QUE PRODUCTOS TIENEN / TU CATALOGO / TUS CATEGORIAS (o algo generico parecido, sin nombrar un producto puntual): llama a **mostrar_categorias**. Es OBLIGATORIO, no opcional.${categoriasReales.length <= 1 ? ` Esta tienda vende UN SOLO rubro (${categoriasReales[0] || marca}), asi que la herramienta te va a devolver una sola opcion: en ese caso no armes una lista numerada de un solo item ni preguntes "¿cual te interesa?" (no hay entre que elegir), decilo en una frase natural y pasa a preguntar que anda buscando.` : ''}
NUNCA armes vos la lista de memoria, NUNCA mandes un link a una pagina web, y NUNCA respondas "nos especializamos en X" recortando el catalogo por tu cuenta: la tienda vende todo lo que devuelve esa herramienta.
El menu tiene DOS NIVELES: primero los rubros (Calzado, Abrigos...) y despues, cuando el cliente elige uno, los tipos que hay adentro (Zapatillas urbanas, Botas...). La herramienta sabe en que nivel esta parado el cliente: llamala igual en los dos casos.

Datos que ya sabes de este cliente (los usas para no preguntar dos veces lo mismo, pero NUNCA se los repitas ni le digas que los "guardaste"):
${datosConocidosDelLead(lead)}

COMO CONDUCIS LA VENTA (con calidez, pero siempre empujando un paso mas):
- Entendé que necesita, mostrale opciones reales, resolvé sus dudas, y cuando muestre interes de verdad avanzá hacia cerrar el pedido. Es un ida y vuelta natural, no una lista de pasos rigida que hay que tildar en orden exacto.
- El presupuesto no se pregunta como un requisito de entrada: surge naturalmente si el cliente lo menciona, o lo consultas mas adelante si hace falta para recomendar bien, nunca como segunda pregunta obligatoria.
- Si el cliente menciona algo util (para quien es, que necesita, marca/talla/color, un detalle), guardalo con actualizar_datos_lead pero sin que se note en tu texto que estas "llenando un formulario".
- NUNCA cambies de categoria por tu cuenta: si el cliente busca zapatillas, seguis buscando dentro de zapatillas aunque no encuentres coincidencia exacta. Jamas le ofrezcas algo de otra categoria (una mochila, una camisa) solo porque coincide en presupuesto - eso confunde y no es lo que pidio.
- Cuando el cliente elige un favorito entre varias opciones ("me gusta el segundo", "esa quiero"), guardalo con actualizar_datos_lead (productoFavoritoId) y de ahi en mas enfocate SOLO en ese producto: dejá de mostrarle mas alternativas salvo que el mismo diga que cambio de opinion.
- Actualizá estadoConversacion via actualizar_datos_lead a medida que el cliente avanza (explorando -> buscando_producto -> comparando -> interesado -> intencion_de_compra -> listo_para_comprar): eso ayuda al sistema a saber cuando dejar de sugerir y empezar a cerrar.
- PROACTIVO CON FOTOS: en cuanto el cliente muestre interes real en un producto especifico (dice "me gusta", "ese me interesa", o cualquier reaccion positiva), mandale las fotos con enviar_fotos_producto SIN que tenga que pedirlas.
- Cuando hay intencion clara de compra, pedile lo que falte (nombre, tipo de entrega, direccion si es a domicilio, forma de pago) de forma natural, de a una cosa por mensaje. Antes de crear nada, llama a confirmar_pedido: el sistema arma el resumen exacto (producto, variante, cantidad, precio real, entrega) para que se lo leas y el cliente diga que esta todo bien. Recien despues llama a crear_pedido.
- FORMAS DE PAGO REALES de esta tienda (nunca ofrezcas otra que no este en esta lista): ${metodosPago.length ? metodosPago.join(', ') : 'ninguna configurada todavia - si el cliente pregunta, decile que un asesor va a coordinar el pago con el'}.
- TIPOS DE ENTREGA REALES de esta tienda: ${entregas.join(' o ')}. ${config && config.direccionTienda ? 'Si elige retirar, el sistema le manda la direccion real del local (vos NUNCA la escribas de memoria).' : 'Esta tienda todavia no cargo la direccion de su local, asi que por ahora solo podes ofrecer entrega a domicilio - nunca inventes una direccion de tienda.'}
${faltantes.length ? `- LO UNICO QUE TE FALTA PARA PODER MOSTRAR en la categoria "${categoriaActual.nombre}": ${faltantes.join(' y ')}. Preguntá SOLO "${faltantes[0]}" en este mensaje${faltantes.length > 1 ? ` (lo demas se lo preguntas despues, de a uno)` : ''} y guardalo con actualizar_datos_lead (talla/color/marca van en su campo propio; cualquier otro atributo como Genero o Uso va en atributosCategoria). Apenas lo tengas, MOSTRA productos: no aproveches para preguntar otra cosa.` : ''}
${recomendados.length ? `- Datos que podrian afinar la recomendacion en "${categoriaActual.nombre}": ${recomendados.join(', ')}. NO los preguntes antes de mostrar productos - solo te sirven DESPUES, si el cliente vio las opciones y ninguna le convencio.` : ''}
- CIERRE SIN INSISTIR: acompañas al cliente, no lo empujas. Cuando EL muestra intencion de compra ("me gusta esa", "la quiero", "cuanto sale el envio"), ahi si avanzas y le pedis lo que falta para el pedido. Si todavia no dijo nada de eso, NO insistas: nada de "¿alguna te convencio?", "¿cual preferis?", "¿hacemos el pedido?" despues de mostrarle cosas. Un vendedor que presiona espanta. Dejalo mirar; si necesita algo, pregunta.

REGLAS TECNICAS (estas si son estrictas, aunque no se noten en tu forma de hablar):
- SOLO TEMAS DEL NEGOCIO: sos un vendedor de "${marca}", no un asistente general. Si te preguntan algo que no tiene nada que ver con la tienda o sus productos (la hora, capitales, cultura general, matematica, tareas, programacion, chistes, opiniones sobre temas ajenos, etc.), NO respondas esa pregunta: con una frase breve y amable aclara que ahi no podes ayudar, y redirigi de inmediato hacia la conversacion de venta ("de eso no te puedo ayudar, pero contame, ¿que andas buscando hoy?"). Nunca sigas el hilo de un tema ajeno aunque el cliente insista, y nunca gastes mas de una frase en la aclaracion.
- PRIMERO ENTENDER, DESPUES MOSTRAR: no arranques mostrando productos porque el cliente nombro una categoria. Si el bloque de resultados de abajo no existe todavia, es porque el sistema necesita que primero entiendas que busca: preguntá, no muestres.
- TARJETAS: para mostrar cualquier producto SIEMPRE llama a mostrar_productos con sus IDs. Nunca escribas precio o stock como texto plano: eso va en la tarjeta que genera el sistema. Mostra las opciones del bloque de resultados (son pocas y muy relevantes a proposito), nunca mas de las que te da el sistema.
- MOSTRAR POCAS NO ES QUE HAYA POCAS: el bloque de resultados te dice el total_matches real. Si el total es mayor a lo que le mostraste, JAMAS digas "esas son todas las que tengo": decile cuantas hay y ofrecele ver las siguientes con ver_mas_productos.
- MONEDA: los precios de esta tienda estan en ${moneda} (${simboloMoneda(moneda)}). Nunca los conviertas a otra moneda, nunca cambies el simbolo y nunca escribas un precio que no venga del sistema tal cual.
- No muestres ni inventes ningun producto que no este en el bloque de resultados de abajo: esa es la UNICA fuente real del inventario.
- Usa derivar_a_asesor cuando el cliente lo pida explicitamente, este muy molesto, o detectes pedido mayorista, compra de monto alto, negociacion especial de precio, descuento fuera de lo normal, un problema que no podes resolver, condicion comercial especial, o un cliente empresarial. Nunca por preguntas normales de precio, stock o forma de pago: esas las respondes vos con la info disponible.
- No se puede crear un pedido sin nombre, tipo de entrega (y direccion si es a domicilio) y forma de pago: pedilos de forma natural antes de llamar crear_pedido si faltan.
- ACCIONES: nunca afirmes que hiciste algo (mandar una foto, mandar el QR, mandar la ubicacion, crear el pedido) si el sistema no te confirmo que salio bien. Cada herramienta te responde si funciono o si fallo: si fallo, decile la verdad al cliente y ofrecele reintentar.
- Si un producto tiene variantes (talla/color/etc., estan listadas debajo de ese producto en el bloque de resultados), NUNCA llames crear_pedido sin antes preguntarle al cliente cual elige: usa el ID de esa variante exacta en idVariante.
- Si el cliente pide ver "el catalogo", "todos los productos" o "tus categorias", llama a mostrar_categorias. PROHIBIDO mandarle un link a una pagina: el cliente compra dentro de WhatsApp, no lo mandes afuera.
- FORMATO WHATSAPP (no Markdown): negrita = *un asterisco pegado al texto*, nunca **doble asterisco** ni # titulos.

Informacion comercial:
${extra ? `- ${extra}` : '(sin instrucciones adicionales)'}

${resumenInventario(productos)}

${seccionProductos(productos, lead, categoriaActual, moneda)}

REGLA ANTI-INVENTO: cada producto que muestres DEBE corresponder a una linea del bloque de arriba, con su precio EXACTO. Los IDs son solo para tus llamadas a funciones, nunca los menciones al cliente. Si te preguntan un detalle puntual que no figura ahi (ej. una talla exacta que no esta en las caracteristicas), respondé con lo real que si tenes (el rango que SI aparece) sin inventar numeros nuevos, y ofrecé confirmarlo si hace falta precision.

SI NO SABES ALGO, DECILO: cuando el cliente pregunta un dato que la ficha no tiene (que tipo de algodon es, si abriga mucho, cuanto pesa), la respuesta correcta es admitirlo con naturalidad: "la ficha dice 100% algodon, pero no tengo registrado el tipo exacto". PROHIBIDO rellenar con adjetivos que no estan en los datos ("algodon premium", "confeccion de alta calidad", "muy resistente"). Lo mismo si te preguntan por que cuesta lo que cuesta: solo podes usar atributos reales de la ficha, nunca justificaciones inventadas.

CIERRE NATURAL: sin guion de call center y sin presion. Un vendedor real resuelve la duda, deja que el cliente mire, y recien encamina hacia la compra cuando el cliente da la señal. Nunca cierres un mensaje pidiendole que decida o que compre si el no mostro intencion: eso incomoda y hace que deje de contestar.${sinHerramientas ? `

ATENCION: esta es tu respuesta final de este turno, ya NO podes llamar ninguna funcion mas. Los UNICOS productos que existen son los que estan en el bloque de resultados de arriba (por nombre exacto) - si no alcanza para responder algo puntual, decilo con naturalidad ("dejame confirmarte ese dato") en vez de inventar un producto, caracteristica o numero que no este ahi. NUNCA menciones un producto o modelo que no aparezca literalmente en ese bloque.` : ''}`;
}

// ============================ Llamadas al modelo (por proveedor) ============================
// Formato estandar de mensajes para el loop de tools:
//  { role: 'user'|'assistant', content: string }
//  { role: 'assistant', content, tool_calls: [{id,name,arguments}] }
//  { role: 'tool', tool_call_id, content }

async function llamarOpenAI({ system, mensajes, tools, modelo }) {
  const openai = getOpenAI();
  const convertidos = mensajes.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
        })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    return { role: m.role, content: m.content };
  });

  const params = {
    model: modelo,
    messages: [{ role: 'system', content: system }, ...convertidos],
    tools,
    tool_choice: 'auto',
  };
  const campoTokens = /^(gpt-5|o[0-9])/i.test(modelo) ? 'max_completion_tokens' : 'max_tokens';
  params[campoTokens] = 700;

  const resp = await openai.chat.completions.create(params);
  const msg = resp.choices[0].message;
  return {
    content: msg.content || '',
    tool_calls: (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    })),
  };
}

async function llamarAnthropic({ system, mensajes, tools, modelo }) {
  const anthropic = getAnthropic();
  const convertidos = mensajes.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const bloques = [];
      if (m.content) bloques.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) bloques.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
      return { role: 'assistant', content: bloques };
    }
    if (m.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content || '') }] };
    }
    return { role: m.role, content: m.content };
  });

  const resp = await anthropic.messages.create({
    model: modelo,
    max_tokens: 700,
    system,
    messages: convertidos,
    tools: toolsParaAnthropic(tools),
  });

  const texto = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolCalls = resp.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} }));
  return { content: texto, tool_calls: toolCalls };
}

/**
 * Traduce los argumentos de `actualizar_datos_lead` al objeto que se guarda en
 * ClienteFinal. Puro a proposito: aca vive la memoria del cliente, que es lo
 * mas facil de romper sin darse cuenta.
 *
 * EL ORDEN IMPORTA. Si el cliente cambia de categoria, la limpieza deja las
 * listas depuradas en `datos`, y los bloques que acumulan (atributos,
 * descartados) tienen que construir SOBRE esa limpieza, no sobre el valor
 * viejo del cliente: un mismo mensaje puede cambiar de rubro y traer atributos
 * nuevos a la vez, y leyendo el valor viejo se resucitan los de la categoria
 * anterior.
 */
function datosDeActualizacionDeLead(args = {}, clienteFinal = {}, productos = []) {
  const datos = {};
  if (args.nombre) datos.nombre = String(args.nombre).slice(0, 120);
  if (args.categoriaInteres) {
    datos.categoriaInteres = String(args.categoriaInteres).slice(0, 120);
    // Resuelve tambien la categoria REAL (para saber sus atributos
    // obligatorios) con el mismo matching que ya usa extraerFiltros.
    const resuelto = productos.find((p) => p.categoria && coincideTexto(datos.categoriaInteres, p.categoria.nombre));
    datos.categoriaId = resuelto ? resuelto.categoria.id : null;

    // El cliente cambio de rubro ("mejor quiero zapatillas urbanas"): lo que
    // seguia siendo valido se mantiene (genero, talla, presupuesto), pero
    // todo lo que apuntaba a la categoria vieja deja de tener sentido y hay
    // que soltarlo. Sin esto el bot se quedaba enfocado en cerrar la venta
    // de un producto que el cliente ya descarto.
    if (datos.categoriaId !== clienteFinal.categoriaId) {
      Object.assign(datos, limpiezaPorCambioDeCategoria(clienteFinal, productos, datos.categoriaId));
    }
  }
  if (args.presupuesto) {
    datos.presupuesto = String(args.presupuesto).slice(0, 60);
    // El texto queda para repetirselo al cliente; el filtrado real usa el
    // rango numerico ya interpretado (nunca se reparsea en cada busqueda).
    const { min, max } = interpretarPresupuesto(datos.presupuesto);
    datos.presupuestoMin = min;
    datos.presupuestoMax = max;
  }
  if (args.cantidad) datos.cantidad = String(args.cantidad).slice(0, 20);
  if (args.marca) datos.marca = String(args.marca).slice(0, 60);
  if (args.talla) datos.talla = String(args.talla).slice(0, 30);
  if (args.color) datos.color = String(args.color).slice(0, 30);
  if (args.direccionEntrega) datos.direccionEntrega = String(args.direccionEntrega).slice(0, 300);
  if (args.tipoEntrega) datos.tipoEntrega = String(args.tipoEntrega).toUpperCase();
  if (args.formaPago) datos.formaPago = String(args.formaPago).toUpperCase();
  if (args.observaciones) datos.observaciones = String(args.observaciones).slice(0, 500);
  if (args.nivelInteres) datos.nivelInteres = String(args.nivelInteres).toUpperCase();
  if (args.estadoConversacion) datos.estadoConversacion = String(args.estadoConversacion).toUpperCase();
  if (args.productoFavoritoId) datos.productoFavoritoId = Number(args.productoFavoritoId);
  if (args.varianteFavoritaId) datos.varianteFavoritaId = Number(args.varianteFavoritaId);
  if (Array.isArray(args.productosDescartadosIds) && args.productosDescartadosIds.length) {
    const actuales = datos.productosDescartados ?? clienteFinal.productosDescartados ?? [];
    datos.productosDescartados = [...new Set([...actuales, ...args.productosDescartadosIds.map(Number)])];
  }
  if (args.atributosCategoria && typeof args.atributosCategoria === 'object') {
    const actuales = datos.atributosLead ?? clienteFinal.atributosLead ?? {};
    const nuevos = {};
    for (const [k, v] of Object.entries(args.atributosCategoria)) {
      if (v) nuevos[String(k).slice(0, 60)] = String(v).slice(0, 120);
    }
    datos.atributosLead = { ...actuales, ...nuevos };
  }
  datos.estadoLead = 'EN_CONVERSACION';
  return datos;
}

// ============================ Ejecucion de tools ============================
// helpers: { empresaId, telefonoCliente, conexion, fotosParaMostrar, conversacionId, leadActual }
async function ejecutarFuncion(toolCall, contexto, helpers) {
  const { empresaId, telefonoCliente, conexion, fotosParaMostrar, conversacionId, leadActual, config } = helpers;
  const moneda = helpers.moneda || 'BOB';
  const args = toolCall.arguments || {};

  const clienteFinal = await prisma.clienteFinal.upsert({
    where: { empresaId_telefono: { empresaId, telefono: telefonoCliente } },
    update: {},
    create: { empresaId, telefono: telefonoCliente },
  });

  if (toolCall.name === 'actualizar_datos_lead') {
    const datos = datosDeActualizacionDeLead(args, clienteFinal, contexto);
    await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: datos });
    // Si en este mismo turno la IA tambien llama mostrar_productos despues de
    // esto (muy comun: "guarda que pidio talla L" + "mostrale las opciones"),
    // ese siguiente tool call necesita ver la talla/color recien guardados
    // para poder filtrar la ficha - leadActual viene de un fetch de ANTES de
    // este turno, asi que se actualiza en memoria aca tambien.
    if (leadActual) Object.assign(leadActual, datos);
    logEtapa('memoria', telefonoCliente, { datos: Object.keys(datos) });
    return null;
  }

  if (toolCall.name === 'mostrar_productos' || toolCall.name === 'enviar_fotos_producto' || toolCall.name === 'ver_mas_productos') {
    const yaEnviadas = (clienteFinal.contexto && clienteFinal.contexto.fotosEnviadas) || [];
    const categoriaActual = categoriaDelLead(contexto, leadActual || {});

    // GATE EN CODIGO: mientras falten los datos que esta categoria marca como
    // imprescindibles, no se muestra NADA. El prompt ya se lo pide, pero el
    // modelo igual intenta mostrar productos apenas escucha una categoria
    // ("zapatillas" -> tres tarjetas), que es justo lo que el negocio no
    // quiere: primero entender, despues mostrar.
    if (toolCall.name !== 'enviar_fotos_producto' && leadActual) {
      // El cliente esta parado en un rubro que se subdivide: primero elige el
      // tipo. Sin esto el modelo muestra 3 productos cualquiera del rubro.
      if (categoriaActual && !categoriaActual.padreId) {
        const subs = subcategoriasDe(contexto, categoriaActual.id);
        if (subs.length) {
          logEtapa('mostrar_bloqueado_falta_subcategoria', telefonoCliente, { rubro: categoriaActual.nombre });
          return `TODAVIA NO le muestres productos: "${categoriaActual.nombre}" se divide en ${subs.map((x) => x.nombre).join(', ')}. No se envio ninguna tarjeta (TOOL_FAILED). Pasale esa lista numerada y preguntale cual quiere ver; cuando elija, ahi si.`;
        }
      }
      const faltantes = atributosFaltantes(categoriaActual, leadActual, 'OBLIGATORIO');
      if (faltantes.length) {
        logEtapa('mostrar_bloqueado_faltan_datos', telefonoCliente, { faltantes });
        return `TODAVIA NO le muestres productos: falta saber ${faltantes.join(' y ')}. No se envio ninguna tarjeta (TOOL_FAILED). Preguntaselo primero de forma natural, de a una cosa por mensaje, guardalo con actualizar_datos_lead y recien despues volve a mostrar.`;
      }
    }

    const busqueda = leadActual ? buscarConFallback(contexto, leadActual) : { resultados: [], total: 0, relajado: null };

    // Se encontraron opciones solo aflojando un filtro: no se muestran hasta
    // que el cliente diga que quiere verlas (el documento es explicito: el
    // cliente decide si acepta ampliar la busqueda).
    //
    // El turno importa: no alcanza con "ya se lo pregunte", tiene que haber
    // sido en un turno ANTERIOR. Si no, el modelo pregunta y se autorresponde
    // en la misma vuelta, que es exactamente lo que se quiere evitar.
    if (toolCall.name === 'mostrar_productos' && busqueda.relajado) {
      const preguntado = (clienteFinal.contexto || {}).relajadoPreguntado;
      const respondioElCliente = preguntado
        && preguntado.filtro === busqueda.relajado
        && preguntado.turno !== helpers.turno;
      if (!respondioElCliente) {
        await prisma.clienteFinal.update({
          where: { id: clienteFinal.id },
          data: {
            contexto: {
              ...(clienteFinal.contexto || {}),
              relajadoPreguntado: { filtro: busqueda.relajado, turno: helpers.turno },
            },
          },
        });
        logEtapa('mostrar_bloqueado_filtro_relajado', telefonoCliente, { relajado: busqueda.relajado });
        return `NO se mostro nada todavia (TOOL_FAILED a proposito): no hay coincidencia exacta y estas opciones aparecen recien aflojando ${NOMBRE_FILTRO_RELAJADO[busqueda.relajado]}. Primero decile eso con claridad y preguntale si quiere verlas igual. Cuando el cliente te conteste que si, volve a llamar mostrar_productos y ahi si se las mando.`;
      }
    }

    let ids;
    if (toolCall.name === 'enviar_fotos_producto') {
      ids = [Number(args.idProducto)];
    } else if (toolCall.name === 'ver_mas_productos') {
      // La siguiente pagina la elige el backend, no el modelo: es la unica
      // forma de garantizar que no repita ni se saltee resultados reales.
      ids = paginar(busqueda.resultados, yaEnviadas).pagina.map((p) => p.id);
      if (!ids.length) {
        return `Ya le mostraste TODAS las opciones reales de esta busqueda (total_matches = ${busqueda.total}, no queda ninguna sin mostrar). Decile con naturalidad que esas son todas las que hay para lo que pidio, y ofrecele ajustar algo (otro color, otra talla, otro presupuesto) o ver otra categoria.`;
      }
    } else {
      ids = (args.idsProductos || []).slice(0, MAX_PRODUCTOS_A_MOSTRAR).map(Number);
    }

    // NUNCA confiar a ciegas en el ID que manda el modelo: tiene que ser un
    // producto que de verdad salio en la busqueda real de esta conversacion
    // (candidato actual, ya mostrado, o el favorito guardado). Sin esto, si
    // el modelo confunde o inventa un ID (ej. describio productos en texto
    // plano en vez de con mostrar_productos, y despues "adivina" cual era
    // "el primero"), termina mandando la foto de un producto totalmente
    // distinto al que se esta hablando - bug real que ya paso.
    if (leadActual) {
      const idsValidos = new Set([
        ...busqueda.resultados.map((c) => c.id),
        ...(leadActual.productosMostrados || []),
        ...yaEnviadas,
        ...(leadActual.productoFavoritoId ? [leadActual.productoFavoritoId] : []),
      ]);
      const idsInvalidos = ids.filter((id) => !idsValidos.has(id));
      if (idsInvalidos.length) {
        logEtapa('id_producto_rechazado', telefonoCliente, { tool: toolCall.name, idsInvalidos, idsValidos: [...idsValidos] });
        ids = ids.filter((id) => idsValidos.has(id));
        if (!ids.length) {
          return 'Ese producto no es parte de lo que se busco o mostro de verdad en esta conversacion (no inventes ni supongas un ID). Volve a mirar el bloque de resultados reales de arriba y usa el ID EXACTO del producto correcto - si no estas seguro cual es, primero llama a mostrar_productos con la busqueda actual para confirmarlo.';
        }
      }
    }

    // Si el modelo pide mostrar productos que YA se mandaron en esta misma
    // conversacion, no se reenvian las tarjetas (spam) - se le avisa que ya
    // las vio, para que en su texto siga la charla en vez de repetir.
    if (toolCall.name === 'mostrar_productos') {
      const idsNuevos = ids.filter((id) => !yaEnviadas.includes(id));
      if (ids.length && idsNuevos.length === 0) {
        const restantes = paginar(busqueda.resultados, yaEnviadas).pagina.length;
        return `Estos productos YA se los mostraste en esta conversacion (mira el historial, ya tienen tarjeta). NO vuelvas a llamar mostrar_productos con los mismos IDs. ${restantes ? 'Todavia quedan otras opciones reales sin mostrar: si el cliente quiere ver mas, llama a ver_mas_productos.' : `Ya vio las ${busqueda.total} opciones reales de esta busqueda: podes decirle con seguridad que no hay mas.`}`;
      }
      // Nunca mas de una pagina de golpe, aunque el modelo pida diez IDs.
      ids = idsNuevos.slice(0, MAX_PRODUCTOS_A_MOSTRAR);

      // ...pero tampoco MENOS de una pagina: si el modelo pidio 1 sola
      // tarjeta habiendo 3 para mostrar, se completan las que faltan. Sin
      // esto la IA manda una tarjeta y "resuelve" el resto describiendolo en
      // texto plano, que es como empezo el bug de la foto equivocada (ver
      // docs/03, punto 7). El tope sigue siendo la pagina actual.
      for (const c of paginar(busqueda.resultados, yaEnviadas).pagina) {
        if (ids.length >= MAX_PRODUCTOS_A_MOSTRAR) break;
        if (!ids.includes(c.id)) ids.push(c.id);
      }
    }

    let productos = contexto.filter((p) => ids.includes(p.id));
    if (!productos.length) return 'No encontre esos productos para mostrartelos.';

    // Tope duro de fotos por turno, contando TODAS las herramientas que se
    // hayan ejecutado en este mismo turno (el modelo puede llamar mostrar_
    // productos y despues enviar_fotos_producto). Sin esto, el cliente
    // termina con el chat lleno de imagenes.
    const yaMandadasEnEsteTurno = helpers.fotosEnviadasEnTurno || 0;
    const cupo = Math.max(0, MAX_FOTOS_POR_TURNO - yaMandadasEnEsteTurno);
    if (!cupo) {
      return `Ya le mandaste ${MAX_FOTOS_POR_TURNO} fotos en este mismo turno, que es el maximo para no llenarle el chat. NO mandes mas ahora: respondele con texto, y si quiere ver otras opciones se las mostras cuando te conteste.`;
    }
    productos = productos.slice(0, cupo);

    const nuevasEnviadas = [...yaEnviadas];
    const enviados = [];
    const avisos = [];
    const fallidos = [];

    for (const producto of productos) {
      const caption = fichaProducto(producto, leadActual || {}, moneda);
      if (toolCall.name === 'enviar_fotos_producto' && yaEnviadas.includes(producto.id)) {
        return `Ya te envie todas las fotos disponibles de ese producto 📸 ¿Quieres:\n1) Mas informacion\n2) Confirmar el pedido\n3) Ver otras opciones parecidas?`;
      }

      const foto = fotoParaMostrar(producto, leadActual || {});
      const mediaUrl = foto.url;

      // TOOL_SUCCESS / TOOL_FAILED de verdad: antes se asumia que el envio
      // habia salido bien y el texto decia "te mande la foto" aunque hubiera
      // fallado. Ahora se mira el resultado real de la API de WhatsApp.
      let envioOk = true;
      let errorEnvio = null;
      if (conexion && conexion.estado === 'CONECTADO' && mediaUrl) {
        const resultados = await wa.enviarImagenes(conexion, telefonoCliente, [mediaUrl], caption);
        const fallo = (resultados || []).find((r) => !r.ok);
        envioOk = !fallo;
        errorEnvio = fallo ? fallo.error : null;
      } else if (conexion && conexion.estado === 'CONECTADO') {
        const envio = await wa.enviarTexto(conexion, telefonoCliente, caption);
        envioOk = envio.ok;
        errorEnvio = envio.error || null;
      } else if (mediaUrl && fotosParaMostrar) {
        // Sin conexion real (modo de prueba en el panel): se registran las
        // fotos para que el chat de prueba las muestre como imagenes de
        // verdad, no solo como texto.
        fotosParaMostrar.push({ url: mediaUrl, caption });
      }

      if (!envioOk) {
        fallidos.push(`${producto.nombre}${errorEnvio ? ` (${errorEnvio})` : ''}`);
        logEtapa('envio_fallido', telefonoCliente, { tool: toolCall.name, productoId: producto.id, error: errorEnvio });
        continue;
      }

      // El cliente pidio un color puntual del que no hay foto propia: se
      // manda la que hay, pero el bot TIENE que aclarar que es referencial.
      // Hacer pasar la foto de un color por otro es justo lo que el negocio
      // marco como error grave.
      avisos.push(...avisosDeFoto(producto, foto));

      // La tarjeta se manda por WhatsApp arriba, pero tambien se guarda como
      // Mensaje real: si no, el historial de la conversacion en el panel
      // queda incompleto (el cliente recibio la foto/ficha, pero el equipo
      // que revisa la conversacion despues no la ve).
      if (conversacionId) {
        const mensajeGuardado = await prisma.mensaje.create({
          data: { conversacionId, rol: 'AGENTE', contenido: caption, mediaUrl, mediaTipo: mediaUrl ? 'imagen' : null },
        });
        emitMensaje(empresaId, {
          conversacionId, rol: 'AGENTE', contenido: caption, mediaUrl, mediaTipo: mensajeGuardado.mediaTipo, createdAt: mensajeGuardado.createdAt,
        });
      }

      enviados.push(caption);
      if (mediaUrl) helpers.fotosEnviadasEnTurno = (helpers.fotosEnviadasEnTurno || 0) + 1;
      if (!nuevasEnviadas.includes(producto.id)) nuevasEnviadas.push(producto.id);
    }

    if (!enviados.length) {
      logEtapa('tool_ejecutada', telefonoCliente, { tool: toolCall.name, tool_result: 'TOOL_FAILED', fallidos });
      return resultadoDeEnvio({ enviados: 0, fallidos });
    }

    const mostradosActuales = clienteFinal.productosMostrados || [];
    const mostradosNuevos = toolCall.name === 'enviar_fotos_producto'
      ? mostradosActuales
      : [...new Set([...mostradosActuales, ...productos.map((p) => p.id)])];

    await prisma.clienteFinal.update({
      where: { id: clienteFinal.id },
      data: {
        contexto: { ...(clienteFinal.contexto || {}), fotosEnviadas: nuevasEnviadas },
        productosMostrados: mostradosNuevos,
      },
    });

    const pendientes = paginar(busqueda.resultados, nuevasEnviadas);
    logEtapa('tool_ejecutada', telefonoCliente, {
      tool: toolCall.name,
      tool_result: 'TOOL_SUCCESS',
      productos: productos.map((p) => p.id),
      total_matches: busqueda.total,
      results_returned: enviados.length,
      restantes: pendientes.pagina.length + pendientes.restantes,
    });

    return resultadoDeEnvio({
      enviados: enviados.length,
      fallidos,
      avisos,
      resumen: productos.map((p) => `${p.nombre} (${formatearPrecio(p.precio, moneda)})`).join('; '),
      total: busqueda.total,
      quedan: pendientes.pagina.length + pendientes.restantes,
    });
  }

  if (toolCall.name === 'confirmar_pedido' || toolCall.name === 'crear_pedido') {
    const accion = toolCall.name === 'crear_pedido' ? 'crees el pedido' : 'sigas';
    if (!nombreValido(clienteFinal.nombre)) {
      return `TODAVIA NO ${accion}: falta el nombre del cliente. Preguntaselo, guardalo con actualizar_datos_lead y recien ahi volve a llamar.`;
    }
    if (!clienteFinal.tipoEntrega) {
      const opciones = config && config.direccionTienda
        ? 'a domicilio o retiro en la tienda'
        : 'a domicilio (esta tienda no tiene cargada la direccion de su local, asi que no ofrezcas retiro)';
      return `TODAVIA NO ${accion}: falta saber como quiere recibirlo. Preguntale si lo quiere ${opciones}, guardalo con actualizar_datos_lead (tipoEntrega) y volve a llamar.`;
    }
    if (clienteFinal.tipoEntrega === 'DOMICILIO' && !clienteFinal.direccionEntrega) {
      return `TODAVIA NO ${accion}: es una entrega a domicilio y falta la direccion. Pedile la direccion o que te comparta su ubicacion por WhatsApp, guardala con actualizar_datos_lead y volve a llamar.`;
    }
    if (clienteFinal.tipoEntrega === 'RECOJO' && !(config && config.direccionTienda)) {
      return `TODAVIA NO ${accion}: el cliente quiere retirar en la tienda, pero este negocio no tiene cargada la direccion de su local. NUNCA inventes una direccion: avisale que un asesor le va a pasar la ubicacion exacta, u ofrecele entrega a domicilio.`;
    }
    const metodosHabilitados = {
      QR: Boolean(config && config.aceptaQr),
      EFECTIVO: !config || config.aceptaEfectivo !== false,
      TARJETA: Boolean(config && config.aceptaTarjeta),
    };
    if (!clienteFinal.formaPago) {
      return `TODAVIA NO ${accion}: falta la forma de pago. Preguntasela (solo entre las formas de pago reales de esta tienda, ver bloque de arriba), guardala con actualizar_datos_lead y recien ahi volve a llamar.`;
    }
    if (!metodosHabilitados[clienteFinal.formaPago]) {
      const disponibles = Object.entries(metodosHabilitados).filter(([, ok]) => ok).map(([m]) => m.toLowerCase()).join(', ');
      return `TODAVIA NO ${accion}: esta tienda no tiene habilitada esa forma de pago. Las formas de pago reales son: ${disponibles || 'ninguna configurada, avisale que un asesor lo va a contactar para coordinar el pago'}. Preguntale de nuevo entre esas, guardala con actualizar_datos_lead y recien ahi volve a llamar.`;
    }

    const items = [];
    let total = 0;
    for (const item of args.items || []) {
      const producto = await prisma.producto.findFirst({
        where: { id: Number(item.idProducto), empresaId },
        include: { variantes: { where: { activa: true } } },
      });
      if (!producto) continue;
      const cantidad = Math.max(1, Number(item.cantidad) || 1);

      let variante = null;
      if (producto.variantes.length) {
        if (!item.idVariante) {
          const opciones = producto.variantes
            .map((v) => `- [Variante ID ${v.id}] ${formatearAtributosVariante(v.atributos)} - Precio: ${formatearPrecio(v.precio ?? producto.precio, moneda)} - Stock: ${v.stock}`)
            .join('\n');
          return `TODAVIA NO ${accion} de "${producto.nombre}": ese producto tiene variantes y falta saber cual eligio el cliente. Preguntaselo y volve a llamar con el idVariante correcto entre estas opciones reales:\n${opciones}`;
        }
        variante = producto.variantes.find((v) => v.id === Number(item.idVariante));
        if (!variante) return `No encontre esa variante de "${producto.nombre}". Ofrece una de las opciones reales disponibles.`;
        if (variante.stock < cantidad) {
          return `No hay stock suficiente de "${producto.nombre}" (${formatearAtributosVariante(variante.atributos)}) - quedan ${variante.stock}. Ofrece la cantidad disponible u otra variante.`;
        }
      } else if (producto.stock < cantidad) {
        return `No hay stock suficiente de ${producto.nombre} (quedan ${producto.stock}). Ofrece la cantidad disponible o un producto alternativo.`;
      }

      const precioUnitario = Number(variante ? (variante.precio ?? producto.precio) : producto.precio);
      total += precioUnitario * cantidad;
      items.push({
        productoId: producto.id,
        varianteId: variante ? variante.id : null,
        nombre: variante ? `${producto.nombre} (${formatearAtributosVariante(variante.atributos)})` : producto.nombre,
        precio: precioUnitario,
        cantidad,
      });
    }
    if (!items.length) return 'No encontre esos productos para armar el pedido.';

    // Firma de lo que se esta por comprar. crear_pedido exige que sea la
    // MISMA que se le confirmo al cliente: asi un pedido nunca se crea sin
    // que la persona haya visto y aceptado el resumen exacto.
    const firmaItems = items.map((i) => `${i.productoId}:${i.varianteId || 0}:${i.cantidad}`).sort().join('|');

    if (toolCall.name === 'confirmar_pedido') {
      await prisma.clienteFinal.update({
        where: { id: clienteFinal.id },
        data: {
          contexto: { ...(clienteFinal.contexto || {}), resumenConfirmado: firmaItems },
          estadoConversacion: 'DATOS_DE_PEDIDO',
        },
      });
      const lineas = items.map((i) => `- ${i.cantidad}x ${i.nombre} — ${formatearPrecio(i.precio, moneda)} c/u`).join('\n');
      const entrega = clienteFinal.tipoEntrega === 'RECOJO'
        ? `Retira en la tienda: ${config.direccionTienda}`
        : `Entrega a domicilio: ${clienteFinal.direccionEntrega}`;
      logEtapa('resumen_confirmado', telefonoCliente, { items: items.length, total, tipoEntrega: clienteFinal.tipoEntrega });
      return `TOOL_SUCCESS. Resumen REAL del pedido (todos estos datos salen de la base, usalos tal cual, no los cambies ni redondees):
${lineas}
Total: ${formatearPrecio(total, moneda)}
A nombre de: ${clienteFinal.nombre}
${entrega}
Forma de pago: ${clienteFinal.formaPago.toLowerCase()}

Tu texto ahora: leele este resumen al cliente de forma clara y ordenada y preguntale si esta todo correcto. NO llames a crear_pedido en este turno: espera a que el cliente confirme que si.`;
    }

    if ((clienteFinal.contexto || {}).resumenConfirmado !== firmaItems) {
      return 'TODAVIA NO crees el pedido: el cliente no confirmo ESTE pedido exacto todavia (o cambio algo desde el resumen anterior). Llama primero a confirmar_pedido con estos mismos items, leele el resumen, y crea el pedido recien cuando te diga que esta todo bien.';
    }

    const pedido = await prisma.$transaction(async (tx) => {
      const creado = await tx.pedido.create({
        data: {
          empresaId,
          clienteId: clienteFinal.id,
          conversacionId: conversacionId || null,
          total,
          tipoEntrega: clienteFinal.tipoEntrega,
          direccionEntrega: clienteFinal.tipoEntrega === 'RECOJO' ? null : clienteFinal.direccionEntrega,
          entregaLat: clienteFinal.tipoEntrega === 'RECOJO' ? null : clienteFinal.ubicacionLat,
          entregaLng: clienteFinal.tipoEntrega === 'RECOJO' ? null : clienteFinal.ubicacionLng,
          notas: clienteFinal.observaciones,
          formaPago: clienteFinal.formaPago,
          items: { create: items },
        },
      });
      for (const item of items) {
        if (item.varianteId) {
          await tx.variante.update({ where: { id: item.varianteId }, data: { stock: { decrement: item.cantidad } } });
        } else {
          await tx.producto.update({ where: { id: item.productoId }, data: { stock: { decrement: item.cantidad } } });
        }
      }
      await tx.clienteFinal.update({
        where: { id: clienteFinal.id },
        data: {
          estadoLead: 'PEDIDO_CREADO',
          estadoConversacion: 'PEDIDO_COMPLETADO',
          contexto: { ...(clienteFinal.contexto || {}), resumenConfirmado: null },
        },
      });
      return creado;
    });
    logEtapa('pedido_creado', telefonoCliente, {
      pedidoId: pedido.id, items: items.length, total, moneda,
      tipoEntrega: clienteFinal.tipoEntrega,
      selected_variant: items.map((i) => i.varianteId).filter(Boolean),
    });

    const resumen = items.map((i) => `${i.cantidad}x ${i.nombre}`).join(', ');

    // Retiro en tienda: se manda la ubicacion REAL que cargo el negocio.
    // Igual que con el QR, solo se puede afirmar que se mando si el envio
    // por WhatsApp devolvio exito de verdad.
    let avisoEntrega = '';
    if (clienteFinal.tipoEntrega === 'RECOJO' && config && config.direccionTienda) {
      const textoUbicacion = `📍 Nos encontrás en: ${config.direccionTienda}${config.tiendaLat && config.tiendaLng ? `\nhttps://www.google.com/maps?q=${config.tiendaLat},${config.tiendaLng}` : ''}`;
      if (conexion && conexion.estado === 'CONECTADO') {
        const envio = await wa.enviarTexto(conexion, telefonoCliente, textoUbicacion);
        avisoEntrega = envio.ok
          ? ` La ubicacion real de la tienda SI se le mando por WhatsApp (TOOL_SUCCESS): "${config.direccionTienda}".`
          : ' La ubicacion de la tienda NO se pudo mandar (fallo el envio): no le digas que se la mandaste, avisale que se la vas a pasar en un momento.';
      } else {
        avisoEntrega = ` [Modo de prueba] La direccion de la tienda es: ${config.direccionTienda}.`;
      }
    }

    // Si eligio QR, se manda la imagen real que subio el negocio (estatica,
    // no una pasarela de pago). Nunca se afirma que se mando si no hubo
    // TOOL_SUCCESS real: si falla o no hay imagen cargada, se le avisa tal
    // cual al modelo para que sea honesto con el cliente.
    let avisoQr = '';
    if (clienteFinal.formaPago === 'QR') {
      if (!config || !config.qrCobroUrl) {
        avisoQr = ' No se pudo mandar el QR porque la tienda todavia no cargo la imagen: avisale con naturalidad que un asesor se lo va a mandar.';
      } else if (conexion && conexion.estado === 'CONECTADO') {
        const envio = await wa.enviarImagen(conexion, telefonoCliente, config.qrCobroUrl, 'Este es el QR para el pago 📲');
        avisoQr = envio.ok
          ? ' El QR de pago SI se mando por WhatsApp (TOOL_SUCCESS): podes decirle que te fijes que lo recibio.'
          : ' El QR de pago NO se pudo mandar (fallo el envio): no le digas que se lo mandaste, avisale que un asesor se lo va a mandar.';
      } else if (fotosParaMostrar) {
        fotosParaMostrar.push({ url: config.qrCobroUrl, caption: 'QR de pago' });
        avisoQr = ' [Modo de prueba] El QR de pago se muestra como imagen en el chat de prueba.';
      }
    }

    return `TOOL_SUCCESS: pedido #${pedido.id} creado con: ${resumen}. Total ${formatearPrecio(total, moneda)}.${avisoEntrega}${avisoQr} Tu texto ahora: confirma el pedido al cliente con calidez, y explica que un asesor coordinara ${clienteFinal.tipoEntrega === 'RECOJO' ? 'el retiro' : 'la entrega'}. Si tiene dudas de pago, ofrece derivar_a_asesor.`;
  }

  if (toolCall.name === 'mostrar_categorias') {
    // La lista la arma el sistema con lo que existe DE VERDAD y tiene stock.
    // Antes esto mandaba un link al catalogo web: el cliente tenia que salir
    // de WhatsApp, abrir una pagina y volver. Ahora la conversacion no se
    // interrumpe.
    const arbol = arbolDeCategorias(contexto);
    if (!arbol.length) {
      return 'No hay ningun producto con stock en este momento (TOOL_FAILED). Decilo con transparencia y ofrece derivar_a_asesor para avisarle cuando haya reposicion.';
    }

    // Si el cliente ya eligio un rubro, el menu baja un nivel: se le muestran
    // los tipos de ESE rubro, no los rubros otra vez.
    const categoriaActual = categoriaDelLead(contexto, leadActual || {});
    const rubroElegido = categoriaActual
      ? arbol.find((r) => r.id === categoriaActual.id || r.subcategorias.some((s) => s.id === categoriaActual.id))
      : null;

    if (rubroElegido && rubroElegido.subcategorias.length && !rubroElegido.subcategorias.some((s) => s.id === categoriaActual.id)) {
      const lista = rubroElegido.subcategorias.map((s, i) => `${i + 1}. ${s.nombre}`).join('\n');
      logEtapa('menu_subcategorias', telefonoCliente, { rubro: rubroElegido.nombre, opciones: rubroElegido.subcategorias.length });
      return `TOOL_SUCCESS. Dentro de "${rubroElegido.nombre}" hay estos tipos (son los reales con stock, no inventes otros ni los renombres):\n${lista}\n\nTu texto ahora: pasale esta lista tal cual, numerada, una por linea, y preguntale cual quiere ver. Nada de descripciones ni de mandar productos todavia.`;
    }

    const lista = arbol.map((r, i) => `${i + 1}. ${r.nombre}`).join('\n');
    logEtapa('menu_rubros', telefonoCliente, { opciones: arbol.length });
    return `TOOL_SUCCESS. Esto es lo que vende la tienda (rubros reales con stock, no inventes otros ni los renombres):\n${lista}\n\nTu texto ahora: pasale esta lista tal cual, numerada, una por linea, y preguntale cual le interesa. NO mandes ningun link, NO describas los rubros y NO muestres productos todavia: primero que elija.`;
  }

  if (toolCall.name === 'derivar_a_asesor') {
    const ETIQUETAS_DERIVACION = {
      solicitud_expresa: 'Pidio hablar con una persona',
      cliente_molesto: 'Cliente molesto',
      pedido_mayorista: 'Posible pedido mayorista',
      compra_alto_valor: 'Compra de alto valor',
      negociacion_especial: 'Pide negociar precio',
      descuento_fuera_de_regla: 'Pide descuento fuera de lo normal',
      problema_no_resuelto: 'Problema sin resolver',
      condicion_comercial_especial: 'Condicion comercial especial',
      cliente_empresarial: 'Cliente empresarial',
    };
    const etiqueta = ETIQUETAS_DERIVACION[args.tipo] || 'Solicitud de asesor';
    await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: { estadoLead: 'DERIVADO_A_ASESOR' } });
    await prisma.notificacion.create({
      data: {
        empresaId,
        titulo: `${etiqueta}`,
        mensaje: `El cliente ${clienteFinal.nombre || telefonoCliente}${args.motivo ? `: ${args.motivo}` : ' necesita atencion de un asesor.'}`,
        tipo: 'MANUAL',
      },
    });
    logEtapa('derivacion', telefonoCliente, { tipo: args.tipo || null });
    return 'Perfecto, voy a derivarte con un asesor para que pueda ayudarte con mas detalle. Por favor espera unos momentos.';
  }

  return null;
}

/**
 * Genera la respuesta del agente para un mensaje del cliente, ejecutando el
 * loop completo de function-calling (hasta 3 vueltas): el modelo llama
 * tools, el sistema las ejecuta de verdad (actualiza el cliente, manda fotos
 * reales por WhatsApp, crea el pedido validando stock) y recien entonces el
 * modelo redacta el mensaje final.
 *
 * Si algo falla de verdad (no se pudo consultar el catalogo, o el proveedor
 * de IA no respondio), NUNCA se cae a una respuesta que "adivine"
 * disponibilidad: se devuelve un mensaje honesto de error tecnico. Eso es
 * distinto del modo demo (sin API key configurada), que es un modo de
 * prueba conocido, no una falla.
 *
 * @param {number} agenteId
 * @param {string} telefonoCliente
 * @param {Array<{rol:string, contenido:string}>} historial  mensajes previos (de Mensaje)
 * @param {string} mensajeCliente
 * @param {number} [conversacionId]
 * @param {{ llamarInyectado?: Function }} [opciones]  solo para tests: permite inyectar un "llamar" falso sin pegarle a un proveedor real.
 */
async function generarRespuesta(agenteId, telefonoCliente, historial, mensajeCliente, conversacionId, opciones = {}) {
  logEtapa('mensaje_recibido', telefonoCliente, { agenteId, mensaje: mensajeCliente.slice(0, 200), conversacionId });

  let agente;
  try {
    agente = await prisma.agente.findUnique({
      where: { id: agenteId },
      include: {
        config: true,
        conexion: true,
        empresa: {
          include: {
            suscripcion: { include: { plan: true } },
            productos: {
              where: { activo: true },
              orderBy: { nombre: 'asc' },
              take: 200,
              // "padre" trae el rubro al que pertenece la categoria del
              // producto: con eso se arma el menu de dos niveles sin una
              // consulta aparte (ver arbolDeCategorias en catalogo.js).
              include: { variantes: { where: { activa: true }, orderBy: { id: 'asc' } }, categoria: { include: { atributos: true, padre: true } } },
            },
          },
        },
      },
    });
  } catch (err) {
    logErrorEtapa('base_de_datos', telefonoCliente, err);
    return { ok: true, demo: false, error: true, proveedor: 'error', respuesta: respuestaErrorTecnico() };
  }
  if (!agente) return { ok: false, respuesta: 'Agente no encontrado.', demo: true, proveedor: 'demo' };

  const { empresa } = agente;
  const productos = empresa.productos;

  let clienteFinal;
  try {
    clienteFinal = await prisma.clienteFinal.upsert({
      where: { empresaId_telefono: { empresaId: empresa.id, telefono: telefonoCliente } },
      update: {},
      create: { empresaId: empresa.id, telefono: telefonoCliente },
    });
  } catch (err) {
    logErrorEtapa('base_de_datos', telefonoCliente, err);
    return { ok: true, demo: false, error: true, proveedor: 'error', respuesta: respuestaErrorTecnico() };
  }

  // Si el cliente respondio con un numero suelto ("2") a algo que el agente
  // ofrecio, se resuelve a que opcion real corresponde ANTES de extraer
  // filtros (si no, "2" no matchea contra ninguna categoria real).
  const ultimoAgente = [...historial].reverse().find((h) => h.rol === 'AGENTE');
  const opcionElegida = resolverSeleccionMenu(mensajeCliente, ultimoAgente && ultimoAgente.contenido);
  const textoParaExtraccion = opcionElegida || mensajeCliente;

  // Extraccion determinista por codigo: se aplica ANTES de armar el prompt,
  // sin depender de que el modelo llame a actualizar_datos_lead.
  const detectados = extraerFiltros(textoParaExtraccion, productos);
  let lead = clienteFinal;
  if (Object.keys(detectados).length) {
    // El cliente cambio de rubro y lo detecto el codigo (no la IA): hay que
    // soltar lo que era de la categoria vieja igual que en
    // actualizar_datos_lead, o el bot sigue empujando un producto que ya no
    // viene al caso.
    if (detectados.categoriaId && detectados.categoriaId !== clienteFinal.categoriaId) {
      Object.assign(detectados, limpiezaPorCambioDeCategoria(clienteFinal, productos, detectados.categoriaId));
    }
    try {
      lead = await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: detectados });
    } catch (err) {
      logErrorEtapa('memoria', telefonoCliente, err);
      return { ok: true, demo: false, error: true, proveedor: 'error', respuesta: respuestaErrorTecnico() };
    }
  }
  const categoriaActual = categoriaDelLead(productos, lead);
  const faltantesObligatorios = atributosFaltantes(categoriaActual, lead, 'OBLIGATORIO');
  logEtapa('atributos_detectados', telefonoCliente, {
    ...detectados,
    presupuesto: lead.presupuesto,
    marca: lead.marca,
    talla: lead.talla,
    purchase_stage: lead.estadoConversacion,
    missing_attributes: faltantesObligatorios,
  });

  const busquedaActual = faltantesObligatorios.length
    ? { resultados: [], total: 0, relajado: null }
    : buscarConFallback(productos, lead);
  const candidatosActuales = busquedaActual.resultados;
  logEtapa('busqueda_ejecutada', telefonoCliente, {
    categoria: lead.categoriaInteres || null,
    total_matches: busquedaActual.total,
    results_returned: paginar(candidatosActuales, (lead.contexto || {}).fotosEnviadas || []).pagina.length,
    filtro_relajado: busquedaActual.relajado,
    bloqueado_por_datos_faltantes: faltantesObligatorios.length > 0,
  });

  const previos = historial.map((m) => ({ role: m.rol === 'CLIENTE' ? 'user' : 'assistant', content: m.contenido }));
  // El historial ya incluye el mensaje actual del cliente (se persiste antes
  // de generar la respuesta), asi que "primer mensaje" NO es historial vacio:
  // es que el agente todavia nunca respondio nada en esta conversacion.
  const esPrimerMensaje = !historial.some((h) => h.rol === 'AGENTE');

  const proveedor = proveedorActivo();
  const plan = empresa.suscripcion && empresa.suscripcion.plan;
  const modelo = modeloParaPlan(proveedor, plan);
  const llamar = opciones.llamarInyectado || (proveedor === 'openai' ? llamarOpenAI : proveedor === 'anthropic' ? llamarAnthropic : null);

  if (!llamar) {
    logEtapa('modo_demo', telefonoCliente, { motivo: 'sin_api_key' });
    return { ok: true, demo: true, proveedor: 'demo', respuesta: respuestaDemo(empresa, productos, mensajeCliente) };
  }

  // Fotos que las tools van registrando en este turno para el modo de
  // prueba (sin WhatsApp real conectado), para que el chat de prueba las
  // pueda mostrar como imagenes de verdad.
  const fotosParaMostrar = [];
  // "turno" identifica este intercambio puntual: sirve para exigir que ciertas
  // confirmaciones (ej: aceptar ver alternativas con un filtro aflojado) pasen
  // por una respuesta REAL del cliente y no se resuelvan solas en la misma vuelta.
  const helpers = { empresaId: empresa.id, empresaSlug: empresa.slug, telefonoCliente, conexion: agente.conexion, fotosParaMostrar, conversacionId, baseUrl: opciones.baseUrl, config: agente.config, moneda: empresa.moneda || 'BOB', turno: historial.length };
  const mensajesTurno = [];
  const MAX_VUELTAS = 3;

  try {
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      // El prompt se rearma en cada vuelta con el lead recalculado.
      const leadActual = vuelta === 0 ? lead : await prisma.clienteFinal.findUnique({ where: { id: clienteFinal.id } });
      helpers.leadActual = leadActual;
      const esUltimaVuelta = vuelta === MAX_VUELTAS - 1;
      const system = construirSystem(empresa, productos, agente.config, leadActual, esUltimaVuelta, esPrimerMensaje, agente.nombre);

      const resp = await llamar({
        system,
        mensajes: [...previos, { role: 'user', content: mensajeCliente }, ...mensajesTurno],
        tools: esUltimaVuelta ? [] : TOOLS,
        modelo,
      });

      if (!resp.tool_calls?.length) {
        // FORZADO EN CODIGO (la regla de "TARJETAS SIEMPRE" en el prompt no
        // alcanza sola): si el modelo describio productos con precio en
        // texto plano en vez de llamar mostrar_productos, esa tarjeta nunca
        // se genero con datos reales - y si despues piden fotos de "el
        // primero", el modelo tiene que adivinar el ID (bug real: mando la
        // foto de un producto totalmente distinto). Se rechaza y se le pide
        // que corrija ANTES de mandarselo al cliente, mientras todavia
        // quedan vueltas para hacerlo bien.
        if (!esUltimaVuelta && candidatosActuales.length && pareceListadoDeProductosEnTexto(resp.content)) {
          logEtapa('texto_con_precios_rechazado', telefonoCliente, { vuelta });
          mensajesTurno.push({ role: 'assistant', content: resp.content });
          mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): acabas de describir productos con precio como texto plano - eso esta PROHIBIDO. Volve a responder ahora mismo llamando a mostrar_productos con los IDs reales del bloque de resultados de arriba, nunca describiendolos vos con texto.' });
          continue;
        }

        // FORZADO EN CODIGO: varias preguntas en un mismo mensaje. El prompt
        // ya lo prohibe, pero paso en produccion igual (el bot pidio marca,
        // ocasion y talla juntas en una lista con viñetas).
        if (!esUltimaVuelta && pareceInterrogatorio(resp.content)) {
          logEtapa('interrogatorio_rechazado', telefonoCliente, { vuelta });
          mensajesTurno.push({ role: 'assistant', content: resp.content });
          mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): mandaste mas de una pregunta en el mismo mensaje. Eso esta PROHIBIDO, parece un formulario. Volve a escribir el mensaje con UNA SOLA pregunta, la mas importante para poder avanzar; el resto se lo preguntas mas adelante si hace falta.' });
          continue;
        }

        // FORZADO EN CODIGO: prometer una busqueda en vez de mostrar. El turno
        // termina en ese mensaje, asi que el cliente queda esperando algo que
        // no va a llegar.
        if (!esUltimaVuelta && pareceAnuncioDeBusqueda(resp.content)) {
          logEtapa('anuncio_de_busqueda_rechazado', telefonoCliente, { vuelta });
          mensajesTurno.push({ role: 'assistant', content: resp.content });
          mensajesTurno.push({ role: 'user', content: `RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): dijiste que ibas a buscar algo, pero este mensaje es lo ultimo que el cliente recibe en este turno - se queda esperando de gusto. ${candidatosActuales.length ? 'Llama AHORA a mostrar_productos con los IDs del bloque de resultados y mostraselos de verdad.' : 'Todavia no podes mostrar productos: en vez de prometer una busqueda, hace la UNICA pregunta que te falta para poder buscar.'}` });
          continue;
        }
        logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false });
        return { ok: true, demo: false, proveedor, modelo, respuesta: resp.content || '...', fotos: fotosParaMostrar };
      }

      mensajesTurno.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.tool_calls });
      for (const toolCall of resp.tool_calls) {
        const resultado = await ejecutarFuncion(toolCall, productos, helpers);
        mensajesTurno.push({ role: 'tool', tool_call_id: toolCall.id, content: resultado || 'Hecho.' });
      }
    }
    logEtapa('respuesta_enviada', telefonoCliente, { vuelta: MAX_VUELTAS, agotoVueltas: true });
    return { ok: true, demo: false, proveedor, modelo, respuesta: 'Un momento, ya te ayudo con eso.', fotos: fotosParaMostrar };
  } catch (err) {
    // Falla real del proveedor de IA (o de una tool durante el loop): NUNCA
    // se usa respuestaDemo() aca, porque esa funcion hace matching simple de
    // texto y podria "afirmar" disponibilidad sin haber consultado el
    // catalogo de verdad para esta conversacion puntual. Mejor ser honesto.
    logErrorEtapa(proveedor === 'openai' || proveedor === 'anthropic' ? 'proveedor_ia' : 'generacion', telefonoCliente, err);
    return { ok: true, demo: false, error: true, proveedor: 'error', respuesta: respuestaErrorTecnico() };
  }
}

// ============================ Percepcion multimodal ============================
// El cliente puede escribir, pero tambien mandar una foto de un producto que
// vio en otro lado ("¿tienen esto?"), un audio (mucha gente prefiere hablar
// antes que tipear), o su ubicacion para la entrega. En vez de duplicar todo
// el motor de ventas por cada tipo de mensaje, estas funciones convierten
// cualquier adjunto a TEXTO natural (una descripcion, una transcripcion), y
// ese texto entra por la MISMA puerta que un mensaje escrito: extraerFiltros,
// el loop de tools y las reglas anti-invento no cambian ni se duplican.

// Analiza una foto que mando el cliente y trata de reconocer si corresponde
// a un producto real del catalogo (para que el vendedor pueda reaccionar con
// criterio: "si, eso es la zapatilla X" en vez de ignorar la imagen).
async function analizarImagenProducto(buffer, mimeType, productos) {
  const proveedor = proveedorActivo();
  if (proveedor === 'demo') return null;

  const listado = productos.length
    ? productos.map((p) => `${p.nombre} (categoria: ${p.categoria?.nombre || 'General'})`).join(', ')
    : '(el catalogo esta vacio)';
  const instruccion = `Un cliente de una tienda envio esta foto por WhatsApp, probablemente preguntando por un producto. El catalogo REAL de la tienda tiene estos productos: ${listado}.
Mira la imagen y en 1-2 frases breves (en español) describe que se ve. Si se parece con claridad a alguno de esos productos EXACTOS, decilo por su nombre exacto tal como esta arriba. Si no se parece a ninguno, decí simplemente que no coincide con el catalogo. No fuerces una coincidencia si no es real.`;
  const media = mimeType || 'image/jpeg';
  const base64 = buffer.toString('base64');

  try {
    if (proveedor === 'openai') {
      const openai = getOpenAI();
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: instruccion },
            { type: 'image_url', image_url: { url: `data:${media};base64,${base64}` } },
          ],
        }],
      });
      return resp.choices[0].message.content?.trim() || null;
    }
    if (proveedor === 'anthropic') {
      const anthropic = getAnthropic();
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media, data: base64 } },
            { type: 'text', text: instruccion },
          ],
        }],
      });
      return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || null;
    }
  } catch (err) {
    console.error('Error analizando imagen del cliente:', err.message);
  }
  return null;
}

// Transcribe un audio/nota de voz que mando el cliente. Solo disponible via
// Whisper (OpenAI); si la plataforma esta configurada solo con Anthropic (que
// no ofrece transcripcion de audio), devuelve null y el llamador debe
// degradar con gracia (pedirle al cliente que lo escriba).
async function transcribirAudio(buffer, mimeType) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const { toFile } = require('openai');
    const openai = getOpenAI();
    const extension = /ogg/.test(mimeType || '') ? 'ogg' : /mp4|m4a/.test(mimeType || '') ? 'm4a' : 'mp3';
    const archivo = await toFile(buffer, `audio.${extension}`);
    const resp = await openai.audio.transcriptions.create({ file: archivo, model: 'whisper-1', language: 'es' });
    return resp.text?.trim() || null;
  } catch (err) {
    console.error('Error transcribiendo audio del cliente:', err.message);
    return null;
  }
}

// Respuesta basica sin IA: busca coincidencias simples en el catalogo.
function respuestaDemo(empresa, productos, mensaje) {
  const marca = empresa.marca || empresa.nombre;
  const moneda = empresa.moneda || 'BOB';
  const texto = String(mensaje).toLowerCase();

  const encontrados = productos.filter((p) =>
    texto.split(/\s+/).some((w) => w.length > 3 && p.nombre.toLowerCase().includes(w.replace(/[^a-z0-9]/gi, '')))
  );

  if (encontrados.length) {
    const lista = encontrados.slice(0, 3).map((p) => `• ${p.nombre}: ${Number(p.precio).toFixed(2)}`).join('\n');
    return `¡Hola! En ${marca} tenemos:\n${lista}\n¿Te gustaría hacer un pedido?`;
  }
  if (/hola|buenas|buenos/.test(texto)) {
    return `¡Hola! Bienvenido a ${marca}. ¿Qué producto estás buscando hoy?`;
  }
  if (/precio|costo|cuanto|cuánto/.test(texto) && productos.length) {
    const lista = productos.slice(0, 3).map((p) => `• ${p.nombre}: ${Number(p.precio).toFixed(2)}`).join('\n');
    return `Estos son algunos de nuestros precios:\n${lista}`;
  }
  return `¡Gracias por escribir a ${marca}! Cuéntame qué producto te interesa y te ayudo. (Respuesta de demostración — configura OPENAI_API_KEY o ANTHROPIC_API_KEY para activar la IA real.)`;
}

module.exports = {
  generarRespuesta, construirSystem, proveedorActivo, analizarImagenProducto, transcribirAudio,
  // Exportado para tests de regresion (unidades deterministas, sin llamar a ningun proveedor de IA).
  // buscarProductosFiltrados y compañia viven en catalogo.js; se reexportan
  // aca porque son parte de la superficie que los tests del motor ya usaban.
  buscarProductosFiltrados, productosCandidatosAMostrar, extraerFiltros, resolverSeleccionMenu,
  respuestaErrorTecnico, seccionProductos, fichaProducto, atributosFaltantes, filtrosCompletos,
  formatearPrecio, avisosDeFoto, resultadoDeEnvio, limpiezaPorCambioDeCategoria,
  datosDeActualizacionDeLead, pareceInterrogatorio, pareceAnuncioDeBusqueda,
};
