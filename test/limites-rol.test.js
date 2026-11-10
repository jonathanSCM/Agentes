// Límites de usuarios por rol en los planes: reglas puras y el recorrido plan → copia del cliente → propagación.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const L = require('../lib/services/limitesRol');
const P = require('../lib/services/planesCliente');

describe('reglas por rol (puras)', () => {
  const u = (...roles) => roles.map((rol) => ({ rol }));

  test('el dueño no cuenta; los demás cuentan por rol, con sus invitaciones pendientes', () => {
    const e = L.estadoPorRol(u('OWNER', 'ADMIN', 'CAJERO', 'CAJERO', 'STAFF'), u('CAJERO', 'PROFESIONAL'), { maxCajeros: 3 });
    const por = Object.fromEntries(e.map((x) => [x.rol, x]));
    assert.equal(por.ADMIN.usados, 1);
    assert.equal(por.CAJERO.usados, 3);
    assert.equal(por.CAJERO.lleno, true);
    assert.equal(por.STAFF.usados, 1);
    assert.equal(por.PROFESIONAL.usados, 1);
    assert.equal(e.some((x) => x.rol === 'OWNER'), false);
  });
  test('sin tope = sin límite por rol; con tope 0 el rol no se puede usar', () => {
    assert.equal(L.puedeSumar('CAJERO', u('CAJERO', 'CAJERO', 'CAJERO'), [], {}).ok, true);
    assert.equal(L.puedeSumar('CAJERO', u('CAJERO'), [], { maxCajeros: null }).ok, true);
    const cero = L.puedeSumar('CAJERO', [], [], { maxCajeros: 0 });
    assert.equal(cero.ok, false);
    assert.match(cero.mensaje, /no incluye cajeros/);
  });
  test('el mensaje dice cuántos permite el plan y cuenta las invitaciones pendientes', () => {
    const r = L.puedeSumar('ADMIN', u('ADMIN'), [], { maxAdmins: 1 });
    assert.equal(r.ok, false);
    assert.match(r.mensaje, /permite 1 administrador \(contando las invitaciones pendientes\)/);
    const r2 = L.puedeSumar('CAJERO', u('CAJERO'), u('CAJERO'), { maxCajeros: 2 });
    assert.equal(r2.ok, false);
    assert.match(r2.mensaje, /permite 2 cajeros/);
    assert.equal(L.puedeSumar('CAJERO', u('CAJERO'), [], { maxCajeros: 2 }).ok, true);
  });
  test('un rol desconocido se toma como colaborador (igual que al crear la invitación)', () => {
    assert.equal(L.rolEfectivo('LO_QUE_SEA'), 'STAFF');
    assert.equal(L.puedeSumar('LO_QUE_SEA', u('STAFF'), [], { maxStaff: 1 }).ok, false);
    assert.equal(L.puedeSumar(undefined, [], [], { maxStaff: 1 }).ok, true);
  });
  test('un tope bajo lo que ya hay no echa a nadie: solo no deja sumar', () => {
    const e = L.estadoPorRol(u('CAJERO', 'CAJERO', 'CAJERO'), [], { maxCajeros: 1 }).find((x) => x.rol === 'CAJERO');
    assert.equal(e.usados, 3);
    assert.equal(e.lleno, true);
  });
  test('lectura del formulario: vacío = sin límite, enteros de 0 o más', () => {
    assert.equal(L.leerTope(''), null);
    assert.equal(L.leerTope(undefined), null);
    assert.equal(L.leerTope('3'), 3);
    assert.equal(L.leerTope('0'), 0);
    for (const malo of ['-1', '1.5', 'abc', '999999999']) assert.throws(() => L.leerTope(malo, 'Cajeros'), /Cajeros/);
  });
});

const SLUG = 'test-limites-rol';
const CODIGO = 'TEST_LIM_ROL';
let empresa; let plan;

describe('del plan a la copia del cliente', () => {
  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: SLUG } });
    await prisma.plan.deleteMany({ where: { codigo: CODIGO } });
    empresa = await prisma.empresa.create({ data: { nombre: 'Limites rol', slug: SLUG } });
    plan = await prisma.plan.create({ data: { codigo: CODIGO, nombre: 'Plan límites', mensualidadBs: 1, implementacionBs: 0, primerPagoBs: 1, convIncluidas: 10, maxProductos: 10, maxUsuarios: 6, maxCajeros: 2, maxAdmins: 1 } });
  });
  after(async () => {
    await prisma.empresa.deleteMany({ where: { slug: SLUG } });
    await prisma.plan.deleteMany({ where: { codigo: CODIGO } });
  });

  test('al asignar el plan, el cliente recibe los topes por rol; lo que el plan no limita queda sin límite', async () => {
    await P.asignarPlan(empresa.id, plan.id, { meses: 1 });
    const v = await P.valoresDe(empresa.id);
    assert.equal(v.limites.maxCajeros, 2);
    assert.equal(v.limites.maxAdmins, 1);
    assert.equal(v.limites.maxStaff, null);
    assert.equal(v.limites.maxProfesionales, null);
    const e = L.estadoPorRol([], [], v.limites);
    assert.equal(e.find((x) => x.rol === 'CAJERO').tope, 2);
    assert.equal(e.find((x) => x.rol === 'STAFF').hayTope, false);
  });
  test('el superadmin ajusta la copia de un cliente (vacío = sin límite)', async () => {
    await P.editarCopia(empresa.id, { maxCajeros: '5', maxAdmins: '' });
    const v = await P.valoresDe(empresa.id);
    assert.equal(v.limites.maxCajeros, 5);
    assert.equal(v.limites.maxAdmins, null);
    await assert.rejects(P.editarCopia(empresa.id, { maxCajeros: '-2' }), /número entero/);
  });
  test('al propagar un cambio del plan, el cliente recibe el nuevo tope y un aviso que lo nombra', async () => {
    await P.asignarPlan(empresa.id, plan.id, { meses: 1 });
    await prisma.plan.update({ where: { id: plan.id }, data: { maxCajeros: 4 } });
    const r = await P.propagarCambiosDePlan(plan.id);
    assert.equal(r.actualizados, 1);
    assert.equal((await P.valoresDe(empresa.id)).limites.maxCajeros, 4);
    const aviso = await prisma.notificacion.findFirst({ where: { empresaId: empresa.id, tipo: 'PLAN_CAMBIO' }, orderBy: { id: 'desc' } });
    assert.match(aviso.mensaje, /Cajeros: 2 → 4/);
  });
  test('acceso total (ilimitado) no tiene topes por rol', async () => {
    await P.editarCopia(empresa.id, { ilimitado: true });
    const v = await P.valoresDe(empresa.id);
    assert.equal(v.limites.maxCajeros, null);
    assert.equal(L.puedeSumar('CAJERO', Array(50).fill({ rol: 'CAJERO' }), [], v.limites).ok, true);
  });
  test('sin plan (estado base) no hay límites por rol: manda el total de 1 usuario', () => {
    const base = P.valoresDeSuscripcion(null);
    assert.equal(base.limites.maxCajeros, null);
    assert.equal(base.limites.maxUsuarios, 1);
  });
});
