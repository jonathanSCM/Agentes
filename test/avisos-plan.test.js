// Avisos automáticos del plan: corte (7 d, 2 d, mismo día), gracia, vencimiento y uso (80 % / 95 %).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const P = require('../lib/services/planesCliente');
const A = require('../lib/services/avisosPlan');
const { consumirConversacion } = require('../lib/services/suscripciones');

const SLUG = 'test-avisos-plan';
const DIA = 24 * 60 * 60 * 1000;
let empresaId;
let plan;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_AVISOS' } });
  empresaId = (await prisma.empresa.create({ data: { nombre: 'Cliente Avisos', slug: SLUG } })).id;
  plan = await prisma.plan.create({
    data: { codigo: 'TEST_AVISOS', nombre: 'Plan avisos', mensualidadBs: 1, implementacionBs: 0, primerPagoBs: 1, convIncluidas: 10, maxProductos: 5, maxUsuarios: 1, modulos: ['AGENTE'] },
  });
});
after(async () => {
  await prisma.registroUso.deleteMany({ where: { suscripcion: { empresaId } } });
  await prisma.suscripcion.deleteMany({ where: { empresaId } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_AVISOS' } });
});
beforeEach(async () => {
  await prisma.notificacion.deleteMany({ where: { empresaId } });
  await prisma.registroUso.deleteMany({ where: { suscripcion: { empresaId } } });
});

const avisos = (tipo) => prisma.notificacion.findMany({ where: { empresaId, ...(tipo ? { tipo } : {}) }, orderBy: { id: 'asc' } });
const sub = () => prisma.suscripcion.findUnique({ where: { empresaId }, include: { plan: true } });

/** Deja el plan con el fin a `dias` dias del `ahora` simulado. */
async function conFinEn(dias, ahora, estado = 'ACTIVA') {
  await P.asignarPlan(empresaId, plan.id, { meses: 1, ahora });
  await prisma.suscripcion.update({ where: { empresaId }, data: { planFin: new Date(ahora.getTime() + dias * DIA), estado, avisosEnviados: {} } });
}

describe('avisos de corte', () => {
  test('7 días antes, 2 días antes y el mismo día: uno por vez y sin repetirse', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(7, ahora);
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), ['corte7']);
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), [], 'no se repite');
    assert.match((await avisos('PLAN_CORTE'))[0].titulo, /vence en 7 días/);

    await prisma.suscripcion.update({ where: { empresaId }, data: { planFin: new Date(ahora.getTime() + 2 * DIA) } });
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), ['corte2']);

    await prisma.suscripcion.update({ where: { empresaId }, data: { planFin: new Date(ahora.getTime() + 1000) } });
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), ['corte0']);
    assert.equal((await avisos('PLAN_CORTE')).length, 3);
  });

  test('si el plan tiene más de 7 días no avisa nada', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(20, ahora);
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), []);
    assert.equal((await avisos()).length, 0);
  });

  test('una prueba gratis avisa como "prueba", no como "plan"', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(2, ahora, 'PRUEBA');
    await A.revisarVigencia(await sub(), ahora);
    assert.match((await avisos())[0].titulo, /prueba termina en 2 días/);
  });
});

describe('gracia y vencimiento', () => {
  test('vencido: avisa la gracia (5 días con todo funcionando) y NO corta todavía', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(-1, ahora);
    const hecho = await A.revisarVigencia(await sub(), ahora);
    assert.deepEqual(hecho, ['gracia']);
    assert.equal((await sub()).estado, 'ACTIVA');
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), [], 'el aviso de gracia es una sola vez');
  });

  test('pasada la gracia: el agente se corta (MOROSA) y se avisa una vez', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(-6, ahora);
    await prisma.suscripcion.update({ where: { empresaId }, data: { avisosEnviados: { gracia: true } } });
    assert.ok((await A.revisarVigencia(await sub(), ahora)).includes('morosa'));
    assert.equal((await sub()).estado, 'MOROSA');
    assert.equal((await avisos('PERIODO_VENCIDO')).length, 1);
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), [], 'MOROSA no avisa de nuevo');
  });

  test('prueba vencida: avisa una sola vez', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(-6, ahora, 'PRUEBA');
    await prisma.suscripcion.update({ where: { empresaId }, data: { avisosEnviados: { gracia: true } } });
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), ['pruebaVencida']);
    assert.deepEqual(await A.revisarVigencia(await sub(), ahora), []);
  });

  test('renovar vuelve a habilitar los avisos de corte del nuevo ciclo', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(7, ahora);
    await A.revisarVigencia(await sub(), ahora);
    await P.renovar(empresaId, 1, { ahora });
    assert.equal(Boolean((await sub()).avisosEnviados.corte7), false);
  });

  test('el plan de acceso total (sin vencimiento) nunca avisa', async () => {
    const full = await prisma.plan.create({ data: { codigo: 'TEST_AVISOS_FULL', nombre: 'Full', mensualidadBs: 0, implementacionBs: 0, primerPagoBs: 0, convIncluidas: 0, maxProductos: 0, maxUsuarios: 0, ilimitado: true, modulos: ['AGENTE', 'POS', 'PANEL'] } });
    await P.asignarPlan(empresaId, full.id, {});
    assert.deepEqual(await A.revisarVigencia(await sub()), []);
    assert.deepEqual(await A.revisarUsoDe(await sub()), []);
    await prisma.suscripcion.deleteMany({ where: { empresaId } });
    await prisma.plan.delete({ where: { id: full.id } });
  });
});

describe('avisos de uso de conversaciones', () => {
  async function gastar(sus, n) { for (let i = 0; i < n; i += 1) await consumirConversacion(sus.id, 't'); }

  test('al 80 % y al 95 %, una sola vez cada uno', async () => {
    const ahora = new Date();
    await P.asignarPlan(empresaId, plan.id, { meses: 3, ahora });
    let s = await sub();
    await gastar(s, 7);
    assert.deepEqual(await A.revisarUsoDe(await sub()), []);
    await gastar(s, 1); // 8 de 10
    assert.deepEqual(await A.revisarUsoDe(await sub()), ['uso80']);
    assert.deepEqual(await A.revisarUsoDe(await sub()), [], 'no se repite');
    await gastar(s, 2); // 10 de 10 (>= 95 %)
    assert.deepEqual(await A.revisarUsoDe(await sub()), ['uso95']);
    const lista = await avisos('PLAN_USO');
    assert.equal(lista.length, 2);
    assert.match(lista[0].mensaje, /8 de 10/);
  });

  test('cada mes arranca un cupo nuevo: los avisos de uso se reinician', async () => {
    const ahora = new Date();
    await P.asignarPlan(empresaId, plan.id, { meses: 3, ahora });
    await prisma.suscripcion.update({ where: { empresaId }, data: { avisosEnviados: { uso80: true, uso95: true, usoPeriodo: '2020-01-01T00:00:00.000Z' } } });
    const s = await sub();
    await gastar(s, 8);
    assert.deepEqual(await A.revisarUsoDe(await sub()), ['uso80'], 'con otro período los avisos viejos ya no cuentan');
  });
});

describe('revisión completa (la que corre el job)', () => {
  test('recorre todas las suscripciones sin romper si una falla', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await conFinEn(2, ahora);
    const r = await A.revisarTodas(ahora);
    assert.ok(r.revisadas >= 1);
    assert.ok((await avisos('PLAN_CORTE')).length >= 1);
  });
});
