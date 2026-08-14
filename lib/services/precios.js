// Resolucion de precio de un Plan/Paquete segun el pais del visitante.
// Cascada: precio propio del pais (PlanPrecioPais/PaquetePrecioPais) ->
// default en dolares (mensualidadUsd etc / precioUsd) -> default en
// bolivianos (mensualidadBs etc, el precio historico). Pura funcion
// determinista, sin DB ni red, mismo patron que buscarProductosFiltrados en
// lib/services/agente.js.

const SIMBOLOS_MONEDA = { BOB: 'Bs', USD: 'US$', PEN: 'S/' };

function simboloMoneda(moneda) {
  return SIMBOLOS_MONEDA[moneda] || moneda;
}

// preciosPais: array de filas PlanPrecioPais (ya traidas de la DB para este plan).
function precioPlanParaPais(plan, pais, preciosPais = []) {
  const override = pais ? preciosPais.find((o) => o.pais === pais) : null;
  if (override) {
    return {
      mensualidad: Number(override.mensualidad),
      implementacion: Number(override.implementacion),
      primerPago: Number(override.primerPago),
      moneda: override.moneda,
    };
  }
  if (plan.mensualidadUsd != null) {
    return {
      mensualidad: Number(plan.mensualidadUsd),
      implementacion: Number(plan.implementacionUsd),
      primerPago: Number(plan.primerPagoUsd),
      moneda: 'USD',
    };
  }
  return {
    mensualidad: Number(plan.mensualidadBs),
    implementacion: Number(plan.implementacionBs),
    primerPago: Number(plan.primerPagoBs),
    moneda: 'BOB',
  };
}

// preciosPais: array de filas PaquetePrecioPais (ya traidas de la DB para este paquete).
function precioPaqueteParaPais(paquete, pais, preciosPais = []) {
  const override = pais ? preciosPais.find((o) => o.pais === pais) : null;
  if (override) {
    return {
      precio: Number(override.precio),
      costoUnitario: Number(override.costoUnitario),
      moneda: override.moneda,
    };
  }
  return {
    precio: Number(paquete.precioUsd),
    costoUnitario: Number(paquete.costoUnitarioUsd),
    moneda: 'USD',
  };
}

module.exports = { precioPlanParaPais, precioPaqueteParaPais, simboloMoneda, SIMBOLOS_MONEDA };
