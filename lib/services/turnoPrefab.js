'use strict';
// lib/services/turnoPrefab.js
//
// FASE M1 (docs/10-plan-mensajes-prefabricados.md): la IA NO escribe texto.
// Solo ELIGE un mensaje del catalogo (por clave) y, si hace falta, un dato de una
// lista cerrada (id de producto, atributo, id de pregunta frecuente). El backend
// arma el texto con `mensajes.js`, rellenando precio, stock, nombre, etc. con datos reales.
//
// Este modulo es puro (sin base de datos ni red): lo usa agente.js cuando el agente
// tiene el flag `mensajesPrefabricados` (que exige `flujoDeterminista`).

const { obtenerFabrica } = require('./mensajesBase');
const { ErrorMensaje } = require('./mensajes');
const { formatearHorario } = require('./faq');
const { formasDePago } = require('./modoSinIA');

const NOMBRE_TOOL = 'responder';
const CATEGORIAS_ELEGIBLES = new Set(['Conversación', 'Información']);
// Los "sin datos" los decide el backend cuando falta el dato; la IA no los elige.
const NO_ELEGIBLES = new Set(['pago_sin_datos', 'direccion_sin_datos', 'horario_sin_datos', 'producto_dato_no_disponible', 'agregado_al_carrito']);
const MAX_CANDIDATOS_EN_PROMPT = 12;

// Herramientas de accion que la IA conserva en este modo (el resto lo hace el flujo con botones).
const TOOLS_DE_ACCION = new Set([
  'actualizar_datos_lead', 'buscar_producto', 'mostrar_productos', 'ver_mas_productos',
  'enviar_fotos_producto', 'mostrar_categorias', 'mostrar_tarjeta_categoria',
  'agregar_al_carrito', 'ver_carrito', 'quitar_del_carrito', 'cambiar_cantidad_carrito', 'derivar_a_asesor',
]);

/** Mensajes que la IA puede elegir: [{ clave, descripcion, necesita }] (de fabrica; los propios llegan en M2). */
function mensajesElegibles(ctx) {
  const salida = [];
  for (const clave of ctx.claves()) {
    const f = obtenerFabrica(clave);
    if (!f || !CATEGORIAS_ELEGIBLES.has(f.categoria) || NO_ELEGIBLES.has(clave)) continue;
    const necesita = [];
    if (/\{\{producto\}\}|\{\{precio\}\}|\{\{stock\}\}/.test(f.texto)) necesita.push('producto_id');
    if (/\{\{falta\}\}/.test(f.texto)) necesita.push('falta');
    if (clave === 'producto_dato') necesita.push('atributo');
    if (clave === 'faq_respuesta') necesita.push('faq_id');
    salida.push({ clave, descripcion: f.descripcion, necesita });
  }
  // Los mensajes propios del negocio: la IA los elige leyendo la descripcion que el negocio escribio.
  for (const p of (ctx.propios ? ctx.propios() : [])) {
    if (p.descripcion) salida.push({ clave: p.clave, descripcion: p.descripcion, necesita: [] });
  }
  return salida;
}

/** Definicion de la unica herramienta "de hablar": la IA elige una clave de una lista cerrada. */
function herramientaResponder(elegibles) {
  return {
    type: 'function',
    function: {
      name: NOMBRE_TOOL,
      description: 'Contesta al cliente ELIGIENDO un mensaje prefabricado. No escribas texto: el sistema arma el mensaje con datos reales.',
      parameters: {
        type: 'object',
        properties: {
          mensaje: { type: 'string', enum: elegibles.map((e) => e.clave), description: 'Clave del mensaje a enviar.' },
          producto_id: { type: 'integer', description: 'ID del producto (solo de la lista del sistema) si el mensaje habla de un producto.' },
          falta: { type: 'string', enum: ['la talla', 'el color', 'la talla y el color'], description: 'Que dato falta (solo para pedir_variante).' },
          atributo: { type: 'string', description: 'Nombre del dato del producto que pregunto el cliente (solo para producto_dato), como figura en la lista.' },
          faq_id: { type: 'integer', description: 'Numero de la pregunta frecuente (solo para faq_respuesta).' },
        },
        required: ['mensaje'],
      },
    },
  };
}

/** Las herramientas de este turno: las de accion que correspondan + responder. */
function herramientasDelTurno(toolsDelEstado, elegibles) {
  return [...toolsDelEstado.filter((t) => TOOLS_DE_ACCION.has(t.function.name)), herramientaResponder(elegibles)];
}

