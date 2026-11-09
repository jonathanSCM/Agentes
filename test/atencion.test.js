// Configuración del modelo de citas: servicios, equipo, horarios, bloqueos, "Mi negocio" y rubros de ejemplo.
process.env.FERIADOS_OFFLINE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const A = require('../lib/services/atencion');
const agenda = require('../lib/services/agenda');
const { parsearNegocio } = require('../lib/services/miNegocio');
const { vocabularioDe, cargarEjemplo, RUBROS } = require('../lib/services/rubros');
const { pasosIniciales } = require('../lib/services/primerosPasos');
const T = require('../lib/services/tiempo');

const ZONA = 'America/La_Paz';
const SLUGS = [];
let plan;

async function empresa({ conPlan = false, extra = {} } = {}) {
  const slug = `test-atencion-${Math.random().toString(36).slice(2, 8)}`;
  SLUGS.push(slug);
  const e = await prisma.empresa.create({ data: { nombre: 'Negocio', slug, modeloNegocio: 'CITAS', ...extra } });
  if (conPlan) await prisma.suscripcion.create({ data: { empresaId: e.id, planId: plan.id, estado: 'ACTIVA', periodoInicio: new Date(Date.now() - 86400000), periodoFin: new Date(Date.now() + 29 * 86400000) } });
  return e;
}

before(async () => {
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_ATENCION' } });
  plan = await prisma.plan.create({ data: { codigo: 'TEST_ATENCION', nombre: 'Prueba atención', mensualidadBs: 0, implementacionBs: 0, primerPagoBs: 0, convIncluidas: 10, maxProductos: 1, maxUsuarios: 1, maxServicios: 3, maxCitasMes: 10 } });
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_ATENCION' } });
});

describe('servicios', () => {
  test('validarServicio: lo obligatorio, los rangos y las personas', () => {
    assert.deepEqual(A.validarServicio({ nombre: 'Corte', duracionMin: '30' }).errores, []);
    const malo = A.validarServicio({ nombre: '  ', duracionMin: '2', bufferMin: '999', precio: '-5' });
    assert.equal(malo.errores.length, 4);
    const mesa = A.validarServicio({ nombre: 'Mesa', duracionMin: '90', usaPersonas: '1', maxPersonas: '12', precio: '12,50' });
    assert.deepEqual([mesa.datos.usaPersonas, mesa.datos.maxPersonas, mesa.datos.precio], [true, 12, 12.5]);
    assert.equal(A.validarServicio({ nombre: 'Mesa', duracionMin: '90', usaPersonas: '1', maxPersonas: '0' }).errores.length, 1);
  });

  test('el tope del plan frena la creación; desactivar libera cupo y reactivar vuelve a contar', async () => {
    const e = await empresa({ conPlan: true });
    const nuevo = (n) => A.crearServicio(e.id, A.validarServicio({ nombre: `S${n}`, duracionMin: 30 }).datos);
    const [a] = [await nuevo(1), await nuevo(2), await nuevo(3)];
    await assert.rejects(nuevo(4), (err) => err.codigo === 'TOPE_SERVICIOS');
    await A.cambiarActivoServicio(e.id, a.id, false);
    await nuevo(4);
    await assert.rejects(A.cambiarActivoServicio(e.id, a.id, true), (err) => err.codigo === 'TOPE_SERVICIOS');
  });

  test('no se borra un servicio con historial de citas (se desactiva)', async () => {
    const e = await empresa();
    const s = await A.crearServicio(e.id, A.validarServicio({ nombre: 'Corte', duracionMin: 30 }).datos);
    const sinCitas = await A.crearServicio(e.id, A.validarServicio({ nombre: 'Otro', duracionMin: 30 }).datos);
    const c = await prisma.clienteFinal.create({ data: { empresaId: e.id, telefono: `591${Math.random().toString().slice(2, 10)}` } });
    await prisma.cita.create({ data: { empresaId: e.id, clienteId: c.id, servicioId: s.id, inicio: new Date(), fin: new Date() } });
    await assert.rejects(A.eliminarServicio(e.id, s.id), (err) => err.codigo === 'CON_HISTORIAL');
    await A.eliminarServicio(e.id, sinCitas.id);
    assert.equal(await prisma.servicio.count({ where: { empresaId: e.id } }), 1);
  });

  test('no se toca un servicio de otro negocio', async () => {
    const a = await empresa(); const b = await empresa();
    const s = await A.crearServicio(a.id, A.validarServicio({ nombre: 'Corte', duracionMin: 30 }).datos);
    await assert.rejects(A.actualizarServicio(b.id, s.id, { nombre: 'Robado' }), /no existe/);
    await A.eliminarServicio(b.id, s.id);
    assert.equal(await prisma.servicio.count({ where: { id: s.id } }), 1, 'el borrado de otro negocio no hizo nada');
  });
});

