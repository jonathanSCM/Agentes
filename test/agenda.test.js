// Motor de agenda del modelo de Citas (lib/services/agenda.js), topes del plan y feriados.
process.env.FERIADOS_OFFLINE = '1'; // nunca salir a internet en los tests

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const agenda = require('../lib/services/agenda');
const limites = require('../lib/services/limitesCitas');
const feriados = require('../lib/services/feriados');
const T = require('../lib/services/tiempo');

const ZONA = 'America/La_Paz';
const SLUGS = [];
let planPrueba;

// Proximo dia con ese dia de la semana (0 = domingo), a partir de mañana.
function proximo(dow) {
  let f = T.sumarDias(T.hoy(ZONA), 1);
  while (T.diaSemanaDe(f) !== dow) f = T.sumarDias(f, 1);
  return f;
}

// Lunes a viernes 09:00-18:00
const HORARIO = [1, 2, 3, 4, 5].map((d) => ({ diaSemana: d, horaInicio: '09:00', horaFin: '18:00' }));

async function negocio({ nombre, servicios, recursos, horario = HORARIO, config = {}, plan = false }) {
  const slug = `test-agenda-${Math.random().toString(36).slice(2, 8)}`;
  SLUGS.push(slug);
  const empresa = await prisma.empresa.create({ data: { nombre, slug, modeloNegocio: 'CITAS', zonaHoraria: ZONA, configAgenda: config } });
  const servs = [];
  for (const s of servicios) servs.push(await prisma.servicio.create({ data: { empresaId: empresa.id, ...s } }));
  const recs = [];
  for (const r of recursos) recs.push(await prisma.recurso.create({ data: { empresaId: empresa.id, ...r } }));
  await prisma.horarioAtencion.createMany({ data: horario.map((h) => ({ empresaId: empresa.id, ...h })) });
  if (plan) {
    await prisma.suscripcion.create({
      data: { empresaId: empresa.id, planId: planPrueba.id, estado: 'ACTIVA', periodoInicio: new Date(Date.now() - 86400000), periodoFin: new Date(Date.now() + 29 * 86400000) },
    });
  }
  return { empresa, servicios: servs, recursos: recs };
}
const cliente = (empresaId, n) => prisma.clienteFinal.create({ data: { empresaId, telefono: `5917${String(n).padStart(7, '0')}-${Math.random().toString(36).slice(2, 6)}` } });

before(async () => {
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_CITAS' } });
  planPrueba = await prisma.plan.create({
    data: {
      codigo: 'TEST_CITAS', nombre: 'Prueba citas', mensualidadBs: 0, implementacionBs: 0, primerPagoBs: 0,
      convIncluidas: 100, maxProductos: 10, maxUsuarios: 1, maxServicios: 2, maxCitasMes: 3,
    },
  });
});

after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_CITAS' } });
});

describe('tiempo', () => {
  test('instante <-> hora local de La Paz (UTC-4)', () => {
    const d = T.aInstante('2026-11-10', '15:30', ZONA);
    assert.equal(d.toISOString(), '2026-11-10T19:30:00.000Z');
    assert.deepEqual(T.aLocal(d, ZONA), { fecha: '2026-11-10', hora: '15:30', diaSemana: 2 });
    assert.equal(T.aInstante('2026-13-45', '99:99', ZONA), null);
  });
  test('validadores', () => {
    assert.ok(T.esFecha('2026-11-10') && !T.esFecha('10/11/2026') && !T.esFecha('2026-02-31'));
    assert.ok(T.esHora('09:05') && !T.esHora('9:5') && !T.esHora('24:00'));
    assert.ok(T.esZonaValida('America/La_Paz') && !T.esZonaValida('Marte/Olimpo'));
  });
  test('legible en español', () => assert.match(T.legible(T.aInstante('2026-11-10', '15:30', ZONA), ZONA), /martes 10 de noviembre, 15:30/));
});

