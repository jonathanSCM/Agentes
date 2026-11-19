// Rentabilidad: pagos confirmados (Bs) frente al costo de IA convertido a Bs con el cambio de cada día.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const R = require('../lib/services/rentabilidad');
const tipoCambio = require('../lib/services/tipoCambio');

const SLUGS = ['test-rent-a', 'test-rent-b', 'test-rent-c'];
let a; let b; let c;

async function nueva(slug, nombre) {
  await prisma.empresa.deleteMany({ where: { slug } });
  return prisma.empresa.create({ data: { nombre, slug, agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
}
const uso = (e, usd, extra = {}) => prisma.usoIA.create({ data: { empresaId: e.id, proveedor: 'openai', modelo: 'm', promptTokens: 1, completionTokens: 1, costoUsd: usd, estado: 'COMPLETADA', ...extra } });

before(async () => {
  [a, b, c] = [await nueva(SLUGS[0], 'Rent A'), await nueva(SLUGS[1], 'Rent B'), await nueva(SLUGS[2], 'Rent C')];
  await tipoCambio.ponerManual({ valor: '10', fecha: tipoCambio.hoyBolivia(), nota: 'test rentabilidad' });
  // A: paga Bs 100 y cuesta US$ 2 (= Bs 20) -> margen Bs 80
  await prisma.pago.create({ data: { empresaId: a.id, tipo: 'MENSUALIDAD', monto: 100, moneda: 'BOB', estado: 'CONFIRMADO' } });
  await uso(a, 1); await uso(a, 1);
  await prisma.pago.create({ data: { empresaId: a.id, tipo: 'MENSUALIDAD', monto: 500, moneda: 'BOB', estado: 'PENDIENTE' } }); // no cuenta
  // B: paga US$ 5 (= Bs 50) y cuesta US$ 10 (= Bs 100) -> pérdida
  await prisma.pago.create({ data: { empresaId: b.id, tipo: 'MENSUALIDAD', monto: 5, moneda: 'USD', estado: 'CONFIRMADO' } });
  await uso(b, 10);
  await prisma.usoIA.create({ data: { empresaId: b.id, proveedor: 'openai', modelo: 'm', promptTokens: 0, completionTokens: 0, estado: 'FALLIDA' } }); // no suma costo
  // C: usa IA y no paga
  await uso(c, 3);
  await prisma.conversacion.create({ data: { agenteId: a.agentes[0].id, telefonoCliente: '59170000001' } });
});
after(async () => {
  for (const e of [a, b, c]) await prisma.empresa.delete({ where: { id: e.id } }).catch(() => {});
  await prisma.tipoCambio.deleteMany({ where: { nota: 'test rentabilidad' } });
});

const fila = (r, e) => r.filas.find((f) => f.empresaId === e.id);

describe('porEmpresa', () => {
  test('ingresos solo con pagos confirmados, costo en Bs con el cambio del día y margen', async () => {
    const r = await R.porEmpresa({ dias: 30 });
    const fa = fila(r, a);
    assert.equal(fa.ingresosBs, 100); assert.equal(fa.costoBs, 20); assert.equal(fa.margenBs, 80); assert.equal(fa.margenPct, 80);
    assert.equal(fa.estado, 'OK'); assert.equal(fa.conversaciones, 1); assert.equal(fa.costoPorConversacionBs, 20);
  });
  test('un pago en dólares se pasa a Bs y una empresa que cuesta más de lo que paga queda en pérdida', async () => {
    const fb = fila(await R.porEmpresa({ dias: 30 }), b);
    assert.equal(fb.ingresosBs, 50); assert.equal(fb.costoBs, 100); assert.equal(fb.margenBs, -50); assert.equal(fb.estado, 'PERDIDA');
  });
  test('usar IA sin pagar es SIN_INGRESOS, sin porcentaje', async () => {
    const fc = fila(await R.porEmpresa({ dias: 30 }), c);
    assert.equal(fc.estado, 'SIN_INGRESOS'); assert.equal(fc.margenPct, null); assert.equal(fc.margenBs, -30);
  });
  test('ordena de menor a mayor margen y los totales suman', async () => {
    const r = await R.porEmpresa({ dias: 30 });
    for (let i = 1; i < r.filas.length; i++) assert.ok(r.filas[i - 1].margenBs <= r.filas[i].margenBs);
    assert.ok(r.totales.empresasEnPerdida >= 1 && r.totales.empresasSinIngresos >= 1);
    assert.equal(Math.round((r.totales.ingresosBs - r.totales.costoBs) * 100), Math.round(r.totales.margenBs * 100));
  });
  test('un período corto que no incluye los datos no los cuenta', async () => {
    const viejo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await prisma.usoIA.updateMany({ where: { empresaId: c.id }, data: { createdAt: viejo } });
    assert.equal(fila(await R.porEmpresa({ dias: 30 }), c), undefined);
    // Ese día es anterior al primer tipo de cambio guardado: no se convierte ni se inventa, queda aparte.
    const fc = fila(await R.porEmpresa({ dias: 365 }), c);
    assert.equal(fc.costoBs, 0); assert.equal(fc.costoSinConvertirUsd, 3);
  });
});
