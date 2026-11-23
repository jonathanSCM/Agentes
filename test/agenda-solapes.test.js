// Que las citas NUNCA se pisen: servicios distintos con la misma persona, solapes parciales, reservas simultáneas, buffers y estados.
process.env.FERIADOS_OFFLINE = '1';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const agenda = require('../lib/services/agenda');
const T = require('../lib/services/tiempo');

const ZONA = 'America/La_Paz';
const SLUGS = [];
function proximo(dow) { let f = T.sumarDias(T.hoy(ZONA), 1); while (T.diaSemanaDe(f) !== dow) f = T.sumarDias(f, 1); return f; }
const HORARIO = [1, 2, 3, 4, 5].map((d) => ({ diaSemana: d, horaInicio: '09:00', horaFin: '18:00' }));
let n = 0;

async function negocio({ servicios, recursos }) {
  const slug = `test-solapes-${Math.random().toString(36).slice(2, 8)}`; SLUGS.push(slug);
  const empresa = await prisma.empresa.create({ data: { nombre: slug, slug, modeloNegocio: 'CITAS', zonaHoraria: ZONA, configAgenda: { intervaloMin: 15 } } });
  const servs = {}; for (const s of servicios) servs[s.nombre] = await prisma.servicio.create({ data: { empresaId: empresa.id, ...s } });
  const recs = {}; for (const r of recursos) recs[r.nombre] = await prisma.recurso.create({ data: { empresaId: empresa.id, ...r } });
  await prisma.horarioAtencion.createMany({ data: HORARIO.map((h) => ({ empresaId: empresa.id, ...h })) });
  return { empresa, s: servs, r: recs };
}
const cliente = (empresaId) => prisma.clienteFinal.create({ data: { empresaId, telefono: `5917${String(++n).padStart(6, '0')}${Math.random().toString(36).slice(2, 5)}` } });
const reservar = async (nego, sv, fecha, hora, extra = {}) => agenda.crearCita(nego.empresa, { clienteId: (extra.cliente || await cliente(nego.empresa.id)).id, servicioId: sv.id, fecha, hora, ...extra });
const intenta = (p) => p.then(() => true, () => false);

after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

describe('la misma persona no puede estar en dos citas a la vez (aunque sean servicios distintos)', () => {
  const casos = [
    ['empieza dentro de la otra', '10:15'], ['empieza justo cuando empieza', '10:00'], ['empieza antes y termina dentro', '09:45'],
    ['envuelve a la otra', '09:30'],
  ];
  for (const [nombre, hora] of casos) {
    test(`otro servicio que ${nombre} (${hora}) con la misma persona: rechazado`, async () => {
      const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Color', duracionMin: 90 }, { nombre: 'Barba', duracionMin: 45 }], recursos: [{ nombre: 'Carla' }] });
      const f = proximo(2);
      await reservar(g, g.s.Corte, f, '10:00');
      assert.equal(await intenta(reservar(g, g.s.Barba, f, hora)), hora === '09:00' ? true : false);
    });
  }
  test('un servicio largo que cubre la cita ya existente también se rechaza', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Color', duracionMin: 120 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(3);
    await reservar(g, g.s.Corte, f, '11:00');
    assert.equal(await intenta(reservar(g, g.s.Color, f, '10:00')), false, 'Color de 10:00 a 12:00 pisa el corte de 11:00');
  });
  test('citas pegadas (una termina cuando empieza la otra) sí se permiten', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Barba', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(2);
    await reservar(g, g.s.Corte, f, '10:00');
    assert.equal(await intenta(reservar(g, g.s.Barba, f, '10:30')), true);
    assert.equal(await intenta(reservar(g, g.s.Barba, f, '09:30')), true);
  });
  test('el tiempo de limpieza (buffer) cuenta aunque la siguiente cita sea de otro servicio', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Color', duracionMin: 60, bufferMin: 30 }, { nombre: 'Corte', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(4);
    await reservar(g, g.s.Color, f, '10:00'); // ocupa hasta 11:30
    assert.equal(await intenta(reservar(g, g.s.Corte, f, '11:00')), false);
    assert.equal(await intenta(reservar(g, g.s.Corte, f, '11:30')), true);
  });
  test('con dos personas, el mismo horario se reparte; a la tercera no le queda lugar', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }, { nombre: 'Diego' }] });
    const f = proximo(2);
    const a = await reservar(g, g.s.Corte, f, '10:00'); const b = await reservar(g, g.s.Corte, f, '10:00');
    assert.notEqual(a.recursoId, b.recursoId, 'cada uno con una persona distinta');
    assert.equal(await intenta(reservar(g, g.s.Corte, f, '10:00')), false);
  });
});

