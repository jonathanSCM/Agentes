// Cambio de plan pedido por el cliente: validaciones, aprobación atómica, guardas y aislamiento entre empresas.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const S = require('../lib/services/solicitudesPlan');
const P = require('../lib/services/planesCliente');
const { construirMenu } = require('../lib/services/menuPanel');

const SLUGS = ['test-solplan-a', 'test-solplan-b'];
const CODIGOS = ['TEST_SP_BASICO', 'TEST_SP_POS', 'TEST_SP_OCULTO', 'TEST_SP_RETIRADO'];
let A; let B; let basico; let conPos; let oculto; let retirado;

const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.match(e.message, patron); return true; });
const crearPlan = (codigo, extra) => prisma.plan.create({ data: { codigo, nombre: `Plan ${codigo}`, mensualidadBs: 100, implementacionBs: 0, primerPagoBs: 100, convIncluidas: 200, maxProductos: 50, maxUsuarios: 2, modulos: ['AGENTE'], ...extra } });

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.plan.deleteMany({ where: { codigo: { in: CODIGOS } } });
  A = (await prisma.empresa.create({ data: { nombre: 'Cliente A', slug: SLUGS[0] } })).id;
  B = (await prisma.empresa.create({ data: { nombre: 'Cliente B', slug: SLUGS[1] } })).id;
  basico = await crearPlan('TEST_SP_BASICO', {});
  conPos = await crearPlan('TEST_SP_POS', { modulos: ['AGENTE', 'POS'], convIncluidas: 500, mensualidadBs: 250 });
  oculto = await crearPlan('TEST_SP_OCULTO', { oculto: true });
  retirado = await crearPlan('TEST_SP_RETIRADO', { activo: false });
});
after(async () => {
  await prisma.suscripcion.deleteMany({ where: { empresaId: { in: [A, B] } } });
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.plan.deleteMany({ where: { codigo: { in: CODIGOS } } });
});

describe('pedir un plan', () => {
  test('solo se pueden pedir planes activos y visibles; los ocultos y retirados no', async () => {
    const lista = (await S.disponibles()).map((p) => p.codigo);
    assert.ok(lista.includes('TEST_SP_BASICO') && lista.includes('TEST_SP_POS'));
    assert.ok(!lista.includes('TEST_SP_OCULTO') && !lista.includes('TEST_SP_RETIRADO'));
    assert.ok(!lista.includes('ACCESO_TOTAL'), 'el plan de acceso total solo lo asigna el superadmin');
    await rechaza(S.crear(A, { planId: oculto.id, meses: 1 }), /no está disponible/);
    await rechaza(S.crear(A, { planId: retirado.id, meses: 1 }), /no está disponible/);
    await rechaza(S.crear(A, { planId: 99999999, meses: 1 }), /no está disponible/);
  });

  test('la duración tiene que ser 1, 2, 3, 6 o 12 meses', async () => {
    for (const m of [0, 4, 24, 'x', -1, 1.5]) await rechaza(S.crear(A, { planId: basico.id, meses: m }), /duración/);
  });

  test('pedir no cambia el plan; queda pendiente con el nombre del plan', async () => {
    const sol = await S.crear(A, { planId: conPos.id, meses: 3, nota: 'pago por transferencia' });
    assert.equal(sol.estado, 'PENDIENTE');
    assert.equal(sol.planNombre, 'Plan TEST_SP_POS');
    assert.equal(await prisma.suscripcion.count({ where: { empresaId: A } }), 0, 'sin aprobar, el cliente sigue sin plan');
    assert.equal(await S.contarPendientes() >= 1, true);
  });

  test('no se repite el mismo pedido pendiente ni se acumulan más de dos', async () => {
    await rechaza(S.crear(A, { planId: conPos.id, meses: 6 }), /ya pediste ese plan/i);
    await S.crear(A, { planId: basico.id, meses: 1 });
    const tercero = await crearPlan('TEST_SP_TERCERO', {});
    try { await rechaza(S.crear(A, { planId: tercero.id, meses: 1 }), /esperando respuesta/); } finally { await prisma.plan.delete({ where: { id: tercero.id } }); }
  });

  test('cada cliente solo ve sus pedidos', async () => {
    await S.crear(B, { planId: basico.id, meses: 2 });
    assert.ok((await S.delCliente(A)).every((s) => s.empresaId === A));
    assert.equal((await S.delCliente(B)).length, 1);
  });
});

