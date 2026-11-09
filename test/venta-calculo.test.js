// Reglas de dinero del punto de venta (puras): centavos enteros, descuentos, pagos, vuelto y caja.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/services/ventaCalculo');

const falla = (fn, patron) => assert.throws(fn, (e) => { assert.equal(e.codigo, 'VENTA'); assert.match(e.message, patron); return true; });

describe('centavos', () => {
  test('sin errores de coma flotante', () => {
    assert.equal(V.aCentavos(0.1) + V.aCentavos(0.2), 30);
    assert.equal(V.aCentavos('19.99'), 1999);
    assert.equal(V.aCentavos({ toString: () => '12.50' }), 1250, 'acepta Decimal de Prisma');
    assert.ok(Number.isNaN(V.aCentavos('abc')));
    assert.ok(Number.isNaN(V.aCentavos('')));
    assert.equal(V.deCentavos(1999), 19.99);
    assert.equal(V.formatoMonto(1250, 'Bs'), 'Bs 12.50');
  });
});

describe('calcularVenta', () => {
  test('suma líneas, aplica descuentos de línea y global', () => {
    const r = V.calcularVenta([
      { precioUnitario: 10.1, cantidad: 3 },
      { precioUnitario: '5.50', cantidad: 2, descuento: 1 },
    ], 2);
    assert.equal(r.subtotalCentavos, 3030 + 1100);
    assert.equal(r.descuentoCentavos, 100 + 200);
    assert.equal(r.totalCentavos, 4130 - 300);
    assert.equal(r.lineas[1].totalCentavos, 1100 - 100);
  });

  test('rechaza cantidades raras, precios inválidos y descuentos mayores al importe', () => {
    for (const cantidad of [0, -2, 1.5, NaN, 'x', V.MAX_CANTIDAD + 1]) falla(() => V.calcularVenta([{ precioUnitario: 10, cantidad }]), /entero mayor a 0/);
    falla(() => V.calcularVenta([{ precioUnitario: -1, cantidad: 1 }]), /precio/);
    falla(() => V.calcularVenta([{ precioUnitario: 'x', cantidad: 1 }]), /precio/);
    falla(() => V.calcularVenta([{ precioUnitario: 10, cantidad: 1, descuento: 11 }]), /mayor que su importe/);
    falla(() => V.calcularVenta([{ precioUnitario: 10, cantidad: 1, descuento: -1 }]), /descuento/);
    falla(() => V.calcularVenta([{ precioUnitario: 10, cantidad: 1 }], 10.01), /no puede ser mayor/);
    falla(() => V.calcularVenta([]), /al menos un producto/);
    falla(() => V.calcularVenta(Array.from({ length: V.MAX_LINEAS + 1 }, () => ({ precioUnitario: 1, cantidad: 1 }))), /Demasiados/);
  });

  test('una venta de 0 es válida (producto regalado al 100 %) pero nunca negativa', () => {
    assert.equal(V.calcularVenta([{ precioUnitario: 10, cantidad: 1 }], 10).totalCentavos, 0);
  });
});

describe('validarPagos', () => {
  test('efectivo exacto, con vuelto y mixto', () => {
    let p = V.validarPagos(4130, [{ metodo: 'efectivo', monto: 41.3 }]);
    assert.equal(p[0].vueltoCentavos, 0);
    p = V.validarPagos(4130, [{ metodo: 'EFECTIVO', monto: 41.3, recibido: 50 }]);
    assert.equal(p[0].vueltoCentavos, 870);
    assert.equal(p[0].recibidoCentavos, 5000);
    p = V.validarPagos(10000, [{ metodo: 'EFECTIVO', monto: 30, recibido: 50 }, { metodo: 'QR', monto: 70 }]);
    assert.equal(p[0].vueltoCentavos, 2000);
    assert.equal(p[1].vueltoCentavos, 0);
  });

  test('la suma tiene que ser exactamente el total', () => {
    falla(() => V.validarPagos(10000, [{ metodo: 'QR', monto: 99.99 }]), /Falta cobrar 0\.01/);
    falla(() => V.validarPagos(10000, [{ metodo: 'QR', monto: 100.01 }]), /0\.01 más que el total/);
    falla(() => V.validarPagos(10000, []), /Elegí cómo paga/);
  });

  test('método inválido, monto 0 o negativo, efectivo recibido menor', () => {
    falla(() => V.validarPagos(100, [{ metodo: 'cheque', monto: 1 }]), /no es válida/);
    falla(() => V.validarPagos(100, [{ metodo: 'QR', monto: 0 }]), /mayor a 0/);
    falla(() => V.validarPagos(100, [{ metodo: 'QR', monto: -1 }]), /mayor a 0/);
    falla(() => V.validarPagos(10000, [{ metodo: 'EFECTIVO', monto: 100, recibido: 90 }]), /no alcanza/);
    falla(() => V.validarPagos(100, Array.from({ length: 7 }, () => ({ metodo: 'QR', monto: 1 }))), /Demasiadas/);
  });

  test('solo el efectivo da vuelto: tarjeta/QR/transferencia se cobran justo', () => {
    const p = V.validarPagos(5000, [{ metodo: 'TARJETA', monto: 50, recibido: 80 }]);
    assert.equal(p[0].vueltoCentavos, 0);
    assert.equal(p[0].recibidoCentavos, 5000);
  });
});

describe('efectivo esperado en caja', () => {
  test('inicial + cobros en efectivo (sin vuelto) + entradas - salidas', () => {
    assert.equal(V.efectivoEsperado({ inicialCentavos: 10000, cobrosEfectivoCentavos: 25000, entradasCentavos: 5000, salidasCentavos: 3000 }), 37000);
    assert.equal(V.efectivoEsperado({ inicialCentavos: 0, cobrosEfectivoCentavos: 0 }), 0);
  });
});
