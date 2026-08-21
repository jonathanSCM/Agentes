// Carrito de la conversacion.
//
// El cliente va agregando lo que quiere ("me interesa la Ginger Tav en blanco
// talla 9"), el bot le pregunta si desea ver algo mas, y al final se cierra
// todo junto con un resumen. Antes el pedido se armaba de una sola vez y el
// modelo tenia que "acordarse" de los items: si se olvidaba uno, se vendia de
// menos.
//
// Vive en ClienteFinal.contexto.carrito, no en una tabla: por decision del
// negocio el carrito NO sobrevive a la conversacion (si el cliente vuelve al
// dia siguiente, arranca limpio). Se guarda junto al id de conversacion para
// poder detectar exactamente eso.
//
// Puro y determinista: sin DB ni red, se testea sin levantar nada.

const MAX_ITEMS = 20;

/**
 * El carrito de ESTA conversacion. Si el guardado quedo de una conversacion
 * anterior, se devuelve vacio: el cliente que vuelve otro dia empieza de cero.
 */
function carritoDe(contexto = {}, conversacionId = null) {
  const guardado = contexto.carrito;
  if (!guardado || !Array.isArray(guardado.items)) return [];
  if (conversacionId && guardado.conversacionId && guardado.conversacionId !== conversacionId) return [];
  return guardado.items;
}

function guardarCarrito(contexto = {}, conversacionId, items) {
  return { ...contexto, carrito: { conversacionId: conversacionId || null, items: items.slice(0, MAX_ITEMS) } };
}

function contextoSinCarrito(contexto = {}) {
  return { ...contexto, carrito: null };
}

// Dos lineas son la misma si apuntan al mismo producto Y a la misma variante:
// la misma zapatilla en talla 9 y en talla 10 son items distintos.
function mismaLinea(a, b) {
  return a.productoId === b.productoId && (a.varianteId || null) === (b.varianteId || null);
}

/**
 * Agrega (o suma cantidad si ya estaba). Devuelve el carrito nuevo, sin mutar
 * el anterior.
 */
function agregarItem(items, item) {
  const existente = items.find((i) => mismaLinea(i, item));
  if (existente) {
    return items.map((i) => (mismaLinea(i, item) ? { ...i, cantidad: i.cantidad + item.cantidad } : i));
  }
  return [...items, item];
}

function quitarItem(items, { productoId, varianteId = null }) {
  return items.filter((i) => !mismaLinea(i, { productoId, varianteId }));
}

function totalCarrito(items) {
  return items.reduce((suma, i) => suma + Number(i.precio) * i.cantidad, 0);
}

/**
 * Resumen legible del carrito, con el formateador de precio que corresponda a
 * la moneda del negocio (se inyecta para no acoplar esto a agente.js).
 */
function resumenCarrito(items, formatearPrecio) {
  if (!items.length) return 'El carrito esta vacio.';
  const lineas = items.map((i) => `- ${i.cantidad}x ${i.nombre} — ${formatearPrecio(i.precio)} c/u`);
  return `${lineas.join('\n')}\nTotal: ${formatearPrecio(totalCarrito(items))}`;
}

// Los items en el formato que espera crear_pedido. Se lleva agregadoEn (si el
// item lo tiene) para que confirmar_pedido pueda avisar cuando algo lleva
// horas en el carrito de una sesion que no se llego a cerrar - nunca se
// inventa, si el item no lo tiene queda null.
function itemsParaPedido(items) {
  return items.map((i) => ({ idProducto: i.productoId, idVariante: i.varianteId || undefined, cantidad: i.cantidad, agregadoEn: i.agregadoEn || null }));
}

module.exports = {
  carritoDe, guardarCarrito, contextoSinCarrito,
  agregarItem, quitarItem, totalCarrito, resumenCarrito, itemsParaPedido,
  MAX_ITEMS,
};