/** System prompt compacto en dos partes (fija = cacheable, variable = estado). No incluye textos para copiar. */
function armarSystem({ empresa, elegibles, candidatos = [], carrito = [], config = {}, lead = {} }) {
  const negocio = (empresa && (empresa.marca || empresa.nombre)) || 'la tienda';
  const lineasMsg = elegibles.map((e) => `- ${e.clave}: ${e.descripcion}${e.necesita.length ? ` [indica: ${e.necesita.join(', ')}]` : ''}`);
  const lineasProd = candidatos.slice(0, MAX_CANDIDATOS_EN_PROMPT).map((p) => {
    const attrs = Object.entries(p.atributos || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return `- [${p.id}] ${p.nombre} | ${p.categoria && p.categoria.nombre ? p.categoria.nombre : 'General'} | ${stockTotal(p) > 0 ? `stock ${stockTotal(p)}` : 'AGOTADO'}${variantesCortas(p) ? ` | variantes: ${variantesCortas(p)}` : ''}${attrs ? ` | ${attrs}` : ''}`;
  });
  const faq = Array.isArray(config.faq) ? config.faq : [];
  const lineasFaq = faq.map((f, i) => `- ${i + 1}: ${f.pregunta}`);
  const lineasCarrito = carrito.map((i) => `- ${i.cantidad}x ${i.nombre}`);
  const fijo = [
    `Sos el agente de ventas de ${negocio} por WhatsApp. NO escribas texto para el cliente: solo actuas con herramientas.`,
    'Para contestar usa la herramienta "responder" y elegi UNA clave de la lista; el sistema completa precios, stock y nombres.',
    'Si necesitas buscar o mostrar productos, usa primero esas herramientas (el sistema manda las tarjetas) y despues elegi el mensaje.',
    'Si el cliente nombra un producto: mostralo con mostrar_productos y despues elegi producto_mostrado. Si dice que le gusta uno o lo quiere: usa agregar_al_carrito. Afirmar algo (agotado, ya en el carrito) solo si la lista de abajo lo muestra.',
    'Si el cliente pregunta algo que ningun mensaje cubre o no estas seguro, usa derivar_a_asesor. Nunca inventes datos.',
    '',
    'MENSAJES QUE PODES ELEGIR:', ...lineasMsg,
  ].join('\n');
  const variable = [
    lineasFaq.length ? 'PREGUNTAS FRECUENTES DEL NEGOCIO (faq_respuesta):' : '', ...lineasFaq,
    'PRODUCTOS (usa solo estos ID):', ...(lineasProd.length ? lineasProd : ['- (ninguno cargado para esta busqueda: usa buscar_producto)']),
    lineasCarrito.length ? 'CARRITO ACTUAL:' : '', ...lineasCarrito,
    lead && lead.nombre ? `Cliente: ${lead.nombre}` : '',
  ].filter((l) => l !== '').join('\n');
  return { fijo, variable, texto: `${fijo}\n\n${variable}` };
}

/** Stock real: si el producto tiene variantes activas, la suma de ellas; si no, el del producto. */
function stockTotal(p) {
  const vs = (p.variantes || []).filter((v) => v.activa !== false);
  return vs.length ? vs.reduce((t, v) => t + (Number(v.stock) || 0), 0) : (Number(p.stock) || 0);
}

/** Variantes con stock, en corto: "Talla 42 Negro (5), ..." */
function variantesCortas(p) {
  return (p.variantes || []).filter((v) => v.activa !== false && Number(v.stock) > 0)
    .map((v) => Object.values(v.atributos || {}).join(' ')).filter(Boolean).slice(0, 8).join(', ');
}

function productoPorId(productos, id) {
  const n = Number(id);
  return Number.isInteger(n) ? (productos || []).find((p) => p.id === n) || null : null;
}

/**
 * Valida la eleccion de la IA y arma el texto.
 * @returns {{ ok: true, texto, clave } | { ok: false, motivo }}
 */
function resolverEleccion(eleccion, { ctx, productos, config = {}, elegibles, carrito = [], mostrados = [] }) {
  const args = eleccion || {};
  let clave = String(args.mensaje || '');
  if (!elegibles.some((e) => e.clave === clave)) return { ok: false, motivo: 'clave_no_permitida' };
  // El backend sabe que tarjetas mando en este turno: si fue UNA sola, el mensaje nombra ese producto.
  const unicos = [...new Set(mostrados)];
  if (unicos.length === 1 && (clave === 'productos_mostrados' || (clave === 'producto_mostrado' && !args.producto_id))) {
    clave = 'producto_mostrado';
    args.producto_id = unicos[0];
  }
  const asesor = ctx.t('ofrecer_asesor');
  const producto = productoPorId(productos, args.producto_id);
  const necesitaProducto = (elegibles.find((e) => e.clave === clave) || {}).necesita.includes('producto_id');
  if (necesitaProducto && !producto) return { ok: false, motivo: 'producto_invalido' };

  // Afirmaciones: solo se aceptan si los datos reales las respaldan (la IA puede equivocarse al elegir).
  if (producto) {
    const stock = stockTotal(producto);
    if (clave === 'producto_agotado' && stock > 0) return { ok: false, motivo: 'el_producto_tiene_stock' };
    if (clave === 'producto_sin_stock' && stock <= 0) return { ok: false, motivo: 'el_producto_esta_agotado' };
    if (clave === 'ya_en_carrito' && !carrito.some((i) => i.productoId === producto.id)) return { ok: false, motivo: 'el_producto_no_esta_en_el_carrito' };
    if (clave === 'pedir_variante' && !(producto.variantes || []).some((v) => v.activa !== false)) return { ok: false, motivo: 'el_producto_no_tiene_variantes' };
    if (['producto_mostrado', 'fotos_enviadas'].includes(clave) && stock <= 0) return { ok: false, motivo: 'el_producto_esta_agotado' };
  }
  try {
    switch (clave) {
      case 'producto_precio':
        return listo(ctx.render(clave, { producto: producto.nombre, precio: Number(producto.precio) }));
      case 'producto_sin_stock':
        return listo(ctx.render(clave, { producto: producto.nombre, stock: stockTotal(producto) }));
      case 'producto_dato': {
        const atributos = producto.atributos || {};
        const nombre = Object.keys(atributos).find((k) => k.toLowerCase() === String(args.atributo || '').toLowerCase());
        const valor = nombre ? atributos[nombre] : (/descrip/i.test(String(args.atributo || '')) ? producto.descripcion : null);
        if (!valor) return listo(ctx.render('producto_dato_no_disponible', { producto: producto.nombre }));
        return listo(ctx.render(clave, { producto: producto.nombre, atributo: `${nombre || 'descripción'}:`, valor: String(valor) }));
      }
      case 'producto_variantes': {
        const op = variantesCortas(producto);
        if (!op) return listo(ctx.render('producto_agotado', { producto: producto.nombre }));
        return listo(ctx.render(clave, { producto: producto.nombre, opciones: op }));
      }
      case 'pedir_variante':
        return listo(ctx.render(clave, { producto: producto.nombre, falta: String(args.falta || 'la talla') }));
      case 'faq_respuesta': {
        const faq = Array.isArray(config.faq) ? config.faq : [];
        const f = faq[Number(args.faq_id) - 1];
        if (!f || !f.respuesta) return { ok: false, motivo: 'faq_invalida' };
        return listo(ctx.render(clave, { respuesta: String(f.respuesta) }));
      }
      case 'pago_formas': {
        const formas = formasDePago(config);
        if (!formas.length) return listo(ctx.render('pago_sin_datos', { asesor }));
        return listo(ctx.render(clave, { formas: formas.length > 1 ? `${formas.slice(0, -1).join(', ')} y ${formas[formas.length - 1]}` : formas[0] }));
      }
      case 'direccion_tienda':
        return config.direccionTienda
          ? listo(ctx.render(clave, { direccion: config.direccionTienda }))
          : listo(ctx.render('direccion_sin_datos', { asesor }));
      case 'envio_info':
        return listo(ctx.render(clave, { retiro: config.direccionTienda ? 'si' : '', asesor }));
      case 'horario_info': {
        const horario = formatearHorario(config.horarioAtencion);
        return horario ? listo(ctx.render(clave, { horario })) : listo(ctx.render('horario_sin_datos', { asesor }));
      }
      case 'productos_mostrados':
        return listo(ctx.render(clave, unicos.length ? { cantidad: unicos.length } : {}));
      default: {
        const vars = {};
        if (producto) vars.producto = producto.nombre;
        return listo(ctx.render(clave, vars));
      }
    }
  } catch (err) {
    if (err instanceof ErrorMensaje) return { ok: false, motivo: `mensaje_invalido: ${err.message}` };
    throw err;
  }
}

function listo(r) {
  return { ok: true, texto: r.texto, clave: r.clave };
}

module.exports = {
  stockTotal,
  NOMBRE_TOOL, TOOLS_DE_ACCION, mensajesElegibles, herramientaResponder, herramientasDelTurno,
  armarSystem, resolverEleccion,
};
