// Calendario de citas y rol PROFESIONAL: funciones puras, datos por empresa/profesional e invitaciones.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const C = require('../lib/services/calendarioCitas');
const { crearInvitacion } = require('../lib/services/auth');
const { construirMenu } = require('../lib/services/menuPanel');

describe('piezas puras del calendario', () => {
  test('la semana va de lunes a domingo (el 11/11/2026 es miércoles)', () => {
    const r = C.rangoDe('semana', '2026-11-11', 'America/La_Paz');
    assert.equal(r.desde, '2026-11-09');
    assert.equal(r.hasta, '2026-11-16');
    assert.equal(r.dias.length, 7);
  });
  test('el mes cubre semanas completas', () => {
    const r = C.rangoDe('mes', '2026-11-11', 'America/La_Paz');
    assert.equal(r.dias.length % 7, 0);
    assert.equal(r.dias[0], '2026-10-26');
    assert.ok(r.dias.includes('2026-11-30'));
  });
  test('una vista inválida cae en semana y el día es un solo día', () => {
    assert.equal(C.rangoDe('xx', '2026-11-11', 'UTC').vista, 'semana');
    assert.deepEqual(C.rangoDe('dia', '2026-11-11', 'UTC').dias, ['2026-11-11']);
  });
  test('citas superpuestas se reparten en columnas; las seguidas no', () => {
    const r = C.distribuir([
      { id: 1, inicioMin: 540, finMin: 600 }, { id: 2, inicioMin: 560, finMin: 620 }, { id: 3, inicioMin: 600, finMin: 660 }, { id: 4, inicioMin: 700, finMin: 730 },
    ]);
    const por = Object.fromEntries(r.map((c) => [c.id, c]));
    assert.equal(por[1].cols, 2);
    assert.notEqual(por[1].col, por[2].col);
    assert.equal(por[4].cols, 1);
  });
  test('anterior y siguiente según la vista', () => {
    assert.deepEqual(C.vecinas('semana', '2026-11-11', 'UTC'), { anterior: '2026-11-04', siguiente: '2026-11-18' });
    assert.deepEqual(C.vecinas('dia', '2026-11-11', 'UTC'), { anterior: '2026-11-10', siguiente: '2026-11-12' });
    assert.deepEqual(C.vecinas('mes', '2026-11-11', 'UTC'), { anterior: '2026-10-11', siguiente: '2026-12-11' });
  });
});

const SLUGS = ['test-cal-a', 'test-cal-b'];
let A; let B; let ana; let beto; let servicio;
const cita = (emp, cli, recurso, inicio, extra = {}) => prisma.cita.create({
  data: { empresaId: emp.id, clienteId: cli.id, recursoId: recurso ? recurso.id : null, inicio, fin: new Date(inicio.getTime() + 1800000), estado: 'CONFIRMADA', ...extra },
});

describe('calendario con datos', () => {
  let cli; let cliB;
  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
    A = await prisma.empresa.create({ data: { nombre: 'Cal A', slug: SLUGS[0], modeloNegocio: 'CITAS', zonaHoraria: 'America/La_Paz' } });
    B = await prisma.empresa.create({ data: { nombre: 'Cal B', slug: SLUGS[1], modeloNegocio: 'CITAS', zonaHoraria: 'America/La_Paz' } });
    servicio = await prisma.servicio.create({ data: { empresaId: A.id, nombre: 'Corte' } });
    ana = await prisma.recurso.create({ data: { empresaId: A.id, nombre: 'Ana' } });
    beto = await prisma.recurso.create({ data: { empresaId: A.id, nombre: 'Beto' } });
    cli = await prisma.clienteFinal.create({ data: { empresaId: A.id, telefono: '59170003333', nombre: 'Clienta' } });
    cliB = await prisma.clienteFinal.create({ data: { empresaId: B.id, telefono: '59170004444', nombre: 'Otra' } });
    await cita(A, cli, ana, new Date('2026-11-10T13:00:00Z'));
    await cita(A, cli, beto, new Date('2026-11-10T14:00:00Z'));
    await cita(A, cli, ana, new Date('2026-11-11T13:00:00Z'), { estado: 'CANCELADA' });
    await cita(B, cliB, null, new Date('2026-11-10T13:00:00Z'));
  });
  after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

  test('el negocio ve todas; un profesional ve solo las suyas; las canceladas no salen', async () => {
    const todas = await C.calendario(A, 'semana', '2026-11-10');
    assert.equal(todas.dias.reduce((n, d) => n + d.total, 0), 2);
    const deAna = await C.calendario(A, 'semana', '2026-11-10', { recursoId: ana.id });
    const evs = deAna.dias.flatMap((d) => d.eventos);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].recurso, 'Ana');
  });
  test('nunca mezcla empresas', async () => {
    const b = await C.calendario(B, 'semana', '2026-11-10');
    assert.equal(b.dias.reduce((n, d) => n + d.total, 0), 1);
  });
  test('la grilla se amplía si hay una cita fuera del horario por defecto', async () => {
    await cita(A, cli, ana, new Date('2026-11-12T03:00:00Z')); // 23:00 del 11 en La Paz
    const r = await C.calendario(A, 'semana', '2026-11-10');
    assert.ok(r.ventana.hasta >= 23);
  });
});

describe('invitar a un profesional', () => {
  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
    A = await prisma.empresa.create({ data: { nombre: 'Cal A', slug: SLUGS[0], modeloNegocio: 'CITAS' } });
    B = await prisma.empresa.create({ data: { nombre: 'Cal B', slug: SLUGS[1], modeloNegocio: 'CITAS' } });
    ana = await prisma.recurso.create({ data: { empresaId: A.id, nombre: 'Ana' } });
    beto = await prisma.recurso.create({ data: { empresaId: B.id, nombre: 'Beto de otra empresa' } });
  });
  after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

  test('exige elegir un profesional de ESTE negocio', async () => {
    await assert.rejects(crearInvitacion({ empresaId: A.id, email: 'p1@test.local', rol: 'PROFESIONAL' }), (e) => e.codigo === 'RECURSO_INVALIDO');
    await assert.rejects(crearInvitacion({ empresaId: A.id, email: 'p1@test.local', rol: 'PROFESIONAL', recursoId: beto.id }), (e) => e.codigo === 'RECURSO_INVALIDO');
  });
  test('con un profesional válido queda vinculado; otros roles no llevan vínculo', async () => {
    const inv = await crearInvitacion({ empresaId: A.id, email: 'p2@test.local', rol: 'PROFESIONAL', recursoId: ana.id });
    assert.equal(inv.rol, 'PROFESIONAL');
    assert.equal(inv.recursoId, ana.id);
    const caj = await crearInvitacion({ empresaId: A.id, email: 'c1@test.local', rol: 'CAJERO', recursoId: ana.id });
    assert.equal(caj.recursoId, null);
  });
});

describe('menú del profesional', () => {
  test('solo ve su agenda', () => {
    const menu = construirMenu({ rol: 'PROFESIONAL', modeloNegocio: 'CITAS', modulos: {} });
    const claves = JSON.stringify(menu);
    assert.match(claves, /mi-agenda/);
    assert.doesNotMatch(claves, /"pos"|"ventas"|"configuracion"|"equipo"/);
  });
});
