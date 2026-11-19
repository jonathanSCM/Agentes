// Conversión de saldos de conversaciones a créditos: saldo en créditos = saldo antiguo x 5, idempotente, con informe de diferencias en cero.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const conv = require('../lib/services/conversionCreditos');
const C = require('../lib/services/creditos');
const K = require('../lib/services/creditosConsumo');
const { registrarCompraPaquete, consumirConversacion, obtenerEstadoConsumo } = require('../lib/services/suscripciones');

const SLUGS = ['test-conv-a', 'test-conv-b', 'test-conv-c'];
const dia = 24 * 60 * 60 * 1000;
let a; let b; let c; let planId; let subA;

async function empresaConPlan(slug, { ilimitado = false, estado = 'ACTIVA' } = {}) {
  await prisma.empresa.deleteMany({ where: { slug } });
  const e = await prisma.empresa.create({ data: { nombre: slug, slug } });
  const s = await prisma.suscripcion.create({ data: { empresaId: e.id, planId, estado, ilimitado, convIncluidas: 20, periodoInicio: new Date(Date.now() - 5 * dia), periodoFin: new Date(Date.now() + 25 * dia), planInicio: new Date(Date.now() - 5 * dia), planFin: new Date(Date.now() + 25 * dia) } });
  return { e, s };
}

before(async () => {
  planId = (await prisma.plan.findFirst({ where: { codigo: 'AGENTE_POS' } })).id;
  ({ e: a, s: subA } = await empresaConPlan(SLUGS[0]));
  ({ e: b } = await empresaConPlan(SLUGS[1], { ilimitado: true }));
  ({ e: c } = await empresaConPlan(SLUGS[2], { estado: 'CANCELADA' }));
  // A: usa 6 del plan (quedan 14), compra 10 y usa 0 -> hoy tiene 14 + 10 conversaciones (si el cupo del plan es 20)
  for (let i = 0; i < 6; i++) await consumirConversacion(subA.id, 'x');
  await registrarCompraPaquete({ empresaId: a.id, cantidad: 10, precioUsd: 1 });
});
after(async () => { for (const e of [a, b, c]) await prisma.empresa.delete({ where: { id: e.id } }).catch(() => {}); });

const filaDe = (r, e) => r.filas.find((f) => f.empresaId === e.id);

describe('planificar (simulación)', () => {
  test('calcula x5 el cupo restante del plan y cada paquete vigente, sin escribir nada', async () => {
    const antes = await obtenerEstadoConsumo(subA.id);
    const r = await conv.planificar();
    const f = filaDe(r, a);
    assert.equal(f.conversaciones, antes.totalDisponible);
    assert.equal(f.creditosEsperados, antes.totalDisponible * 5);
    assert.deepEqual(f.lotes.map((l) => l.origen).sort(), ['MIGRACION', 'PLAN']);
    assert.equal(await prisma.creditoLote.count({ where: { empresaId: a.id } }), 0, 'no escribió nada');
  });
  test('los planes ilimitados se omiten y las suscripciones canceladas no entran', async () => {
    const r = await conv.planificar();
    assert.equal(filaDe(r, b).omitida, 'PLAN_ILIMITADO');
    assert.equal(filaDe(r, c), undefined);
  });
  test('un paquete vencido o agotado no se convierte', async () => {
    await prisma.compraPaquete.create({ data: { empresaId: a.id, cantidad: 10, consumidas: 10, precioUsd: 0, fechaRenovacion: new Date(Date.now() + 30 * dia), estado: 'AGOTADA' } });
    await prisma.compraPaquete.create({ data: { empresaId: a.id, cantidad: 10, consumidas: 0, precioUsd: 0, fechaRenovacion: new Date(Date.now() - dia), estado: 'VENCIDA' } });
    const f = filaDe(await conv.planificar(), a);
    assert.equal(f.lotes.filter((l) => l.origen === 'MIGRACION').length, 1);
  });
});

describe('aplicar', () => {
  test('crea los lotes, el saldo en créditos es el saldo antiguo x 5 y el informe da diferencia cero', async () => {
    const antes = await obtenerEstadoConsumo(subA.id);
    const r = await conv.aplicar({ empresaId: a.id });
    assert.equal(r.verificacion.ok, true);
    assert.equal(r.verificacion.filas[0].diferencia, 0);
    assert.equal((await C.saldo(a.id)).total, antes.totalDisponible * 5);
    assert.equal((await C.verificarCuadre(a.id)).ok, true);
  });
  test('es idempotente: correrlo de nuevo no duplica', async () => {
    const t = (await C.saldo(a.id)).total;
    await conv.aplicar({ empresaId: a.id });
    assert.equal((await C.saldo(a.id)).total, t);
    assert.equal(await prisma.creditoLote.count({ where: { empresaId: a.id } }), 2);
  });
  test('la entrega mensual no vuelve a dar el cupo del mismo periodo (misma clave)', async () => {
    const t = (await C.saldo(a.id)).total;
    await K.otorgarPlanes(new Date(), { empresaId: a.id });
    assert.equal((await C.saldo(a.id)).total, t);
  });
  test('los datos de conversaciones no se tocan', async () => {
    const e = await obtenerEstadoConsumo(subA.id);
    assert.equal(e.incluidasUsadas, 6);
    assert.equal(e.extraDisponible, 10);
  });
  test('avisa de los pedidos de conversaciones pendientes', async () => {
    await prisma.solicitudConversaciones.create({ data: { empresaId: a.id, cantidad: 500, nota: 'pendiente de prueba' } });
    const r = await conv.planificar({ empresaId: a.id });
    assert.ok(r.solicitudesPendientes >= 1);
  });
});