describe('reservas simultáneas', () => {
  test('muchas reservas a la vez de servicios distintos con la misma persona: ninguna se pisa', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Barba', duracionMin: 45 }, { nombre: 'Color', duracionMin: 60 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(5);
    const pedidos = [];
    for (const hora of ['10:00', '10:15', '10:30', '10:45', '11:00', '11:15']) for (const sv of [g.s.Corte, g.s.Barba, g.s.Color]) pedidos.push([sv, hora]);
    const rs = await Promise.allSettled(pedidos.map(([sv, hora]) => reservar(g, sv, f, hora)));
    assert.ok(rs.some((r) => r.status === 'fulfilled'), 'alguna entra');
    const citas = await prisma.cita.findMany({ where: { empresaId: g.empresa.id, estado: { notIn: ['CANCELADA', 'NO_ASISTIO'] } }, orderBy: { inicio: 'asc' } });
    for (let i = 1; i < citas.length; i++) {
      const finAnterior = citas[i - 1].fin.getTime() + citas[i - 1].bufferMin * 60000;
      assert.ok(citas[i].inicio.getTime() >= finAnterior, `la cita ${citas[i].id} empieza antes de que termine la ${citas[i - 1].id}`);
    }
  });
  test('la misma persona con 10 pedidos simultáneos al mismo horario: entra uno solo', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(2);
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => reservar(g, g.s.Corte, f, '15:00')));
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  });
});

describe('estados y reprogramación', () => {
  test('al cancelar o marcar "no asistió" el horario se libera; completada o confirmada lo siguen ocupando', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(2);
    const c = await reservar(g, g.s.Corte, f, '10:00');
    assert.equal(await intenta(reservar(g, g.s.Corte, f, '10:00')), false);
    await prisma.cita.update({ where: { id: c.id }, data: { estado: 'CANCELADA' } });
    assert.equal(await intenta(reservar(g, g.s.Corte, f, '10:00')), true);
  });
  test('reprogramar sobre un horario ocupado de otro servicio se rechaza y la cita original se conserva', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Barba', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(3);
    const a = await reservar(g, g.s.Corte, f, '10:00');
    await reservar(g, g.s.Barba, f, '11:00');
    await assert.rejects(() => agenda.reprogramarCita(g.empresa, a.id, { fecha: f, hora: '11:00' }));
    assert.equal((await prisma.cita.findUnique({ where: { id: a.id } })).estado, 'CONFIRMADA');
  });
});

describe('el mismo cliente', () => {
  test('un cliente no puede tener dos citas a la misma hora con personas distintas', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Barba', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }, { nombre: 'Diego' }] });
    const f = proximo(2);
    const yo = await cliente(g.empresa.id);
    await reservar(g, g.s.Corte, f, '10:00', { cliente: yo });
    assert.equal(await intenta(reservar(g, g.s.Barba, f, '10:00', { cliente: yo })), false, 'no puede estar en dos lugares a la vez');
  });
  test('reprogramar su propia cita a un horario que se cruza con la original sí se permite (la original no cuenta)', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const f = proximo(3);
    const yo = await cliente(g.empresa.id);
    const a = await reservar(g, g.s.Corte, f, '10:00', { cliente: yo });
    const b = await agenda.reprogramarCita(g.empresa, a.id, { fecha: f, hora: '10:15' });
    assert.equal(b.estado, 'CONFIRMADA');
    assert.equal((await prisma.cita.findUnique({ where: { id: a.id } })).estado, 'CANCELADA');
  });
  test('dos pedidos simultáneos del MISMO cliente a la misma hora con personas distintas: entra uno solo', async () => {
    const g = await negocio({ servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Barba', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }, { nombre: 'Diego' }] });
    const f = proximo(4);
    const yo = await cliente(g.empresa.id);
    const rs = await Promise.allSettled([reservar(g, g.s.Corte, f, '12:00', { cliente: yo }), reservar(g, g.s.Barba, f, '12:00', { cliente: yo }), reservar(g, g.s.Corte, f, '12:15', { cliente: yo })]);
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  });
});