describe('motor de agenda', () => {
  test('no permite doble reserva y asigna otro recurso libre', async () => {
    const n = await negocio({ nombre: 'Clinica Test', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Dra. Ana' }, { nombre: 'Dr. Luis' }] });
    const [serv] = n.servicios; const [r1] = n.recursos;
    const [a, b, c] = [await cliente(n.empresa.id, 1), await cliente(n.empresa.id, 2), await cliente(n.empresa.id, 3)];
    const fecha = proximo(1);

    const c1 = await agenda.crearCita(n.empresa, { clienteId: a.id, servicioId: serv.id, recursoId: r1.id, fecha, hora: '10:00' });
    await assert.rejects(agenda.crearCita(n.empresa, { clienteId: b.id, servicioId: serv.id, recursoId: r1.id, fecha, hora: '10:00' }), agenda.ErrorAgenda);
    const c2 = await agenda.crearCita(n.empresa, { clienteId: b.id, servicioId: serv.id, fecha, hora: '10:00' });
    assert.notEqual(c2.recursoId, c1.recursoId);
    await assert.rejects(agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha, hora: '10:00' }), agenda.ErrorAgenda);
    await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha, hora: '10:30' });
  });

  test('respeta el horario de atención, los domingos y los bloqueos', async () => {
    const n = await negocio({ nombre: 'Clinica Horarios', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }] });
    const [serv] = n.servicios;
    assert.deepEqual(await agenda.horariosLibres(n.empresa, { servicioId: serv.id, desde: proximo(0), dias: 1 }), []);
    const lunes = await agenda.horariosLibres(n.empresa, { servicioId: serv.id, desde: proximo(1), dias: 1 });
    assert.equal(lunes[0].hora, '09:00');
    assert.equal(lunes.at(-1).hora, '17:30'); // 17:30 + 30 min = cierre 18:00

    const f = proximo(2);
    await prisma.bloqueoAgenda.create({ data: { empresaId: n.empresa.id, inicio: T.aInstante(f, '00:00', ZONA), fin: T.aInstante(f, '23:59', ZONA), motivo: 'Feriado' } });
    assert.deepEqual(await agenda.horariosLibres(n.empresa, { servicioId: serv.id, desde: f, dias: 1 }), []);
  });

  test('un bloqueo de UN recurso no afecta a los otros', async () => {
    const n = await negocio({ nombre: 'Salon Bloqueo', servicios: [{ nombre: 'Corte', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }, { nombre: 'Diego' }] });
    const f = proximo(3);
    await prisma.bloqueoAgenda.create({ data: { empresaId: n.empresa.id, recursoId: n.recursos[0].id, inicio: T.aInstante(f, '00:00', ZONA), fin: T.aInstante(f, '23:59', ZONA) } });
    const libres = await agenda.horariosLibres(n.empresa, { servicioId: n.servicios[0].id, desde: f, dias: 1 });
    assert.ok(libres.length > 0);
    assert.ok(libres.every((s) => s.recursos.length === 1 && s.recursos[0].nombre === 'Diego'));
  });

  test('capacidad por personas (restaurante)', async () => {
    const n = await negocio({
      nombre: 'Resto Test', servicios: [{ nombre: 'Reserva de mesa', duracionMin: 90, usaPersonas: true, maxPersonas: 12 }],
      recursos: [{ nombre: 'Salón', tipo: 'recurso', capacidad: 40 }, { nombre: 'Terraza', tipo: 'recurso', capacidad: 20 }],
      horario: [5].map((d) => ({ diaSemana: d, horaInicio: '19:00', horaFin: '23:30' })),
    });
    const terraza = n.recursos[1]; const [serv] = n.servicios; const f = proximo(5);
    const nuevo = (i) => cliente(n.empresa.id, i);

    await assert.rejects(agenda.crearCita(n.empresa, { clienteId: (await nuevo(1)).id, servicioId: serv.id, recursoId: terraza.id, fecha: f, hora: '20:00', personas: 13 }), /maximo/);
    await agenda.crearCita(n.empresa, { clienteId: (await nuevo(2)).id, servicioId: serv.id, recursoId: terraza.id, fecha: f, hora: '20:00', personas: 12 });
    await assert.rejects(agenda.crearCita(n.empresa, { clienteId: (await nuevo(3)).id, servicioId: serv.id, recursoId: terraza.id, fecha: f, hora: '20:30', personas: 9 }), agenda.ErrorAgenda);
    await agenda.crearCita(n.empresa, { clienteId: (await nuevo(4)).id, servicioId: serv.id, recursoId: terraza.id, fecha: f, hora: '20:30', personas: 8 });
  });

  test('reprogramar cancela la original y libera su horario', async () => {
    const n = await negocio({ nombre: 'Salon Test', servicios: [{ nombre: 'Corte', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const [serv] = n.servicios; const a = await cliente(n.empresa.id, 11); const f = proximo(3);
    const original = await agenda.crearCita(n.empresa, { clienteId: a.id, servicioId: serv.id, fecha: f, hora: '11:00' });
    const nueva = await agenda.reprogramarCita(n.empresa, original.id, { fecha: f, hora: '15:00' });
    assert.equal((await prisma.cita.findUnique({ where: { id: original.id } })).estado, 'CANCELADA');
    assert.equal(T.aLocal(nueva.inicio, ZONA).hora, '15:00');
    const libres = await agenda.horariosLibres(n.empresa, { servicioId: serv.id, desde: f, dias: 1 });
    assert.ok(libres.some((s) => s.hora === '11:00'), 'el horario de la original quedó libre');
    assert.ok(!libres.some((s) => s.hora === '15:00'));
  });

  test('el tiempo de limpieza (buffer) del servicio bloquea el horario siguiente', async () => {
    const n = await negocio({ nombre: 'Salon Buffer', servicios: [{ nombre: 'Color', duracionMin: 60, bufferMin: 30 }], recursos: [{ nombre: 'Carla' }] });
    const [serv] = n.servicios; const f = proximo(2);
    await agenda.crearCita(n.empresa, { clienteId: (await cliente(n.empresa.id, 21)).id, servicioId: serv.id, fecha: f, hora: '10:00' });
    const horas = (await agenda.horariosLibres(n.empresa, { servicioId: serv.id, desde: f, dias: 1 })).map((s) => s.hora);
    assert.ok(!horas.includes('10:30') && !horas.includes('11:00'), 'ocupado hasta las 11:30 con el buffer');
    assert.ok(horas.includes('11:30'));
  });

  test('la anticipación mínima y el máximo de días se respetan', async () => {
    const n = await negocio({ nombre: 'Anticipacion', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }], config: { anticipacionMin: 60 * 24 * 3, diasMaximos: 10 } });
    const libres = await agenda.horariosLibres(n.empresa, { servicioId: n.servicios[0].id, desde: T.hoy(ZONA), dias: 30 });
    assert.ok(libres.length > 0);
    assert.ok(libres.every((s) => s.inicio.getTime() >= Date.now() + 60 * 24 * 3 * 60000 - 1000), 'nada antes de 3 días');
    assert.ok(libres.every((s) => s.fecha <= T.sumarDias(T.hoy(ZONA), 10)), 'nada después de 10 días');
  });

  test('un recurso solo ofrece los servicios que atiende', async () => {
    const n = await negocio({ nombre: 'Salon Servicios', servicios: [{ nombre: 'Corte', duracionMin: 30 }, { nombre: 'Barba', duracionMin: 30 }], recursos: [{ nombre: 'Carla' }, { nombre: 'Diego' }] });
    await prisma.recursoServicio.create({ data: { recursoId: n.recursos[1].id, servicioId: n.servicios[1].id } }); // Diego: solo barba
    const f = proximo(1);
    const corte = await agenda.horariosLibres(n.empresa, { servicioId: n.servicios[0].id, desde: f, dias: 1 });
    assert.ok(corte.every((s) => s.recursos.map((r) => r.nombre).join() === 'Carla'), 'Diego no hace cortes');
    const barba = await agenda.horariosLibres(n.empresa, { servicioId: n.servicios[1].id, desde: f, dias: 1 });
    assert.ok(barba.every((s) => s.recursos.map((r) => r.nombre).sort().join() === 'Carla,Diego'));
  });

  test('dos clientes pidiendo el último lugar a la vez: solo uno lo consigue', async () => {
    const n = await negocio({ nombre: 'Carrera', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }] });
    const [serv] = n.servicios; const f = proximo(4);
    const clientes = await Promise.all([1, 2, 3, 4, 5].map((i) => cliente(n.empresa.id, 30 + i)));
    const resultados = await Promise.allSettled(clientes.map((c) => agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha: f, hora: '09:00' })));
    assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await prisma.cita.count({ where: { empresaId: n.empresa.id, estado: 'CONFIRMADA' } }), 1);
  });

  test('un negocio no puede tocar las citas de otro', async () => {
    const a = await negocio({ nombre: 'Uno', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }] });
    const b = await negocio({ nombre: 'Dos', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }] });
    const cita = await agenda.crearCita(a.empresa, { clienteId: (await cliente(a.empresa.id, 41)).id, servicioId: a.servicios[0].id, fecha: proximo(1), hora: '09:00' });
    await assert.rejects(agenda.cancelarCita(b.empresa, cita.id), /inexistente/);
    await assert.rejects(agenda.horariosLibres(b.empresa, { servicioId: a.servicios[0].id, desde: proximo(1), dias: 1 }), /Servicio inexistente/);
  });

  test('citas próximas del cliente: solo activas y futuras', async () => {
    const n = await negocio({ nombre: 'Proximas', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }] });
    const c = await cliente(n.empresa.id, 51);
    const a = await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: n.servicios[0].id, fecha: proximo(1), hora: '09:00' });
    const b = await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: n.servicios[0].id, fecha: proximo(2), hora: '09:00' });
    await agenda.cancelarCita(n.empresa, b.id);
    const lista = await agenda.citasProximasDeCliente(n.empresa.id, c.id);
    assert.deepEqual(lista.map((x) => x.id), [a.id]);
    assert.equal(lista[0].servicio.nombre, 'Consulta');
  });
});

