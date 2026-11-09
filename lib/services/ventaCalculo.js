'use strict';
// lib/services/ventaCalculo.js
//
// Reglas de DINERO del punto de venta, puras (sin base de datos). Todo se calcula en CENTAVOS ENTEROS:
// nunca se suman decimales en coma flotante (0.1 + 0.2). El servidor recalcula siempre desde los
// precios de la base; lo que mande el navegador solo son cantidades y descuentos.

const METODOS = ['EFECTIVO', 'QR', 'TARJETA', 'TRANSFERENCIA'];
const ETIQUETAS_METODO = { EFECTIVO: 'Efectivo', QR: 'QR', TARJETA: 'Tarjeta', TRANSFERENCIA: 'Transferencia' };
const MAX_LINEAS = 100;
const MAX_CANTIDAD = 10000;
const MAX_MONTO_CENTAVOS = 100000000 * 100; // 100 millones

class ErrorVenta extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje);
    this.codigo = 'VENTA';
    this.detalle = detalle;
  }
}

/** "12.5" / 12.5 / Decimal -> 1250 (centavos). NaN si no es un numero. */
function aCentavos(valor) {
  if (valor === null || valor === undefined || valor === '') return NaN;
  const n = Number(typeof valor === 'object' && valor.toString ? valor.toString() : valor);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** 1250 -> 12.5 (para guardar en columnas DECIMAL). */
const deCentavos = (c) => Math.round(c) / 100;

/** "Bs 12.50" con la moneda que se pase. */
const formatoMonto = (centavos, simbolo = '') => `${simbolo ? `${simbolo} ` : ''}${(centavos / 100).toFixed(2)}`;

function enteroPositivo(valor, mensaje, tope) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0 || n > tope) throw new ErrorVenta(mensaje);
  return n;
}

/**
 * @param {Array<{ precioUnitario: number|string, cantidad: number, descuento?: number|string }>} lineas
 *   (precioUnitario sale de la base; descuento es un monto por linea, opcional)
 * @param {number|string} [descuentoGlobal] monto de descuento sobre el total
 * @returns {{ lineas: Array<{ cantidad, precioCentavos, brutoCentavos, descuentoCentavos, totalCentavos }>, subtotalCentavos, descuentoCentavos, totalCentavos }}
 */
function calcularVenta(lineas, descuentoGlobal = 0) {
  if (!Array.isArray(lineas) || !lineas.length) throw new ErrorVenta('Agregá al menos un producto.');
  if (lineas.length > MAX_LINEAS) throw new ErrorVenta(`Demasiados productos en una venta (máximo ${MAX_LINEAS}).`);
  let subtotal = 0;
  let descuentoLineas = 0;
  const calculadas = lineas.map((l, i) => {
    const cantidad = enteroPositivo(l.cantidad, `La cantidad de la línea ${i + 1} tiene que ser un número entero mayor a 0.`, MAX_CANTIDAD);
    const precio = aCentavos(l.precioUnitario);
    if (!Number.isFinite(precio) || precio < 0) throw new ErrorVenta(`El precio de la línea ${i + 1} no es válido.`);
    const bruto = precio * cantidad;
    const descuentoCentavos = l.descuento === undefined || l.descuento === '' || l.descuento === null ? 0 : aCentavos(l.descuento);
    if (!Number.isFinite(descuentoCentavos) || descuentoCentavos < 0) throw new ErrorVenta(`El descuento de la línea ${i + 1} no es válido.`);
    if (descuentoCentavos > bruto) throw new ErrorVenta(`El descuento de la línea ${i + 1} no puede ser mayor que su importe.`);
    subtotal += bruto;
    descuentoLineas += descuentoCentavos;
    return { cantidad, precioCentavos: precio, brutoCentavos: bruto, descuentoCentavos, totalCentavos: bruto - descuentoCentavos };
  });
  const global = descuentoGlobal === undefined || descuentoGlobal === '' || descuentoGlobal === null ? 0 : aCentavos(descuentoGlobal);
  if (!Number.isFinite(global) || global < 0) throw new ErrorVenta('El descuento no es válido.');
  if (descuentoLineas + global > subtotal) throw new ErrorVenta('El descuento no puede ser mayor que el total de la venta.');
  if (subtotal > MAX_MONTO_CENTAVOS) throw new ErrorVenta('El monto de la venta es demasiado grande.');
  const descuentoCentavos = descuentoLineas + global;
  return { lineas: calculadas, subtotalCentavos: subtotal, descuentoCentavos, totalCentavos: subtotal - descuentoCentavos };
}

/**
 * Valida los pagos contra el total y calcula el vuelto del efectivo.
 * Regla: la suma de los montos tiene que ser EXACTAMENTE el total. En efectivo se puede recibir mas
 * de lo que se cobra (se da vuelto); los demas metodos se cobran justo.
 * @param {number} totalCentavos
 * @param {Array<{ metodo: string, monto: number|string, recibido?: number|string, referencia?: string }>} pagos
 */
function validarPagos(totalCentavos, pagos) {
  if (!Array.isArray(pagos) || !pagos.length) throw new ErrorVenta('Elegí cómo paga el cliente.');
  if (pagos.length > 6) throw new ErrorVenta('Demasiadas formas de pago en una venta.');
  let suma = 0;
  const salida = pagos.map((p, i) => {
    const metodo = String(p.metodo || '').toUpperCase();
    if (!METODOS.includes(metodo)) throw new ErrorVenta(`La forma de pago ${i + 1} no es válida.`);
    const monto = aCentavos(p.monto);
    if (!Number.isFinite(monto) || monto <= 0) throw new ErrorVenta(`El monto de ${ETIQUETAS_METODO[metodo]} tiene que ser mayor a 0.`);
    let recibido = monto;
    let vuelto = 0;
    if (metodo === 'EFECTIVO' && p.recibido !== undefined && p.recibido !== null && p.recibido !== '') {
      recibido = aCentavos(p.recibido);
      if (!Number.isFinite(recibido) || recibido < monto) throw new ErrorVenta('El efectivo recibido no alcanza para cubrir lo que se cobra en efectivo.');
      vuelto = recibido - monto;
    }
    suma += monto;
    return { metodo, montoCentavos: monto, recibidoCentavos: recibido, vueltoCentavos: vuelto, referencia: p.referencia ? String(p.referencia).trim().slice(0, 80) : null };
  });
  if (suma !== totalCentavos) {
    const diferencia = totalCentavos - suma;
    throw new ErrorVenta(diferencia > 0
      ? `Falta cobrar ${formatoMonto(diferencia)}.`
      : `Los pagos suman ${formatoMonto(-diferencia)} más que el total.`, { diferencia });
  }
  return salida;
}

/**
 * Efectivo que deberia haber en la caja: inicial + cobros en efectivo (el monto cobrado, sin el vuelto) +
 * entradas manuales - salidas manuales. Las ventas anuladas no cuentan.
 */
function efectivoEsperado({ inicialCentavos, cobrosEfectivoCentavos, entradasCentavos = 0, salidasCentavos = 0 }) {
  return inicialCentavos + cobrosEfectivoCentavos + entradasCentavos - salidasCentavos;
}

module.exports = {
  METODOS, ETIQUETAS_METODO, MAX_LINEAS, MAX_CANTIDAD, ErrorVenta,
  aCentavos, deCentavos, formatoMonto, calcularVenta, validarPagos, efectivoEsperado,
};
