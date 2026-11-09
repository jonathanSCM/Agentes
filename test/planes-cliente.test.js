// Planes por cliente: copia de los valores, vigencia, estado base y plan ilimitado.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const P = require('../lib/services/planesCliente');
const { consumirConversacion, obtenerEstadoConsumo } = require('../lib/services/suscripciones');

const SLUG = 'test-planes-cliente';
const COD = ['TEST_PC_AGENTE', 'TEST_PC_FULL']; // la plantilla PRUEBA es la sembrada: no se borra (otros tests la usan)
let empresaId;
let planAgente;
let planFull;

const datosPlan = (codigo, extra = {}) => ({
  codigo, nombre: `Plan ${codigo}`, mensualidadBs: 100, implementacionBs: 0, primerPagoBs: 100,
  convIncluidas: 3, maxProductos: 50, maxUsuarios: 2, maxMensajesPropios: 10, maxServicios: 5, maxCitasMes: 40, modeloIa: 'gpt-4o-mini', ...extra,
});

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  await prisma.plan.deleteMany({ where: { codigo: { in: COD } } });
  empresaId = (await prisma.empresa.create({ data: { nombre: 'Cliente Planes', slug: SLUG } })).id;
  planAgente = await prisma.plan.create({ data: datosPlan('TEST_PC_AGENTE', { modulos: ['AGENTE'] }) });
  planFull = await prisma.plan.create({ data: datosPlan('TEST_PC_FULL', { modulos: ['AGENTE', 'POS', 'PANEL'], ilimitado: true, oculto: true, nombre: 'Acceso total' }) });
});
after(async () => {
  await prisma.registroUso.deleteMany({ where: { suscripcion: { empresaId } } });
  await prisma.suscripcion.deleteMany({ where: { empresaId } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  await prisma.plan.deleteMany({ where: { codigo: { in: COD } } });
});

describe('estado base (sin suscripción)', () => {
  test('solo el módulo Agente y sin conversaciones incluidas', async () => {
    const v = await P.valoresDe(empresaId);
    assert.equal(v.origen, 'BASE');
    assert.deepEqual(v.modulos, ['AGENTE']);
    assert.equal(v.limites.convIncluidas, 0);
    assert.equal(await P.tieneModulo(empresaId, 'POS'), false);
    assert.equal(await P.tieneModulo(empresaId, 'AGENTE'), true);
  });
});

describe('asignar un plan', () => {
  test('copia los valores, empieza hoy y vence en los meses elegidos', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    const r = await P.asignarPlan(empresaId, planAgente.id, { meses: 3, ahora });
    const v = r.valores;
    assert.equal(v.planNombre, 'Plan TEST_PC_AGENTE');
    assert.deepEqual(v.modulos, ['AGENTE']);
    assert.equal(v.limites.maxProductos, 50);
    assert.equal(v.planInicio.toISOString(), ahora.toISOString());
    assert.equal(v.planFin.toISOString().slice(0, 10), '2027-02-08');
  });

  test('exige duración (o fecha) salvo en el plan ilimitado; valida meses y fechas', async () => {
    await assert.rejects(() => P.asignarPlan(empresaId, planAgente.id, {}), /duración/);
    await assert.rejects(() => P.asignarPlan(empresaId, planAgente.id, { meses: 5 }), /1, 2, 3, 6 o 12/);
    await assert.rejects(() => P.asignarPlan(empresaId, planAgente.id, { fechaFin: '2020-01-01' }), /posterior/);
  });

  test('el cliente se rige por SU COPIA: cambiar la plantilla no le cambia nada', async () => {
    await P.asignarPlan(empresaId, planAgente.id, { meses: 1 });
    await prisma.plan.update({ where: { id: planAgente.id }, data: { maxProductos: 5, convIncluidas: 1, modulos: ['AGENTE', 'POS'] } });
    const v = await P.valoresDe(empresaId);
    assert.equal(v.limites.maxProductos, 50);
    assert.equal(v.limites.convIncluidas, 3);
    assert.deepEqual(v.modulos, ['AGENTE']);
    await prisma.plan.update({ where: { id: planAgente.id }, data: { maxProductos: 50, convIncluidas: 3, modulos: ['AGENTE'] } });
  });

  test('el superadmin ajusta la copia de ese cliente (sin tocar el plan)', async () => {
    await P.editarCopia(empresaId, { maxProductos: 200, convIncluidas: '', modulos: ['AGENTE', 'POS'] });
    const v = await P.valoresDe(empresaId);
    assert.equal(v.limites.maxProductos, 200);
    assert.equal(v.limites.convIncluidas, null, 'vacío = sin límite');
    assert.deepEqual(v.modulos, ['AGENTE', 'POS']);
    assert.equal((await prisma.plan.findUnique({ where: { id: planAgente.id } })).maxProductos, 50);
    await assert.rejects(() => P.editarCopia(empresaId, { modulos: ['POS'] }), /incluir Agente/);
    await assert.rejects(() => P.editarCopia(empresaId, { maxProductos: -3 }), /entero/);
  });

  test('renovar suma meses al fin vigente y reinicia los avisos de corte', async () => {
    await P.asignarPlan(empresaId, planAgente.id, { meses: 1, ahora: new Date('2026-11-08T12:00:00Z') });
    await prisma.suscripcion.update({ where: { empresaId }, data: { avisosEnviados: { corte7: true, uso80: true } } });
    const s = await P.renovar(empresaId, 2, { ahora: new Date('2026-11-20T12:00:00Z') });
    assert.equal(s.planFin.toISOString().slice(0, 10), '2027-02-08');
    assert.deepEqual(s.avisosEnviados, { uso80: true });
    await assert.rejects(() => P.renovar(empresaId, 4), /1, 2, 3, 6 o 12/);
  });
});

describe('conversaciones con la copia del plan', () => {
  test('usa el tope copiado y se reinicia cada mes', async () => {
    const ahora = new Date();
    await prisma.registroUso.deleteMany({ where: { suscripcion: { empresaId } } });
    const { suscripcion } = await P.asignarPlan(empresaId, planAgente.id, { meses: 3, ahora });
    for (let i = 0; i < 3; i += 1) assert.equal((await consumirConversacion(suscripcion.id, 't')).ok, true);
    const agotado = await consumirConversacion(suscripcion.id, 't');
    assert.equal(agotado.ok, false);
    assert.equal(agotado.motivo, 'SIN_SALDO');
    const e = await obtenerEstadoConsumo(suscripcion.id);
    assert.equal(e.incluidasTotal, 3);
    assert.equal(e.porcentajeUsado, 100);
  });
});

describe('plan ilimitado (oculto, solo superadmin)', () => {
  test('todos los módulos, sin topes y sin vencimiento', async () => {
    const r = await P.asignarPlan(empresaId, planFull.id, {});
    const v = r.valores;
    assert.equal(v.ilimitado, true);
    assert.deepEqual([...v.modulos].sort(), ['AGENTE', 'PANEL', 'POS']);
    assert.equal(v.limites.convIncluidas, null);
    assert.equal(v.limites.maxProductos, null);
    assert.equal(v.vigencia.estado, 'SIN_FIN');
    assert.equal(P.topeNumerico(v.limites.maxProductos) >= 1e9, true);
    assert.equal(P.topeTexto(null), 'Ilimitado');
    const e = await obtenerEstadoConsumo(r.suscripcion.id);
    assert.equal(e.puedeAtender, true);
    assert.equal(e.ilimitado, true);
    assert.equal((await consumirConversacion(r.suscripcion.id, 't')).ok, true);
  });
});

describe('prueba gratis', () => {
  test('solo el módulo Agente y vence en los días de prueba', async () => {
    await prisma.suscripcion.deleteMany({ where: { empresaId } });
    await prisma.plan.upsert({
      where: { codigo: 'PRUEBA' }, update: {},
      create: datosPlan('PRUEBA', { nombre: 'Prueba gratis', modulos: ['AGENTE'], mensualidadBs: 0, primerPagoBs: 0 }),
    });
    const ahora = new Date('2026-11-08T12:00:00Z');
    const r = await P.iniciarPrueba(empresaId, { ahora });
    assert.equal(r.suscripcion.estado, 'PRUEBA');
    assert.deepEqual(r.valores.modulos, ['AGENTE']);
    assert.equal(r.valores.planFin.toISOString().slice(0, 10), '2026-11-22');
  });
});

describe('llevar los cambios del plan a los clientes (opcional)', () => {
  test('solo cambia lo que cambió, avisa al dueño y no toca las fechas', async () => {
    const ahora = new Date('2026-11-08T12:00:00Z');
    await prisma.notificacion.deleteMany({ where: { empresaId } });
    await P.asignarPlan(empresaId, planAgente.id, { meses: 3, ahora });
    const antes = await prisma.suscripcion.findUnique({ where: { empresaId } });

    // Sin cambios en el plan: no se actualiza a nadie ni se avisa.
    let r = await P.propagarCambiosDePlan(planAgente.id);
    assert.equal(r.actualizados, 0);
    assert.equal(await prisma.notificacion.count({ where: { empresaId, tipo: 'PLAN_CAMBIO' } }), 0);

    await prisma.plan.update({ where: { id: planAgente.id }, data: { convIncluidas: 10, modulos: ['AGENTE', 'POS'] } });
    r = await P.propagarCambiosDePlan(planAgente.id);
    assert.equal(r.actualizados, 1);
    const despues = await prisma.suscripcion.findUnique({ where: { empresaId } });
    assert.equal(despues.convIncluidas, 10);
    assert.deepEqual(despues.modulos, ['AGENTE', 'POS']);
    assert.equal(despues.planFin.toISOString(), antes.planFin.toISOString(), 'las fechas no se tocan');
    const aviso = await prisma.notificacion.findFirst({ where: { empresaId, tipo: 'PLAN_CAMBIO' } });
    assert.match(aviso.mensaje, /Conversaciones por mes: 3 → 10/);
    assert.match(aviso.mensaje, /Agente → Agente \+ Punto de venta/);
    await prisma.plan.update({ where: { id: planAgente.id }, data: { convIncluidas: 3, modulos: ['AGENTE'] } });
  });
});