describe('aprobar y rechazar', () => {
  test('aprobar asigna el plan con sus valores, desde hoy, y avisa al cliente', async () => {
    const sol = (await S.delCliente(A)).find((s) => s.planNombre === 'Plan TEST_SP_POS');
    const ahora = new Date('2026-11-10T15:00:00Z');
    const r = await S.aprobar(sol.id, { respuesta: 'Pago confirmado', ahora });
    assert.equal(r.estado, 'APROBADA');
    const v = await P.valoresDe(A, ahora);
    assert.equal(v.planNombre, 'Plan TEST_SP_POS');
    assert.deepEqual(v.modulos, ['AGENTE', 'POS']);
    assert.equal(v.limites.convIncluidas, 500);
    assert.equal(v.planFin.toISOString().slice(0, 10), '2027-02-10', '3 meses desde hoy');
    const avisos = await prisma.notificacion.findMany({ where: { empresaId: A, titulo: 'Tu plan fue actualizado' } });
    assert.equal(avisos.length, 1);
    assert.match(avisos[0].mensaje, /Plan TEST_SP_POS por 3 meses/);
    assert.equal(await prisma.auditoria.count({ where: { empresaId: A, accion: 'PLAN_ASIGNADO' } }), 1);
  });

  test('el superadmin puede ajustar la duración al aprobar', async () => {
    const sol = (await S.delCliente(B))[0];
    await S.aprobar(sol.id, { meses: 12, ahora: new Date('2026-11-10T15:00:00Z') });
    assert.equal((await P.valoresDe(B, new Date('2026-11-10T15:00:00Z'))).planFin.toISOString().slice(0, 10), '2027-11-10');
    await rechaza(S.aprobar((await S.delCliente(B))[0].id, { meses: 5 }), /ya fue resuelto|duración/);
  });

  test('un pedido ya resuelto no se aprueba dos veces, ni dos aprobaciones simultáneas lo aplican dos veces', async () => {
    const nuevo = await S.crear(B, { planId: conPos.id, meses: 1 });
    const r = await Promise.allSettled([S.aprobar(nuevo.id), S.aprobar(nuevo.id), S.aprobar(nuevo.id)]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await prisma.auditoria.count({ where: { empresaId: B, accion: 'PLAN_ASIGNADO' } }), 2, 'una por cada pedido aprobado (el de 12 meses y este)');
    await rechaza(S.rechazar(nuevo.id), /ya fue resuelto/);
  });

  test('rechazar no cambia el plan y el cliente ve el motivo', async () => {
    const antes = (await P.valoresDe(A)).planNombre;
    const sol = await S.crear(A, { planId: basico.id, meses: 6 }).catch(async () => (await S.delCliente(A)).find((s) => s.estado === 'PENDIENTE'));
    const r = await S.rechazar(sol.id, { respuesta: 'No llegó el pago' });
    assert.equal(r.estado, 'RECHAZADA');
    assert.equal((await P.valoresDe(A)).planNombre, antes);
    const aviso = await prisma.notificacion.findFirst({ where: { empresaId: A, titulo: 'No pudimos confirmar tu cambio de plan' } });
    assert.match(aviso.mensaje, /No llegó el pago/);
  });

  test('con una caja abierta no se puede pasar a un plan sin Punto de venta: el pedido queda pendiente', async () => {
    await prisma.sesionCaja.create({ data: { empresaId: A, efectivoInicial: 10, estado: 'ABIERTA' } });
    const sol = await S.crear(A, { planId: basico.id, meses: 1 });
    await rechaza(S.aprobar(sol.id), /caja abierta/);
    assert.equal((await prisma.solicitudPlan.findUnique({ where: { id: sol.id } })).estado, 'PENDIENTE', 'no queda "aprobado" sin haberse aplicado');
    assert.deepEqual((await P.valoresDe(A)).modulos, ['AGENTE', 'POS'], 'el plan no cambió');
    await prisma.sesionCaja.updateMany({ where: { empresaId: A, estado: 'ABIERTA' }, data: { estado: 'CERRADA', cerradaAt: new Date() } });
    await S.aprobar(sol.id);
    assert.deepEqual((await P.valoresDe(A)).modulos, ['AGENTE'], 'cerrada la caja, ya se puede');
  });

  test('el superadmin tampoco puede quitarle el POS a un cliente con la caja abierta', async () => {
    await S.aprobar((await S.crear(B, { planId: conPos.id, meses: 1 }).catch(() => null))?.id || 0).catch(() => {});
    await P.asignarPlan(B, conPos.id, { meses: 1 });
    await prisma.sesionCaja.create({ data: { empresaId: B, efectivoInicial: 10, estado: 'ABIERTA' } });
    await rechaza(P.editarCopia(B, { modulos: ['AGENTE'] }), /caja abierta/);
    await rechaza(P.asignarPlan(B, basico.id, { meses: 1 }), /caja abierta/);
    await prisma.sesionCaja.updateMany({ where: { empresaId: B, estado: 'ABIERTA' }, data: { estado: 'CERRADA', cerradaAt: new Date() } });
  });
});

describe('menú', () => {
  test('"Cambiar de plan" lo ve el dueño; administrador y colaborador no', () => {
    const claves = (rol) => construirMenu({ rol, modulos: ['AGENTE'] }).flatMap((g) => g.items).map((i) => i.clave);
    assert.ok(claves('OWNER').includes('plan'));
    assert.ok(!claves('ADMIN').includes('plan') && !claves('STAFF').includes('plan') && !claves('CAJERO').includes('plan'));
  });
});