describe('topes del plan', () => {
  test('el tope de citas por periodo bloquea la siguiente; reprogramar y las canceladas no gastan cupo', async () => {
    const n = await negocio({ nombre: 'Tope citas', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }], plan: true });
    const [serv] = n.servicios; const c = await cliente(n.empresa.id, 61); const f = proximo(1);
    const una = await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha: f, hora: '09:00' });
    const dos = await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha: f, hora: '10:00' });
    await agenda.reprogramarCita(n.empresa, una.id, { fecha: f, hora: '11:00' }); // no gasta cupo
    assert.equal((await limites.estadoDeLimites(n.empresa.id)).citas.usados, 2, 'la reprogramada reemplaza a la original');
    await agenda.cancelarCita(n.empresa, dos.id);
    assert.equal((await limites.estadoDeLimites(n.empresa.id)).citas.usados, 1, 'una cancelada deja el cupo libre');
    await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha: f, hora: '12:00' });
    await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha: f, hora: '13:00' });
    await assert.rejects(agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: serv.id, fecha: f, hora: '14:00' }), (e) => e.codigo === 'TOPE_CITAS');
  });

  test('al acercarse (80 %) y al llegar al tope el negocio recibe UN aviso en la campanita', async () => {
    const n = await negocio({ nombre: 'Aviso tope', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }], plan: true });
    const c = await cliente(n.empresa.id, 71); const f = proximo(1);
    for (const h of ['09:00', '10:00', '11:00']) await agenda.crearCita(n.empresa, { clienteId: c.id, servicioId: n.servicios[0].id, fecha: f, hora: h });
    await new Promise((r) => setTimeout(r, 300)); // el aviso se crea sin esperar a la cita
    const avisos = await prisma.notificacion.findMany({ where: { empresaId: n.empresa.id, tipo: 'TOPE_CITAS' } });
    assert.equal(avisos.length, 1, 'sin duplicar mientras no se lea');
  });

  test('el tope de servicios cuenta solo los activos', async () => {
    const n = await negocio({ nombre: 'Tope servicios', servicios: [{ nombre: 'A' }, { nombre: 'B' }], recursos: [{ nombre: 'Equipo' }], plan: true });
    assert.deepEqual(await limites.puedeCrearServicio(n.empresa.id), { ok: false, usados: 2, tope: 2 });
    await prisma.servicio.update({ where: { id: n.servicios[0].id }, data: { activo: false } });
    assert.equal((await limites.puedeCrearServicio(n.empresa.id)).ok, true);
  });

  test('sin suscripción se usan los topes por defecto (no bloquea)', async () => {
    const n = await negocio({ nombre: 'Sin plan', servicios: [{ nombre: 'A' }], recursos: [{ nombre: 'Equipo' }] });
    const e = await limites.estadoDeLimites(n.empresa.id);
    assert.deepEqual([e.servicios.tope, e.citas.tope], [10, 200]);
  });
});

