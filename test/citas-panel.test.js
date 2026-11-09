// Agenda del panel: citas del día por zona horaria, indicadores y cambios de estado con reglas.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const P = require('../lib/services/citasPanel');
const { construirMenu } = require('../lib/services/menuPanel');

const SLUGS = ['test-agenda-a', 'test-agenda-b'];
let A; let B; let servicio; let cliente; let clienteB;
const DIA = 86400000;

const cita = (emp, cli, inicio, extra = {}) => prisma.cita.create({
  data: { empresaId: emp.id, clienteId: cli.id, servicioId: emp === A ? servicio.id : null, inicio, fin: new Date(inicio.getTime() + 1800000), estado: 'CONFIRMADA', ...extra },
});
const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.equal(e.codigo, 'CITA'); assert.match(e.message, patron); return true; });

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  A = await prisma.empresa.create({ data: { nombre: 'Agenda A', slug: SLUGS[0], modeloNegocio: 'CITAS', zonaHoraria: 'America/La_Paz' } });
  B = await prisma.empresa.create({ data: { nombre: 'Agenda B', slug: SLUGS[1], modeloNegocio: 'CITAS', zonaHoraria: 'America/La_Paz' } });
  servicio = await prisma.servicio.create({ data: { empresaId: A.id, nombre: 'Corte' } });
  cliente = await prisma.clienteFinal.create({ data: { empresaId: A.id, telefono: '59170001111', nombre: 'Ana Rojas' } });
  clienteB = await prisma.clienteFinal.create({ data: { empresaId: B.id, telefono: '59170002222', nombre: 'Otro Cliente' } });
});
after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

describe('citas del día', () => {
  test('el día se mide en la zona del negocio y salen ordenadas por hora, solo de esa empresa', async () => {
    // 2026-11-10 22:30 en La Paz = 2026-11-11 02:30 UTC: tiene que salir en el día 10, no en el 11.
    await cita(A, cliente, new Date('2026-11-11T02:30:00Z'));
    await cita(A, cliente, new Date('2026-11-10T13:00:00Z')); // 09:00 La Paz
    await cita(A, cliente, new Date('2026-11-11T13:00:00Z')); // otro día
    await cita(B, clienteB, new Date('2026-11-10T13:00:00Z')); // otra empresa
    const dia = await P.delDia(A, '2026-11-10');
    assert.deepEqual(dia.map((c) => c.hora), ['09:00', '22:30']);
    assert.equal(dia[0].cliente, 'Ana Rojas');
    assert.equal(dia[0].servicio, 'Corte');
    assert.ok(dia.every((c) => c.telefono === '59170001111'), 'nada de otra empresa');
  });

  test('un día vacío devuelve una lista vacía', async () => {
    assert.deepEqual(await P.delDia(A, '2030-01-01'), []);
  });
});

describe('cambios de estado', () => {
  test('una cita futura se puede cancelar, pero no marcar como completada ni como no asistió', async () => {
    const c = await cita(A, cliente, new Date(Date.now() + 5 * DIA));
    await rechaza(P.cambiarEstado(A, c.id, 'COMPLETADA'), /Todavía no llegó la hora/);
    await rechaza(P.cambiarEstado(A, c.id, 'NO_ASISTIO'), /Todavía no llegó la hora/);
    const r = await P.cambiarEstado(A, c.id, 'CANCELADA', { id: 1, rol: 'OWNER', nombre: 'Dueña' });
    assert.equal(r.estado, 'CANCELADA');
    assert.equal(await prisma.auditoria.count({ where: { empresaId: A.id, accion: 'CITA_CANCELADA' } }), 1, 'queda en la auditoría');
  });

  test('una cita que ya empezó se marca como completada o como no asistió; las cerradas no se reabren', async () => {
    const c = await cita(A, cliente, new Date(Date.now() - 2 * 3600000));
    assert.deepEqual((await P.delDia(A, require('../lib/services/tiempo').hoy('America/La_Paz'))).find((x) => x.id === c.id)?.acciones.sort(), ['CANCELADA', 'COMPLETADA', 'NO_ASISTIO']);
    assert.equal((await P.cambiarEstado(A, c.id, 'COMPLETADA')).estado, 'COMPLETADA');
    await rechaza(P.cambiarEstado(A, c.id, 'CONFIRMADA'), /ya está cerrada/);
    await rechaza(P.cambiarEstado(A, c.id, 'CANCELADA'), /ya está cerrada/);
  });

  test('una cita por confirmar pasa a confirmada o se cancela; un estado inventado se rechaza', async () => {
    const c = await cita(A, cliente, new Date(Date.now() + 2 * DIA), { estado: 'PENDIENTE' });
    await rechaza(P.cambiarEstado(A, c.id, 'COMPLETADA'), /no corresponde/);
    await rechaza(P.cambiarEstado(A, c.id, 'LOQUESEA'), /no corresponde/);
    assert.equal((await P.cambiarEstado(A, c.id, 'CONFIRMADA')).estado, 'CONFIRMADA');
  });

  test('dos personas tocando a la vez: solo un cambio se aplica', async () => {
    const c = await cita(A, cliente, new Date(Date.now() + 3 * DIA));
    const r = await Promise.allSettled([P.cambiarEstado(A, c.id, 'CANCELADA'), P.cambiarEstado(A, c.id, 'CANCELADA'), P.cambiarEstado(A, c.id, 'CANCELADA')]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await prisma.auditoria.count({ where: { empresaId: A.id, accion: 'CITA_CANCELADA', entidadId: c.id } }), 1);
  });

  test('no se puede tocar la cita de otro negocio', async () => {
    const ajena = await cita(B, clienteB, new Date(Date.now() + 2 * DIA));
    await rechaza(P.cambiarEstado(A, ajena.id, 'CANCELADA'), /no existe/);
    assert.equal((await prisma.cita.findUnique({ where: { id: ajena.id } })).estado, 'CONFIRMADA');
  });
});

describe('indicadores y menú', () => {
  test('cuenta las citas activas de hoy y de los próximos 7 días, las por confirmar y las que no asistieron', async () => {
    const hoy = await P.indicadores(B);
    assert.ok(hoy.proximas7 >= 0 && hoy.noAsistio30 === 0);
    await cita(B, clienteB, new Date(Date.now() + 2 * 3600000), { estado: 'PENDIENTE' });
    await cita(B, clienteB, new Date(Date.now() - 3 * DIA), { estado: 'NO_ASISTIO' });
    const i = await P.indicadores(B);
    assert.equal(i.pendientes, hoy.pendientes + 1);
    assert.equal(i.noAsistio30, 1);
  });

  test('el negocio de citas ve "Agenda" en el menú; el de productos no', () => {
    const claves = (esCitas) => construirMenu({ esCitas }).flatMap((g) => g.items).map((i) => i.clave);
    assert.ok(claves(true).includes('citas'));
    assert.ok(!claves(false).includes('citas'));
  });
});