describe('equipo', () => {
  test('validarRecurso', () => {
    assert.deepEqual(A.validarRecurso({ nombre: 'Terraza', tipo: 'recurso', capacidad: '20' }).datos.capacidad, 20);
    assert.equal(A.validarRecurso({ nombre: '', capacidad: '0' }).errores.length, 2);
  });
  test('solo se asignan servicios del propio negocio', async () => {
    const a = await empresa(); const b = await empresa();
    const sa = await A.crearServicio(a.id, A.validarServicio({ nombre: 'A', duracionMin: 30 }).datos);
    const sb = await A.crearServicio(b.id, A.validarServicio({ nombre: 'B', duracionMin: 30 }).datos);
    const r = await A.crearRecurso(a.id, A.validarRecurso({ nombre: 'Carla' }).datos, [String(sa.id), String(sb.id)]);
    const filas = await prisma.recursoServicio.findMany({ where: { recursoId: r.id } });
    assert.deepEqual(filas.map((f) => f.servicioId), [sa.id]);
    await A.actualizarRecurso(a.id, r.id, { nombre: 'Carla R.' }, []);
    assert.equal(await prisma.recursoServicio.count({ where: { recursoId: r.id } }), 0, 'sin servicios = atiende todos');
  });
});

describe('horarios', () => {
  test('lee turnos partidos y valida horas, orden y superposición', () => {
    const ok = A.parsearHorarioSemana({ ini1: ['09:00', '14:00'], fin1: ['12:00', '18:00'], ini2: '09:00', fin2: '17:00' });
    assert.deepEqual(ok.errores, []);
    assert.equal(ok.filas.filter((f) => f.diaSemana === 1).length, 2);
    assert.match(A.parsearHorarioSemana({ ini1: '9:00', fin1: '12:00' }).errores[0], /hora inválida/);
    assert.match(A.parsearHorarioSemana({ ini1: '18:00', fin1: '09:00' }).errores[0], /después de la de apertura/);
    assert.match(A.parsearHorarioSemana({ ini1: ['09:00', '11:00'], fin1: ['12:00', '15:00'] }).errores[0], /se pisan/);
    assert.deepEqual(A.parsearHorarioSemana({ ini1: ['', ''], fin1: ['', ''] }), { filas: [], errores: [] }, 'un día sin horas = cerrado');
  });
  test('guardarHorario reemplaza el general y el propio de un recurso sin mezclarlos', async () => {
    const e = await empresa();
    const r = await A.crearRecurso(e.id, A.validarRecurso({ nombre: 'Carla' }).datos, []);
    await A.guardarHorario(e.id, null, A.parsearHorarioSemana({ ini1: '09:00', fin1: '18:00' }).filas);
    await A.guardarHorario(e.id, r.id, A.parsearHorarioSemana({ ini2: '10:00', fin2: '14:00' }).filas);
    await A.guardarHorario(e.id, null, A.parsearHorarioSemana({ ini3: '08:00', fin3: '12:00' }).filas);
    const general = await prisma.horarioAtencion.findMany({ where: { empresaId: e.id, recursoId: null } });
    assert.deepEqual(general.map((h) => h.diaSemana), [3]);
    assert.equal(await prisma.horarioAtencion.count({ where: { empresaId: e.id, recursoId: r.id } }), 1);
  });
  test('un horario no se guarda para un recurso de otro negocio', async () => {
    const a = await empresa(); const b = await empresa();
    const r = await A.crearRecurso(a.id, A.validarRecurso({ nombre: 'Carla' }).datos, []);
    await assert.rejects(A.guardarHorario(b.id, r.id, []), /no existe/);
  });
});

