// Reglas de transicion de estado de un pedido. Logica pura (sin DB) para que
// sea facil de testear - la aplicacion real (incluido el restock) vive en el
// handler de server.js.
const TRANSICIONES_VALIDAS = {
  NUEVO: ['CONFIRMADO', 'CANCELADO'],
  CONFIRMADO: ['ENTREGADO', 'CANCELADO'],
  ENTREGADO: [], // estado final: no se puede reabrir un pedido ya entregado
  CANCELADO: [], // estado final: no se puede reabrir un pedido ya cancelado
};

function transicionValida(estadoActual, estadoNuevo) {
  return (TRANSICIONES_VALIDAS[estadoActual] || []).includes(estadoNuevo);
}

// El stock se descuenta al CREAR el pedido (ver crear_pedido en agente.js),
// no al entregarlo - asi que solo hay que devolverlo si el pedido se
// cancela, y solo una vez (nunca si ya estaba cancelado).
function requiereRestock(estadoActual, estadoNuevo) {
  return estadoNuevo === 'CANCELADO' && estadoActual !== 'CANCELADO';
}

const VENTANA_24H_MS = 24 * 60 * 60 * 1000;

// Meta solo deja mandar un mensaje de texto libre (no plantilla aprobada) si
// el cliente escribio hace menos de 24 horas. Se usa Conversacion.ultimoMensajeAt
// como referencia de "cuando escribio por ultima vez".
function dentroDeVentana24h(ultimoMensajeAt, ahora = new Date()) {
  if (!ultimoMensajeAt) return false;
  return ahora.getTime() - new Date(ultimoMensajeAt).getTime() < VENTANA_24H_MS;
}

module.exports = { TRANSICIONES_VALIDAS, transicionValida, requiereRestock, dentroDeVentana24h };
