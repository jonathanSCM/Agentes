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
          categoriaInteres: { type: 'string', description: "La categoria de producto con las palabras EXACTAS que uso el cliente. NUNCA la traduzcas ni la reemplaces por otra: el buscador interno necesita las palabras literales del cliente." },
          presupuesto: { type: 'string' },
          cantidad: { type: 'string', description: 'Cuantas unidades quiere el cliente.' },
          direccionEntrega: { type: 'string' },
          observaciones: { type: 'string' },
          nivelInteres: { type: 'string', enum: ['frio', 'tibio', 'caliente'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mostrar_productos',
      description: 'Presenta productos al cliente como tarjetas visuales (foto + ficha con precio, stock y detalles). SIEMPRE que vayas a mostrar uno o mas productos del bloque de resultados, llama esta funcion con sus IDs en vez de describirlos en texto. Maximo 3.',
      parameters: {
        type: 'object',
        properties: {
          idsProductos: { type: 'array', items: { type: 'integer' }, description: 'IDs exactos de los productos a mostrar. Maximo 3.' },
        },
        required: ['idsProductos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_fotos_producto',
      description: 'Envia las fotos de un producto especifico por WhatsApp cuando el cliente pide ver fotos o imagenes de un producto.',
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
      name: 'crear_pedido',
      description: 'Crea el pedido cuando el cliente confirmo que quiere comprar uno o mas productos especificos. El sistema valida el stock antes de confirmar. NO cobra ni procesa el pago: solo deja el pedido registrado para coordinar el pago y la entrega.',
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
      description: "Deriva la conversacion a un asesor humano SOLO cuando el cliente lo pide explicitamente ('quiero hablar con una persona') o esta claramente molesto tras varios intentos. NUNCA derivar por preguntas de precio, stock, formas de pago o dudas normales de compra.",
      parameters: { type: 'object', properties: { motivo: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mostrar_catalogo',
      description: "Manda el link al catalogo web completo, SOLO cuando el cliente pide ver 'el catalogo', 'todos los productos' o algo generico similar (no cuando busca un producto puntual: para eso usa mostrar_productos). Muestra todo el catalogo activo con fotos, categoria y precio.",
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
  if (precio.monto > presupuesto.monto * TOPE_PRESUPUESTO) return 'fuera_de_presupuesto';
  if (precio.monto > presupuesto.monto * TOLERANCIA_PRESUPUESTO) return 'excedido';
  return 'dentro';
}

function scoreProducto(p, lead = {}) {
  let score = 0;
  if (lead.categoriaInteres && coincideTexto(lead.categoriaInteres, p.categoria || '')) score += 3;
  if (lead.presupuesto && estadoPresupuesto(lead.presupuesto, p.precio) === 'dentro') score += 2;
  if (p.stock > 3) score += 1;
  if (lead.observaciones) {
    const textoProd = `${(p.caracteristicas || []).join(' ')} ${p.descripcion || ''} ${p.nombre}`;
    const clavesProd = new Set(palabrasClave(textoProd));
    for (const clave of palabrasClave(lead.observaciones)) {
      if ([...clavesProd].some((c) => c.includes(clave) || clave.includes(c))) score += 1;
    }
  }
  return score;
}

function buscarProductosFiltrados(productos, lead = {}, { ignorarPresupuesto = false, ignorarCategoria = false } = {}) {
  return productos
    .filter((p) => {
      if (p.stock <= 0) return false;
      if (
        !ignorarCategoria &&
        !coincideTexto(lead.categoriaInteres, p.categoria || '') &&
        !coincideTexto(lead.categoriaInteres, p.nombre || '') &&
        !coincideTexto(lead.categoriaInteres, p.descripcion || '')
      )
        return false;

      if (lead.presupuesto) {
        const estado = estadoPresupuesto(lead.presupuesto, p.precio);
        if (estado === 'fuera_de_presupuesto') return false;
        if (!ignorarPresupuesto && estado === 'excedido') return false;
      }
      return true;
    })
    .sort((a, b) => scoreProducto(b, lead) - scoreProducto(a, lead))
    .slice(0, 3);
}

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
  let mejorPuntaje = 0;
  const categoriasUnicas = [...new Set(productos.map((p) => p.categoria).filter(Boolean))];
  for (const categoria of categoriasUnicas) {
    const claves = palabrasClave(categoria);
    if (!claves.length) continue;
    const presentes = claves.filter((c) => norm.includes(` ${c} `) || norm.includes(`${c} `)).length;
    if (presentes === claves.length && presentes > mejorPuntaje) {
      mejorCategoria = categoria;
      mejorPuntaje = presentes;
    }
  }
  if (!mejorCategoria) {
    for (const p of productos) {
      if (!p.categoria) continue;
      const claves = palabrasClave(p.nombre).filter((c) => c.length > 3);
      const presentes = claves.filter((c) => norm.includes(c)).length;
      if (presentes > mejorPuntaje) {
        mejorCategoria = p.categoria;
        mejorPuntaje = presentes;
      }
    }
  }
  if (mejorCategoria) cambios.categoriaInteres = mejorCategoria;

  const cant = norm.match(/\b(\d+)\s*(unidades?|piezas?|und\.?)\b/);
  if (cant) cambios.cantidad = cant[1];

  return cambios;
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
  const conStock = productos.filter((p) => p.stock > 0);
  const contar = (lista) => {
    const c = {};
    for (const p of lista) {
      const v = (p.categoria || '').trim();
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

function formatearProductos(productos) {
  return productos
    .map((p) => {
      const caract = p.caracteristicas?.length ? ` - Caracteristicas: ${p.caracteristicas.join(', ')}` : '';
      const base = `- [ID ${p.id}] ${p.nombre} - Categoria: ${p.categoria || 'General'} - Precio: ${Number(p.precio).toFixed(2)} - Stock: ${p.stock}${caract} - ${p.descripcion || ''}`;
      const variantes = (p.variantes || []).filter((v) => v.activa);
      if (!variantes.length) return base;
      const lineasVariantes = variantes
        .map((v) => `  · [Variante ID ${v.id}] ${formatearAtributosVariante(v.atributos)} - Precio: ${Number(v.precio ?? p.precio).toFixed(2)} - Stock: ${v.stock}`)
        .join('\n');
      return `${base}\n  Este producto tiene variantes (talla/color/etc.). Si el cliente quiere comprarlo, preguntale cual de estas elige ANTES de crear el pedido, y usa el ID de variante exacto en crear_pedido:\n${lineasVariantes}`;
    })
    .join('\n');
}

function filtrosCompletos(lead = {}) {
  return Boolean(lead.categoriaInteres);
}

function seccionProductos(productos, lead = {}) {
  if (!filtrosCompletos(lead)) {
    return 'Todavia no sabes que anda buscando el cliente (no es que no haya stock, es que aun no lo dijo). NUNCA digas que "no hay productos" en este punto ni menciones ninguno todavia: segui la charla con naturalidad hasta entender que necesita, preguntando como lo haria una persona, no con un menu de categorias.';
  }

  const exactos = buscarProductosFiltrados(productos, lead);
  if (exactos.length) {
    return `Resultados de la busqueda (ya filtrados por categoria y presupuesto pedidos, maximo 3, son los UNICOS productos reales que puedes mencionar, NUNCA inventes otros):\n${formatearProductos(exactos)}\n\nMuestraselos DE INMEDIATO llamando a mostrar_productos UNA SOLA VEZ, con los IDs de TODOS los productos de esta lista juntos en el mismo array (no solo el primero) - el sistema manda una tarjeta con foto y ficha por cada uno. PROHIBIDO nombrar, describir o comparar en tu texto ningun producto de esta lista (ni "tambien tenemos...", ni resumirlos): si esta en la lista, va en la tarjeta, nunca en tu texto. Tu texto de esta vuelta es SOLO una reaccion corta + pregunta de cierre.\n\nADVERTENCIA SOBRE EL HISTORIAL: si en mensajes anteriores dijiste que "no habia productos disponibles" en esta categoria, eso quedo OBSOLETO. El bloque de arriba es la UNICA verdad actual del inventario. Corrigete con naturalidad y muestra los productos.`;
  }

  if (lead.presupuesto) {
    const sinPresupuesto = buscarProductosFiltrados(productos, lead, { ignorarPresupuesto: true });
    if (sinPresupuesto.length) {
      return `No hay nada dentro del presupuesto (${lead.presupuesto}) en esa categoria, PERO si hay estas opciones reales apenas por encima (misma categoria, maximo 3, no inventes otras):\n${formatearProductos(sinPresupuesto)}\n\nMuestraselas DE INMEDIATO llamando a mostrar_productos, y en tu texto se transparente en que estan un poco por encima de su presupuesto.`;
    }
  }

  const sinCategoria = buscarProductosFiltrados(productos, lead, { ignorarCategoria: true });
  if (sinCategoria.length) {
    return `No hay ningun producto que calce en la categoria "${lead.categoriaInteres}". PERO si hay estas opciones reales en otras categorias con stock (maximo 3, no inventes otras):\n${formatearProductos(sinCategoria)}\n\nMUESTRALAS llamando a mostrar_productos, y en tu texto aclara que son de otra categoria.`;
  }

  return 'NINGUN producto calza ni siquiera relajando presupuesto y categoria. No digas simplemente que no hay nada: reencuadra ofreciendo derivar_a_asesor o preguntando si busca algo distinto.';
}

function nombreValido(nombre) {
  if (!nombre) return false;
  const limpio = String(nombre).trim();
  if (limpio.length < 2) return false;
  if (!/[a-zA-ZñÑáéíóúÁÉÍÓÚ]{2,}/.test(limpio)) return false;
  if (/^(cliente|usuario|hola|si|no|nn|xx)$/i.test(limpio)) return false;
  return true;
}

function fichaProducto(p) {
  const lineas = [`· *Precio*: ${Number(p.precio).toFixed(2)}`];
  if (p.categoria) lineas.push(`· *Categoria*: ${p.categoria}`);
  lineas.push(`· *Disponibilidad*: ${p.stock > 0 ? (p.stock <= 3 ? `¡Ultimas ${p.stock} unidades!` : `${p.stock} en stock`) : 'Agotado'}`);
  const variantes = (p.variantes || []).filter((v) => v.activa && v.stock > 0);
  if (variantes.length) {
    lineas.push(`\n*Opciones disponibles*:\n${variantes.map((v) => `· ${formatearAtributosVariante(v.atributos)}`).join('\n')}`);
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
    ['Direccion de entrega', lead.direccionEntrega],
    ['Otras observaciones', lead.observaciones],
  ].filter(([, valor]) => valor);
  if (!campos.length) return 'Todavia no se sabe nada del cliente, esta es la primera vez que pregunta o recien empieza la conversacion.';
  return campos.map(([etiqueta, valor]) => `- ${etiqueta}: ${valor}`).join('\n');
}

// Construye el prompt de sistema con la identidad del negocio y su catalogo.
// sinHerramientas=true se usa SOLO en la ultima vuelta del loop de tools,
// cuando ya no puede llamar mas funciones y tiene que redactar el mensaje
// final: ahi se refuerza con mas fuerza la regla anti-invento, porque es el
// momento de mas riesgo de que "complete" la respuesta con datos inventados.
function construirSystem(empresa, productos, config, lead = {}, sinHerramientas = false) {
  const marca = empresa.marca || empresa.nombre;
  const tono = (config && config.tono) || 'cordial y profesional';
  const extra = (config && config.instrucciones) || '';

  return `Eres la persona que atiende el WhatsApp de "${marca}". No eres un bot de formulario ni un menu de opciones: sos un vendedor de carne y hueso, con buena onda, que charla con el cliente como charlaria cualquier vendedor bueno en una tienda real. Es una conversacion real con un cliente real, no una demo.

COMO SUENA UN VENDEDOR HUMANO (esto es lo mas importante de todo este mensaje):
- Habla natural, como si tipeara rapido en el celular: frases cortas, tono ${tono}, nada de sonar como un catalogo leido en voz alta.
- EMOJIS CON MODERACION: 1 emoji por mensaje esta bien cuando aporta calidez (un saludo, un cierre, una buena noticia); en mensajes con mas contenido podes usar 2 como mucho. Nunca mas de 2, y nunca los pongas si el mensaje es serio (un reclamo, un problema de stock). Si dudas, poné menos.
- NUNCA reciten los datos del cliente ni las reglas internas ("ya tengo tu categoria de interes guardada", "procesando tu solicitud"). Eso rompe la ilusion de estar hablando con una persona.
- Variá como saludás y como preguntás: si repetís la misma frase que ya usaste antes en la conversacion, suena a bot. Cada mensaje se siente escrito en el momento, pensando en lo que el cliente acaba de decir.
- USA LISTAS CUANDO AYUDEN: si vas a mencionar varias categorias, varias opciones para elegir, o los pasos de algo (formas de pago, como coordinar la entrega), escribilo como una lista corta (con numeros o guiones), no como un parrafo denso. Una lista se lee mas rapido en WhatsApp que un bloque de texto. Para una pregunta abierta simple (que anda buscando, si es para el o para regalo) no hace falta lista, preguntala como la haria una persona.

COMO ARRANCA LA CONVERSACION: si el cliente recien saluda sin decir que busca ("hola", "buenas"), saluda con calidez y preguntale de forma abierta y natural que anda buscando (variá la frase, no uses siempre la misma).
SI EL CLIENTE PREGUNTA QUE TENES / QUE VENDES / QUE PRODUCTOS TIENEN (o algo generico similar, sin especificar un producto puntual): esto es OBLIGATORIO, no opcional - respondele con las categorias reales en formato de LISTA (numerada o con guiones, una por linea), nunca las menciones todas seguidas en una misma frase de parrafo. Ejemplo del formato esperado:
"¡Claro! Por ahora tenemos:
1. Electrodomesticos
2. Accesorios
3. Calzado
¿Cual te interesa?"
Usa el bloque de inventario real de abajo para saber que categorias existen de verdad.

Datos que ya sabes de este cliente (los usas para no preguntar dos veces lo mismo, pero NUNCA se los repitas ni le digas que los "guardaste"):
${datosConocidosDelLead(lead)}

COMO CONDUCIS LA VENTA (con calidez, pero siempre empujando un paso mas):
- Entendé que necesita, mostrale opciones reales, resolvé sus dudas, y cuando muestre interes de verdad avanzá hacia cerrar el pedido. Es un ida y vuelta natural, no una lista de pasos rigida que hay que tildar en orden exacto.
- El presupuesto no se pregunta como un requisito de entrada: surge naturalmente si el cliente lo menciona, o lo consultas mas adelante si hace falta para recomendar bien, nunca como segunda pregunta obligatoria.
- Si el cliente menciona algo util (para quien es, que necesita, un detalle), guardalo con actualizar_datos_lead pero sin que se note en tu texto que estas "llenando un formulario".
- PROACTIVO CON FOTOS: en cuanto el cliente muestre interes real en un producto especifico (dice "me gusta", "ese me interesa", o cualquier reaccion positiva), mandale las fotos con enviar_fotos_producto SIN que tenga que pedirlas.
- Si no le convence lo que le mostraste, ofrecele otra alternativa real del catalogo automaticamente, como lo haria un vendedor que conoce bien su tienda, sin esperar a que el cliente lo pida.
- Cuando hay intencion clara de compra, pedile lo que falte (nombre, direccion de entrega) de forma natural y llama a crear_pedido.
- CIERRE: cada mensaje tuyo deberia dejar la conversacion avanzando un paso, nunca en el aire. Evita cerrar con un "¿en que mas te ayudo?" vacio o un "¿que te parecio?" cuando ya hay una oportunidad clara de seguir (mostrar otra opcion, preguntar cual prefiere, pedir el dato que falta para el pedido). No hace falta forzarlo en cada linea si la charla recien esta arrancando, pero en cuanto el cliente mostro interes real, el mensaje siguiente SIEMPRE empuja hacia el cierre.

REGLAS TECNICAS (estas si son estrictas, aunque no se noten en tu forma de hablar):
- TARJETAS: para mostrar cualquier producto SIEMPRE llama a mostrar_productos con sus IDs. Nunca escribas precio o stock como texto plano: eso va en la tarjeta que genera el sistema.
- No muestres ni inventes ningun producto que no este en el bloque de resultados de abajo: esa es la UNICA fuente real del inventario.
- Usa derivar_a_asesor SOLO si el cliente lo pide explicitamente o esta muy molesto. Nunca por preguntas normales de precio, stock o forma de pago: esas las respondes vos con la info disponible.
- No se puede crear un pedido sin nombre y direccion de entrega: pedilos de forma natural antes de llamar crear_pedido si faltan.
- Si un producto tiene variantes (talla/color/etc., estan listadas debajo de ese producto en el bloque de resultados), NUNCA llames crear_pedido sin antes preguntarle al cliente cual elige: usa el ID de esa variante exacta en idVariante.
- Si el cliente pide ver "el catalogo" o "todos los productos" en general (no un producto puntual), llama a mostrar_catalogo: manda un link real a la pagina con todo el catalogo.
- FORMATO WHATSAPP (no Markdown): negrita = *un asterisco pegado al texto*, nunca **doble asterisco** ni # titulos.

Informacion comercial:
${extra ? `- ${extra}` : '(sin instrucciones adicionales)'}

${resumenInventario(productos)}

${seccionProductos(productos, lead)}

REGLA ANTI-INVENTO: cada producto que muestres DEBE corresponder a una linea del bloque de arriba, con su precio EXACTO. Los IDs son solo para tus llamadas a funciones, nunca los menciones al cliente. Si te preguntan un detalle puntual que no figura ahi (ej. una talla exacta que no esta en las caracteristicas), respondé con lo real que si tenes (el rango que SI aparece) sin inventar numeros nuevos, y ofrecé confirmarlo si hace falta precision.

CIERRE NATURAL: llevá la charla hacia concretar la venta, pero sin sonar a guion de call center. Un vendedor real a veces solo charla un poco, resuelve una duda, y recien despues encamina hacia la compra. Evita quedarte en un "¿en que mas te ayudo?" vacio cuando hay una oportunidad clara de avanzar, pero tampoco fuerces el cierre en cada linea si la conversacion todavia no llego ahi.${sinHerramientas ? `

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

// ============================ Ejecucion de tools ============================
// helpers: { empresaId, telefonoCliente, conexion, fotosParaMostrar, conversacionId }
async function ejecutarFuncion(toolCall, contexto, helpers) {
  const { empresaId, telefonoCliente, conexion, fotosParaMostrar, conversacionId } = helpers;
  const args = toolCall.arguments || {};

  const clienteFinal = await prisma.clienteFinal.upsert({
    where: { empresaId_telefono: { empresaId, telefono: telefonoCliente } },
    update: {},
    create: { empresaId, telefono: telefonoCliente },
  });

  if (toolCall.name === 'actualizar_datos_lead') {
    const datos = {};
    if (args.nombre) datos.nombre = String(args.nombre).slice(0, 120);
    if (args.categoriaInteres) datos.categoriaInteres = String(args.categoriaInteres).slice(0, 120);
    if (args.presupuesto) datos.presupuesto = String(args.presupuesto).slice(0, 60);
    if (args.cantidad) datos.cantidad = String(args.cantidad).slice(0, 20);
    if (args.direccionEntrega) datos.direccionEntrega = String(args.direccionEntrega).slice(0, 300);
    if (args.observaciones) datos.observaciones = String(args.observaciones).slice(0, 500);
    if (args.nivelInteres) datos.nivelInteres = args.nivelInteres.toUpperCase();
    datos.estadoLead = 'EN_CONVERSACION';
    await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: datos });
    return null;
  }

  if (toolCall.name === 'mostrar_productos' || toolCall.name === 'enviar_fotos_producto') {
    const ids = toolCall.name === 'mostrar_productos'
      ? (args.idsProductos || []).slice(0, 3).map(Number)
      : [Number(args.idProducto)];

    const productos = contexto.filter((p) => ids.includes(p.id));
    if (!productos.length) return 'No encontre esos productos para mostrartelos.';

    const yaEnviadas = (clienteFinal.contexto && clienteFinal.contexto.fotosEnviadas) || [];
    const nuevasEnviadas = [...yaEnviadas];
    const enviados = [];

    for (const producto of productos) {
      const caption = fichaProducto(producto);
      if (toolCall.name === 'enviar_fotos_producto' && yaEnviadas.includes(producto.id)) {
        return `Ya te envie todas las fotos disponibles de ese producto 📸 ¿Quieres:\n1) Mas informacion\n2) Confirmar el pedido\n3) Ver otras opciones parecidas?`;
      }
      const mediaUrl = producto.fotos?.length ? producto.fotos[0] : null;
      if (conexion && conexion.estado === 'CONECTADO' && mediaUrl) {
        await wa.enviarImagenes(conexion, telefonoCliente, producto.fotos.slice(0, 1), caption);
      } else if (conexion && conexion.estado === 'CONECTADO') {
        await wa.enviarTexto(conexion, telefonoCliente, caption);
      } else if (mediaUrl && fotosParaMostrar) {
        // Sin conexion real (modo de prueba en el panel): se registran las
        // fotos para que el chat de prueba las muestre como imagenes de
        // verdad, no solo como texto.
        fotosParaMostrar.push({ url: mediaUrl, caption });
      }

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
      if (!nuevasEnviadas.includes(producto.id)) nuevasEnviadas.push(producto.id);
    }

    await prisma.clienteFinal.update({
      where: { id: clienteFinal.id },
      data: { contexto: { ...(clienteFinal.contexto || {}), fotosEnviadas: nuevasEnviadas } },
    });

    const resumen = productos.map((p) => `${p.nombre} (${Number(p.precio).toFixed(2)})`).join('; ');
    return `Ya le mostre al cliente ${productos.length} producto(s) como tarjeta(s) con foto y ficha: ${resumen}.\n${conexion && conexion.estado === 'CONECTADO' ? '' : `[Modo prueba, sin WhatsApp conectado - fichas:]\n${enviados.join('\n\n')}\n`}NO repitas sus datos en texto. Tu texto ahora: reaccion breve de por que le conviene + CIERRE empujando el pedido. Nunca termines con "¿que te parecio?".`;
  }

  if (toolCall.name === 'crear_pedido') {
    if (!nombreValido(clienteFinal.nombre)) {
      return 'TODAVIA NO crees el pedido: falta el nombre del cliente. Preguntaselo, guardalo con actualizar_datos_lead y recien ahi vuelve a llamar crear_pedido.';
    }
    if (!clienteFinal.direccionEntrega) {
      return 'TODAVIA NO crees el pedido: falta la direccion de entrega. Preguntasela, guardala con actualizar_datos_lead y recien ahi vuelve a llamar crear_pedido.';
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
            .map((v) => `- [Variante ID ${v.id}] ${formatearAtributosVariante(v.atributos)} - Precio: ${Number(v.precio ?? producto.precio).toFixed(2)} - Stock: ${v.stock}`)
            .join('\n');
          return `TODAVIA NO crees el pedido de "${producto.nombre}": ese producto tiene variantes y falta saber cual eligio el cliente. Preguntaselo y volve a llamar crear_pedido con el idVariante correcto entre estas opciones reales:\n${opciones}`;
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

    const pedido = await prisma.$transaction(async (tx) => {
      const creado = await tx.pedido.create({
        data: {
          empresaId,
          clienteId: clienteFinal.id,
          total,
          direccionEntrega: clienteFinal.direccionEntrega,
          entregaLat: clienteFinal.ubicacionLat,
          entregaLng: clienteFinal.ubicacionLng,
          notas: clienteFinal.observaciones,
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
      await tx.clienteFinal.update({ where: { id: clienteFinal.id }, data: { estadoLead: 'PEDIDO_CREADO' } });
      return creado;
    });

    const resumen = items.map((i) => `${i.cantidad}x ${i.nombre}`).join(', ');
    return `Pedido #${pedido.id} creado con: ${resumen}. Tu texto ahora: confirma el pedido al cliente con calidez, y explica que un asesor coordinara el pago y la entrega. Si tiene dudas de pago, ofrece derivar_a_asesor.`;
  }

  if (toolCall.name === 'mostrar_catalogo') {
    const base = process.env.APP_BASE_URL || 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/catalogo/${helpers.empresaSlug}`;
    return `Link del catalogo completo: ${link}\nTu texto ahora: mandale ese link EXACTO al cliente en TEXTO PLANO, tal cual esta arriba (NUNCA como "[texto](link)" tipo markdown: WhatsApp no lo interpreta y se ve roto, muestra el link pelado para que WhatsApp lo detecte solo). Decile que ahi puede ver todo el catalogo con fotos y precios, y pregunta si hay algo puntual en lo que le puedas ayudar a elegir.`;
  }

  if (toolCall.name === 'derivar_a_asesor') {
    await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: { estadoLead: 'DERIVADO_A_ASESOR' } });
    await prisma.notificacion.create({
      data: {
        empresaId,
        titulo: 'Cliente pide un asesor',
        mensaje: `El cliente ${clienteFinal.nombre || telefonoCliente} pidio hablar con una persona${args.motivo ? `: ${args.motivo}` : ''}.`,
        tipo: 'MANUAL',
      },
    });
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
 * @param {number} agenteId
 * @param {string} telefonoCliente
 * @param {Array<{rol:string, contenido:string}>} historial  mensajes previos (de Mensaje)
 * @param {string} mensajeCliente
 */
async function generarRespuesta(agenteId, telefonoCliente, historial, mensajeCliente, conversacionId) {
  const agente = await prisma.agente.findUnique({
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
            include: { variantes: { where: { activa: true }, orderBy: { id: 'asc' } } },
          },
        },
      },
    },
  });
  if (!agente) return { ok: false, respuesta: 'Agente no encontrado.', demo: true, proveedor: 'demo' };

  const { empresa } = agente;
  const productos = empresa.productos;

  const clienteFinal = await prisma.clienteFinal.upsert({
    where: { empresaId_telefono: { empresaId: empresa.id, telefono: telefonoCliente } },
    update: {},
    create: { empresaId: empresa.id, telefono: telefonoCliente },
  });

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
    lead = await prisma.clienteFinal.update({ where: { id: clienteFinal.id }, data: detectados });
  }

  const previos = historial.map((m) => ({ role: m.rol === 'CLIENTE' ? 'user' : 'assistant', content: m.contenido }));

  const proveedor = proveedorActivo();
  const plan = empresa.suscripcion && empresa.suscripcion.plan;
  const modelo = modeloParaPlan(proveedor, plan);
  const llamar = proveedor === 'openai' ? llamarOpenAI : proveedor === 'anthropic' ? llamarAnthropic : null;

  if (!llamar) {
    return { ok: true, demo: true, proveedor: 'demo', respuesta: respuestaDemo(empresa, productos, mensajeCliente) };
  }

  // Fotos que las tools van registrando en este turno para el modo de
  // prueba (sin WhatsApp real conectado), para que el chat de prueba las
  // pueda mostrar como imagenes de verdad.
  const fotosParaMostrar = [];
  const helpers = { empresaId: empresa.id, empresaSlug: empresa.slug, telefonoCliente, conexion: agente.conexion, fotosParaMostrar, conversacionId };
  const mensajesTurno = [];
  const MAX_VUELTAS = 3;

  try {
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      // El prompt se rearma en cada vuelta con el lead recalculado.
      const leadActual = vuelta === 0 ? lead : await prisma.clienteFinal.findUnique({ where: { id: clienteFinal.id } });
      const esUltimaVuelta = vuelta === MAX_VUELTAS - 1;
      const system = construirSystem(empresa, productos, agente.config, leadActual, esUltimaVuelta);

      const resp = await llamar({
        system,
        mensajes: [...previos, { role: 'user', content: mensajeCliente }, ...mensajesTurno],
        tools: esUltimaVuelta ? [] : TOOLS,
        modelo,
      });

      if (!resp.tool_calls?.length) {
        return { ok: true, demo: false, proveedor, modelo, respuesta: resp.content || '...', fotos: fotosParaMostrar };
      }

      mensajesTurno.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.tool_calls });
      for (const toolCall of resp.tool_calls) {
        const resultado = await ejecutarFuncion(toolCall, productos, helpers);
        mensajesTurno.push({ role: 'tool', tool_call_id: toolCall.id, content: resultado || 'Hecho.' });
      }
    }
    return { ok: true, demo: false, proveedor, modelo, respuesta: 'Un momento, ya te ayudo con eso.', fotos: fotosParaMostrar };
  } catch (err) {
    console.error(`Error del agente (${proveedor}):`, err.message);
    return { ok: true, demo: true, proveedor: 'demo', respuesta: respuestaDemo(empresa, productos, mensajeCliente) };
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
    ? productos.map((p) => `${p.nombre} (categoria: ${p.categoria || 'General'})`).join(', ')
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

module.exports = { generarRespuesta, construirSystem, proveedorActivo, analizarImagenProducto, transcribirAudio };