describe('bloqueos', () => {
  test('días completos o con horas, en la zona del negocio', () => {
    const dias = A.validarBloqueo({ fechaDesde: '2026-12-24', fechaHasta: '2026-12-26', motivo: 'Navidad' }, ZONA);
    assert.deepEqual(dias.errores, []);
    assert.equal(dias.datos.inicio.toISOString(), '2026-12-24T04:00:00.000Z');
    assert.equal(dias.datos.fin.toISOString(), '2026-12-27T04:00:00.000Z', 'hasta el final del 26');
    const horas = A.validarBloqueo({ fechaDesde: '2026-12-24', horaDesde: '12:00', horaHasta: '14:00' }, ZONA);
    assert.equal(horas.datos.fin.toISOString(), '2026-12-24T18:00:00.000Z');
    assert.ok(A.validarBloqueo({ fechaDesde: '2026-12-26', fechaHasta: '2026-12-24' }, ZONA).errores.length, 'termina antes de empezar');
    assert.ok(A.validarBloqueo({}, ZONA).errores.length);
  });
  test('un bloqueo cierra la agenda de verdad', async () => {
    const e = await empresa();
    const s = await A.crearServicio(e.id, A.validarServicio({ nombre: 'Consulta', duracionMin: 30 }).datos);
    await A.crearRecurso(e.id, A.validarRecurso({ nombre: 'Equipo' }).datos, []);
    await A.guardarHorario(e.id, null, A.parsearHorarioSemana(Object.fromEntries([1, 2, 3, 4, 5].flatMap((d) => [[`ini${d}`, '09:00'], [`fin${d}`, '18:00']]))).filas);
    let f = T.sumarDias(T.hoy(ZONA), 2);
    while (T.diaSemanaDe(f) === 0 || T.diaSemanaDe(f) === 6) f = T.sumarDias(f, 1);
    assert.ok((await agenda.horariosLibres(e, { servicioId: s.id, desde: f, dias: 1 })).length > 0);
    const b = A.validarBloqueo({ fechaDesde: f, motivo: 'Cerrado' }, ZONA);
    const creado = await A.crearBloqueo(e.id, b.datos);
    assert.equal((await agenda.horariosLibres(e, { servicioId: s.id, desde: f, dias: 1 })).length, 0);
    await A.eliminarBloqueo(e.id, creado.id);
    assert.ok((await agenda.horariosLibres(e, { servicioId: s.id, desde: f, dias: 1 })).length > 0);
  });
});

describe('Mi negocio', () => {
  const actual = { modeloNegocio: 'PRODUCTOS', zonaHoraria: 'America/La_Paz', configAgenda: {} };
  test('elige el modelo; un valor inválido deja el actual', () => {
    assert.equal(parsearNegocio({ modeloNegocio: 'CITAS' }, actual).empresa.modeloNegocio, 'CITAS');
    assert.equal(parsearNegocio({ modeloNegocio: 'cualquiera' }, actual).empresa.modeloNegocio, 'PRODUCTOS');
  });
  test('zona horaria y país se validan', () => {
    assert.match(parsearNegocio({ zonaHoraria: 'Marte/Olimpo' }, actual).errores[0], /zona horaria/);
    assert.match(parsearNegocio({ pais: 'Bolivia' }, actual).errores[0], /2 letras/);
    assert.equal(parsearNegocio({ pais: 'bo' }, actual).empresa.pais, 'BO');
  });
  test('el vocabulario guarda solo lo que se aparta de las palabras del rubro', () => {
    const r = parsearNegocio({ rubro: 'salon', vocabCita: 'turno', vocabProfesional: 'peluquero', vocabProfesionales: 'Estilistas' }, actual);
    assert.deepEqual(r.empresa.vocabulario, { profesional: 'peluquero' });
    assert.equal(r.empresa.rubro, 'salon');
  });
  test('reglas de agenda: horas a minutos, rangos y casillas', () => {
    const r = parsearNegocio({ agendaIntervalo: '45', agendaAnticipacionHoras: '2', agendaDiasMaximos: '30', agendaCerrarFeriados: '1' }, actual);
    assert.deepEqual(r.errores, []);
    assert.deepEqual(r.empresa.configAgenda, { intervaloMin: 45, anticipacionMin: 120, diasMaximos: 30, cerrarFeriados: true, permiteElegirRecurso: false, reservaPublica: false });
    const conWeb = parsearNegocio({ agendaIntervalo: '30', agendaDiasMaximos: '30', agendaReservaPublica: '1' }, actual);
    assert.equal(conWeb.empresa.configAgenda.reservaPublica, true, 'la casilla de la página de reservas se guarda');
    assert.equal(parsearNegocio({ agendaIntervalo: '1', agendaDiasMaximos: '30' }, actual).errores.length, 1);
  });
  test('el registro del agente: vos o tu', () => {
    assert.equal(parsearNegocio({ registro: 'tu' }, actual).registro, 'tu');
    assert.equal(parsearNegocio({ registro: 'usted' }, actual).registro, null, 'usted todavía no tiene textos');
  });
});

