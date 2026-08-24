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
  carritoDe, guardarCarrito, contextoSinCarrito,
  agregarItem, quitarItem, resumenCarrito, itemsParaPedido,
} = require('./carrito');
const { generarTokenSesion } = require('./sesionWeb');
const { resolverCoordenadas } = require('./ubicacion');
const { buscarPorSimilitud } = require('./embeddings');
const {
  palabrasClave, coincideTexto, normalizarSimple, tokensDeLista, compararTallas,
  parsePrecio, estadoPresupuesto, rangoPresupuesto, interpretarPresupuesto, valoresEquivalentes,
  textoCompletoProducto, coincideAtributo, valorDeAtributo,
  scoreProducto, tieneStock, buscarPorNombre,
  buscarProductosFiltrados, buscarConFallback, paginar, fotoParaMostrar,
  arbolDeCategorias, subcategoriasDe, opcionesDisponibles, resumenCategoria,
  valoresRealesDeAtributo, resolverValorDeAtributo, expresaSinPreferencia,
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

// Si el cliente se fue y vuelve despues de este rato, la conversacion arranca
// "fresca" en lo que se le mostro: el bot vuelve a mandarle las tarjetas y las
// fotos si se las pide, en vez de contestarle "ya te las mostre antes" (que a
// esa altura el cliente ya no tiene a mano y suena a que lo estan corriendo).
// Solo se olvida lo MOSTRADO: lo que dijo -categoria, talla, color, nombre,
// direccion- se conserva, que es la memoria util.
const MINUTOS_PARA_REINICIAR_VISTOS = Number(process.env.MINUTOS_REINICIO_VISTOS || 10);

/**
 * Si paso el tiempo de inactividad, devuelve el contexto sin la memoria de lo
 * ya mostrado. Si no, devuelve null (no hay nada que reiniciar).
 */
function contextoReiniciadoPorInactividad(contextoActual = {}, ahora = Date.now()) {
  const ultimo = contextoActual.ultimoTurnoAt ? new Date(contextoActual.ultimoTurnoAt).getTime() : null;
  if (!ultimo) return null;
  if (ahora - ultimo < MINUTOS_PARA_REINICIAR_VISTOS * 60 * 1000) return null;
  return {
    ...contextoActual,
    fotosEnviadas: [],
    urlsFotosEnviadas: [],
    relajadoPreguntado: null,
    ultimoTurnoAt: new Date(ahora).toISOString(),
  };
}

// Ademas de "lo mostrado" (arriba, que se olvida rapido), si paso MUCHO mas
// tiempo sin escribir tambien se olvida lo que el cliente dijo que buscaba
// -categoria, talla, color, marca, presupuesto, favorito-: se lo trata como
// una charla de compra nueva. Nombre y direccion NO se tocan: son datos de
// identidad/logistica que siguen sirviendo si vuelve a comprar mas adelante.
//
// Bug real reportado: un cliente volvia horas despues con una intencion
// nueva ("que modelos o colores tienes?") y el bot le seguia aplicando un
// filtro de talla/color de una prueba de la madrugada anterior - hasta
// armaba tarjetas con texto tipo "lo que buscabas (talla 9,10 en crema)",
// algo que ese dia ni habia mencionado.
const MINUTOS_PARA_REINICIAR_INTENCION = Number(process.env.MINUTOS_REINICIO_INTENCION || 300);

function intencionReiniciadaPorInactividad(clienteFinal, ahora = Date.now()) {
  const contextoActual = clienteFinal.contexto || {};
  const ultimo = contextoActual.ultimoTurnoAt ? new Date(contextoActual.ultimoTurnoAt).getTime() : null;
  if (!ultimo) return null;
  if (ahora - ultimo < MINUTOS_PARA_REINICIAR_INTENCION * 60 * 1000) return null;
  return {
    categoriaInteres: null,
    categoriaId: null,
    talla: null,
    color: null,
    marca: null,
    presupuesto: null,
    productoFavoritoId: null,
    varianteFavoritaId: null,
    productosDescartados: [],
    productosMostrados: [],
  };
}

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

// El modelo mas barato de cada proveedor: se usa en turnos "simples" (ver
// esTurnoSimple mas abajo) independientemente del plan, para no pagar el
// modelo caro cuando todavia no hay nada de catalogo real en juego.
const MODELO_ECONOMICO = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

function modeloEconomico(proveedor) {
  return MODELO_ECONOMICO[proveedor] || MODELO_ECONOMICO.openai;
}

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
      name: 'buscar_producto',
      description: 'Busca un producto POR NOMBRE en todo el catalogo cuando el cliente lo nombra ("¿tenes las Tekkira Cup?", "y la Superstar?"). Usala SIEMPRE antes de decirle que no lo tenes: el bloque de resultados de arriba esta filtrado por lo que venia pidiendo, asi que algo puede existir aunque no aparezca ahi. Si lo encuentra, mostraselo con mostrar_productos.',
      parameters: {
        type: 'object',
        properties: { nombre: { type: 'string', description: 'El nombre tal como lo nombro el cliente. Puede ser parcial ("tekkira" encuentra "ZAPATILLAS TEKKIRA CUP").' } },
        required: ['nombre'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agregar_al_carrito',
      description: 'Agrega al carrito lo que el cliente eligio de una tarjeta ("me interesa la Ginger Tav en blanco talla 9"). El sistema valida el stock. Despues de agregar, preguntale si desea ver algo mas: si dice que si, volves al menu de categorias; si dice que no, cerras la venta.',
      parameters: {
        type: 'object',
        properties: {
          idProducto: { type: 'integer', description: 'ID exacto del producto que eligio, de los que le mostraste en tarjeta.' },
          idVariante: { type: 'integer', description: 'ID EXACTO de la variante (talla+color) que eligio. Obligatorio si el producto tiene variantes: el cliente ya las vio en la tarjeta.' },
          cantidad: { type: 'integer', description: 'Cuantas unidades. Si no lo dijo, 1.' },
        },
        required: ['idProducto'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_carrito',
      description: 'Muestra lo que el cliente lleva agregado hasta ahora, con el total real. Usala si pregunta que lleva, o antes de cerrar.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quitar_del_carrito',
      description: 'Saca un producto del carrito cuando el cliente se arrepiente ("sacame las negras").',
      parameters: {
        type: 'object',
        properties: {
          idProducto: { type: 'integer' },
          idVariante: { type: 'integer', description: 'Si agrego varias variantes del mismo producto, cual sacar.' },
        },
        required: ['idProducto'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_pedido',
      description: 'Arma el resumen exacto del pedido (productos, variante, cantidad, precios reales, total, entrega y forma de pago) para leerselo al cliente ANTES de crear nada. Usa SIEMPRE lo que el cliente tiene en el carrito real - no le pases una lista de productos, el sistema ya sabe que hay. Es obligatorio llamarla antes de crear_pedido: el sistema no deja crear un pedido que el cliente no confirmo. Si falta algun dato, te dice cual pedir.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crear_pedido',
      description: 'Crea el pedido DESPUES de que el cliente dijo que si al resumen que le leiste con confirmar_pedido. Usa SIEMPRE lo que el cliente tiene en el carrito real (el mismo que uso confirmar_pedido) - no le pases una lista de productos. Requiere nombre, tipo de entrega (y direccion si es a domicilio) y forma de pago ya guardados via actualizar_datos_lead. El sistema revalida stock y precio antes de confirmar. Registra la forma de pago elegida pero no procesa ningun cobro: eso lo coordina un asesor humano por fuera del bot.',
      parameters: { type: 'object', properties: {} },
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
  {
    type: 'function',
    function: {
      name: 'mostrar_tarjeta_categoria',
      description: "Presenta una categoria puntual la PRIMERA vez que el cliente la nombra o elige (ej. 'estoy buscando zapatillas deportivas', o elige 'Zapatillas' del menu). Manda una tarjeta con foto real de la categoria, cuantos modelos hay, desde que precio, 1-2 modelos destacados, y un link para ver todos. Llamala UNA sola vez por categoria, ANTES de mostrar productos individuales con mostrar_productos - despues, si el cliente pide ver modelos especificos, segui normal con mostrar_productos. No la llames si ya se la mostraste antes en esta conversacion para esa misma categoria.",
      parameters: { type: 'object', properties: {} },
    },
  },
];

function toolsParaAnthropic(tools) {
  const convertidas = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
  // Las tools nunca cambian entre llamadas: marcar la ultima como punto de
  // corte de cache le dice a Anthropic que todo el bloque (fijo) es
  // reutilizable, no solo el system prompt.
  if (convertidas.length) convertidas[convertidas.length - 1].cache_control = { type: 'ephemeral' };
  return convertidas;
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
function extraerFiltros(texto, productos = [], categoriaActualId = null) {
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
      // Este fallback es DEBIL: matchea contra el nombre suelto de UN
      // producto cualquiera del catalogo entero, no contra la categoria en
      // si. Si el cliente ya esta parado en una categoria, una sola palabra
      // generica en comun (ej. "modelo") no alcanza para sacarlo de ahi y
      // mandarlo a una categoria sin ninguna relacion real - bug real: "fotos
      // del segundo modelo" saltaba a otra categoria del catalogo por esa
      // palabra sola, y el bot perdia de vista lo que se estaba mostrando.
      // Para SALIR de la categoria actual por esta via debil hace falta mas
      // de una palabra en comun; para entrar a una categoria nueva (todavia
      // no hay ninguna elegida) con una sola alcanza, como antes.
      const minimoNecesario = (categoriaActualId && p.categoria.id !== categoriaActualId) ? 2 : 1;
      if (presentes >= minimoNecesario && presentes > mejorPuntaje) {
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

  // Forma de pago y tipo de entrega: el cliente muchas veces contesta con
  // UNA sola palabra ("QR", "domicilio") y el modelo no siempre se acuerda
  // de guardarla con actualizar_datos_lead antes de seguir - bug real
  // reportado: confirmar_pedido volvia a pedir la forma de pago que el
  // cliente ya habia dicho un mensaje antes. Se detecta aca, en codigo,
  // igual que categoria/talla, asi no depende de que el modelo se acuerde.
  if (/\bqr\b/.test(norm)) cambios.formaPago = 'QR';
  else if (/\befectivo\b/.test(norm)) cambios.formaPago = 'EFECTIVO';
  else if (/\btarjeta\b/.test(norm)) cambios.formaPago = 'TARJETA';

  if (/\b(domicilio|delivery)\b/.test(norm)) cambios.tipoEntrega = 'DOMICILIO';
  else if (/\b(recojo|recoger|retiro|retirar)\b/.test(norm)) cambios.tipoEntrega = 'RECOJO';

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

/**
 * Le dice al modelo QUE VALORES existen de verdad, para que cuando pregunte por
 * un atributo ofrezca opciones concretas en vez de preguntar al aire.
 *
 * Sin esto el bot preguntaba "¿que color preferis?" sin haber mostrado ningun
 * color, y si el cliente contestaba "no se cuales tenes" se lo devolvia como
 * pregunta (caso real reportado por el dueño).
 */
function bloqueDeOpciones(productos, soloEstos = null) {
  const opciones = opcionesDisponibles(productos);
  const nombres = soloEstos && soloEstos.length
    ? Object.keys(opciones).filter((n) => soloEstos.some((s) => normalizarSimple(s) === normalizarSimple(n)))
    : Object.keys(opciones);
  if (!nombres.length) return '';
  const lineas = nombres.map((n) => `- ${n}: ${opciones[n].join(', ')}`).join('\n');
  return `
VALORES REALES DISPONIBLES (con stock, salen del catalogo - son los UNICOS que podes nombrar):
${lineas}
PARA QUE SIRVE ESTA LISTA: para RESPONDER cuando el cliente pregunta que colores o tallas hay, y para afinar DESPUES de haberle mostrado productos. NO es un cuestionario para completar antes de mostrar.
Si tenes productos en el bloque de resultados, mostraselos PRIMERO y despues, si hace falta, usa estos valores para ajustar. Preguntarle el color antes de que haya visto una sola foto lo hace abandonar.
Cuando SI corresponda preguntar, ofrece estas opciones concretas ("¿lo queres en negro, blanco o gris?"), nunca al aire.
`;
}

// Texto que le explica al modelo que filtro hubo que aflojar para encontrar
// algo. Nunca se afloja en silencio: el cliente tiene que enterarse y decidir.
const NOMBRE_FILTRO_RELAJADO = {
  color: 'el color',
  marca: 'la marca',
  presupuesto: 'el presupuesto',
  talla: 'la talla',
};

function seccionProductos(productos, lead = {}, categoria = null, moneda = 'BOB', config = null, yaEligioOCerrando = false, pidioProductoPuntual = false) {
  // Cliente ya en cierre (algo en el carrito o estadoConversacion ya en
  // ESTADOS_DE_CIERRE) pero SIN un favorito puntual - por ejemplo, se le
  // limpio productoFavoritoId porque nombro una categoria nueva a mitad del
  // cierre (ver limpiezaPorCambioDeCategoria). Bug real: sin este corte, los
  // gates de abajo (atributos obligatorios, rubro dividido, etc.) se
  // disparaban de nuevo y el bot volvia a preguntar genero/talla con el
  // cliente a punto de pagar. El caso CON productoFavoritoId ya tiene su
  // propio bloque cierre-seguro mas abajo, no hace falta duplicarlo aca.
  if (yaEligioOCerrando && !lead.productoFavoritoId) {
    return 'El cliente ya tiene algo en el carrito y esta en etapa de cierre: NO le muestres productos nuevos ni le preguntes atributos de categoria (genero, talla, marca, etc.) salvo que el mismo pida explicitamente ver algo distinto. Segui el cierre: si falta nombre, ubicacion o forma de pago, pedile UNA sola cosa; si ya tenes todo, llama a confirmar_pedido.';
  }

  // GATE INICIAL: antes que nada, lo que la tienda marco como imprescindible
  // para todo el catalogo (ej. genero). Va primero incluso que el menu de
  // rubros: no tiene sentido ofrecerle vestidos a un hombre.
  const inicialesFaltantes = preguntasInicialesFaltantes(config, lead, productos);
  if (inicialesFaltantes.length) {
    // Se le pasan los valores REALES para que la pregunta sea cerrada
    // ("¿hombre o mujer?") y la respuesta se pueda resolver en codigo. Con la
    // pregunta abierta el modelo improvisaba cosas como "¿es para vos o para
    // regalar?", cuya respuesta ("para mi") no contesta nada, y el gate no se
    // destrababa nunca.
    const opciones = valoresRealesDeAtributo(productos, inicialesFaltantes[0]);
    return `TODAVIA NO PODES MOSTRAR PRODUCTOS (el menu de categorias SI se puede mostrar, mostrar_categorias no depende de esto): esta tienda necesita saber primero ${inicialesFaltantes.join(' y ')}.
En ESTE mensaje preguntá UNA sola cosa: "${inicialesFaltantes[0]}"${inicialesFaltantes.length > 1 ? ' (lo que falte se lo preguntas despues, de a uno)' : ''}.${opciones.length ? `
LAS UNICAS OPCIONES REALES SON: ${opciones.join(', ')}. Preguntá NOMBRANDOLAS ("¿lo buscas de ${opciones.slice(0, 2).join(' o de ')}?"), nunca con una pregunta abierta: si el cliente contesta cualquier otra cosa, no sirve y le vas a tener que volver a preguntar.` : ''}
Hacelo natural, como lo diria un vendedor, NUNCA como un formulario.
Si el cliente YA te contesto esto en el mensaje anterior, NO se lo vuelvas a preguntar con otras palabras: guardalo tal cual te lo dijo con actualizar_datos_lead (en atributosCategoria si no es talla/color/marca) y segui. Recien cuando lo sepas se te habilita el catalogo.`;
  }

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

  // GATE: falta informacion obligatoria de esta categoria (funciona igual de
  // bien sobre un rubro que sobre una subcategoria hoja - solo depende de que
  // CategoriaAtributo tenga cargados esa categoria puntual). Va ANTES del
  // gate de subcategorias de mas abajo a proposito: si el rubro necesita
  // saber genero, hay que preguntarlo antes de mostrarle los tipos, no
  // despues - la lista de tipos ya sale filtrada por ese dato una vez que se
  // sabe (subcategoriasDe ya filtra con coincideAtributosLead). Bug real
  // reportado: con el orden viejo, un rubro con subcategorias Y un atributo
  // obligatorio propio nunca llegaba a preguntar el atributo - siempre
  // mostraba la lista de tipos sin filtrar, y despues improvisaba una
  // pregunta generica y abierta en vez de la cerrada que corresponde. No se
  // le pasa ningun producto al modelo todavia - si los ve, los muestra igual
  // (paso en produccion), asi que la unica forma confiable de que primero
  // pregunte es que el bloque de resultados no exista.
  const faltantes = atributosFaltantes(categoria, lead, 'OBLIGATORIO');
  if (faltantes.length) {
    // Los productos de esta categoria, para poder decirle QUE opciones reales
    // hay del dato que falta ("¿que talla usas?" -> "tenemos 38 al 44").
    const deLaCategoria = productos.filter((p) => p.categoria?.id === categoria?.id);
    return `TODAVIA NO PODES MOSTRAR PRODUCTOS de "${lead.categoriaInteres}": falta saber ${faltantes.join(' y ')}. Esta tienda marco eso como imprescindible para recomendar bien en esta categoria.
En ESTE mensaje preguntá UNA sola cosa: "${faltantes[0]}". Nada de listas con viñetas ni dos preguntas juntas${faltantes.length > 1 ? ' (lo que falte se lo preguntas en el mensaje siguiente)' : ''}. Guardalo con actualizar_datos_lead.
${bloqueDeOpciones(deLaCategoria, faltantes)}
No hay bloque de resultados en este turno a proposito: no menciones ningun producto, no digas que "tenemos varias opciones", y no digas que vas a buscar. Tampoco digas que "no hay" (si hay, todavia no sabes cual le sirve).`;
  }

  // GATE DE RUBRO: el cliente nombro un rubro que se divide en tipos
  // ("quiero pantalones" cuando el rubro es "Prendas de abajo"). Mostrarle los
  // 35 productos del rubro entero no le sirve: primero elige el tipo. Igual
  // que con los atributos obligatorios, no se le pasa ningun producto al
  // modelo, porque si los ve los muestra.
  if (categoria && !categoria.padreId) {
    const subcategorias = subcategoriasDe(productos, categoria.id, lead);
    if (subcategorias.length) {
      const lista = subcategorias.map((s, i) => `${i + 1}. ${s.nombre}`).join('\n');
      return `El cliente esta en el rubro "${categoria.nombre}", que se divide en estos tipos (reales, con stock):\n${lista}\n\nTODAVIA NO le muestres productos: son ${subcategorias.reduce((n, s) => n + s.productos, 0)} en todo el rubro y mostrarlos asi no le sirve. Pasale la lista tal cual, numerada, una por linea, y preguntale cual quiere ver. Cuando elija uno, ahi si aparecen los productos de ese tipo.`;
    }
  }

  const { resultados, relajado, adicionales = [] } = buscarConFallback(productos, lead);

  // Panorama de la categoria, para que el modelo NUNCA diga "es el unico que
  // tenemos" cuando en realidad hay mas y quedaron afuera por un filtro o por
  // falta de stock. Paso en produccion: el negocio tenia 4 zapatillas
  // cargadas y el bot le juraba al cliente que solo existia una.
  const deLaCategoria = categoria
    ? productos.filter((p) => p.categoria?.id === categoria.id || p.categoria?.padre?.id === categoria.id)
    : [];
  const sinStock = deLaCategoria.filter((p) => !tieneStock(p));
  const fueraPorFiltro = deLaCategoria.length - sinStock.length - resultados.length;
  const panorama = deLaCategoria.length
    ? `\nPANORAMA REAL de "${categoria.nombre}": ${deLaCategoria.length} producto(s) cargado(s) en total; ${deLaCategoria.length - sinStock.length} con stock; ${resultados.length} calzan con lo que pidio este cliente.${sinStock.length ? ` ${sinStock.length} esta(n) sin stock: NO los ofrezcas.` : ''}${fueraPorFiltro > 0 ? ` ${fueraPorFiltro} quedaron afuera por lo que el cliente pidio (ej. otro genero): existen, pero no le sirven a el.` : ''}
PROHIBIDO decir "es el unico modelo que tenemos" o "solo tenemos eso en inventario": lo correcto es acotarlo a lo que EL busca ("de hombre tengo estos ${resultados.length}"). Decir que el inventario entero es uno solo cuando hay ${deLaCategoria.length} cargados es mentirle al cliente.\n`
    : '';

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

  // REGLA DEL NEGOCIO: sin un producto puntual nombrado por el cliente, nunca
  // se muestran tarjetas de productos individuales - se fuerza la tarjeta de
  // categoria (foto real, cantidad de modelos, precio desde, link al
  // catalogo filtrado), que ya existe y hace exactamente eso. Pedido directo
  // del dueño del negocio: las tarjetas sueltas quedan reservadas para
  // busquedas puntuales ("tenes la Park St 2.0?"), nunca para "mostrame lo
  // que tenes" o elegir una categoria generica.
  if (!pidioProductoPuntual) {
    const yaMostroTarjeta = ((lead.contexto || {}).tarjetasCategoriaMostradas || []).includes(categoria?.id);
    const nombreCategoria = categoria ? categoria.nombre : lead.categoriaInteres;
    if (!yaMostroTarjeta) {
      return `El cliente todavia no nombro un producto puntual por su nombre - no le muestres tarjetas de productos individuales.${panorama}
Llama AHORA a mostrar_tarjeta_categoria: le manda una tarjeta real de "${nombreCategoria}" con foto, cantidad de modelos, precio desde, y un link al catalogo filtrado. Es la unica forma de mostrar algo en este punto.`;
    }
    return `Ya le mostraste la tarjeta de "${nombreCategoria}" antes en esta conversacion. NO muestres tarjetas de productos individuales todavia: preguntale, por su nombre, cual modelo puntual le interesa (podes mencionar 1-2 nombres reales de esta lista como ejemplo, en texto, nunca con tarjeta):\n${formatearProductos(pagina.length ? pagina : resultados, moneda)}
Recien cuando diga un nombre puntual se habilita mostrarle esa tarjeta.`;
  }

  if (!pagina.length) {
    // Ya vio TODOS los resultados reales de esta busqueda. Antes el bot decia
    // "esas son todas" sin saberlo; ahora lo sabe de verdad porque el total
    // lo calcula el backend.
    return `Resultados de la busqueda (los mismos de antes, YA SE LOS MOSTRASTE a este cliente en esta conversacion - mira el historial, ya tienen tarjeta con foto):\n${formatearProductos(resultados, moneda)}\n\ntotal_matches = ${total}, ya vistos = ${yaVistos}, quedan por mostrar = 0.
${panorama}${adicionales.length
  ? `OJO, SI HAY MAS PRODUCTOS que este cliente todavia no vio. No calzan exacto con lo que venia pidiendo (difieren en color, talla o precio), pero existen y tienen stock:
${formatearProductos(adicionales.slice(0, RESULTADOS_POR_PAGINA), moneda)}
Si dice "no quiero esas", "mostrame otras" o "que mas tenes", PROHIBIDO contestarle que no hay mas: tenes ${adicionales.length} opcion(es) para ofrecerle. Contale que hay otras aunque no sean exactamente lo que pidio y preguntale si quiere verlas; cuando diga que si, llama a mostrar_productos con esos IDs.`
  : `Estas son TODAS las opciones reales que hay para lo que pidio. Si pregunta que mas tenes, podes decirle con seguridad que no quedan otras, y ofrecerle ajustar algo (otra talla, otro color, otra categoria).`}
Si quiere volver a ver una tarjeta que ya vio, mandasela de nuevo sin problema. PROHIBIDO insistir para que compre: nada de "¿alguna te convencio?", "¿cual te gusto?", "¿hacemos el pedido?". Ya vio las opciones; si quiere avanzar lo va a decir el.`;
  }

  return `Resultados de la busqueda (ya filtrados por categoria, genero, talla y presupuesto pedidos, son los UNICOS productos reales que puedes mencionar, NUNCA inventes otros):\n${formatearProductos(pagina, moneda)}
${bloqueDeOpciones(resultados)}${panorama}
total_matches = ${total} (los que calzan con lo que pidio ESTE cliente), ya vistos por el cliente = ${yaVistos}, en este bloque = ${pagina.length}, quedan sin mostrar = ${restantes}.
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
 * ¿El texto nombra un producto del catalogo? Se compara contra los nombres
 * reales de los candidatos, normalizados, para no depender de que el modelo
 * escriba exactamente igual.
 */
function nombraUnProductoReal(texto, candidatos = []) {
  if (!texto) return null;
  const t = normalizarSimple(texto);
  for (const p of candidatos) {
    const nombre = normalizarSimple(p.nombre);
    if (nombre.length > 5 && t.includes(nombre)) return p.nombre;
  }
  return null;
}

/**
 * Detecta que el modelo esta pidiendo una preferencia (color, talla, marca,
 * presupuesto) en vez de mostrar lo que ya tiene listo para mostrar.
 *
 * El dueño fue explicito: primero se muestra, despues se afina. Un cliente que
 * todavia no vio una foto y ya tiene que contestar de que color la quiere,
 * abandona.
 */
function pidePreferenciaSinMostrar(texto) {
  if (!texto || !texto.includes('?')) return false;
  const t = normalizarSimple(texto);
  const atributo = '(color|talla|tamano|numero|marca|presupuesto)';
  const pedir = '(prefier|prefer|busca|quer|gusta|usas|necesit|interesa|estas)';
  // "¿que color?" / "en que color las buscas" / "que talla usas" y tambien el
  // orden invertido: "necesito saber el color que preferis".
  return new RegExp(`(que|cual|en que)\\s+${atributo}`).test(t)
    || new RegExp(`${atributo}[^.?!]{0,30}${pedir}`).test(t)
    || new RegExp(`${pedir}[^.?!]{0,30}${atributo}`).test(t);
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
  return /(dame un momento|un momentito|ya te (muestro|paso|busco|env[ií]o)|voy a (buscar|revisar|ver|mostrarte|consultar)|estoy buscando|permiteme (un|revisar|corregirlo)|enseguida te|te mostrare|te (voy a )?mostrar[ée])/.test(t);
}

/**
 * Detecta que el bot esta pidiendo datos de CIERRE (entrega, pago, nombre,
 * direccion). Sirve para frenarlo cuando todavia no sabe QUE combinacion
 * exacta se lleva el cliente.
 *
 * Bug real con capturas: el cliente contesto "si" a "¿alguna te interesa?" y
 * el bot salto directo a "¿te lo enviamos a domicilio?" sin haberle
 * preguntado talla ni color. El pedido se armaba a ciegas: agregar_al_carrito
 * SI exige la variante, pero el modelo puede llegar al cierre conversando sin
 * pasar nunca por el carrito.
 */
function pideDatosDeCierre(texto) {
  if (!texto) return false;
  const t = normalizarSimple(texto);
  return /(a domicilio|lo (enviamos|mandamos|llevamos)|retiro en (la )?tienda|pasas a (buscarlo|recogerlo)|forma de pago|metodo de pago|como (lo )?(vas a |queres |prefieres )?pagar|a nombre de quien|cual es tu nombre|tu direccion|cual es la direccion|compartirme tu ubicacion)/.test(t);
}

/**
 * Detecta que el bot afirma que un producto YA esta en el carrito. Se cruza
 * siempre con el carrito REAL (ver uso en el loop de vueltas): si el carrito
 * esta vacio, la afirmacion es necesariamente falsa - no hace falta entender
 * de que producto habla, alcanza con que diga "ya esta" y no haya nada.
 *
 * Bug real con capturas: el cliente dijo "estoy viendo la Park St 2.0" (solo
 * la estaba mirando, sin talla ni color) y el bot respondio "ya la tienes en
 * tu carrito" en el mismo mensaje en el que recien preguntaba la talla -
 * agregar_al_carrito exige la variante, asi que en verdad no se habia
 * agregado nada. El cliente se entera del pedido incompleto recien al leer
 * el resumen final.
 */
function afirmaAgregoAlCarrito(texto) {
  if (!texto) return false;
  const t = normalizarSimple(texto);
  return /(ya (lo|la|los|las) tien[e]?s? en tu carrito|ya (esta|quedo) en tu carrito|(lo|la|los|las) agregu[eé] a tu carrito|agregad[oa]s? a tu carrito|carrito ya (tiene|cuenta con))/.test(t);
}

/**
 * Detecta que el modelo afirma, en texto libre, que no hay stock/disponibilidad
 * de algo. No es lo mismo que un "no lo tenemos" dicho DESPUES de una consulta
 * real (buscar_producto, mostrar_productos, mostrar_categorias devolviendo
 * vacio) - ese caso es legitimo y no pasa por este detector.
 *
 * Bug real con capturas: el bot dijo "no tenemos zapatillas en stock" y, en el
 * mismo tramo de la conversacion, mostro tarjetas reales de zapatillas. Nada
 * en codigo validaba esa frase antes de mandarla - se uso el mismo criterio
 * que "antes de decir que no lo tenemos, buscalo" (ya en el prompt), pero
 * como backstop de codigo, igual que los demas detectores de este archivo.
 */
function afirmaFaltaDeStockSinRespaldo(texto) {
  if (!texto) return false;
  const t = normalizarSimple(texto);
  // La ventana NO cruza comas a proposito: "no hay problema, tenemos
  // disponible ese producto" es una afirmacion de stock, no una negacion -
  // sin el corte por coma, el detector la marcaba como falsa igual (bug real
  // encontrado en revision de codigo, verificado corriendo la funcion).
  return /(no (tenemos|hay|contamos con|disponemos de)\b[^,.?!]{0,25}(stock|disponible|disponibilidad|en existencia)|no tengo (la capacidad|como|forma) (de|para)[^,.?!]{0,40}(mostrar|ver|consultar|acceder)[^,.?!]{0,30}(inventario|stock|productos|catalogo))/.test(t);
}

/**
 * Detecta que el bot le dice al cliente que le mando/mostro algo (tarjeta,
 * catalogo, opciones) cuando en este turno NO se mando ninguna tarjeta real
 * (ni de producto ni de categoria). Reusa el mismo criterio que ya pide el
 * prompt ("AQUI TIENES SOLO SI DE VERDAD MANDASTE ALGO", agente.js linea
 * ~1505) pero como backstop en codigo: si mostrar_tarjeta_categoria fallo
 * (TOOL_FAILED, ej. el envio real por WhatsApp no salio), el modelo puede
 * igual escribir un texto confiado como si hubiera mandado algo - bug real
 * reportado: "Genial, te muestro las zapatillas... Aqui puedes revisar las
 * opciones." sin ninguna imagen ni link adjunto.
 */
function afirmaQueMostroAlgoSinTarjeta(texto) {
  if (!texto) return false;
  const t = normalizarSimple(texto);
  return /(te muestro|(aqui|aca) (tienes|tenes|puedes revisar|te dejo|las tienes|van( los)?)|te paso|te envie|te comparto|echale un vistazo|hechale un vistazo|dale un vistazo|revisa las opciones|mira las opciones|dejame mostrarte|estas son las opciones)/.test(t);
}

// Nombres reales de las tools (ver TOOLS mas abajo) - se usan para detectar
// cuando el modelo escribe la llamada como texto plano en vez de usar el
// mecanismo real de tool calling.
const NOMBRES_DE_TOOLS = [
  'actualizar_datos_lead', 'mostrar_productos', 'ver_mas_productos', 'enviar_fotos_producto',
  'buscar_producto', 'agregar_al_carrito', 'ver_carrito', 'quitar_del_carrito',
  'confirmar_pedido', 'crear_pedido', 'derivar_a_asesor', 'mostrar_categorias', 'mostrar_tarjeta_categoria',
];
const REGEX_LLAMADA_EN_TEXTO = new RegExp(`\\b(${NOMBRES_DE_TOOLS.join('|')})\\s*[{(]`);

/**
 * Detecta que el modelo escribio la sintaxis de una tool call directo en el
 * texto de respuesta (ej. `mostrar_productos{"ids":["Zapatillas urbanas"]}`)
 * en vez de invocar la funcion de verdad. Es distinto de "nombraUnProductoReal"
 * o "pareceListadoDeProductosEnTexto": esos dependen de que haya candidatos
 * reales de esta busqueda, pero este patron es SIEMPRE invalido (el cliente
 * jamas debe ver algo asi), pase lo que pase con candidatosActuales.
 *
 * Bug real con capturas: en la ULTIMA vuelta (tools:[], sin forma de llamar
 * una funcion de verdad) el modelo igual "quiso" llamar a mostrar_productos
 * y en vez de una tarjeta el cliente recibio el texto crudo de la llamada,
 * con nombres de producto como IDs en vez de los reales. Como el guard de
 * los demas detectores exige candidatosActuales.length, y en este caso no
 * habia, nada lo atajo.
 */
function pareceLlamadaDeHerramientaEnTexto(texto) {
  if (!texto) return false;
  return REGEX_LLAMADA_EN_TEXTO.test(texto);
}

/**
 * Detecta que el CLIENTE (no el bot) esta pidiendo ver todo lo que vende la
 * tienda, no solo lo que hay dentro de la categoria en la que ya esta
 * parado. Sirve para que mostrar_categorias pueda "salir" de la categoria
 * actual del lead cuando corresponde, en vez de quedar pegado ahi para
 * siempre (extraerFiltros solo sabe ENTRAR a una categoria, nunca salir).
 *
 * Bug real con capturas: con categoriaInteres="Zapatillas" ya fijado, el
 * cliente pregunto "¿que mas venden?" y "¿solo vendes zapatillas?" varias
 * veces seguidas y el bot siguio mostrando solo tipos de zapatillas.
 */
function pareceQuererCatalogoCompleto(texto) {
  if (!texto) return false;
  const t = normalizarSimple(texto);
  // OJO: "aparte de"/"ademas de" sueltos NO alcanzan como señal (bug real
  // encontrado en revision de codigo: "aparte de esto, tiene descuento?" no
  // tiene nada que ver con pedir el catalogo completo). La frase real del
  // reporte ("que cosas venden aparte de zapatillas") ya matchea igual por
  // el primer grupo, gracias al alternativo "cosas".
  return /(que (mas|otras cosas|otros productos|cosas) (vend|tien)|otra[s]? categor|solo vend|unicamente vend|todo lo que (vend|tien)|catalogo completo)/.test(t);
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

  // El orden importa: "no hay foto de ESE color" es distinto de "este producto
  // no tiene ninguna foto", y el mensaje al cliente cambia por completo.
  const noHayNingunaFoto = !foto.coloresConFoto.length && !(producto.fotos || []).length;
  if (noHayNingunaFoto) {
    avisos.push(`"${producto.nombre}" no tiene ninguna foto cargada: se envio solo la ficha en texto. No digas que le mandaste una foto.`);
    return avisos;
  }

  if (!foto.esDelColorPedido) {
    avisos.push(`NO SE ENVIO NINGUNA FOTO de "${producto.nombre}" en ${foto.colorPedido}: ese color no tiene imagen cargada. No se manda la de otro color por las tuyas, porque mandarle una zapatilla negra a alguien que pidio blancas es peor que no mandarle nada.
Deciselo tal cual: que en ${foto.colorPedido} SI hay stock, pero todavia no tenes foto de ese color.${foto.coloresConFoto.length ? ` De estos colores SI tenes foto: ${foto.coloresConFoto.join(', ')}.` : ''}${foto.referenciaDisponible ? ` Ofrecele verla en ${foto.referenciaDisponible} COMO REFERENCIA para que vea el modelo; si acepta, guarda ese color con actualizar_datos_lead y ahi si mandasela.` : ''}
PROHIBIDO escribir "aqui tienes", "te paso las fotos" o cualquier cosa que suene a que mandaste una imagen: no se mando ninguna.`);
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
// Link al catalogo web para "ver mejor antes de decidir": foto grande,
// descripcion completa, selector de talla/color con stock real. Es un
// COMPLEMENTO de la tarjeta que ya se mando, nunca un reemplazo - y solo
// tiene sentido mandarlo cuando ya se mostro algo real (esta funcion se
// llama desde el resultado de mostrar_productos/ver_mas_productos, nunca
// antes). Sin baseUrl o slug (ej. en tests sin request HTTP real) devuelve
// null y no se menciona nada - nunca un link roto.
async function linkCatalogoWeb(helpers, ruta) {
  if (!helpers.baseUrl || !helpers.empresaSlug) return null;
  try {
    const token = generarTokenSesion({ empresaId: helpers.empresaId, telefono: helpers.telefonoCliente, conversacionId: helpers.conversacionId });
    const destino = `${helpers.baseUrl}/catalogo/${helpers.empresaSlug}${ruta}${ruta.includes('?') ? '&' : '?'}s=${encodeURIComponent(token)}`;
    // El link con el token es largo (se ve feo y desconfia por WhatsApp) -
    // se manda acortado; server.js resuelve /l/:codigo al destino real.
    const corto = await prisma.linkCorto.create({ data: { destino } });
    return `${helpers.baseUrl}/l/${corto.id.toString(36)}`;
  } catch {
    return null;
  }
}

// Si en este turno se calculo un link real al catalogo web (ver
// linkCatalogoWeb) y el texto final del modelo no lo incluyo, se agrega en
// codigo antes de mandarlo. No se puede confiar en que el modelo copie un
// link solo porque el prompt se lo sugiere como "opcional" - bug real: el
// cliente pedia ver mas modelos y el link nunca le llegaba.
function conLinkPendienteSiFalta(texto, helpers) {
  const link = helpers.linkWebPendiente;
  if (!link) return texto;
  helpers.linkWebPendiente = null; // una sola vez por turno
  if (texto && texto.includes(link)) return texto;
  return `${texto || ''}\n\n👉 Para ver más con foto grande y elegir talla/color: ${link}`;
}

function resultadoDeEnvio({ enviados = 0, fallidos = [], avisos = [], resumen = '', total = 0, quedan = 0, linkWeb = null }) {
  if (!enviados) {
    return `TOOL_FAILED: no se pudo enviar ninguna tarjeta por WhatsApp${fallidos.length ? ` (${fallidos.join('; ')})` : ''}. NO le digas al cliente que le mandaste algo, porque no le llego: avisale con honestidad que hubo un problema tecnico y que lo intentas de nuevo en un momento.`;
  }
  return `TOOL_SUCCESS: se le mostraron al cliente ${enviados} producto(s) como tarjeta(s) con foto y ficha: ${resumen}.${fallidos.length ? ` NO se pudieron enviar: ${fallidos.join('; ')} - no menciones esos como enviados.` : ''}
${avisos.length ? `\nAVISOS QUE TENES QUE TRASLADARLE AL CLIENTE:\n- ${avisos.join('\n- ')}\n` : ''}
total_matches = ${total}, quedan sin mostrar = ${quedan}. ${quedan ? `Si pregunta por mas modelos, decile que SI hay (${quedan} mas) y llama a ver_mas_productos.` : 'Ya vio todas las opciones reales de esta busqueda: si pregunta por mas, podes decirle con seguridad que no quedan otras.'}
${linkWeb ? `\nOPCIONAL (no lo repitas cada vez, solo si de verdad ayuda): tambien existe esta pagina real con foto grande, descripcion completa y selector de talla/color con stock exacto, por si el cliente quiere "ver bien" antes de decidir: ${linkWeb}\n` : ''}
NO repitas los datos de la ficha en texto. Tu texto ahora: UNA linea corta y natural, nada mas. NO lo presiones para que compre, NO le preguntes si alguna lo convencio, NO le pidas que elija. Acaba de recibir las tarjetas: dejalo mirar tranquilo. Si necesita algo, te va a escribir el.`;
}

function fichaProducto(p, lead = {}, moneda = 'BOB') {
  const lineas = [`· *Precio*: ${formatearPrecio(p.precio, moneda)}`];
  const atributos = p.atributos || {};
  if (atributos.Marca) lineas.push(`· *Marca*: ${atributos.Marca}`);
  if (atributos.Material) lineas.push(`· *Material*: ${atributos.Material}`);

  const variantes = (p.variantes || []).filter((v) => v.activa && v.stock > 0);
  if (variantes.length) {
    // La tarjeta muestra TODO lo que hay con stock, no solo lo que el cliente
    // pidio. Antes se filtraba por su talla y color, y cuando esa combinacion
    // tenia stock en un solo lugar la tarjeta quedaba con una linea sola: un
    // producto con 6 variantes parecia tener una. El cliente tiene que ver el
    // abanico real para poder elegir (reporte del dueño con capturas).
    const aMostrar = variantes;

    // Lo que el cliente pidio no se esconde: se le dice si esa combinacion
    // puntual esta o no, arriba de la lista completa.
    const tallasPedidas = tokensDeLista(lead.talla);
    const coloresPedidos = tokensDeLista(lead.color);
    if (tallasPedidas.length || coloresPedidos.length) {
      const calza = variantes.some((v) => (
        (!tallasPedidas.length || tallasPedidas.includes(normalizarSimple(v.atributos?.Talla)))
        && (!coloresPedidos.length || coloresPedidos.some((c) => valoresEquivalentes(c, v.atributos?.Color || '')))
      ));
      const pedido = [lead.talla ? `talla ${lead.talla}` : null, lead.color].filter(Boolean).join(' en ');
      lineas.push(calza
        ? `· *Lo que buscabas* (${pedido}): disponible ✅`
        : `· *Lo que buscabas* (${pedido}): sin stock por ahora, pero mira lo que si hay 👇`);
    }

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

// Resumen corto de compras REALES anteriores de este cliente (nunca
// inventa: si no hay pedidos, no aparece nada). Pura y determinista - recibe
// los pedidos ya cargados con sus items, no toca Prisma. Sirve para que el
// bot pueda decir "la ultima vez llevaste X" y, mas importante, no le vuelva
// a preguntar una talla que ya sabe si el producto nuevo es de la misma
// categoria.
function resumenPedidosPrevios(pedidos = []) {
  if (!pedidos.length) return '';
  return pedidos.map((p) => {
    const fecha = p.createdAt instanceof Date ? p.createdAt.toISOString().slice(0, 10) : String(p.createdAt).slice(0, 10);
    const items = (p.items || []).map((i) => {
      const talla = i.variante && i.variante.atributos && i.variante.atributos.Talla;
      const categoria = i.producto && i.producto.categoria && i.producto.categoria.nombre;
      return `${i.cantidad}x ${i.nombre}${talla ? ` (talla ${talla})` : ''}${categoria ? ` [categoria: ${categoria}]` : ''}`;
    }).join(', ');
    return `- ${fecha}: ${items}`;
  }).join('\n');
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

/**
 * Busca un atributo dentro de atributosLead SIN exigir que el nombre coincida
 * caracter por caracter.
 *
 * El nombre del atributo lo escribe cada negocio a mano en el panel
 * ("Genero", "Género", "GENERO") y el modelo lo reescribe a su gusto cuando
 * llama a actualizar_datos_lead. Comparando literal, el dato quedaba guardado
 * bajo "género" mientras el gate seguia buscando "Genero" y nunca se
 * enteraba: el bot volvia a preguntar lo mismo para siempre.
 */
function valorEnAtributosLead(atributosLead = {}, nombre) {
  const buscado = normalizarSimple(nombre);
  if (!buscado) return null;
  for (const [k, v] of Object.entries(atributosLead || {})) {
    if (normalizarSimple(k) === buscado && v) return v;
  }
  return null;
}

/**
 * Atributos que el cliente dijo explicitamente que le dan igual ("cualquiera",
 * "el que sea"). Se guardan aparte del valor real a proposito: destraban la
 * pregunta, pero NO filtran la busqueda. Si se guardaran como si fueran un
 * valor (lead.color = 'cualquiera') el buscador no encontraria nada.
 */
function sinPreferenciaDe(lead = {}) {
  return ((lead.contexto || {}).sinPreferencia || []).map((n) => normalizarSimple(n));
}

/**
 * ¿Ya sabemos este dato del cliente? Mira primero el campo propio del lead
 * (talla/color/marca), despues atributosLead con el matching tolerante, y por
 * ultimo si el cliente dijo que no tiene preferencia.
 *
 * Ese ultimo caso existe porque el bot le contestaba "no, tenes que escoger un
 * color antes de seguir" al cliente que ya habia contestado "cualquiera":
 * responder que no importa ES una respuesta, y dejarlo trabado ahi es la
 * mejor forma de perder la venta.
 */
function leadYaTiene(lead = {}, nombre) {
  const campoPropio = ATRIBUTO_A_CAMPO_PROPIO[String(nombre).toLowerCase()];
  if (campoPropio && lead[campoPropio]) return true;
  if (!campoPropio && valorEnAtributosLead(lead.atributosLead, nombre)) return true;
  return sinPreferenciaDe(lead).includes(normalizarSimple(nombre));
}

/**
 * Atributos de la categoria que faltan en cierto nivel.
 *
 * Los de nivel VARIANTE (talla, color) nunca bloquean, por mas que la tienda
 * los haya marcado OBLIGATORIO: esos valores van en la tarjeta, el cliente los
 * lee ahi y elige. Es la misma regla que ya aplicaba el panel al guardar un
 * producto (ver atributosObligatoriosFaltantes en server.js, que filtra por
 * esDeVariante: false) - el bot era el unico que los trataba como bloqueo, y
 * por eso obligaba a elegir un color antes de mostrar una sola foto.
 *
 * En RECOMENDADO si se incluyen: ahi no bloquean nada, son sugerencias para
 * afinar DESPUES de que el cliente vio opciones.
 */
function atributosFaltantes(categoria, lead = {}, nivel = 'OBLIGATORIO') {
  if (!categoria || !categoria.atributos) return [];
  return categoria.atributos
    .filter((a) => a.nivel === nivel)
    .filter((a) => (nivel === 'OBLIGATORIO' ? !a.esDeVariante : true))
    .filter((a) => !leadYaTiene(lead, a.nombre))
    .map((a) => a.nombre);
}

// Una vez que el lead entra en cualquiera de estas etapas, ya eligio que
// comprar: seguir pidiendole atributos de la CATEGORIA (genero, uso, etc.)
// no tiene sentido, solo confunde el cierre.
const ESTADOS_DE_CIERRE = new Set([
  'INTENCION_DE_COMPRA', 'LISTO_PARA_COMPRAR', 'DATOS_DE_PEDIDO', 'ENTREGA', 'PEDIDO_COMPLETADO',
]);

/**
 * La UNICA cosa que falta para poder cerrar el pedido, en el mismo orden
 * que ya exige confirmar_pedido/crear_pedido - nunca inventa nada, solo lee
 * los datos reales del cliente. Se usa cuando hay que forzar una respuesta
 * de cierre en codigo (sin llamar de nuevo al modelo), asi la pregunta
 * siempre es honesta con lo que de verdad falta. Devuelve null si ya esta
 * todo listo para leerle el resumen.
 */
function primeraPreguntaDeCierre(cliente, config) {
  if (!nombreValido(cliente.nombre)) return '¿Me confirmás tu nombre para el pedido?';
  if (!cliente.tipoEntrega) {
    return config && config.direccionTienda
      ? '¿Lo querés a domicilio o pasás a retirarlo por la tienda?'
      : '¿Confirmamos que la entrega es a domicilio?';
  }
  if (cliente.tipoEntrega === 'DOMICILIO' && (!cliente.direccionEntrega || !cliente.ubicacionLat)) {
    return 'Para la entrega necesito tu ubicación real: compartila desde WhatsApp (el clip → Ubicación) o pegame el link de Google Maps.';
  }
  if (!cliente.formaPago) return '¿Cómo preferís pagar?';
  return null;
}

/**
 * Datos que esta tienda quiere saber ANTES de mostrar nada (ni el menu de
 * rubros): filtros que aplican a todo el catalogo, tipicamente el genero.
 *
 * Se resuelven igual que los atributos de categoria: talla/color/marca viven
 * en su campo propio del lead, el resto en atributosLead.
 */
// Cuantas veces se le puede pedir el MISMO dato inicial a un cliente antes de
// soltar el gate y dejarlo ver el catalogo igual.
//
// El gate es una regla de negocio real (no mostrar vestidos a un hombre), pero
// no puede convertirse en una carcel: si despues de dos intentos el dato no
// quedo guardado, el problema es del sistema, no del cliente, y hacerlo
// contestar una tercera vez solo lo hace irse. Bucle real reportado con
// capturas: el cliente escribio "hombre" tres veces y el bot le siguio
// preguntando el genero con otras palabras.
const MAX_INTENTOS_PREGUNTA_INICIAL = 2;

/**
 * Que datos iniciales faltan DE VERDAD todavia.
 *
 * Un dato solo se pregunta si se cumplen las tres condiciones:
 *   1. el negocio lo pidio en /panel/configuracion;
 *   2. no se sabe ya (con matching tolerante de nombre, ver leadYaTiene);
 *   3. el catalogo tiene mas de un valor real para responderlo. Preguntar el
 *      genero en una tienda que solo vende calzado de hombre -o que no cargo
 *      el atributo en ningun producto- es puro tramite: la respuesta no puede
 *      cambiar lo que se muestra. Cuando hay un solo valor, resolverDatosIniciales
 *      lo completa solo.
 *
 * @param {Array} productos  catalogo real; si no se pasa, no se aplica el filtro 3.
 */
function preguntasInicialesFaltantes(config, lead = {}, productos = null) {
  const pedidas = (config && config.preguntasIniciales) || [];
  if (!pedidas.length) return [];

  const intentos = Number((lead.contexto || {}).intentosPreguntaInicial || 0);
  if (intentos >= MAX_INTENTOS_PREGUNTA_INICIAL) return [];

  return pedidas.filter((nombre) => {
    if (leadYaTiene(lead, nombre)) return false;
    if (!productos) return true;
    // talla/color/marca viven en su campo propio del lead, pero sus valores
    // reales se leen del catalogo igual que cualquier otro atributo.
    return valoresRealesDeAtributo(productos, nombre).length > 1;
  });
}

/**
 * Rellena en CODIGO los datos iniciales que se pueden resolver sin molestar al
 * cliente, y devuelve el parche para el lead (o null si no hay nada que hacer):
 *
 *   - el cliente ya lo dijo en su mensaje ("hombre") -> se guarda el valor real
 *     del catalogo, sin depender de que el modelo llame a actualizar_datos_lead;
 *   - el catalogo tiene un solo valor posible -> se completa solo y no se pregunta.
 *
 * Este es el mismo patron que extraerFiltros: un respaldo determinista para lo
 * que el modelo deberia hacer pero no siempre hace.
 */
function resolverDatosIniciales(texto, config, lead = {}, productos = []) {
  const pedidas = (config && config.preguntasIniciales) || [];
  if (!pedidas.length) return null;

  const patch = {};
  const atributos = { ...(lead.atributosLead || {}) };
  let hayCambios = false;

  for (const nombre of pedidas) {
    if (leadYaTiene(lead, nombre)) continue;

    const valores = valoresRealesDeAtributo(productos, nombre);
    if (!valores.length) continue;

    // Un solo valor posible: no hay nada que preguntar, se asume.
    const resuelto = valores.length === 1 ? valores[0] : resolverValorDeAtributo(texto, nombre, productos);
    if (!resuelto) continue;

    const campoPropio = ATRIBUTO_A_CAMPO_PROPIO[String(nombre).toLowerCase()];
    if (campoPropio) {
      patch[campoPropio] = resuelto;
    } else {
      // Se guarda con el nombre tal como lo configuro el negocio, para que el
      // dato quede siempre bajo la misma clave por mas que el modelo escriba
      // "género" una vez y "Genero" la siguiente.
      atributos[nombre] = resuelto;
    }
    hayCambios = true;
  }

  if (!hayCambios) return null;
  if (JSON.stringify(atributos) !== JSON.stringify(lead.atributosLead || {})) {
    patch.atributosLead = atributos;
  }
  return patch;
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
// Separa el system prompt en dos mitades para aprovechar el prompt caching
// de OpenAI/Anthropic (50-90% mas barato en la parte que se repite igual
// entre llamadas). "fijo" es identico en cada vuelta/mensaje/cliente de la
// MISMA empresa (solo depende de marca/tono/config, que no cambian turno a
// turno) - es la parte mas pesada del prompt (reglas de venta, formato).
// "variable" es todo lo que SI cambia por turno: memoria del lead, atributos
// faltantes, y el catalogo/resultados reales de esta busqueda puntual.
// Nunca mezcla nada entre empresas: la marca va en la primera linea de
// "fijo", asi que el prompt de cada tienda es un texto distinto desde el
// primer caracter - cada una tiene su propio cache, aislado.
function partesDelSystem(empresa, productos, config, lead = {}, sinHerramientas = false, esPrimerMensaje = false, nombreAgente = '', tarjetaEnviadaEnTurno = false, pedidosPrevios = [], pidioProductoPuntual = false) {
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
  const arbol = arbolDeCategorias(productos, lead);
  const categoriasReales = arbol.map((r) => r.nombre);
  // Categoria real que ya se resolvio para este cliente (ver extraerFiltros /
  // actualizar_datos_lead) - de ahi sale que atributos obligatorios faltan.
  const categoriaActual = categoriaDelLead(productos, lead);
  // Bug real reportado: el bot le pregunto "genero" a mitad del cierre (ya
  // habia dado nombre, ubicacion y forma de pago), porque faltantes/
  // recomendados se recalculaban SIEMPRE por categoria, sin mirar si el
  // cliente ya eligio producto. Una vez que hay favorito o el lead entro en
  // fase de cierre, mostrar/filtrar por categoria ya no importa: no se
  // vuelve a pedir nada de eso.
  const yaEligioOCerrando = Boolean(lead.productoFavoritoId) || ESTADOS_DE_CIERRE.has(lead.estadoConversacion);
  const faltantes = yaEligioOCerrando ? [] : atributosFaltantes(categoriaActual, lead, 'OBLIGATORIO');
  // Los recomendados no bloquean, pero listarle 8 al modelo lo empuja a
  // interrogar al cliente (el catalogo real tiene categorias con 8 atributos
  // marcados). Se le muestran solo los primeros por orden: son sugerencias
  // para que la charla fluya, no un checklist.
  const recomendados = yaEligioOCerrando ? [] : atributosFaltantes(categoriaActual, lead, 'RECOMENDADO').slice(0, MAX_ATRIBUTOS_SUGERIDOS);
  const moneda = empresa.moneda || 'BOB';
  const entregas = ['a domicilio'];
  if (config && config.direccionTienda) entregas.push('retiro en la tienda');
  const identidad = nombreAgente ? `Te llamas ${nombreAgente} y sos` : 'Eres';

  const fijo = `${identidad} la persona que atiende el WhatsApp de "${marca}". No eres un bot de formulario ni un menu de opciones: sos un vendedor de carne y hueso, con buena onda, que charla con el cliente como charlaria cualquier vendedor bueno en una tienda real. Es una conversacion real con un cliente real, no una demo.${nombreAgente ? ` Si te preguntan tu nombre, respondé que te llamas ${nombreAgente}.` : ''}

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

SI EL CLIENTE PREGUNTA QUE TENES / QUE VENDES / QUE PRODUCTOS TIENEN / TU CATALOGO / TUS CATEGORIAS (o algo generico parecido, sin nombrar un producto puntual): llama a **mostrar_categorias**. Es OBLIGATORIO, no opcional.${categoriasReales.length <= 1 ? ` Esta tienda vende UN SOLO rubro (${categoriasReales[0] || marca}), asi que la herramienta te va a devolver una sola opcion: en ese caso no armes una lista numerada de un solo item ni preguntes "¿cual te interesa?" (no hay entre que elegir), decilo en una frase natural y pasa a preguntar que anda buscando.` : ''}
NUNCA armes vos la lista de memoria, NUNCA mandes un link a una pagina web, y NUNCA respondas "nos especializamos en X" recortando el catalogo por tu cuenta: la tienda vende todo lo que devuelve esa herramienta.
El menu tiene DOS NIVELES: primero los rubros (Calzado, Abrigos...) y despues, cuando el cliente elige uno, los tipos que hay adentro (Zapatillas urbanas, Botas...). La herramienta sabe en que nivel esta parado el cliente: llamala igual en los dos casos.

EL RECORRIDO DE UNA VENTA (este es el orden acordado con el negocio, seguilo):
 1. El cliente pregunta que vendes -> llamas a mostrar_categorias y le pasas la lista.
 2. Elige una (por numero, por nombre o diciendo "me interesa") -> llamas a mostrar_tarjeta_categoria: le manda UNA tarjeta con foto real, cuantos modelos hay, precio desde y el link al catalogo filtrado. NUNCA tarjetas de productos individuales en este paso, ni aunque insista con "mostrame lo que tenes" o "que opciones hay": eso lo resuelve el link del catalogo, no tarjetas sueltas.
 3. Recien cuando el cliente NOMBRA un modelo puntual por su nombre (lo vio en el link, lo escribe el solo, o vos le diste 1-2 nombres de ejemplo y el elige uno) -> ahi si llamas a mostrar_productos con ESE producto puntual.
 4. Si nombra otro modelo puntual o pide comparar varios, llamas a mostrar_productos/ver_mas_productos con los que vaya nombrando.
 5. El cliente elige mirando las tarjetas ("me interesa la Ginger Tav en blanco talla 9"): la talla y el color ya los vio ahi, NO se los preguntes.
 6. Llamas a agregar_al_carrito y le preguntas SI DESEA VER ALGO MAS.
      - Si dice que si -> volves al paso 1 (mostrar_categorias).
      - Si dice que no -> cerras: nombre, tipo de entrega (y ubicacion si es a domicilio), forma de pago.
 7. Llamas a confirmar_pedido, le leas el resumen, y con su "si" llamas a crear_pedido.

COMO CONDUCIS LA VENTA (con calidez, pero siempre empujando un paso mas):
- Entendé que necesita, mostrale opciones reales, resolvé sus dudas, y cuando muestre interes de verdad avanzá hacia cerrar el pedido. Es un ida y vuelta natural, no una lista de pasos rigida que hay que tildar en orden exacto.
- El presupuesto no se pregunta como un requisito de entrada: surge naturalmente si el cliente lo menciona, o lo consultas mas adelante si hace falta para recomendar bien, nunca como segunda pregunta obligatoria.
- Si el cliente menciona algo util (para quien es, que necesita, marca/talla/color, un detalle), guardalo con actualizar_datos_lead pero sin que se note en tu texto que estas "llenando un formulario".
- NUNCA cambies de categoria por tu cuenta: si el cliente busca zapatillas, seguis buscando dentro de zapatillas aunque no encuentres coincidencia exacta. Jamas le ofrezcas algo de otra categoria (una mochila, una camisa) solo porque coincide en presupuesto - eso confunde y no es lo que pidio.
- Cuando el cliente elige un favorito entre varias opciones ("me gusta el segundo", "esa quiero"), guardalo con actualizar_datos_lead (productoFavoritoId) y de ahi en mas enfocate SOLO en ese producto: dejá de mostrarle mas alternativas salvo que el mismo diga que cambio de opinion.
- Actualizá estadoConversacion via actualizar_datos_lead a medida que el cliente avanza (explorando -> buscando_producto -> comparando -> interesado -> intencion_de_compra -> listo_para_comprar): eso ayuda al sistema a saber cuando dejar de sugerir y empezar a cerrar.
- PROACTIVO CON FOTOS: en cuanto el cliente muestre interes real en un producto especifico (dice "me gusta", "ese me interesa", o cualquier reaccion positiva), mandale las fotos con enviar_fotos_producto SIN que tenga que pedirlas.
- Cuando hay intencion clara de compra, pedile lo que falte (nombre, tipo de entrega, ubicacion si es a domicilio, forma de pago) de forma natural, de a una cosa por mensaje. Antes de crear nada, llama a confirmar_pedido: el sistema arma el resumen exacto (producto, variante, cantidad, precio real, entrega) para que se lo leas y el cliente diga que esta todo bien. Recien despues llama a crear_pedido.
- Si la entrega es a domicilio, NUNCA le pidas "la direccion" ni aceptes una direccion escrita a mano como unico dato: pedile especificamente que comparta su UBICACION (el clip -> Ubicacion, nativo de WhatsApp) o que pegue el link de Google Maps de donde esta. El sistema no deja crear el pedido si lo que guardaste no es una ubicacion real que se pueda ubicar en un mapa - si eso pasa, volve a pedirle la ubicacion o el link, nunca insistas en que te escriba la direccion de nuevo.
- FORMAS DE PAGO REALES de esta tienda (nunca ofrezcas otra que no este en esta lista): ${metodosPago.length ? metodosPago.join(', ') : 'ninguna configurada todavia - si el cliente pregunta, decile que un asesor va a coordinar el pago con el'}.
- TIPOS DE ENTREGA REALES de esta tienda: ${entregas.join(' o ')}. ${config && config.direccionTienda ? 'Si elige retirar, el sistema le manda la direccion real del local (vos NUNCA la escribas de memoria).' : 'Esta tienda todavia no cargo la direccion de su local, asi que por ahora solo podes ofrecer entrega a domicilio - nunca inventes una direccion de tienda.'}
- CIERRE SIN INSISTIR: acompañas al cliente, no lo empujas. Cuando EL muestra intencion de compra ("me gusta esa", "la quiero", "cuanto sale el envio"), ahi si avanzas y le pedis lo que falta para el pedido. Si todavia no dijo nada de eso, NO insistas: nada de "¿alguna te convencio?", "¿cual preferis?", "¿hacemos el pedido?" despues de mostrarle cosas. Un vendedor que presiona espanta. Dejalo mirar; si necesita algo, pregunta.

REGLAS TECNICAS (estas si son estrictas, aunque no se noten en tu forma de hablar):
- SOLO TEMAS DEL NEGOCIO: sos un vendedor de "${marca}", no un asistente general. Si te preguntan algo que no tiene nada que ver con la tienda o sus productos (la hora, capitales, cultura general, matematica, tareas, programacion, chistes, opiniones sobre temas ajenos, etc.), NO respondas esa pregunta: con una frase breve y amable aclara que ahi no podes ayudar, y redirigi de inmediato hacia la conversacion de venta ("de eso no te puedo ayudar, pero contame, ¿que andas buscando hoy?"). Nunca sigas el hilo de un tema ajeno aunque el cliente insista, y nunca gastes mas de una frase en la aclaracion.
- SI HAY PRODUCTOS EN EL BLOQUE DE RESULTADOS, MOSTRALOS YA. No pidas color, talla, marca ni presupuesto antes de que el cliente haya visto una sola opcion: eso lo agota y se va. Las tallas y colores VAN EN LA TARJETA, el cliente los lee ahi y te dice cual quiere.
- La UNICA vez que preguntas una talla o un color es cuando el cliente ya eligio un producto y falta saber que combinacion exacta se lleva. Ahi no estas filtrando: estas completando la compra.
- Si el bloque de resultados NO existe, es porque al sistema le falta un dato imprescindible que la tienda marco como tal: ahi si preguntá (una sola cosa), y en cuanto lo tengas, mostrá.
- MOSTRAR POCAS NO ES QUE HAYA POCAS: el bloque de resultados te dice el total_matches real. Si el total es mayor a lo que le mostraste, JAMAS digas "esas son todas las que tengo": decile cuantas hay y ofrecele ver las siguientes con ver_mas_productos.
- MONEDA: los precios de esta tienda estan en ${moneda} (${simboloMoneda(moneda)}). Nunca los conviertas a otra moneda, nunca cambies el simbolo y nunca escribas un precio que no venga del sistema tal cual.
- No muestres ni inventes ningun producto que no este en el bloque de resultados de abajo: esa es la UNICA fuente real del inventario.
- SI YA DECIDIO, NO SE LO VUELVAS A MOSTRAR. Cuando el cliente nombra productos que YA vio y dice que los quiere ("me gustaria el jean recto negro y la polera blanca"), o pregunta cuanto sale todo, NO llames a mostrar_productos: ya los vio, reenviarle la tarjeta le dice que no lo escuchaste. Llama a agregar_al_carrito por CADA producto que nombro (uno por uno, con su variante si dijo talla y color) y despues a ver_carrito para darle el total real. Si nombro dos productos, van los DOS al carrito: no atiendas solo el primero.
- EL TOTAL NUNCA LO CALCULES VOS. Si te pregunta cuanto es, cuanto sale todo o cuanto lleva, el numero sale de ver_carrito. PROHIBIDO sumar precios de cabeza.
- ANTES DE DECIR "NO LO TENEMOS", BUSCALO. Si el cliente nombra un producto que no ves en el bloque de arriba, llama a buscar_producto con ese nombre: el bloque esta filtrado por lo que el venia pidiendo (color, talla, presupuesto) y algo puede existir igual. Decirle que no hay algo que si esta cargado es el peor error que podes cometer.
- Usa derivar_a_asesor cuando el cliente lo pida explicitamente, este muy molesto, o detectes pedido mayorista, compra de monto alto, negociacion especial de precio, descuento fuera de lo normal, un problema que no podes resolver, condicion comercial especial, o un cliente empresarial. Nunca por preguntas normales de precio, stock o forma de pago: esas las respondes vos con la info disponible.
- No se puede crear un pedido sin nombre, tipo de entrega (y direccion si es a domicilio) y forma de pago: pedilos de forma natural antes de llamar crear_pedido si faltan.
- ACCIONES: nunca afirmes que hiciste algo (mandar una foto, mandar el QR, mandar la ubicacion, crear el pedido) si el sistema no te confirmo que salio bien. Cada herramienta te responde si funciono o si fallo: si fallo, decile la verdad al cliente y ofrecele reintentar.
- SI EL SISTEMA TE CORRIGE, HACELO EN SILENCIO: a veces vas a recibir un "RECORDATORIO DEL SISTEMA" pidiendote que llames a una funcion o cambies algo - eso es una nota interna, EL CLIENTE NUNCA LO VIO. PROHIBIDO decirle al cliente "me confundi", "cometi un error", "disculpa el error", "ups" o cualquier cosa que suene a que la conversacion tuvo un problema tecnico: para el, es tu primera y unica respuesta a lo que el pidio. Corregite y segui como si nada, con la misma naturalidad de siempre.
- "AQUI TIENES" SOLO SI DE VERDAD MANDASTE ALGO. Las frases "aqui tienes", "aca te dejo", "te paso", "te envie" anuncian un archivo adjunto: si en ese turno el sistema NO envio ninguna foto ni tarjeta, el cliente ve la frase y no ve nada, y queda como que el bot miente. Cuando solo estas contando lo que hay, usa "tenemos", "ahora mismo contamos con", "hay disponible". Reserva "aqui tienes" para el turno en que la herramienta confirmo que la imagen salio.
- Si un producto tiene variantes (talla/color/etc., estan listadas debajo de ese producto en el bloque de resultados), NUNCA llames crear_pedido sin antes preguntarle al cliente cual elige: usa el ID de esa variante exacta en idVariante.
- Si el cliente pide ver "el catalogo", "todos los productos" o "tus categorias", llama a mostrar_categorias. PROHIBIDO mandarle un link a una pagina: el cliente compra dentro de WhatsApp, no lo mandes afuera.
- REGLA DURA DEL NEGOCIO: NUNCA muestres tarjetas de productos individuales (mostrar_productos/ver_mas_productos) salvo que el cliente haya nombrado un modelo PUNTUAL por su nombre propio (ej. "tenes la Park St 2.0?", "quiero la Ginger Tav blanca"). Elegir una categoria generica ("Zapatillas", "quiero pantalones", "mostrame lo que tenes", "que opciones hay") NUNCA dispara mostrar_productos.
- Cuando el cliente NOMBRA o ELIGE una categoria puntual por primera vez en la conversacion (ej. "estoy buscando zapatillas deportivas", o elige "Zapatillas" de un menu), llama a mostrar_tarjeta_categoria - le da una foto real, cuantos modelos hay, desde que precio, y un link al catalogo filtrado para que vea todo. Es UNA vez por categoria: si ya se la mostraste en esta conversacion y el cliente sigue sin nombrar nada puntual, NO la repitas ni muestres productos - preguntale, por su nombre, cual modelo puntual le interesa.
- Despues de mandar la tarjeta de categoria, tu texto de reaccion NUNCA dice la palabra "tarjeta" ni "te envie/mande esto": hablale del producto/categoria directamente y de forma natural (ej. "Echale un vistazo a los jeans que tenemos" en vez de "mira la tarjeta de jeans que te envie").
- FORMATO WHATSAPP (no Markdown): negrita = *un asterisco pegado al texto*, nunca **doble asterisco** ni # titulos.

Informacion comercial:
${extra ? `- ${extra}` : '(sin instrucciones adicionales)'}

REGLA ANTI-INVENTO: cada producto que muestres DEBE corresponder a una linea del bloque de resultados, con su precio EXACTO. Los IDs son solo para tus llamadas a funciones, nunca los menciones al cliente. Si te preguntan un detalle puntual que no figura ahi (ej. una talla exacta que no esta en las caracteristicas), respondé con lo real que si tenes (el rango que SI aparece) sin inventar numeros nuevos, y ofrecé confirmarlo si hace falta precision.

SI NO SABES ALGO, DECILO: cuando el cliente pregunta un dato que la ficha no tiene (que tipo de algodon es, si abriga mucho, cuanto pesa), la respuesta correcta es admitirlo con naturalidad: "la ficha dice 100% algodon, pero no tengo registrado el tipo exacto". PROHIBIDO rellenar con adjetivos que no estan en los datos ("algodon premium", "confeccion de alta calidad", "muy resistente"). Lo mismo si te preguntan por que cuesta lo que cuesta: solo podes usar atributos reales de la ficha, nunca justificaciones inventadas.`;

  // Si en ESTE mismo primer mensaje el cliente ya dijo que anda buscando
  // (extraerFiltros ya detecto categoria o producto favorito antes de armar
  // este prompt), no tiene sentido forzar el "hola, ¿en que te ayudo?"
  // generico: eso es una vuelta de mas que el cliente ya se salto solo.
  const yaMostroInteresEnEsteMensaje = Boolean(lead.categoriaInteres || lead.productoFavoritoId);
  const variable = `${esPrimerMensaje ? (yaMostroInteresEnEsteMensaje ? `ES EL PRIMER MENSAJE, PERO EL CLIENTE YA DIJO QUE ANDA BUSCANDO (obligatorio): no le preguntes "¿en que te ayudo?" ni nada generico, eso ya lo contesto solo. Presentate en UNA frase corta (quien sos${nombreAgente ? ` -${nombreAgente}-` : ''} y de que tienda) y anda derecho a lo que dijo que buscaba - mostrale opciones ya si el bloque de resultados de abajo tiene algo, o pedile lo unico que falte para poder mostrarle. Nada de discurso de bienvenida largo: fue directo, respondele igual de directo.` : `ESTE ES EL PRIMER MENSAJE DE LA CONVERSACION - TOMA LA INICIATIVA (obligatorio): no respondas solo con algo generico tipo "¿en que puedo ayudarte?". Presentate brevemente: quien sos${nombreAgente ? ` (te llamas ${nombreAgente})` : ''}, de que tienda, que vende la tienda en general (mira las categorias reales de abajo), y como podes ayudar.${bienvenida ? ` El negocio configuro este mensaje de bienvenida como punto de partida: "${bienvenida}" - usalo como base/inspiracion de tu primer mensaje (podes adaptarlo un poco para que fluya natural), no lo ignores.` : ''} Ejemplo del tono esperado si no tenes una bienvenida configurada (adaptalo, no lo copies literal):
"¡Hola! Soy${nombreAgente ? ` ${nombreAgente}` : ''}, el asistente de ventas de ${marca}. Tenemos ${categoriasReales.length ? categoriasReales.slice(0, 3).join(', ') : 'varios productos'}. Te puedo ayudar a encontrar justo lo que buscas. ¿Que andas necesitando?"
Que el cliente entienda de entrada que puede hacer el agente, sin sonar a discurso leido.`) : `COMO ARRANCA LA CONVERSACION (si ya hay historial previo, esto no aplica): si el cliente recien saluda sin decir que busca ("hola", "buenas"), saluda con calidez y preguntale de forma abierta y natural que anda buscando (variá la frase, no uses siempre la misma).`}

Datos que ya sabes de este cliente (los usas para no preguntar dos veces lo mismo, pero NUNCA se los repitas ni le digas que los "guardaste"):
${datosConocidosDelLead(lead)}
${faltantes.length ? `- LO UNICO QUE TE FALTA PARA PODER MOSTRAR en la categoria "${categoriaActual.nombre}": ${faltantes.join(' y ')}. Preguntá SOLO "${faltantes[0]}" en este mensaje${faltantes.length > 1 ? ` (lo demas se lo preguntas despues, de a uno)` : ''} y guardalo con actualizar_datos_lead (talla/color/marca van en su campo propio; cualquier otro atributo como Genero o Uso va en atributosCategoria). Apenas lo tengas, MOSTRA productos: no aproveches para preguntar otra cosa.` : ''}
${recomendados.length ? `- Datos que podrian afinar la recomendacion en "${categoriaActual.nombre}": ${recomendados.join(', ')}. NO los preguntes antes de mostrar productos - solo te sirven DESPUES, si el cliente vio las opciones y ninguna le convencio.` : ''}
${resumenPedidosPrevios(pedidosPrevios) ? `
Compras reales anteriores de este cliente (son datos reales, podes mencionarlos con naturalidad si viene al caso - ej. "la ultima vez llevaste X" - y usar la talla de ahi como dato ya sabido SOLO si el producto que esta viendo ahora es de la misma categoria; si es de otra categoria, no asumas que le sirve la misma talla, preguntala igual):
${resumenPedidosPrevios(pedidosPrevios)}` : ''}

- TARJETAS: para mostrar cualquier producto SIEMPRE llama a mostrar_productos con sus IDs. Nunca escribas precio o stock como texto plano: eso va en la tarjeta que genera el sistema. Mostra las opciones del bloque de resultados (son pocas y muy relevantes a proposito), nunca mas de las que te da el sistema.${tarjetaEnviadaEnTurno ? '\n- YA MANDASTE UNA TARJETA EN ESTE MISMO MENSAJE: tu texto ahora tiene que reaccionar a ESO puntualmente (preguntar si le interesa, si quiere otro color/talla, etc.). NUNCA repitas el menu de categorias ni digas "solo tenemos X, ¿queres ver una opcion?" como si no hubieras mostrado nada: el cliente ya la tiene enfrente.' : ''}

${resumenInventario(productos)}

${seccionProductos(productos, lead, categoriaActual, moneda, config, yaEligioOCerrando, pidioProductoPuntual)}

CIERRE NATURAL: sin guion de call center y sin presion. Un vendedor real resuelve la duda, deja que el cliente mire, y recien encamina hacia la compra cuando el cliente da la señal. Nunca cierres un mensaje pidiendole que decida o que compre si el no mostro intencion: eso incomoda y hace que deje de contestar.${sinHerramientas ? `

ATENCION: esta es tu respuesta final de este turno, ya NO podes llamar ninguna funcion mas. Los UNICOS productos que existen son los que estan en el bloque de resultados de arriba (por nombre exacto) - si no alcanza para responder algo puntual, decilo con naturalidad ("dejame confirmarte ese dato") en vez de inventar un producto, caracteristica o numero que no este ahi. NUNCA menciones un producto o modelo que no aparezca literalmente en ese bloque.` : ''}`;

  return { fijo, variable };
}

// Wrapper de compatibilidad: junta las dos partes en un solo string, igual
// que devolvia esta funcion antes de separarla para el prompt caching (ver
// partesDelSystem). Se mantiene para no romper los usos existentes en tests.
function construirSystem(...args) {
  const { fijo, variable } = partesDelSystem(...args);
  return `${fijo}\n\n${variable}`;
}

// ============================ Llamadas al modelo (por proveedor) ============================
// Formato estandar de mensajes para el loop de tools:
//  { role: 'user'|'assistant', content: string }
//  { role: 'assistant', content, tool_calls: [{id,name,arguments}] }
//  { role: 'tool', tool_call_id, content }

async function llamarOpenAI({ system, mensajes, tools, modelo }) {
  // El caching de OpenAI es automatico por prefijo identico: no necesita
  // ningun cache_control explicito, solo que "system" llegue con la parte
  // fija primero (ver partesDelSystem/construirSystem).
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
    usage: resp.usage,
  };
}

async function llamarAnthropic({ system, systemFijo, systemVariable, mensajes, tools, modelo }) {
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

  // Si viene la parte fija/variable por separado, se arma como dos bloques
  // con cache_control en el primero: Anthropic reutiliza (90% mas barato)
  // todo lo que este ANTES de ese corte cuando el texto es identico a una
  // llamada anterior reciente. Sin las partes separadas (compatibilidad),
  // se manda como string plano, igual que antes.
  const systemParaAnthropic = systemFijo != null
    ? [
        { type: 'text', text: systemFijo, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: systemVariable || '' },
      ]
    : system;

  const resp = await anthropic.messages.create({
    model: modelo,
    max_tokens: 700,
    system: systemParaAnthropic,
    messages: convertidos,
    tools: toolsParaAnthropic(tools),
  });

  const texto = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolCalls = resp.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} }));
  return { content: texto, tool_calls: toolCalls, usage: resp.usage };
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
      if (!v) continue;
      // El modelo escribe el nombre del atributo a su gusto ("Genero" una vez,
      // "género" la siguiente). Si ya existe una clave que significa lo mismo,
      // se reusa esa: si no, el lead termina con dos entradas para el mismo
      // dato y el gate que busca una nunca ve la otra.
      const yaExiste = Object.keys(actuales).find((existente) => normalizarSimple(existente) === normalizarSimple(k));
      nuevos[yaExiste || String(k).slice(0, 60)] = String(v).slice(0, 120);
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
    // URLs de fotos ya enviadas: el control de duplicados es por imagen, no
    // por producto, para poder mandar otro color del mismo par.
    const urlsEnviadas = [...((clienteFinal.contexto && clienteFinal.contexto.urlsFotosEnviadas) || [])];
    const categoriaActual = categoriaDelLead(contexto, leadActual || {});

    // PEDIDO PUNTUAL: el cliente nombro estos productos y buscar_producto los
    // encontro en el catalogo. No es una busqueda por categoria, es "¿tenes
    // ESTO?" - y eso se contesta mostrandolo, no interrogandolo.
    const idsPorNombre = helpers.idsPedidosPorNombre || [];
    const idsPedidos = toolCall.name === 'mostrar_productos' ? (args.idsProductos || []).map(Number) : [];
    const esPedidoPuntual = idsPedidos.length > 0 && idsPedidos.every((id) => idsPorNombre.includes(id));

    // GATE EN CODIGO: mientras falten los datos que esta categoria marca como
    // imprescindibles, no se muestra NADA. El prompt ya se lo pide, pero el
    // modelo igual intenta mostrar productos apenas escucha una categoria
    // ("zapatillas" -> tres tarjetas), que es justo lo que el negocio no
    // quiere: primero entender, despues mostrar.
    //
    // No aplica al pedido puntual. Bug real con capturas: el cliente escribio
    // "tenes de casualidad ZAPATILLAS TEKKIRA CUP en venta", el sistema la
    // encontro (busqueda_por_nombre, conStock 1) y el gate la bloqueo por
    // falta de "Genero" - o sea, le preguntaba de que genero es el modelo que
    // el mismo acababa de nombrar. Los datos que falten se piden DESPUES de
    // contestarle, cuando hagan falta de verdad (para la talla, el color o el
    // cierre), nunca antes de decirle si lo tenemos.
    if (toolCall.name !== 'enviar_fotos_producto' && leadActual && !esPedidoPuntual) {
      const faltanIniciales = preguntasInicialesFaltantes(config, leadActual, contexto);
      if (faltanIniciales.length) {
        logEtapa('mostrar_bloqueado_preguntas_iniciales', telefonoCliente, { faltan: faltanIniciales });
        return `TODAVIA NO le muestres productos (TOOL_FAILED): falta saber ${faltanIniciales.join(' y ')}, que esta tienda pide para cualquier busqueda. Preguntá SOLO "${faltanIniciales[0]}" y guardalo con actualizar_datos_lead.`;
      }

      // El cliente esta parado en un rubro que se subdivide: primero elige el
      // tipo. Sin esto el modelo muestra 3 productos cualquiera del rubro.
      if (categoriaActual && !categoriaActual.padreId) {
        const subs = subcategoriasDe(contexto, categoriaActual.id, leadActual);
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
    if (toolCall.name === 'mostrar_productos' && busqueda.relajado && !esPedidoPuntual) {
      const preguntado = (clienteFinal.contexto || {}).relajadoPreguntado;
      const mismoFiltro = preguntado && preguntado.filtro === busqueda.relajado;
      const respondioElCliente = mismoFiltro && preguntado.turno !== helpers.turno;
      // Tope duro: pedir permiso mas de una vez por el mismo filtro es un
      // bucle, y al cliente lo desespera. Si ya se pregunto dos veces, se
      // muestra igual aclarando que no es exacto. Preferimos mostrar de mas
      // que dejar la conversacion trabada pidiendo permiso para siempre.
      const yaInsistimos = mismoFiltro && (preguntado.intentos || 1) >= 2;

      if (!respondioElCliente && !yaInsistimos) {
        await prisma.clienteFinal.update({
          where: { id: clienteFinal.id },
          data: {
            contexto: {
              ...(clienteFinal.contexto || {}),
              relajadoPreguntado: {
                filtro: busqueda.relajado,
                turno: helpers.turno,
                intentos: mismoFiltro ? (preguntado.intentos || 1) + 1 : 1,
              },
            },
          },
        });
        logEtapa('mostrar_bloqueado_filtro_relajado', telefonoCliente, { relajado: busqueda.relajado, intentos: mismoFiltro ? (preguntado.intentos || 1) + 1 : 1 });
        return `NO se mostro nada todavia (TOOL_FAILED a proposito): no hay coincidencia exacta y estas opciones aparecen recien aflojando ${NOMBRE_FILTRO_RELAJADO[busqueda.relajado]}. Primero decile eso con claridad y preguntale si quiere verlas igual. Cuando el cliente te conteste que si, volve a llamar mostrar_productos y ahi si se las mando.`;
      }
      if (yaInsistimos) {
        logEtapa('filtro_relajado_forzado', telefonoCliente, { relajado: busqueda.relajado });
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
        // Lo que se encontro por nombre tambien es mostrable: existe de
        // verdad y el cliente lo pidio explicitamente.
        ...contexto.filter((c) => tieneStock(c)).map((c) => c.id),
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
      // Solo se bloquea el reenvio DENTRO DEL MISMO TURNO (evita que el modelo
      // mande la misma tarjeta tres veces seguidas). Si el cliente vuelve a
      // pedirlo en otro mensaje, se le manda de nuevo: negarle una tarjeta que
      // pidio porque "ya se la mostraron" hace 20 mensajes es tratarlo mal, y
      // ademas en WhatsApp ya la perdio de vista.
      const mostradosEnTurno = helpers.productosMostradosEnTurno || [];
      const idsNuevos = ids.filter((id) => !mostradosEnTurno.includes(id));
      if (ids.length && idsNuevos.length === 0) {
        const restantes = paginar(busqueda.resultados, yaEnviadas).pagina.length;
        return `Ya le mandaste esas tarjetas en este mismo mensaje: no las repitas. ${restantes ? 'Quedan otras opciones sin mostrar: si quiere ver mas, llama a ver_mas_productos.' : `Son las ${busqueda.total} opciones reales de esta busqueda.`}`;
      }
      // Nunca mas de una pagina de golpe, aunque el modelo pida diez IDs.
      ids = idsNuevos.slice(0, MAX_PRODUCTOS_A_MOSTRAR);

      // ...pero tampoco MENOS de una pagina: si el modelo pidio 1 sola
      // tarjeta habiendo 3 para mostrar, se completan las que faltan. Sin
      // esto la IA manda una tarjeta y "resuelve" el resto describiendolo en
      // texto plano, que es como empezo el bug de la foto equivocada (ver
      // docs/03, punto 7). El tope sigue siendo la pagina actual.
      //
      // EXCEPCION - pedido puntual: si TODO lo que se va a mostrar salio de
      // buscar_producto, es porque el cliente nombro ese producto. Ahi el
      // relleno no ayuda, molesta: pidio uno y recibia tres, con el suyo
      // ultimo. Se le muestra exactamente lo que pidio. Cuando esta
      // explorando ("que modelos tienen?") el relleno sigue igual que antes.
      if (esPedidoPuntual) {
        logEtapa('pedido_puntual_sin_relleno', telefonoCliente, { ids });
      } else {
        for (const c of paginar(busqueda.resultados, mostradosEnTurno).pagina) {
          if (ids.length >= MAX_PRODUCTOS_A_MOSTRAR) break;
          if (!ids.includes(c.id)) ids.push(c.id);
        }
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
      const foto = fotoParaMostrar(producto, leadActual || {});

      // Cuando el cliente pide fotos de un color puntual se mandan TODAS las
      // de ese color (hasta el tope del turno), no una sola. Para la tarjeta
      // alcanza con la primera.
      let aEnviar = toolCall.name === 'enviar_fotos_producto'
        ? (foto.urls || []).filter((u) => !urlsEnviadas.includes(u)).slice(0, MAX_FOTOS_POR_TURNO - (helpers.fotosEnviadasEnTurno || 0))
        : (foto.url ? [foto.url] : []);

      // El control de "ya se la mandé" es por FOTO, no por producto. Antes se
      // cortaba si el producto ya se habia mostrado, asi que pedir otro color
      // del mismo par devolvia "ya te envie todas las fotos" sin mandar nada
      // - y el bot se lo repetia al cliente. Bug real reportado con capturas.
      // Solo cuenta como "ya se la mandaste" si esa foto EXISTE y ya salio.
      // Si el color pedido directamente no tiene imagen, no es un duplicado:
      // se sigue de largo para que el aviso le explique al cliente que de ese
      // color no hay foto (y le ofrezca otra como referencia).
      if (toolCall.name === 'enviar_fotos_producto' && !aEnviar.length && (foto.urls || []).length) {
        const deEseColor = leadActual?.color ? ` de ${leadActual.color}` : '';
        return `Esas fotos${deEseColor} ya se las mandaste en esta conversacion (mira el historial). NO digas que se las estas mandando de nuevo. ${foto.coloresConFoto.length > 1 ? `Los colores con foto de este producto son: ${foto.coloresConFoto.join(', ')} - si quiere ver otro, decilo y mandale ese.` : 'Preguntale si quiere ver otro producto o avanzar con el pedido.'}`;
      }

      const mediaUrl = aEnviar[0] || null;

      // TOOL_SUCCESS / TOOL_FAILED de verdad: antes se asumia que el envio
      // habia salido bien y el texto decia "te mande la foto" aunque hubiera
      // fallado. Ahora se mira el resultado real de la API de WhatsApp.
      let envioOk = true;
      let errorEnvio = null;
      if (conexion && conexion.estado === 'CONECTADO' && aEnviar.length) {
        const resultados = await wa.enviarImagenes(conexion, telefonoCliente, aEnviar, caption);
        const fallo = (resultados || []).find((r) => !r.ok);
        envioOk = !fallo;
        errorEnvio = fallo ? fallo.error : null;
      } else if (conexion && conexion.estado === 'CONECTADO') {
        const envio = await wa.enviarTexto(conexion, telefonoCliente, caption);
        envioOk = envio.ok;
        errorEnvio = envio.error || null;
      } else if (aEnviar.length && fotosParaMostrar) {
        // Sin conexion real (modo de prueba en el panel): se registran las
        // fotos para que el chat de prueba las muestre como imagenes de
        // verdad, no solo como texto.
        for (const u of aEnviar) fotosParaMostrar.push({ url: u, caption });
      }
      if (envioOk) urlsEnviadas.push(...aEnviar);

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
      helpers.fotosEnviadasEnTurno = (helpers.fotosEnviadasEnTurno || 0) + aEnviar.length;
      if (toolCall.name !== 'enviar_fotos_producto') {
        helpers.tarjetasEnTurno = (helpers.tarjetasEnTurno || 0) + 1;
        helpers.productosMostradosEnTurno = [...(helpers.productosMostradosEnTurno || []), producto.id];
      }
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
        contexto: {
          ...(clienteFinal.contexto || {}),
          fotosEnviadas: nuevasEnviadas,
          // Se recortan a las ultimas 60: es memoria de una conversacion, no
          // un historial permanente.
          urlsFotosEnviadas: [...new Set(urlsEnviadas)].slice(-60),
        },
        productosMostrados: mostradosNuevos,
      },
    });

    // Complemento (no reemplazo) de la tarjeta: un producto puntual -> su
    // pagina de detalle; varios -> la lista filtrada con el MISMO criterio
    // que ya se uso para buscarlos, nunca el catalogo generico completo.
    let linkWeb = null;
    if (toolCall.name !== 'enviar_fotos_producto') {
      if (productos.length === 1) {
        linkWeb = await linkCatalogoWeb(helpers, `/producto/${productos[0].id}`);
      } else if (productos.length > 1) {
        const params = new URLSearchParams();
        if (leadActual?.categoriaInteres) params.set('categoria', leadActual.categoriaInteres);
        if (leadActual?.color) params.set('color', leadActual.color);
        if (leadActual?.talla) params.set('talla', leadActual.talla);
        if (leadActual?.marca) params.set('marca', leadActual.marca);
        linkWeb = await linkCatalogoWeb(helpers, `?${params.toString()}`);
      }
    }
    // Guardado en helpers (no solo en el string que le devolvemos al
    // modelo): asi el codigo puede garantizar en la vuelta final que el
    // link de verdad le llega al cliente, sin depender de que el modelo se
    // acuerde de copiarlo en su texto (bug real: lo mencionaba "opcional" y
    // el modelo simplemente no lo mandaba nunca).
    if (linkWeb) helpers.linkWebPendiente = linkWeb;

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
      linkWeb,
    });
  }

  if (toolCall.name === 'buscar_producto') {
    // Busca en TODO el catalogo de la empresa, sin los filtros de la
    // conversacion: el cliente nombro algo puntual y merece una respuesta
    // sobre si existe o no, no sobre si calza con el color que pidio antes.
    const buscado = String(args.nombre || '').trim();
    if (!buscado) return 'Decime que nombre busco.';

    const { conStock, agotados } = buscarPorNombre(contexto, buscado);
    // El cliente nombro estos productos: se anotan para que mostrar_productos
    // NO les agregue relleno despues (ver "pedido puntual" mas abajo). Bug
    // real con capturas: pidio "Zapatillas Park St 2.0" y recibio tres
    // tarjetas, la suya ultima.
    helpers.idsPedidosPorNombre = [...new Set([...(helpers.idsPedidosPorNombre || []), ...conStock.map((p) => p.id)])];
    logEtapa('busqueda_por_nombre', telefonoCliente, { buscado, conStock: conStock.length, agotados: agotados.length });

    if (!conStock.length && !agotados.length) {
      // El nombre literal no matcheo nada: antes de decir que no existe, se
      // intenta un fallback semantico (embeddings) por si el cliente uso
      // otra palabra para lo mismo ("remera" cuando el catalogo dice
      // "polera"). Nunca reemplaza el matching literal, solo es la ultima
      // red de seguridad antes de negar que algo existe.
      const idsConStock = contexto.filter((p) => tieneStock(p)).map((p) => p.id);
      const idsSimilares = await buscarPorSimilitud(empresaId, buscado, idsConStock, 3);
      const porSimilitud = idsSimilares.map((id) => contexto.find((p) => p.id === id)).filter(Boolean);
      if (porSimilitud.length) {
        logEtapa('busqueda_semantica_encontro', telefonoCliente, { buscado, ids: idsSimilares });
        return `No hay ningun producto con ese nombre exacto, pero esto es lo mas parecido en significado que se encontro en el catalogo:
${formatearProductos(porSimilitud, moneda)}
Ofreceselo como posible coincidencia (no digas que es exactamente lo que pidio, aclara que es lo mas parecido) y mostraselo con mostrar_productos si le interesa.`;
      }
      return `Buscado "${buscado}" en TODO el catalogo: no existe ningun producto con ese nombre. Ahora si podes decirle con seguridad que no lo manejan, y ofrecerle lo que si hay.`;
    }
    if (!conStock.length) {
      return `"${agotados.map((p) => p.nombre).join(', ')}" SI existe en el catalogo pero esta SIN STOCK. Deciselo asi: que lo manejan pero ahora no hay, y ofrecele las opciones que si tienen. NUNCA digas que no lo conoces.`;
    }
    return `ENCONTRADO en el catalogo, con stock:
${formatearProductos(conStock.slice(0, MAX_PRODUCTOS_A_MOSTRAR), moneda)}
${agotados.length ? `(Ademas existe "${agotados.map((p) => p.nombre).join(', ')}" pero sin stock: no lo ofrezcas.)
` : ''}
Mostraselo YA con mostrar_productos usando esos IDs. PROHIBIDO decirle que no lo tenes: lo tenes.`;
  }

  if (toolCall.name === 'agregar_al_carrito' || toolCall.name === 'ver_carrito' || toolCall.name === 'quitar_del_carrito') {
    const precioTexto = (monto) => formatearPrecio(monto, moneda);
    let items = carritoDe(clienteFinal.contexto || {}, conversacionId);

    if (toolCall.name === 'ver_carrito') {
      return `Esto lleva el cliente:
${resumenCarrito(items, precioTexto)}
${items.length ? 'Leeselo tal cual. Si quiere cerrar, pedile lo que falte (nombre, entrega, forma de pago) y llama a confirmar_pedido.' : 'Esta vacio: invitalo a elegir algo de lo que le mostraste.'}`;
    }

    if (toolCall.name === 'quitar_del_carrito') {
      const antes = items.length;
      items = quitarItem(items, { productoId: Number(args.idProducto), varianteId: args.idVariante ? Number(args.idVariante) : null });
      await prisma.clienteFinal.update({
        where: { id: clienteFinal.id },
        data: { contexto: guardarCarrito(clienteFinal.contexto || {}, conversacionId, items) },
      });
      logEtapa('carrito_quitar', telefonoCliente, { quedan: items.length });
      return antes === items.length
        ? 'Ese producto no estaba en el carrito. Deciselo con naturalidad y mostrale lo que si lleva.'
        : `Listo, lo saque. Ahora el carrito tiene:
${resumenCarrito(items, precioTexto)}`;
    }

    // --- agregar_al_carrito ---
    const producto = await prisma.producto.findFirst({
      where: { id: Number(args.idProducto), empresaId, activo: true },
      include: { variantes: { where: { activa: true } } },
    });
    if (!producto) return 'Ese producto no existe o no esta activo. Usa el ID exacto de una tarjeta que le hayas mostrado.';

    const cantidad = Math.max(1, Number(args.cantidad) || 1);
    let variante = null;
    if (producto.variantes.length) {
      if (!args.idVariante) {
        const opciones = producto.variantes
          .filter((v) => v.stock > 0)
          .map((v) => `- [Variante ID ${v.id}] ${formatearAtributosVariante(v.atributos)} - Stock: ${v.stock}`)
          .join('\n');
        return `Falta saber cual combinacion eligio de "${producto.nombre}". Esto es lo que hay con stock (ya lo vio en la tarjeta):
${opciones}
Preguntaselo en una sola frase y volve a llamar agregar_al_carrito con el idVariante.`;
      }
      variante = producto.variantes.find((v) => v.id === Number(args.idVariante));
      if (!variante) return `Esa variante no es de "${producto.nombre}". Mira las de la tarjeta y usa el ID exacto.`;
      if (variante.stock < cantidad) {
        return `No hay stock suficiente de "${producto.nombre}" (${formatearAtributosVariante(variante.atributos)}): quedan ${variante.stock}. Deciselo y ofrecele esa cantidad u otra combinacion.`;
      }
    } else if (producto.stock < cantidad) {
      return `No hay stock suficiente de "${producto.nombre}": quedan ${producto.stock}.`;
    }

    const precioUnitario = Number(variante ? (variante.precio ?? producto.precio) : producto.precio);
    items = agregarItem(items, {
      productoId: producto.id,
      varianteId: variante ? variante.id : null,
      nombre: variante ? `${producto.nombre} (${formatearAtributosVariante(variante.atributos)})` : producto.nombre,
      precio: precioUnitario,
      cantidad,
      agregadoEn: new Date().toISOString(),
    });

    await prisma.clienteFinal.update({
      where: { id: clienteFinal.id },
      data: {
        contexto: guardarCarrito(clienteFinal.contexto || {}, conversacionId, items),
        productoFavoritoId: producto.id,
        varianteFavoritaId: variante ? variante.id : null,
        estadoConversacion: 'INTENCION_DE_COMPRA',
      },
    });
    if (leadActual) leadActual.productoFavoritoId = producto.id;
    logEtapa('carrito_agregar', telefonoCliente, { productoId: producto.id, varianteId: variante?.id || null, cantidad, itemsEnCarrito: items.length });

    return `TOOL_SUCCESS: agregado al carrito.
${resumenCarrito(items, precioTexto)}

Tu texto ahora: confirmale en una linea que lo agregaste y preguntale SI DESEA VER ALGO MAS. NUNCA le ofrezcas ni menciones otro producto por tu cuenta en este mensaje: si el mismo pide ver algo especifico, ahi si lo buscas. Si dice que si quiere ver mas, llama a mostrar_categorias. Si dice que no, cerra: pedile nombre, como quiere recibirlo y forma de pago, y despues llama a confirmar_pedido.`;
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
      return `TODAVIA NO ${accion}: es una entrega a domicilio y falta la ubicacion. Pedile que comparta su UBICACION (el pin de WhatsApp) o que pegue el link de Google Maps - nunca le aceptes una direccion escrita a mano como unico dato. Guardala con actualizar_datos_lead y volve a llamar.`;
    }
    // No alcanza con tener texto en direccionEntrega: tiene que resolver a
    // coordenadas reales. Antes se aceptaba cualquier direccion escrita a
    // mano ("Av. Ballivian 1234"), que despues no se puede ubicar en un
    // mapa ni usar para coordinar la entrega. Si ya comparte el pin nativo
    // de WhatsApp, ubicacionLat/Lng ya estan guardadas y esto ni se corre.
    if (clienteFinal.tipoEntrega === 'DOMICILIO' && !clienteFinal.ubicacionLat) {
      const resuelto = await resolverCoordenadas(clienteFinal.direccionEntrega);
      if (resuelto) {
        await prisma.clienteFinal.update({
          where: { id: clienteFinal.id },
          data: { ubicacionLat: resuelto.lat, ubicacionLng: resuelto.lng },
        }).catch(() => {});
        clienteFinal.ubicacionLat = resuelto.lat;
        clienteFinal.ubicacionLng = resuelto.lng;
      } else {
        return `TODAVIA NO ${accion}: lo que guardaste como direccion ("${clienteFinal.direccionEntrega}") no es una ubicacion real que se pueda ubicar en un mapa. Pedile especificamente que comparta su UBICACION desde WhatsApp (el clip -> Ubicacion) o que pegue el link de Google Maps de donde esta - una direccion escrita a mano NO alcanza. Guardala con actualizar_datos_lead y volve a llamar.`;
      }
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

    // El carrito es la UNICA fuente de verdad, siempre - nunca lo que el
    // modelo diga que hay que cobrar. Antes se le permitia mandar su propia
    // lista de items "por si acaso", y esa via de escape es justo lo que
    // volvio a perder un producto real: el modelo mando solo lo ultimo que
    // habia conversado (la camisa) y el carrito real tenia ademas unas
    // zapatillas, que desaparecieron del pedido sin ningun aviso. El
    // carrito ya es confiable (se arma con agregar_al_carrito y desde la
    // web, nunca a mano por el modelo), asi que no hace falta ni es seguro
    // dejar que lo reemplace.
    const itemsPedidos = itemsParaPedido(carritoDe(clienteFinal.contexto || {}, conversacionId));
    if (!itemsPedidos.length) {
      return 'El carrito esta vacio: no hay nada que confirmar. Invitalo a elegir algo de lo que le mostraste.';
    }
    // Aparte de `items` (que va tal cual a Prisma en crear_pedido, sin
    // campos extra): un mapa productoId:varianteId -> agregadoEn, solo para
    // poder anotar en el resumen de confirmar_pedido que items estan
    // esperando de una sesion anterior.
    const agregadoEnPorLinea = new Map(itemsPedidos.map((i) => [`${i.idProducto}:${i.idVariante || 0}`, i.agregadoEn]));

    const items = [];
    let total = 0;
    for (const item of itemsPedidos) {
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
      // Items agregados hace rato (de una sesion que no se llego a cerrar)
      // se marcan aparte: el cliente nunca deberia sorprenderse con algo
      // que ya se habia olvidado mezclado en silencio en su pedido nuevo.
      const UMBRAL_ITEM_VIEJO_MS = 2 * 60 * 60 * 1000;
      const ahora = Date.now();
      const esItemViejo = (i) => {
        const agregadoEn = agregadoEnPorLinea.get(`${i.productoId}:${i.varianteId || 0}`);
        return agregadoEn && (ahora - new Date(agregadoEn).getTime()) > UMBRAL_ITEM_VIEJO_MS;
      };
      const hayItemsViejos = items.some(esItemViejo);
      const lineas = items.map((i) => `- ${i.cantidad}x ${i.nombre} — ${formatearPrecio(i.precio, moneda)} c/u${esItemViejo(i) ? ' (ya lo tenia en el carrito de antes)' : ''}`).join('\n');
      const entrega = clienteFinal.tipoEntrega === 'RECOJO'
        ? `Retira en la tienda: ${config.direccionTienda}`
        : `Entrega a domicilio: ${clienteFinal.direccionEntrega}`;
      logEtapa('resumen_confirmado', telefonoCliente, { items: items.length, total, tipoEntrega: clienteFinal.tipoEntrega, hayItemsViejos });
      return `TOOL_SUCCESS. Resumen REAL del pedido (todos estos datos salen de la base, usalos tal cual, no los cambies ni redondees):
${lineas}
Total: ${formatearPrecio(total, moneda)}
A nombre de: ${clienteFinal.nombre}
${entrega}
Forma de pago: ${clienteFinal.formaPago.toLowerCase()}

Tu texto ahora: leele este resumen al cliente de forma clara y ordenada y preguntale si esta todo correcto.${hayItemsViejos ? ' Los items marcados "(ya lo tenia en el carrito de antes)" son de una compra que el cliente no llego a cerrar hace un rato - mencionaselo con naturalidad ("ademas segui con lo que tenias de antes: X"), por si ya no los quiere.' : ''} NO llames a crear_pedido en este turno: espera a que el cliente confirme que si.`;
    }

    if ((clienteFinal.contexto || {}).resumenConfirmado !== firmaItems) {
      return 'TODAVIA NO crees el pedido: el cliente no confirmo ESTE pedido exacto todavia (o cambio algo desde el resumen anterior). Llama primero a confirmar_pedido con estos mismos items, leele el resumen, y crea el pedido recien cuando te diga que esta todo bien.';
    }

    // El cliente muchas veces NO comparte su ubicacion en vivo (eso es lo
    // unico que llenaba ubicacionLat/Lng antes): pega el link de Google
    // Maps como texto en direccionEntrega. Si todavia no hay coordenadas
    // guardadas, se intenta resolver ese link ahora - asi el pedido puede
    // tener un mapa real sin depender de que comparta el pin nativo. Nunca
    // inventa nada: si no se puede resolver, sigue sin coordenadas y el
    // pedido queda igual que antes (solo la direccion en texto).
    let ubicacionLat = clienteFinal.ubicacionLat;
    let ubicacionLng = clienteFinal.ubicacionLng;
    if (clienteFinal.tipoEntrega !== 'RECOJO' && !ubicacionLat && clienteFinal.direccionEntrega) {
      const resuelto = await resolverCoordenadas(clienteFinal.direccionEntrega);
      if (resuelto) {
        ubicacionLat = resuelto.lat;
        ubicacionLng = resuelto.lng;
        // Se guarda tambien en el cliente para que una proxima compra ya
        // la tenga sin volver a resolver el link.
        await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: { ubicacionLat, ubicacionLng } }).catch(() => {});
      }
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
          entregaLat: clienteFinal.tipoEntrega === 'RECOJO' ? null : ubicacionLat,
          entregaLng: clienteFinal.tipoEntrega === 'RECOJO' ? null : ubicacionLng,
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
          contexto: contextoSinCarrito({ ...(clienteFinal.contexto || {}), resumenConfirmado: null }),
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
    // Los nombres de las categorias NUNCA dependen de datos del cliente
    // (genero, etc.) - eso solo importa para decidir que PRODUCTOS mostrar
    // adentro de una categoria, no para saber que categorias existen. Esa
    // proteccion real ya vive donde corresponde: mostrar_productos (linea
    // ~1795) y mostrar_tarjeta_categoria ya chequean preguntasInicialesFaltantes
    // antes de mostrar nada con precio/stock/foto. Antes este handler
    // bloqueaba TAMBIEN el menu de nombres, lo cual generaba que el cliente
    // no pudiera ni ver que rubros existen hasta contestar una pregunta que
    // no tenia nada que ver con eso - pedido explicito del dueño del negocio.
    // La lista la arma el sistema con lo que existe DE VERDAD y tiene stock.
    // Antes esto mandaba un link al catalogo web: el cliente tenia que salir
    // de WhatsApp, abrir una pagina y volver. Ahora la conversacion no se
    // interrumpe.
    const arbol = arbolDeCategorias(contexto, leadActual || {});
    if (!arbol.length) {
      return 'No hay ningun producto con stock en este momento (TOOL_FAILED). Decilo con transparencia y ofrece derivar_a_asesor para avisarle cuando haya reposicion.';
    }

    // Si la tienda vende UN SOLO rubro y ese rubro no se subdivide en tipos,
    // no hay nada que elegir: preguntarle "¿te muestro esta categoria?" es un
    // paso de mas que solo frena la venta (bug real reportado: el cliente
    // contestaba "si, por favor" y el bot igual no mostraba nada). Se le
    // asigna esa categoria directo y se pasa a mostrar sus productos.
    if (leadActual && arbol.length === 1 && !arbol[0].subcategorias.length) {
      const unico = arbol[0];
      if (leadActual.categoriaId !== unico.id) {
        const datosCategoria = { categoriaId: unico.id, categoriaInteres: unico.nombre };
        await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: datosCategoria });
        Object.assign(leadActual, datosCategoria);
      }
      const categoriaCompleta = categoriaDelLead(contexto, leadActual);
      const faltantesObligatorios = atributosFaltantes(categoriaCompleta, leadActual, 'OBLIGATORIO');
      if (faltantesObligatorios.length) {
        logEtapa('menu_rubro_unico_auto', telefonoCliente, { rubro: unico.nombre, faltantesObligatorios });
        return `TOOL_SUCCESS. Esta tienda vende solo "${unico.nombre}" (ya se la asigne como su categoria de interes, no le preguntes si quiere verla). Antes de mostrar productos todavia falta saber ${faltantesObligatorios.join(' y ')}. Preguntaselo de forma natural y guardalo con actualizar_datos_lead.`;
      }
      // Regla del negocio: ni en el rubro unico se saltea a mostrar_productos
      // directo - se manda la tarjeta de categoria como en cualquier otro
      // caso, para mantener la regla sin excepciones raras (Fix D).
      const resultadoTarjeta = await ejecutarFuncion({ name: 'mostrar_tarjeta_categoria', arguments: {} }, contexto, helpers);
      logEtapa('menu_rubro_unico_auto', telefonoCliente, { rubro: unico.nombre, tarjetaCategoria: true });
      return resultadoTarjeta;
    }

    // Si el cliente ya eligio un rubro, el menu baja un nivel: se le muestran
    // los tipos de ESE rubro, no los rubros otra vez. PERO si el mensaje de
    // este turno pide explicitamente ver todo el catalogo ("que mas venden",
    // "solo vendes zapatillas?"), se ignora la categoria ya fijada y se
    // muestran los rubros - sin esto el cliente quedaba pegado en la
    // categoria anterior sin forma de salir (extraerFiltros solo sabe entrar
    // a una categoria, nunca salir de una).
    const quiereCatalogoCompleto = pareceQuererCatalogoCompleto(helpers.mensajeCliente);
    if (quiereCatalogoCompleto) {
      logEtapa('menu_catalogo_completo_forzado', telefonoCliente, {});
    }
    const categoriaActual = quiereCatalogoCompleto ? null : categoriaDelLead(contexto, leadActual || {});
    const rubroElegido = categoriaActual
      ? arbol.find((r) => r.id === categoriaActual.id || r.subcategorias.some((s) => s.id === categoriaActual.id))
      : null;

    if (rubroElegido && rubroElegido.subcategorias.length && !rubroElegido.subcategorias.some((s) => s.id === categoriaActual.id)) {
      // Mismo chequeo que ya hace el camino de "un solo rubro" unas lineas
      // arriba, antes de listar los tipos: si el rubro tiene un atributo
      // obligatorio propio (ej. Genero), hay que preguntarlo primero - sin
      // esto, la lista de tipos salia sin filtrar por ese dato (bug real
      // reportado: pregunta abierta e improvisada en vez de la cerrada que
      // corresponde).
      const faltantesObligatorios = atributosFaltantes(categoriaActual, leadActual, 'OBLIGATORIO');
      if (faltantesObligatorios.length) {
        logEtapa('menu_subcategorias_bloqueado_atributos', telefonoCliente, { rubro: rubroElegido.nombre, faltantesObligatorios });
        return `TOOL_SUCCESS. Antes de mostrarte los tipos de "${rubroElegido.nombre}" falta saber ${faltantesObligatorios.join(' y ')}. Preguntaselo de forma natural y guardalo con actualizar_datos_lead.`;
      }
      const lista = rubroElegido.subcategorias.map((s, i) => `${i + 1}. ${s.nombre}`).join('\n');
      logEtapa('menu_subcategorias', telefonoCliente, { rubro: rubroElegido.nombre, opciones: rubroElegido.subcategorias.length });
      return `TOOL_SUCCESS. Dentro de "${rubroElegido.nombre}" hay estos tipos (son los reales con stock, no inventes otros ni los renombres):\n${lista}\n\nTu texto ahora: pasale esta lista tal cual, numerada, una por linea, y preguntale cual quiere ver. Nada de descripciones ni de mandar productos todavia.`;
    }

    const lista = arbol.map((r, i) => `${i + 1}. ${r.nombre}`).join('\n');
    logEtapa('menu_rubros', telefonoCliente, { opciones: arbol.length });
    return `TOOL_SUCCESS. Esto es lo que vende la tienda (rubros reales con stock, no inventes otros ni los renombres):\n${lista}\n\nTu texto ahora: pasale esta lista tal cual, numerada, una por linea, y preguntale cual le interesa. NO mandes ningun link, NO describas los rubros y NO muestres productos todavia: primero que elija.`;
  }

  if (toolCall.name === 'mostrar_tarjeta_categoria') {
    const categoriaActual = categoriaDelLead(contexto, leadActual || {});
    if (!categoriaActual) {
      return 'Todavia no hay ninguna categoria puntual elegida (TOOL_FAILED): primero hay que saber que categoria le interesa antes de poder mandar esta tarjeta.';
    }

    // GATE EN CODIGO, mismo que mostrar_productos (linea ~1773): mientras
    // falten datos que la tienda marco como imprescindibles (ej. Genero), no
    // se manda ninguna tarjeta - ni de categoria ni de producto. Bug real
    // detectado en test: al redirigir mostrar_productos hacia esta tool
    // (Fix B, regla de "solo tarjeta de categoria"), se colaba la tarjeta
    // sin haber preguntado el atributo obligatorio todavia.
    const faltanIniciales = preguntasInicialesFaltantes(config, leadActual, contexto);
    if (faltanIniciales.length) {
      logEtapa('tarjeta_categoria_bloqueada_preguntas_iniciales', telefonoCliente, { faltan: faltanIniciales });
      return `TODAVIA NO le mandes esta tarjeta (TOOL_FAILED): falta saber ${faltanIniciales.join(' y ')}, que esta tienda pide para cualquier busqueda. Preguntá SOLO "${faltanIniciales[0]}" y guardalo con actualizar_datos_lead.`;
    }
    const faltantesObligatorios = atributosFaltantes(categoriaActual, leadActual, 'OBLIGATORIO');
    if (faltantesObligatorios.length) {
      logEtapa('tarjeta_categoria_bloqueada_atributos', telefonoCliente, { categoria: categoriaActual.nombre, faltantesObligatorios });
      return `TODAVIA NO le mandes esta tarjeta (TOOL_FAILED): falta saber ${faltantesObligatorios.join(' y ')} de "${categoriaActual.nombre}", que esta tienda marco como imprescindible. Preguntá SOLO "${faltantesObligatorios[0]}" y guardalo con actualizar_datos_lead.`;
    }

    // Una sola vez por categoria en la conversacion: repetirla es spam.
    const yaMostradas = (clienteFinal.contexto || {}).tarjetasCategoriaMostradas || [];
    if (yaMostradas.includes(categoriaActual.id)) {
      return `Ya le mandaste esto de "${categoriaActual.nombre}" antes en esta conversacion (TOOL_FAILED a proposito, no se repite). Si el cliente ya nombro un modelo puntual por su nombre, mostraselo con mostrar_productos; si no nombro nada puntual, preguntale por su nombre cual modelo le interesa - no vuelvas a mandar tarjetas sueltas sin que las nombre.`;
    }

    const resumen = resumenCategoria(contexto, categoriaActual.id);
    if (!resumen.cantidad) {
      return `No hay ningun producto con stock real en "${categoriaActual.nombre}" ahora mismo (TOOL_FAILED, no se mando nada). Decilo con transparencia, no inventes disponibilidad.`;
    }

    const params = new URLSearchParams();
    params.set('categoria', categoriaActual.nombre);
    const linkWeb = await linkCatalogoWeb(helpers, `?${params.toString()}`);

    const caption = `*${categoriaActual.nombre}*\n\n`
      + `🛍️ Tenemos ${resumen.cantidad} modelo${resumen.cantidad === 1 ? '' : 's'} disponible${resumen.cantidad === 1 ? '' : 's'}\n`
      + `💰 Desde ${formatearPrecio(resumen.precioDesde, moneda)}\n`
      + (resumen.destacados.length ? `✨ Por ejemplo: ${resumen.destacados.join(', ')}\n` : '')
      + (linkWeb ? `\n👉 Ver todos los modelos con foto, talla y color: ${linkWeb}` : '');

    // Si la tienda no cargo una foto de categoria a mano, se usa la de uno
    // de sus productos reales (ver fotoDestacada en resumenCategoria) - la
    // subida a mano sigue teniendo prioridad si existe.
    const imagenParaTarjeta = categoriaActual.imagenUrl || resumen.fotoDestacada;

    // Mismo patron que mostrar_productos: solo se afirma exito si el envio
    // real lo confirmo. Sin ninguna foto disponible, se manda el mismo
    // texto sin foto - nunca se inventa una imagen que no existe.
    let envioOk = true;
    if (imagenParaTarjeta && conexion && conexion.estado === 'CONECTADO') {
      const envio = await wa.enviarImagen(conexion, telefonoCliente, imagenParaTarjeta, caption);
      envioOk = envio.ok;
    } else if (conexion && conexion.estado === 'CONECTADO') {
      const envio = await wa.enviarTexto(conexion, telefonoCliente, caption);
      envioOk = envio.ok;
    } else if (imagenParaTarjeta && fotosParaMostrar) {
      // Modo de prueba (sin WhatsApp real conectado): se registra igual que
      // el resto de las tarjetas, para que el chat de prueba la muestre.
      fotosParaMostrar.push({ url: imagenParaTarjeta, caption });
    }

    if (!envioOk) {
      logEtapa('tarjeta_categoria_fallida', telefonoCliente, { categoria: categoriaActual.nombre });
      return 'No se pudo mandar la tarjeta de categoria (TOOL_FAILED, fallo el envio real). NO digas que se la mandaste.';
    }

    await prisma.clienteFinal.update({
      where: { id: clienteFinal.id },
      data: { contexto: { ...(clienteFinal.contexto || {}), tarjetasCategoriaMostradas: [...new Set([...yaMostradas, categoriaActual.id])] } },
    });
    // Igual que mostrar_productos (linea ~2050): marca que este turno SI
    // mando una tarjeta real, para que los detectores de texto vago/mentiras
    // ("todavia no mostraste nada") no disparen en falso despues de un envio
    // exitoso de la tarjeta de categoria.
    helpers.tarjetasEnTurno = (helpers.tarjetasEnTurno || 0) + 1;
    logEtapa('tarjeta_categoria_enviada', telefonoCliente, { categoria: categoriaActual.nombre, cantidad: resumen.cantidad, conImagen: Boolean(imagenParaTarjeta), imagenPropia: Boolean(categoriaActual.imagenUrl) });
    return `TOOL_SUCCESS: se le mando la tarjeta real de "${categoriaActual.nombre}" (${imagenParaTarjeta ? 'con foto' : 'sin foto, ni la tienda ni sus productos tienen una cargada'}).\nTu texto ahora: UNA linea corta y natural invitandolo a mirar los ${categoriaActual.nombre.toLowerCase()} (ej: "Echale un vistazo a los ${categoriaActual.nombre.toLowerCase()} que tenemos, a ver si alguno te gusta"). NO digas la palabra "tarjeta" ni "te envie/mande esto" - hablale del producto/categoria directamente, no de lo que le llego. NO repitas los datos (cantidad, precio, modelos, link) que ya estan ahi arriba.`;
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
              // padre.atributos: sin esto, categoriaDelLead devolviendo el
              // RUBRO (via p.categoria.padre, cuando el lead esta parado en
              // el rubro y el producto es de una subcategoria) traia un
              // objeto sin atributos - atributosFaltantes nunca podia ver un
              // atributo obligatorio configurado en el rubro mismo. Bug real
              // encontrado escribiendo el test de este fix.
              include: { variantes: { where: { activa: true }, orderBy: { id: 'asc' } }, categoria: { include: { atributos: true, padre: { include: { atributos: true } } } } },
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

  // Si paso MUCHISIMO tiempo sin escribir, la intencion de compra (categoria,
  // talla, color, marca, presupuesto, favorito) tambien se olvida - ver
  // intencionReiniciadaPorInactividad. Se calcula ANTES de extraer filtros
  // para que, si el mensaje de hoy SI menciona una categoria, no quede
  // protegida de menos por la categoria vieja que se esta por descartar.
  const intencionFresca = intencionReiniciadaPorInactividad(clienteFinal);
  if (intencionFresca) {
    logEtapa('reinicio_por_inactividad_intencion', telefonoCliente, { minutos: MINUTOS_PARA_REINICIAR_INTENCION });
  }

  // Extraccion determinista por codigo: se aplica ANTES de armar el prompt,
  // sin depender de que el modelo llame a actualizar_datos_lead.
  const detectadosDeEsteMensaje = extraerFiltros(textoParaExtraccion, productos, intencionFresca ? null : clienteFinal.categoriaId);
  // Lo que reseteamos por inactividad son valores por defecto: si el mensaje
  // de HOY ya trae algo (ej. menciono una categoria), eso gana.
  const detectados = intencionFresca ? { ...intencionFresca, ...detectadosDeEsteMensaje } : detectadosDeEsteMensaje;

  // Lo mismo para los datos que la tienda pide ANTES de mostrar nada (el gate
  // de preguntasIniciales, tipicamente el Genero). Sin este respaldo, el unico
  // camino para guardar la respuesta era que el modelo llamara a
  // actualizar_datos_lead: cuando no lo hacia, el cliente contestaba "hombre"
  // y el bot volvia a preguntarle el genero una y otra vez.
  const inicialesResueltas = resolverDatosIniciales(textoParaExtraccion, agente.config, clienteFinal, productos);
  if (inicialesResueltas) {
    Object.assign(detectados, inicialesResueltas);
    logEtapa('datos_iniciales_resueltos', telefonoCliente, inicialesResueltas);
  }

  // El cliente estuvo un rato largo sin escribir: se olvida QUE se le mostro,
  // para que si vuelve y pide las zapatillas otra vez se las mande de nuevo en
  // vez de contestarle "ya te las mostre". Lo que dijo (categoria, talla,
  // color, nombre, direccion) se conserva por mas tiempo (ver arriba),
  // pero eventualmente tambien se pierde si paso demasiado.
  const contextoFresco = contextoReiniciadoPorInactividad(clienteFinal.contexto || {});
  if (contextoFresco) {
    detectados.contexto = contextoFresco;
    logEtapa('reinicio_por_inactividad', telefonoCliente, { minutos: MINUTOS_PARA_REINICIAR_VISTOS });
  } else {
    detectados.contexto = { ...(clienteFinal.contexto || {}), ultimoTurnoAt: new Date().toISOString() };
  }

  // El cliente contesto "cualquiera" / "me da igual": eso ES una respuesta.
  // Se anota que no tiene preferencia por lo que se le estaba preguntando, asi
  // el gate se destraba y la busqueda NO se filtra por ese atributo. Sin esto
  // el bot le contestaba "no, tenes que escoger un color antes de seguir" y no
  // salia nunca de ahi (reportado por el negocio).
  if (expresaSinPreferencia(mensajeCliente)) {
    const leadParcial = { ...clienteFinal, ...detectados };
    const categoriaParaPendientes = categoriaDelLead(productos, leadParcial);
    const pendientes = [
      ...preguntasInicialesFaltantes(agente.config, leadParcial, productos),
      ...atributosFaltantes(categoriaParaPendientes, leadParcial, 'OBLIGATORIO'),
      ...atributosFaltantes(categoriaParaPendientes, leadParcial, 'RECOMENDADO'),
    ];
    if (pendientes.length) {
      const yaAnotados = (detectados.contexto || {}).sinPreferencia || [];
      const sinPreferencia = [...new Set([...yaAnotados, ...pendientes])];
      detectados.contexto = { ...detectados.contexto, sinPreferencia };
      logEtapa('cliente_sin_preferencia', telefonoCliente, { atributos: pendientes });
    }
  }

  // Cuenta cuantas veces se le pidio al cliente el mismo dato inicial sin
  // conseguirlo. Al llegar al tope, preguntasInicialesFaltantes deja de
  // bloquear y el cliente puede ver el catalogo igual: es preferible mostrar
  // de mas que dejarlo atrapado contestando siempre lo mismo.
  const leadTrasResolver = { ...clienteFinal, ...detectados };
  const pedidasIniciales = (agente.config && agente.config.preguntasIniciales) || [];
  // OJO: se mira leadYaTiene y no preguntasInicialesFaltantes. Esa funcion ya
  // devuelve [] cuando el contador llego al tope (gate liberado), asi que
  // usarla aca reseteaba el contador justo despues de liberarlo y el gate se
  // volvia a armar en el turno siguiente: el mismo bucle, mas lento.
  const resueltasTodas = pedidasIniciales.every((n) => leadYaTiene(leadTrasResolver, n));
  if (pedidasIniciales.length && !resueltasTodas) {
    const intentos = Number((detectados.contexto || {}).intentosPreguntaInicial || 0) + 1;
    detectados.contexto = { ...detectados.contexto, intentosPreguntaInicial: intentos };
    if (intentos === MAX_INTENTOS_PREGUNTA_INICIAL) {
      logEtapa('gate_inicial_liberado', telefonoCliente, { faltaban: pedidasIniciales, intentos });
    }
  } else if ((clienteFinal.contexto || {}).intentosPreguntaInicial) {
    detectados.contexto = { ...detectados.contexto, intentosPreguntaInicial: 0 };
  }

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
  // El cliente agrego algo al carrito desde el catalogo web (fuera de una
  // tool call del bot, ver POST /catalogo/:slug/producto/:id/carrito en
  // server.js) - se le avisa al modelo como un hecho ya ocurrido para que
  // reaccione solo ("¡buena eleccion!") en vez de que el cliente tenga que
  // repetirselo. Se limpia la marca de una: si el proveedor de IA falla a
  // mitad de turno, se prefiere perder el aviso una vez a repetirlo en bucle.
  let avisoCarritoWeb = null;
  if (lead.contexto && lead.contexto.carritoWebPendiente) {
    const pendiente = lead.contexto.carritoWebPendiente;
    const productoAgregado = productos.find((p) => p.id === pendiente.productoId);
    if (productoAgregado) {
      avisoCarritoWeb = `RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente en este mensaje - paso hace un momento en el catalogo web): el cliente ACABA de agregar esto a su carrito desde la web:\n${fichaProducto(productoAgregado, lead, empresa.moneda)}\n\nTu texto AHORA: saludalo con entusiasmo natural por esa eleccion ("¡buena eleccion!" o similar), confirmale que ya quedo en su carrito, y preguntale si quiere ver algo mas. NUNCA le ofrezcas ni menciones otro producto por tu cuenta. NO le preguntes que producto eligio: ya lo sabes.`;
    }
    try {
      await prisma.clienteFinal.update({
        where: { id: clienteFinal.id },
        data: { contexto: { ...lead.contexto, carritoWebPendiente: null } },
      });
      lead = { ...lead, contexto: { ...lead.contexto, carritoWebPendiente: null } };
    } catch (err) {
      logErrorEtapa('memoria', telefonoCliente, err);
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

  // Deterministico (en codigo, no depende del modelo): el cliente nombro EN
  // SU PROPIO MENSAJE un producto real, ya sea de los candidatos actuales o
  // de algo que ya se le mostro antes en esta conversacion. Si es asi, mas
  // abajo se fuerza que la tarjeta de ESE producto sea la que se manda este
  // turno, sin importar que IDs haya elegido el modelo. Bug real reportado:
  // el cliente escribio "Zapatillas Park St 2.0" (ya mostrada) y el bot le
  // mando tres tarjetas totalmente distintas, mintiendo en el texto que
  // esa era una de ellas.
  const universoNombrable = [
    ...candidatosActuales,
    ...productos.filter((p) => (lead.productosMostrados || []).includes(p.id)),
  ];
  const idsYaVistos = new Set();
  const productoNombradoPorCliente = universoNombrable.find((p) => {
    if (idsYaVistos.has(p.id)) return false;
    idsYaVistos.add(p.id);
    const nombre = normalizarSimple(p.nombre);
    return nombre.length > 5 && normalizarSimple(mensajeCliente).includes(nombre);
  }) || null;

  const previos = historial.map((m) => ({ role: m.rol === 'CLIENTE' ? 'user' : 'assistant', content: m.contenido }));
  // El historial ya incluye el mensaje actual del cliente (se persiste antes
  // de generar la respuesta), asi que "primer mensaje" NO es historial vacio:
  // es que el agente todavia nunca respondio nada en esta conversacion.
  const esPrimerMensaje = !historial.some((h) => h.rol === 'AGENTE');

  const proveedor = proveedorActivo();
  const plan = empresa.suscripcion && empresa.suscripcion.plan;

  // Ruteo por costo: lo dificil (y lo que justifica el modelo caro) es
  // entender que quiere el cliente y elegir bien que mostrarle - no saludar
  // ni pasar el menu de categorias. Mientras el cliente todavia no eligio
  // ninguna categoria (candidatosActuales SIEMPRE tiene algo si hay stock,
  // aunque no haya dicho nada: sin categoria, buscarConFallback no filtra
  // nada y devuelve todo el catalogo - por eso no sirve como señal) ni tiene
  // nada en el carrito/favorito, el turno es "de orientacion": saludo, ayuda
  // generica, ver el menu de categorias. Ahi se usa el modelo economico sin
  // importar el plan. En cuanto sabemos que categoria le interesa (lo
  // detecta el codigo, no la IA, apenas lo dice) o ya eligio un favorito, se
  // pasa al modelo del plan: ahi es donde de verdad se juega entender la
  // necesidad del cliente y no trabarse mostrando.
  const esTurnoSimple = !lead.categoriaInteres && !lead.productoFavoritoId;
  const modelo = esTurnoSimple ? modeloEconomico(proveedor) : modeloParaPlan(proveedor, plan);
  logEtapa('modelo_elegido', telefonoCliente, { proveedor, modelo, esTurnoSimple, plan: plan && plan.codigo });
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
  //
  // Se cuentan los mensajes del CLIENTE en la conversacion, no historial.length:
  // el historial viene cortado a los ultimos 20 mensajes, asi que en una charla
  // larga su largo se queda clavado y el numero de turno deja de avanzar. Con
  // eso, el sistema nunca se enteraba de que el cliente habia contestado y le
  // volvia a pedir permiso una y otra vez - bucle real en produccion: el
  // cliente dijo "si quiero ver" tres veces y el bot seguia preguntando.
  const turno = conversacionId
    ? await prisma.mensaje.count({ where: { conversacionId, rol: 'CLIENTE' } }).catch(() => historial.length)
    : historial.length;

  // Compras reales anteriores del mismo cliente (Opcion A de
  // docs/05-propuesta-personalizacion-ia.md): se lee UNA vez por turno, no
  // se inventa nada - si no hay pedidos, el prompt simplemente no menciona
  // el bloque. Se busca por telefono/empresa (no por clienteFinal.id) por si
  // el registro de lead se recreo en algun momento.
  const pedidosPrevios = await prisma.pedido.findMany({
    where: { empresaId: empresa.id, cliente: { telefono: telefonoCliente }, estado: { not: 'CANCELADO' } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    include: { items: { include: { variante: true, producto: { include: { categoria: true } } } } },
  }).catch(() => []);
  const helpers = { empresaId: empresa.id, empresaSlug: empresa.slug, telefonoCliente, conexion: agente.conexion, fotosParaMostrar, conversacionId, baseUrl: opciones.baseUrl, config: agente.config, moneda: empresa.moneda || 'BOB', turno, mensajeCliente };

  // DECISION DETERMINISTICA (backend, no la IA), un paso antes de la tarjeta
  // de categoria de abajo: sin ninguna categoria elegida todavia (ni rubro
  // ni subcategoria) y sin nombrar nada puntual, el MENU de rubros se manda
  // directo - es siempre la misma lista real, no hay nada que interpretar.
  // Pedido explicito del dueño despues de un bug real: el cliente contesto
  // el genero que la tienda pide y el bot respondio "tuve un problema" antes
  // de mostrar el menu, aunque mostrar_categorias nunca falla de verdad (es
  // una consulta pura a la tabla Categoria) - lo que fallaba era dejar que
  // la IA decidiera turno a turno si llamar a esa funcion o probar otra
  // cosa. El menu de NOMBRES de categorias nunca depende de datos del
  // cliente (genero, etc.) - eso solo importa para filtrar PRODUCTOS
  // adentro de una categoria puntual (ver Fix A en el handler de
  // mostrar_categorias, unas lineas mas abajo).
  if (!lead.categoriaId && !productoNombradoPorCliente && !lead.productoFavoritoId && !ESTADOS_DE_CIERRE.has(lead.estadoConversacion) && !(lead.productosMostrados || []).length) {
    const arbolPre = arbolDeCategorias(productos, lead);
    if (arbolPre.length) {
      helpers.leadActual = lead;
      // Mismo mensaje de bienvenida que la tienda ya configuro para el
      // camino AI-driven (config.mensajeBienvenida, ver partesDelSystem) -
      // si no configuraron uno, se arma una frase cordial de respaldo, nunca
      // el nombre pelado como antes ("Soy Raul de Tienda Demo." sonaba a
      // formulario, no a un vendedor real).
      const bienvenidaConfigurada = (agente.config && agente.config.mensajeBienvenida) || '';
      const saludo = esPrimerMensaje
        ? (bienvenidaConfigurada
          ? `${bienvenidaConfigurada} `
          : `¡Hola! Soy ${agente.nombre || 'el asistente de ventas'} de ${empresa.marca || empresa.nombre}. Encantado de ayudarte a encontrar justo lo que buscas. `)
        : '';
      if (arbolPre.length === 1 && !arbolPre[0].subcategorias.length) {
        // Mismo camino que menu_rubro_unico_auto (dentro del handler de
        // mostrar_categorias): un solo rubro sin subcategorias, se reusa la
        // tool para que se autoasigne y mande la tarjeta - misma fuente de
        // verdad que ya usa el camino AI-driven, no se reimplementa.
        const resultadoUnico = await ejecutarFuncion({ name: 'mostrar_categorias', arguments: {} }, productos, helpers);
        if (typeof resultadoUnico === 'string' && resultadoUnico.startsWith('TOOL_SUCCESS') && fotosParaMostrar.length) {
          logEtapa('menu_rubros_forzado_preemptivo', telefonoCliente, { rubroUnico: arbolPre[0].nombre });
          return { ok: true, demo: false, proveedor: 'sistema', modelo: null, respuesta: `${saludo}Echale un vistazo a ${arbolPre[0].nombre.toLowerCase()} que tenemos 👆`, fotos: fotosParaMostrar };
        }
        // TOOL_FAILED (atributo obligatorio de ESA categoria todavia falta,
        // ej. Genero marcado como obligatorio en esa categoria puntual) ->
        // no se improvisa nada, sigue el flujo normal con la IA.
      } else {
        const lista = arbolPre.map((r, i) => `${i + 1}. ${r.nombre}`).join('\n');
        logEtapa('menu_rubros_forzado_preemptivo', telefonoCliente, { opciones: arbolPre.length });
        return { ok: true, demo: false, proveedor: 'sistema', modelo: null, respuesta: `${saludo}Esto es lo que tenemos:\n${lista}\n\n¿Cuál te interesa?`, fotos: [] };
      }
    }
  }

  // DECISION DETERMINISTICA (backend, no la IA): si el cliente ELIGIO LA
  // CATEGORIA RECIEN, EN ESTE MISMO MENSAJE (detectados.categoriaId, no una
  // que ya estaba fijada de turnos anteriores), no nombro nada puntual, y
  // todavia no vio la tarjeta de esa categoria, se manda DIRECTO - no se le
  // pregunta al modelo. Mismo principio que menu_rubro_unico_auto (ver mas
  // abajo): el backend decide y ejecuta, la IA no entra en esta decision.
  // Pedido explicito del dueño del negocio despues de varios bugs reales
  // donde el modelo no llamaba a mostrar_tarjeta_categoria (a veces
  // describia la categoria en texto plano sin llamar ninguna tool, a veces
  // intentaba mostrar_productos sin categoria elegida) - los detectores
  // reactivos que ya existen quedan como red de seguridad para los demas
  // casos (producto puntual, cierre, rubro con subcategorias, mensajes de
  // seguimiento que no vuelven a nombrar la categoria), pero el momento
  // exacto de elegir categoria ya no depende de que la IA decida bien.
  //
  // El gate exige detectados.categoriaId (no solo lead.categoriaId) a
  // proposito: bug real encontrado probando esto - sin ese chequeo, el
  // bloque interceptaba CUALQUIER mensaje de una conversacion ya en curso
  // (preguntar por una foto de color, confirmar un pedido, etc.) solo
  // porque la categoria seguia fijada de turnos anteriores y el mensaje no
  // nombraba un producto por su nombre completo.
  if (detectados.categoriaId && !productoNombradoPorCliente && !lead.productoFavoritoId && !ESTADOS_DE_CIERRE.has(lead.estadoConversacion) && !(lead.productosMostrados || []).length) {
    const categoriaPre = categoriaDelLead(productos, lead);
    if (categoriaPre) {
      const yaMostradaPre = ((lead.contexto || {}).tarjetasCategoriaMostradas || []).includes(categoriaPre.id);
      const esRubroPre = !categoriaPre.padreId && subcategoriasDe(productos, categoriaPre.id, lead).length;
      if (!yaMostradaPre && !esRubroPre) {
        // helpers.leadActual normalmente se setea recien adentro del loop de
        // vueltas (linea ~3010) - como este bloque corre ANTES del loop,
        // hace falta setearlo aca a mano, o el handler de
        // mostrar_tarjeta_categoria ve leadActual undefined y falla siempre
        // (categoriaDelLead(contexto, {}) da null -> "TOOL_FAILED, todavia
        // no hay categoria elegida", aunque si la haya).
        helpers.leadActual = lead;
        const resultadoPre = await ejecutarFuncion({ name: 'mostrar_tarjeta_categoria', arguments: {} }, productos, helpers);
        if (typeof resultadoPre === 'string' && resultadoPre.startsWith('TOOL_SUCCESS')) {
          logEtapa('tarjeta_categoria_forzada_preemptiva', telefonoCliente, { categoria: categoriaPre.nombre });
          return { ok: true, demo: false, proveedor: 'sistema', modelo: null, respuesta: `Echale un vistazo a ${categoriaPre.nombre.toLowerCase()} que tenemos 👆`, fotos: fotosParaMostrar };
        }
        // TOOL_FAILED (falta atributo obligatorio, sin stock, envio real
        // fallo) -> no se improvisa nada aca, sigue el flujo normal con la
        // IA, que ya sabe manejar esos casos (pedir el dato que falta,
        // avisar sin stock, etc.) exactamente como hoy.
      }
    }
  }

  const mensajesTurno = avisoCarritoWeb ? [{ role: 'user', content: avisoCarritoWeb }] : [];
  const MAX_VUELTAS = 3;

  // Una vez que se lo freno por "no sabes que combinacion se lleva", la
  // pregunta por talla/color de este turno es LEGITIMA: es completar la
  // compra, no filtrar antes de mostrar. Sin esta marca los dos detectores
  // se pelean - el de "pedis preferencia sin mostrar" atrapa la pregunta que
  // el otro acaba de pedir, y el turno termina reenviando tarjetas.
  let frenadoPorVariante = false;

  try {
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      // El prompt se rearma en cada vuelta con el lead recalculado.
      const leadActual = vuelta === 0 ? lead : await prisma.clienteFinal.findUnique({ where: { id: clienteFinal.id } });
      helpers.leadActual = leadActual;
      const esUltimaVuelta = vuelta === MAX_VUELTAS - 1;
      const pidioProductoPuntual = Boolean(productoNombradoPorCliente) || Boolean((helpers.idsPedidosPorNombre || []).length);
      const { fijo: systemFijo, variable: systemVariable } = partesDelSystem(empresa, productos, agente.config, leadActual, esUltimaVuelta, esPrimerMensaje, agente.nombre, Boolean(helpers.tarjetasEnTurno), pedidosPrevios, pidioProductoPuntual);
      const system = `${systemFijo}\n\n${systemVariable}`;

      const resp = await llamar({
        system,
        systemFijo,
        systemVariable,
        mensajes: [...previos, { role: 'user', content: mensajeCliente }, ...mensajesTurno],
        tools: esUltimaVuelta ? [] : TOOLS,
        modelo,
      });
      if (resp.usage) logEtapa('uso_tokens', telefonoCliente, { proveedor, modelo, vuelta, ...resp.usage });

      if (!resp.tool_calls?.length) {
        // Si el cliente ya eligio un producto, preguntarle la talla NO es
        // filtrar: es completar la compra. Ahi si corresponde. Y si ya esta
        // en pleno cierre (favorito o algo en el carrito), es NORMAL que el
        // texto nombre el producto ("tus Park St 2.0 llegan a esa direccion")
        // - forzar una tarjeta ahi interrumpe el cierre en vez de seguirlo
        // (bucle real en produccion: pedia confirmar la direccion y el bot
        // le reenviaba la tarjeta sin llegar nunca a crear_pedido).
        const yaEligio = Boolean(lead.productoFavoritoId);
        // ESTADOS_DE_CIERRE se suma aca tambien: cubre el caso de
        // productoFavoritoId limpio (cambio de categoria a mitad del
        // cierre) pero estadoConversacion ya avanzado - bug real donde el
        // "rescate de ultima vuelta" volvia a mostrar tarjetas de producto
        // en vez de seguir el cierre.
        const yaEnCierre = Boolean(lead.productoFavoritoId)
          || carritoDe(leadActual.contexto || {}, conversacionId).length > 0
          || ESTADOS_DE_CIERRE.has(leadActual.estadoConversacion);

        // Los 4 detectores de "esta hablando en vez de actuar": cada uno
        // atrapa una forma distinta de texto vago (pedir preferencia sin
        // mostrar, nombrar un producto sin tarjeta, un listado con precios,
        // varias preguntas juntas, o prometer una busqueda que no llega).
        const pidiendoPreferencia = !yaEligio && !frenadoPorVariante && !helpers.tarjetasEnTurno && candidatosActuales.length && pidePreferenciaSinMostrar(resp.content);
        const nombrado = !yaEnCierre && !helpers.tarjetasEnTurno && candidatosActuales.length ? nombraUnProductoReal(resp.content, candidatosActuales) : null;
        const listadoEnTexto = !yaEnCierre && !helpers.tarjetasEnTurno && candidatosActuales.length && pareceListadoDeProductosEnTexto(resp.content);
        const interrogatorio = pareceInterrogatorio(resp.content);
        const anuncioDeBusqueda = pareceAnuncioDeBusqueda(resp.content);
        // Con el carrito vacio, "ya esta en tu carrito" es necesariamente
        // falso (agregar_al_carrito exige variante y esta vuelta no llamo
        // ninguna tool) - ver afirmaAgregoAlCarrito.
        const carritoFalso = !carritoDe(leadActual.contexto || {}, conversacionId).length && afirmaAgregoAlCarrito(resp.content);
        // "No tenemos stock" es necesariamente falso si la busqueda REAL de
        // este turno (candidatosActuales, calculada por codigo antes del
        // loop) ya encontro algo con esos mismos filtros - ver
        // afirmaFaltaDeStockSinRespaldo.
        const faltaStockFalsa = candidatosActuales.length > 0 && afirmaFaltaDeStockSinRespaldo(resp.content);
        // El bot dice "te muestro esto"/"aqui puedes revisar" pero este turno
        // NO se mando ninguna tarjeta real (ni de producto ni de categoria) -
        // ver afirmaQueMostroAlgoSinTarjeta. Bug real: mostrar_tarjeta_categoria
        // fallo (TOOL_FAILED, ej. el envio real no salio) y el modelo escribio
        // igual un texto confiado como si hubiera mandado algo.
        const afirmoSinMostrar = !helpers.tarjetasEnTurno && afirmaQueMostroAlgoSinTarjeta(resp.content);
        // Bug real: el modelo NO llamo a NINGUNA tool (resp.tool_calls vacio,
        // por eso se esta en esta rama) y en vez de eso describio la
        // categoria en texto libre ("tenemos una excelente seleccion de
        // zapatillas, varios modelos disponibles...") sin mandar la tarjeta
        // real. afirmaQueMostroAlgoSinTarjeta no lo agarra porque el texto no
        // dice "te muestro"/"aqui tenes" - solo describe, sin afirmar que
        // mando algo. Esto es mas fuerte que un chequeo de frases: reusa
        // EXACTAMENTE el mismo gate que seccionProductos usa en el prompt
        // para forzar mostrar_tarjeta_categoria (agente.js linea ~740) - si
        // esa condicion esta activa y el modelo no llamo a la tool, esta mal
        // sin importar que haya escrito.
        const categoriaParaTarjeta = pidioProductoPuntual || yaEnCierre || frenadoPorVariante || !candidatosActuales.length ? null : categoriaDelLead(productos, leadActual);
        const esRubroSinSubcategoriaAun = Boolean(categoriaParaTarjeta && !categoriaParaTarjeta.padreId && subcategoriasDe(productos, categoriaParaTarjeta.id, leadActual).length);
        const yaMostroTarjetaCategoria = Boolean(categoriaParaTarjeta && ((leadActual.contexto || {}).tarjetasCategoriaMostradas || []).includes(categoriaParaTarjeta.id));
        const debioLlamarTarjetaCategoria = Boolean(categoriaParaTarjeta) && !esRubroSinSubcategoriaAun && !yaMostroTarjetaCategoria && !helpers.tarjetasEnTurno;
        // Sin gate de candidatosActuales a proposito: una tool call escrita
        // como texto plano es invalida siempre, haya o no candidatos.
        const llamadaEnTexto = pareceLlamadaDeHerramientaEnTexto(resp.content);

        // Se va al cierre (entrega/pago/nombre) sin saber la combinacion
        // exacta: ni variante elegida, ni nada en el carrito, pero ya le
        // mostro productos que TIENEN talla y color con stock. Primero se
        // pregunta que se lleva; el resto viene despues.
        const productoPendienteDeVariante = (!lead.varianteFavoritaId
          && !carritoDe(leadActual.contexto || {}, conversacionId).length
          && pideDatosDeCierre(resp.content))
          ? (lead.productosMostrados || [])
            .map((id) => productos.find((p) => p.id === id))
            .find((p) => p && (p.variantes || []).some((v) => v.activa !== false && v.stock > 0))
          : null;

        // Si todavia quedan vueltas, se le da la chance de corregirse solo
        // (mejor: el modelo elige que decir). Cada uno con su propio
        // recordatorio especifico, por orden de especificidad.
        if (!esUltimaVuelta) {
          if (carritoFalso) {
            logEtapa('carrito_falso_rechazado', telefonoCliente, { vuelta });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): dijiste que el producto ya esta en el carrito, pero el carrito esta VACIO - eso nunca paso. Si el cliente ya eligio un producto, llama a agregar_al_carrito con su idVariante (preguntale la variante primero si todavia no la sabes); si todavia no eligio, no digas que lo agregaste, segui mostrando/ayudando a decidir.' });
            continue;
          }
          if (productoPendienteDeVariante) {
            frenadoPorVariante = true;
            logEtapa('cierre_sin_variante', telefonoCliente, { vuelta, productoId: productoPendienteDeVariante.id });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: `RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): le estas pidiendo datos de entrega o pago, pero todavia NO sabes que combinacion se lleva de "${productoPendienteDeVariante.nombre}". Un "si, me interesa" no dice ni la talla ni el color. Preguntale AHORA eso -una sola cosa por mensaje, arrancando por la talla-, guardalo con actualizar_datos_lead y agregalo al carrito con agregar_al_carrito. La entrega y el pago se preguntan DESPUES.` });
            continue;
          }
          if (pidiendoPreferencia) {
            logEtapa('pregunta_preferencia_sin_mostrar', telefonoCliente, { vuelta });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): le estas pidiendo color/talla/marca cuando YA tenes productos para mostrarle. Primero se muestra, despues se afina. Llama AHORA a mostrar_productos con los IDs del bloque de resultados; si despues hace falta acotar, se lo preguntas cuando ya haya visto las opciones.' });
            continue;
          }
          if (faltaStockFalsa) {
            logEtapa('falta_stock_falsa_rechazada', telefonoCliente, { vuelta });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): dijiste que no hay stock, pero el bloque de resultados de arriba SI tiene productos reales para esto. Nunca digas que no hay algo que esta cargado. Llama AHORA a mostrar_productos con los IDs del bloque de resultados.' });
            continue;
          }
          if (afirmoSinMostrar) {
            logEtapa('afirmo_mostro_sin_tarjeta_rechazado', telefonoCliente, { vuelta });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): le dijiste al cliente que le mostraste/mandaste algo, pero en este turno NO se envio ninguna tarjeta real (revisa arriba: si hubo un TOOL_FAILED, el envio real fallo). PROHIBIDO decir "te muestro", "aqui tienes" o similar sin haber mandado nada de verdad. Si todavia no llamaste a mostrar_tarjeta_categoria o mostrar_productos en este turno, hacelo ahora; si ya lo intentaste y fallo, decile la verdad con naturalidad (ej. "tuve un problema para mandarte las opciones, ¿te las intento de nuevo?"), nunca afirmes que le llego algo.' });
            continue;
          }
          if (debioLlamarTarjetaCategoria) {
            logEtapa('debio_llamar_tarjeta_categoria_rechazado', telefonoCliente, { vuelta, categoria: categoriaParaTarjeta?.nombre });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: `RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): describiste "${categoriaParaTarjeta?.nombre || 'la categoria'}" en tu texto pero NO llamaste a ninguna funcion, asi que el cliente no ve tarjeta, foto ni link. Llama AHORA a mostrar_tarjeta_categoria - es la unica forma de mostrarle algo real en este punto, no lo describas vos de memoria.` });
            continue;
          }
          if (llamadaEnTexto) {
            logEtapa('llamada_de_tool_en_texto_rechazada', telefonoCliente, { vuelta });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): escribiste el nombre de una funcion como si fuera texto normal (ej. "mostrar_productos{...}") - eso el cliente lo ve tal cual, como codigo, nunca como una tarjeta. Las funciones se llaman de verdad con tool calling, JAMAS escribiendo su nombre en el mensaje. Volve a intentarlo llamando la funcion correspondiente de verdad, con los IDs reales del bloque de resultados (numeros, nunca nombres de producto).' });
            continue;
          }
          if (nombrado || listadoEnTexto) {
            logEtapa('producto_nombrado_sin_tarjeta', telefonoCliente, { producto: nombrado, listadoEnTexto, esUltimaVuelta });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: `RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): ${nombrado ? `nombraste "${nombrado}"` : 'describiste productos'} en tu texto pero NO mandaste su tarjeta, asi que el cliente no ve ni foto, ni precio, ni tallas. Llama AHORA a mostrar_productos con los IDs del bloque de resultados. Si ya se lo mostraste antes en la conversacion, mandaselo igual: puede haber pasado un rato largo y no lo tiene a mano.` });
            continue;
          }
          if (interrogatorio) {
            logEtapa('interrogatorio_rechazado', telefonoCliente, { vuelta });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): mandaste mas de una pregunta en el mismo mensaje. Eso esta PROHIBIDO, parece un formulario. Volve a escribir el mensaje con UNA SOLA pregunta, la mas importante para poder avanzar; el resto se lo preguntas mas adelante si hace falta.' });
            continue;
          }
          if (anuncioDeBusqueda) {
            logEtapa('anuncio_de_busqueda_rechazado', telefonoCliente, { vuelta, yaEnCierre });
            mensajesTurno.push({ role: 'assistant', content: resp.content });
            mensajesTurno.push({ role: 'user', content: yaEnCierre
              ? 'RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): dijiste que ibas a revisar algo, pero el cliente ya esta en pleno cierre (tiene cosas en el carrito). NO le ofrezcas mas productos: segui el cierre pidiendole lo que falte (nombre, ubicacion o forma de pago), o llama a confirmar_pedido si ya tenes todo.'
              : `RECORDATORIO DEL SISTEMA (esto no lo dijo el cliente): dijiste que ibas a buscar algo, pero este mensaje es lo ultimo que el cliente recibe en este turno - se queda esperando de gusto. ${candidatosActuales.length ? 'Llama AHORA a mostrar_productos con los IDs del bloque de resultados y mostraselos de verdad.' : 'Todavia no podes mostrar productos: en vez de prometer una busqueda, hace la UNICA pregunta que te falta para poder buscar.'}` });
            continue;
          }
        } else if (carritoFalso) {
          // Ya no quedan vueltas: no se manda la afirmacion falsa tal cual.
          // Respuesta generica y siempre cierta - no puede nombrar el
          // producto sin arriesgarse a acertar mal cual era.
          logEtapa('carrito_falso_forzado', telefonoCliente, { vuelta });
          return {
            ok: true,
            demo: false,
            proveedor,
            modelo,
            respuesta: 'Para agregarlo a tu carrito me falta la talla y el color que preferís, ¿me confirmás eso?',
            fotos: fotosParaMostrar,
          };
        } else if (productoPendienteDeVariante) {
          // Ya no quedan vueltas: la pregunta la arma el codigo. Nunca se pasa
          // al cierre sin saber que combinacion se lleva el cliente.
          const tallas = [...new Set((productoPendienteDeVariante.variantes || [])
            .filter((v) => v.activa !== false && v.stock > 0)
            .map((v) => (v.atributos || {}).Talla)
            .filter(Boolean))];
          logEtapa('cierre_sin_variante_forzado', telefonoCliente, { vuelta, productoId: productoPendienteDeVariante.id });
          return {
            ok: true,
            demo: false,
            proveedor,
            modelo,
            respuesta: tallas.length
              ? `Para reservarte ${productoPendienteDeVariante.nombre}, ¿en qué talla lo querés? Tengo ${tallas.join(', ')}.`
              : `Para reservarte ${productoPendienteDeVariante.nombre}, ¿en qué talla y color lo querés?`,
            fotos: fotosParaMostrar,
          };
        } else if (pidiendoPreferencia || nombrado || listadoEnTexto || interrogatorio || anuncioDeBusqueda || faltaStockFalsa || llamadaEnTexto || afirmoSinMostrar || debioLlamarTarjetaCategoria) {
          // Ya se quedo sin vueltas (insistio con texto vago 2 veces) y en
          // esta vuelta tools:[] - no puede corregirse solo. NO se le manda
          // ese texto al cliente tal cual: se fuerza una accion real en
          // codigo. Bug real en produccion: sin esto, la ultima vuelta
          // saltaba TODAS las validaciones y el texto de relleno se mandaba
          // igual ("dejame revisar de nuevo, un momento" sin mostrar nada).
          logEtapa('texto_vago_forzado_en_ultima_vuelta', telefonoCliente, { vuelta, pidiendoPreferencia, nombrado, listadoEnTexto, interrogatorio, anuncioDeBusqueda, faltaStockFalsa, llamadaEnTexto, afirmoSinMostrar, debioLlamarTarjetaCategoria, yaEnCierre });

          // El cliente ya eligio o tiene algo en el carrito: forzar
          // mostrar_productos aca reabre el catalogo a mitad del cierre -
          // bug real en produccion, el bot nunca terminaba de cobrar
          // (mandaba tarjetas de nuevo despues de que el cliente ya habia
          // dicho que no queria nada mas). En vez de eso, se fuerza una
          // pregunta de cierre real (nunca inventada: sale de los datos que
          // ya tiene o no tiene el cliente), el mismo espiritu que
          // productoPendienteDeVariante/carritoFalso de arriba.
          if (yaEnCierre) {
            logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false, forzadoEnCodigo: true, cierreForzado: true });
            return {
              ok: true,
              demo: false,
              proveedor,
              modelo,
              respuesta: primeraPreguntaDeCierre(leadActual, agente.config) || 'Ya tengo todo listo para tu pedido — ¿confirmás que está todo bien para procesarlo?',
              fotos: fotosParaMostrar,
            };
          }

          // Ademas de lo que ya marco buscar_producto (idsPedidosPorNombre),
          // se suma productoNombradoPorCliente directo: cubre el caso donde
          // el modelo ni siquiera intento mostrar_productos en ninguna vuelta
          // (ej. mando fotos sueltas con enviar_fotos_producto) pero el
          // cliente si nombro el producto en su mensaje.
          const idsNombrados = (helpers.idsPedidosPorNombre || []).length
            ? helpers.idsPedidosPorNombre
            : (productoNombradoPorCliente ? [productoNombradoPorCliente.id] : []);
          if (idsNombrados.length) {
            // El cliente nombro un producto puntual: el rescate muestra ESE,
            // sigue siendo mostrar_productos como antes.
            const idsForzados = idsNombrados.slice(0, MAX_PRODUCTOS_A_MOSTRAR);
            await ejecutarFuncion({ name: 'mostrar_productos', arguments: { idsProductos: idsForzados } }, productos, helpers);
            // El rescate puede no haber mostrado nada: ejecutarFuncion tiene
            // varios caminos que devuelven un aviso en vez de mandar tarjetas
            // (cupo de fotos del turno agotado, ids ya mostrados, envio
            // rechazado por WhatsApp). Antes ese resultado se descartaba y el
            // "Estas son las opciones 👆" salia igual, con el chat vacio -
            // bug real con capturas. Solo se afirma si hay tarjetas de verdad.
            if (helpers.tarjetasEnTurno) {
              logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false, forzadoEnCodigo: true });
              return { ok: true, demo: false, proveedor, modelo, respuesta: conLinkPendienteSiFalta('Estas son las opciones que tenemos 👆 ¿Alguna te interesa?', helpers), fotos: fotosParaMostrar };
            }
            logEtapa('forzado_sin_tarjetas', telefonoCliente, { vuelta, idsForzados });
            return { ok: true, demo: false, proveedor, modelo, respuesta: 'Perdón, no pude traerte las opciones en este momento. ¿Te las busco de nuevo?', fotos: fotosParaMostrar };
          }
          if (candidatosActuales.length) {
            // Caso generico, sin nombre puntual: regla del negocio, se fuerza
            // la tarjeta de categoria, nunca productos sueltos (Fix C).
            const categoriaDelRescate = categoriaDelLead(productos, leadActual);
            // Bug real: sin categoria elegida todavia (candidatosActuales trae
            // TODO el catalogo sin filtrar en ese caso, no es señal de que haya
            // una categoria resuelta), categoriaDelRescate da null - la
            // tarjeta de categoria no aplica, hace falta el MENU de rubros
            // primero. Sin este chequeo, se intentaba mostrar_tarjeta_categoria
            // sin categoria, fallaba, y el cliente se quedaba con "no pude
            // traerte las opciones" sin haber visto ni el menu.
            if (!categoriaDelRescate) {
              const arbolRescate = arbolDeCategorias(productos, leadActual);
              if (arbolRescate.length) {
                const listaRescate = arbolRescate.map((r, i) => `${i + 1}. ${r.nombre}`).join('\n');
                logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false, forzadoEnCodigo: true, menuCategoriasForzado: true });
                return { ok: true, demo: false, proveedor, modelo, respuesta: `Esto es lo que tenemos:\n${listaRescate}\n\n¿Cuál te interesa?`, fotos: fotosParaMostrar };
              }
            }
            // Rubro con subcategorias sin elegir todavia: la tarjeta de
            // categoria no aplica (el rubro no tiene productos propios) -
            // se deja el camino viejo de mostrar_productos, que ya tiene su
            // propio gate de rubro (agente.js linea ~1801) para devolver la
            // lista de tipos en vez de tarjetas.
            const esRubroConSubcategorias = Boolean(categoriaDelRescate && !categoriaDelRescate.padreId && subcategoriasDe(productos, categoriaDelRescate.id, leadActual).length);
            const yaMostroTarjeta = !esRubroConSubcategorias && ((leadActual.contexto || {}).tarjetasCategoriaMostradas || []).includes(categoriaDelRescate?.id);
            if (esRubroConSubcategorias) {
              const idsForzadosRubro = candidatosActuales.slice(0, MAX_PRODUCTOS_A_MOSTRAR).map((p) => p.id);
              const resultadoRubro = await ejecutarFuncion({ name: 'mostrar_productos', arguments: { idsProductos: idsForzadosRubro } }, productos, helpers);
              logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false, forzadoEnCodigo: true, rubroConSubcategorias: true });
              return {
                ok: true,
                demo: false,
                proveedor,
                modelo,
                respuesta: (typeof resultadoRubro === 'string' && /^TODAVIA NO/.test(resultadoRubro))
                  ? `Dentro de "${categoriaDelRescate.nombre}" tenemos varios tipos - ¿cuál te interesa?`
                  : conLinkPendienteSiFalta('Estas son las opciones que tenemos 👆 ¿Alguna te interesa?', helpers),
                fotos: fotosParaMostrar,
              };
            }
            if (!yaMostroTarjeta) {
              const resultadoTarjeta = await ejecutarFuncion({ name: 'mostrar_tarjeta_categoria', arguments: {} }, productos, helpers);
              const huboTarjeta = typeof resultadoTarjeta === 'string' && resultadoTarjeta.startsWith('TOOL_SUCCESS');
              logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false, forzadoEnCodigo: true, tarjetaCategoria: true, huboTarjeta });
              const nombreCat = categoriaDelRescate ? categoriaDelRescate.nombre.toLowerCase() : 'las opciones';
              return {
                ok: true,
                demo: false,
                proveedor,
                modelo,
                respuesta: huboTarjeta ? `Echale un vistazo a ${nombreCat} que tenemos 👆` : 'Perdón, no pude traerte las opciones en este momento. ¿Te las busco de nuevo?',
                fotos: fotosParaMostrar,
              };
            }
            logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false, forzadoEnCodigo: true, pideModeloPuntual: true });
            const nombreCat = categoriaDelRescate ? categoriaDelRescate.nombre.toLowerCase() : 'los que tenemos';
            return { ok: true, demo: false, proveedor, modelo, respuesta: `¿Hay algún modelo en particular de ${nombreCat} que te interese?`, fotos: fotosParaMostrar };
          }
          // No hay ningun candidato real todavia (falta un dato obligatorio):
          // en vez del texto vago del modelo, se le pide honestamente al
          // cliente la UNICA cosa que falta - nunca un "ya te aviso" vacio.
          const faltaInicial = preguntasInicialesFaltantes(agente.config, leadActual, productos)[0];
          const categoriaEnVuelta = categoriaDelLead(productos, leadActual);
          const faltaObligatorio = atributosFaltantes(categoriaEnVuelta, leadActual, 'OBLIGATORIO')[0];
          const pregunta = faltaInicial
            ? `Para poder mostrarte opciones, contame primero: ¿${faltaInicial.toLowerCase()}?`
            : !leadActual.categoriaInteres
              ? '¿Qué tipo de producto estás buscando?'
              : faltaObligatorio
                ? `Para mostrarte opciones, ¿me confirmás ${faltaObligatorio.toLowerCase()}?`
                : 'Contame un poco más qué estás buscando para poder ayudarte.';
          logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false, forzadoEnCodigo: true, sinCandidatos: true });
          return { ok: true, demo: false, proveedor, modelo, respuesta: pregunta, fotos: fotosParaMostrar };
        }
        logEtapa('respuesta_enviada', telefonoCliente, { vuelta, tools: false });
        return { ok: true, demo: false, proveedor, modelo, respuesta: conLinkPendienteSiFalta(resp.content || '...', helpers), fotos: fotosParaMostrar };
      }

      mensajesTurno.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.tool_calls });
      for (const toolCallOriginal of resp.tool_calls) {
        // FORZADO EN CODIGO: el cliente nombro un producto real puntual y el
        // modelo va a mostrar algo (mostrar_productos/ver_mas_productos) que
        // no lo incluye - se corrige el pedido en vez de confiar en que el
        // modelo eligio bien los IDs. No se toca ninguna otra tool.
        let toolCall = toolCallOriginal;
        if (productoNombradoPorCliente && (toolCall.name === 'mostrar_productos' || toolCall.name === 'ver_mas_productos')) {
          const idsPedidos = (toolCall.arguments?.idsProductos || []).map(Number);
          if (!idsPedidos.includes(productoNombradoPorCliente.id)) {
            logEtapa('producto_nombrado_por_cliente_forzado', telefonoCliente, { producto: productoNombradoPorCliente.nombre, toolOriginal: toolCall.name });
            // Se marca como "pedido puntual" (mismo mecanismo que buscar_producto
            // ya usa) para que ademas se suprima el relleno de la pagina: el
            // cliente pidio UNO, no un pedido puntual mezclado con rellenos.
            helpers.idsPedidosPorNombre = [...new Set([...(helpers.idsPedidosPorNombre || []), productoNombradoPorCliente.id])];
            toolCall = { ...toolCall, name: 'mostrar_productos', arguments: { idsProductos: [productoNombradoPorCliente.id] } };
          }
        } else if (!productoNombradoPorCliente && !(helpers.idsPedidosPorNombre || []).length && (toolCall.name === 'mostrar_productos' || toolCall.name === 'ver_mas_productos')) {
          // FIX B (regla del negocio): sin un producto puntual nombrado, el
          // modelo NO puede mandar tarjetas de productos individuales, aunque
          // el prompt ya se lo pida - esto es el backstop en codigo, mismo
          // espiritu que el bloque de arriba. Se redirige a la tarjeta de
          // categoria (o, si ya se mostro, se corta sin ejecutar nada y se le
          // pide al modelo que pregunte por el nombre puntual). El OR con
          // idsPedidosPorNombre es necesario: buscar_producto (linea ~2119)
          // marca ahi mismo un pedido puntual encontrado por nombre PARCIAL
          // ("las TEKKIRA CUP" para "ZAPATILLAS TEKKIRA CUP"), que
          // productoNombradoPorCliente no detecta porque exige el nombre
          // completo dentro del mensaje del cliente.
          const categoriaDelToolCall = categoriaDelLead(productos, leadActual);
          // Si es un rubro que todavia se divide en tipos (ej. "Calzado" con
          // "Botas"/"Sandalias"), la tarjeta de categoria no aplica (el rubro
          // en si no tiene productos propios) - se deja pasar el toolCall
          // original: el gate de rubro que YA existe dentro del handler de
          // mostrar_productos (agente.js linea ~1801) va a devolver la lista
          // de tipos, que es lo correcto en este punto.
          const esRubroConSubcategorias = Boolean(categoriaDelToolCall && !categoriaDelToolCall.padreId && subcategoriasDe(productos, categoriaDelToolCall.id, leadActual).length);
          const yaMostroTarjeta = ((leadActual.contexto || {}).tarjetasCategoriaMostradas || []).includes(categoriaDelToolCall?.id);
          logEtapa('mostrar_productos_sin_puntual_redirigido', telefonoCliente, { categoria: categoriaDelToolCall?.nombre, yaMostroTarjeta, esRubroConSubcategorias, toolOriginal: toolCall.name });
          if (!categoriaDelToolCall) {
            // Bug real: sin ninguna categoria elegida todavia, la tarjeta de
            // categoria no tiene de que categoria ser - hace falta el MENU de
            // rubros primero (mostrar_categorias ya tiene su propia logica
            // para armarlo bien, incluido el caso de un solo rubro).
            toolCall = { ...toolCall, name: 'mostrar_categorias', arguments: {} };
          } else if (esRubroConSubcategorias) {
            // dejar pasar sin tocar
          } else if (!yaMostroTarjeta) {
            toolCall = { ...toolCall, name: 'mostrar_tarjeta_categoria', arguments: {} };
          } else {
            mensajesTurno.push({ role: 'tool', tool_call_id: toolCallOriginal.id, content: `TOOL_FAILED: el cliente no nombro un modelo puntual por su nombre - no le muestres tarjetas de productos individuales (ya vio la tarjeta de "${categoriaDelToolCall?.nombre || 'esta categoria'}"). Preguntale, en texto, cual modelo puntual le interesa por su nombre.` });
            continue;
          }
        }
        const resultado = await ejecutarFuncion(toolCall, productos, helpers);
        mensajesTurno.push({ role: 'tool', tool_call_id: toolCallOriginal.id, content: resultado || 'Hecho.' });
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
  generarRespuesta, construirSystem, partesDelSystem, proveedorActivo, analizarImagenProducto, transcribirAudio,
  // Exportado para tests de regresion (unidades deterministas, sin llamar a ningun proveedor de IA).
  // buscarProductosFiltrados y compañia viven en catalogo.js; se reexportan
  // aca porque son parte de la superficie que los tests del motor ya usaban.
  buscarProductosFiltrados, productosCandidatosAMostrar, extraerFiltros, resolverSeleccionMenu,
  respuestaErrorTecnico, seccionProductos, fichaProducto, atributosFaltantes, filtrosCompletos,
  formatearPrecio, avisosDeFoto, resultadoDeEnvio, limpiezaPorCambioDeCategoria,
  datosDeActualizacionDeLead, pareceInterrogatorio, pareceAnuncioDeBusqueda,
  preguntasInicialesFaltantes, resolverDatosIniciales, valorEnAtributosLead, leadYaTiene,
  sinPreferenciaDe,
  MAX_INTENTOS_PREGUNTA_INICIAL,
  contextoReiniciadoPorInactividad, nombraUnProductoReal, pidePreferenciaSinMostrar,
  resumenPedidosPrevios, primeraPreguntaDeCierre,
  afirmaFaltaDeStockSinRespaldo, afirmaQueMostroAlgoSinTarjeta, pareceQuererCatalogoCompleto, pareceLlamadaDeHerramientaEnTexto,
};