describe('feriados', () => {
  test('un feriado nacional cierra el día; uno marcado "se trabaja" no', async () => {
    const f = proximo(1);
    const anio = Number(f.slice(0, 4));
    await prisma.feriadoCache.upsert({
      where: { pais_anio: { pais: 'BO', anio } },
      update: { datos: [{ fecha: f, nombre: 'Feriado de prueba', regional: false }], actualizadoEn: new Date() },
      create: { pais: 'BO', anio, datos: [{ fecha: f, nombre: 'Feriado de prueba', regional: false }] },
    });
    delete process.env.FERIADOS_OFFLINE;
    try {
      const n = await negocio({ nombre: 'Feriados', servicios: [{ nombre: 'Consulta', duracionMin: 30 }], recursos: [{ nombre: 'Equipo' }] });
      assert.ok((await feriados.fechasCerradas(n.empresa, f, f)).has(f));
      assert.deepEqual(await agenda.horariosLibres(n.empresa, { servicioId: n.servicios[0].id, desde: f, dias: 1 }), []);

      const abierto = await prisma.empresa.update({ where: { id: n.empresa.id }, data: { configAgenda: { feriadosAbiertos: [f] } } });
      assert.equal((await feriados.fechasCerradas(abierto, f, f)).size, 0);
      assert.ok((await agenda.horariosLibres(abierto, { servicioId: n.servicios[0].id, desde: f, dias: 1 })).length > 0);

      const cerrarNada = await prisma.empresa.update({ where: { id: n.empresa.id }, data: { configAgenda: { cerrarFeriados: false } } });
      assert.equal((await feriados.fechasCerradas(cerrarNada, f, f)).size, 0);
    } finally {
      process.env.FERIADOS_OFFLINE = '1';
      await prisma.feriadoCache.deleteMany({ where: { pais: 'BO', anio } });
    }
  });
});