describe('rubros de ejemplo', () => {
  test('hay 5 rubros y el vocabulario cambia con el rubro y con lo que el negocio edite', () => {
    assert.equal(Object.keys(RUBROS).length, 5);
    assert.equal(vocabularioDe({ rubro: 'salon' }).cita, 'turno');
    assert.equal(vocabularioDe({ rubro: 'restaurante' }).profesionales, 'Áreas / Salones');
    assert.equal(vocabularioDe({ rubro: 'salon', vocabulario: { cita: 'sesión', zzz: 'x' } }).cita, 'sesión');
    assert.equal(vocabularioDe({}).cita, 'cita');
  });
  test('cargar el ejemplo no pisa lo que ya hay y es repetible', async () => {
    const e = await empresa();
    const r1 = await cargarEjemplo(e.id, 'clinica');
    assert.deepEqual([r1.servicios, r1.recursos, r1.horarios > 0], [3, 2, true]);
    const r2 = await cargarEjemplo(e.id, 'salon');
    assert.deepEqual([r2.servicios, r2.recursos, r2.horarios], [0, 0, 0], 'ya tenía todo: no cambia nada');
    assert.equal(await prisma.servicio.count({ where: { empresaId: e.id } }), 3);
  });
  test('respeta el tope de servicios del plan', async () => {
    const e = await empresa();
    const r = await cargarEjemplo(e.id, 'salon', { topeServicios: 3 }); // el salón trae 4
    assert.deepEqual([r.servicios, r.omitidosPorTope], [3, 1]);
  });
  test('el ejemplo ya sirve para agendar (servicio + equipo + horario)', async () => {
    const e = await empresa();
    await cargarEjemplo(e.id, 'clinica');
    const [s] = await prisma.servicio.findMany({ where: { empresaId: e.id } });
    let f = T.sumarDias(T.hoy(ZONA), 1);
    while (T.diaSemanaDe(f) !== 1) f = T.sumarDias(f, 1);
    assert.ok((await agenda.horariosLibres(e, { servicioId: s.id, desde: f, dias: 1 })).length > 0);
  });
});

describe('primeros pasos del modelo de citas', () => {
  test('servicios → equipo → horarios → WhatsApp → agente', () => {
    const p = pasosIniciales({ modelo: 'CITAS', servicios: 1, recursos: 0, horarios: 0, productos: 0, whatsappConectado: false, agenteActivo: false });
    assert.deepEqual(p.pasos.map((x) => x.clave), ['servicios', 'equipo', 'horarios', 'whatsapp', 'agente']);
    assert.equal(p.siguiente.clave, 'equipo');
  });
  test('el modelo de productos no cambia', () => {
    assert.deepEqual(pasosIniciales({ productos: 0 }).pasos.map((x) => x.clave), ['producto', 'whatsapp', 'agente']);
  });
});
