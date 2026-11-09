// Página pública de reservas (/reservar/:slug): servicio y rutas HTTP reales (sin login), con seguridad y concurrencia.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { prisma } = require('../lib/db');
const R = require('../lib/services/reservaPublica');
const rutas = require('../lib/rutasReservas');

const SLUGS = ['test-reserva-a', 'test-reserva-b', 'test-reserva-prod'];
let A; let servicio; let ana; let beto; let server; let base;
let seq = 0;

const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.match(e.message, patron); return true; });
const unTel = () => `71${String(Date.now()).slice(-4)}${String(seq += 1).padStart(2, '0')}`;

async function pedir(ruta, { metodo = 'GET', cuerpo = null, ip = null } = {}) {
  const r = await fetch(base + ruta, {
    method: metodo, redirect: 'manual',
    headers: { ...(cuerpo ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: cuerpo ? new URLSearchParams(cuerpo).toString() : undefined,
  });
  return { status: r.status, loc: r.headers.get('location'), tipo: r.headers.get('content-type') || '', texto: await r.text(), cabeceras: r.headers };
}
const horaLibre = async () => {
  // Un día lejano con horarios: sale de la propia página (no se inventa).
  const dias = await pedir(`/reservar/${SLUGS[0]}?servicio=${servicio.id}&profesional=0`);
  const fecha = [...dias.texto.matchAll(/href="([^"]*fecha=(\d{4}-\d{2}-\d{2})[^"]*)"/g)].pop();
  const horas = await pedir(`/reservar/${SLUGS[0]}?servicio=${servicio.id}&profesional=0&fecha=${fecha[2]}`);
  const hora = [...horas.texto.matchAll(/hora=(\d{2}%3A\d{2})/g)].pop()[1].replace('%3A', ':');
  return { fecha: fecha[2], hora };
};

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  const crear = async (slug, extra = {}, conAgente = true) => {
    const e = await prisma.empresa.create({ data: { nombre: `Salón ${slug}`, slug, modeloNegocio: 'CITAS', rubro: 'salon', ...extra, ...(conAgente ? { agentes: { create: { nombre: 'Agente' } } } : {}) }, include: { agentes: true } });
    for (let d = 0; d < 7; d++) await prisma.horarioAtencion.create({ data: { empresaId: e.id, diaSemana: d, horaInicio: '09:00', horaFin: '18:00' } });
    return e;
  };
  A = await crear(SLUGS[0]);
  await prisma.agenteConfig.create({ data: { agenteId: A.agentes[0].id, direccionTienda: 'Av. Arce 100', colorPrimario: '#ff5500' } });
  servicio = await prisma.servicio.create({ data: { empresaId: A.id, nombre: 'Corte de pelo', duracionMin: 30, precio: 60 } });
  ana = await prisma.recurso.create({ data: { empresaId: A.id, nombre: 'Ana' } });
  beto = await prisma.recurso.create({ data: { empresaId: A.id, nombre: 'Beto' } });
  for (const r of [ana, beto]) await prisma.recursoServicio.create({ data: { recursoId: r.id, servicioId: servicio.id } });
  await crear(SLUGS[1], { configAgenda: { reservaPublica: false } });
  await prisma.empresa.create({ data: { nombre: 'Tienda', slug: SLUGS[2], modeloNegocio: 'PRODUCTOS' } });

  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  // La pagina 404 del sitio usa los datos del sitio (como en server.js).
  app.use((req, res, next) => { res.locals.site = { name: 'Proshop', tagline: '', whatsappUrl: 'https://wa.me/0', whatsapp: '0', email: 'x@x.x', instagram: '', facebook: '', tiktok: '' }; next(); });
  app.use('/reservar', rutas);
  app.use((req, res) => res.status(404).send('404'));
  app.use((err, req, res, _next) => { console.error(err); res.status(500).send('error'); });
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
});

describe('datos de entrada', () => {
  test('el teléfono se arma con el código de país y se limpia; uno incompleto se rechaza', () => {
    assert.equal(R.normalizarTelefono('591', '71234567'), '59171234567');
    assert.equal(R.normalizarTelefono('591', '+591 712-34567'), '59171234567', 'si ya trae el código, no se repite');
    assert.equal(R.normalizarTelefono('51', '0987654321'), '51987654321', 'el 0 inicial local sobra');
    assert.throws(() => R.normalizarTelefono('591', '123'), /incompleto/);
    assert.throws(() => R.normalizarTelefono('999', '71234567'), /código de tu país/);
  });

  test('el nombre es de persona: letras, entre 2 y 60', () => {
    assert.equal(R.nombreValido('  Ana   María Pérez '), 'Ana María Pérez');
    for (const malo of ['', 'A', '12345', '<script>alert(1)</script>', 'x'.repeat(61), 'Juan; DROP TABLE']) assert.equal(R.nombreValido(malo), null, malo);
  });

  test('el token de confirmación solo sirve para esa cita y ese teléfono', () => {
    const t = R.tokenDeCita({ id: 7 }, '59171234567');
    assert.equal(R.tokenValido(t, 7, '59171234567'), true);
    assert.equal(R.tokenValido(t, 8, '59171234567'), false);
    assert.equal(R.tokenValido(t, 7, '59170000000'), false);
    assert.equal(R.tokenValido('', 7, '59171234567'), false);
    assert.equal(R.tokenValido(undefined, 7, '59171234567'), false);
  });
});

describe('quién puede reservar', () => {
  test('un negocio de citas con la reserva activa muestra sus servicios; las desactivadas y las tiendas no existen para el público', async () => {
    const ok = await pedir(`/reservar/${SLUGS[0]}`);
    assert.equal(ok.status, 200);
    assert.match(ok.texto, /Salón test-reserva-a/);
    assert.match(ok.texto, /Corte de pelo/);
    assert.match(ok.texto, /60\.00/);
    assert.match(ok.texto, /--acento: #ff5500/, 'usa el color del negocio');
    assert.equal((await pedir(`/reservar/${SLUGS[1]}`)).status, 404, 'desactivada');
    assert.match((await pedir(`/reservar/${SLUGS[1]}`)).texto, /no están disponibles/);
    assert.equal((await pedir(`/reservar/${SLUGS[2]}`)).status, 404, 'una tienda de productos no tiene reservas');
    assert.equal((await pedir('/reservar/no-existe-jamas')).status, 404);
  });

  test('un negocio con el plan vencido no recibe reservas', async () => {
    const plan = await prisma.plan.findFirst({ where: { activo: true } });
    const antes = await prisma.suscripcion.findUnique({ where: { empresaId: A.id } });
    await prisma.suscripcion.upsert({
      where: { empresaId: A.id },
      create: { empresaId: A.id, planId: plan.id, estado: 'ACTIVA', planNombre: 'Vencido', modulos: ['AGENTE'], planInicio: new Date('2025-01-01'), planFin: new Date('2025-02-01'), periodoInicio: new Date('2025-01-01'), periodoFin: new Date('2025-02-01') },
      update: { planFin: new Date('2025-02-01') },
    });
    try {
      assert.equal((await pedir(`/reservar/${SLUGS[0]}`)).status, 404);
    } finally { if (!antes) await prisma.suscripcion.deleteMany({ where: { empresaId: A.id } }); }
  });
});

describe('recorrido paso a paso por la web', () => {
  test('servicio → profesional → día → hora → datos, cada paso con enlaces y un resumen de lo elegido', async () => {
    const paso1 = await pedir(`/reservar/${SLUGS[0]}?servicio=${servicio.id}`);
    assert.match(paso1.texto, /¿Con qué estilista\?/);
    assert.match(paso1.texto, /Cualquiera disponible/);
    assert.match(paso1.texto, /Ana/);
    const paso2 = await pedir(`/reservar/${SLUGS[0]}?servicio=${servicio.id}&profesional=${ana.id}`);
    assert.match(paso2.texto, /Elegí el día/);
    assert.match(paso2.texto, /horarios?/);
    assert.match(paso2.texto, /Estilista<\/small><strong>Ana/, 'la elección queda a la vista y se puede cambiar');
    const { fecha, hora } = await horaLibre();
    const paso3 = await pedir(`/reservar/${SLUGS[0]}?servicio=${servicio.id}&profesional=0&fecha=${fecha}`);
    assert.match(paso3.texto, /Elegí la hora/);
    assert.match(paso3.texto, /Por la mañana/);
    const paso4 = await pedir(`/reservar/${SLUGS[0]}?servicio=${servicio.id}&profesional=0&fecha=${fecha}&hora=${hora}`);
    assert.match(paso4.texto, /Tus datos/);
    assert.match(paso4.texto, /name="sitio_web"/, 'trampa para robots');
    assert.match(paso4.texto, /value="591" selected/, 'código de país del negocio (Bolivia)');
  });

  test('un parámetro manipulado no rompe nada: servicio ajeno o fechas inválidas vuelven al inicio de la lista', async () => {
    const otro = await prisma.servicio.create({ data: { empresaId: (await prisma.empresa.findUnique({ where: { slug: SLUGS[1] } })).id, nombre: 'Servicio de otro negocio' } });
    const r = await pedir(`/reservar/${SLUGS[0]}?servicio=${otro.id}`);
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.texto, /Servicio de otro negocio/);
    assert.match(r.texto, /Qué servicio/);
    for (const q of ['fecha=hoy', 'fecha=2026-13-45', 'hora=99:99', `profesional=999999`, 'servicio=abc', `servicio=${servicio.id}&desde=zzz`]) {
      assert.ok([200, 302].includes((await pedir(`/reservar/${SLUGS[0]}?servicio=${servicio.id}&profesional=0&${q}`)).status), q);
    }
  });

  test('reservar crea la cita (origen web), el cliente y el aviso al negocio, y lleva a una confirmación con token', async () => {
    const { fecha, hora } = await horaLibre();
    const tel = unTel();
    const r = await pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: { servicio: servicio.id, profesional: ana.id, personas: 1, fecha, hora, nombre: 'Carla Mendoza', codigo: '591', telefono: tel, sitio_web: '' } });
    assert.equal(r.status, 302);
    assert.match(r.loc, new RegExp(`^/reservar/${SLUGS[0]}/listo/\\d+\\?t=`));
    const citaId = Number(r.loc.match(/listo\/(\d+)/)[1]);
    const cita = await prisma.cita.findUnique({ where: { id: citaId }, include: { cliente: true } });
    assert.equal(cita.origen, 'web');
    assert.equal(cita.estado, 'CONFIRMADA');
    assert.equal(cita.recursoId, ana.id);
    assert.equal(cita.cliente.telefono, `591${tel}`);
    assert.equal(cita.cliente.nombre, 'Carla Mendoza');
    assert.equal(await prisma.notificacion.count({ where: { empresaId: A.id, titulo: 'Reserva nueva desde la web' } }) >= 1, true);

    const listo = await pedir(r.loc);
    assert.equal(listo.status, 200);
    assert.match(listo.texto, /Reserva confirmada/);
    assert.match(listo.texto, /Av\. Arce 100/);
    assert.equal(listo.cabeceras.get('x-robots-tag'), 'noindex, nofollow');
    const ics = await pedir(r.loc.replace('/listo/', '/listo/').replace(/\?t=/, '/calendario.ics?t='));
    assert.match(ics.tipo, /text\/calendar/);
    assert.match(ics.texto, /BEGIN:VEVENT[\s\S]*SUMMARY:Corte de pelo en Salón test-reserva-a[\s\S]*END:VCALENDAR/);
  });

  test('datos mal escritos vuelven al formulario con lo escrito y el motivo; no se crea nada', async () => {
    const { fecha, hora } = await horaLibre();
    const antes = await prisma.cita.count({ where: { empresaId: A.id } });
    const malo = await pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: { servicio: servicio.id, profesional: 0, personas: 1, fecha, hora, nombre: '1234', codigo: '591', telefono: '71234567' } });
    assert.equal(malo.status, 400);
    assert.match(malo.texto, /Escribí tu nombre/);
    const tel = await pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: { servicio: servicio.id, profesional: 0, personas: 1, fecha, hora, nombre: 'Ana Gómez', codigo: '591', telefono: '12' } });
    assert.match(tel.texto, /incompleto/);
    assert.match(tel.texto, /value="Ana Gómez"/, 'conserva lo que escribió');
    assert.equal(await prisma.cita.count({ where: { empresaId: A.id } }), antes);
  });

  test('un robot que llena el campo trampa no reserva nada', async () => {
    const { fecha, hora } = await horaLibre();
    const antes = await prisma.cita.count({ where: { empresaId: A.id } });
    const r = await pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: { servicio: servicio.id, profesional: 0, personas: 1, fecha, hora, nombre: 'Robot Spam', codigo: '591', telefono: unTel(), sitio_web: 'http://spam.example' } });
    assert.equal(r.status, 302);
    assert.equal(r.loc, `/reservar/${SLUGS[0]}`);
    assert.equal(await prisma.cita.count({ where: { empresaId: A.id } }), antes);
  });
});

describe('reglas e integridad', () => {
  test('dos personas por el último lugar a la vez: reserva una y la otra vuelve a elegir hora', async () => {
    const unico = await prisma.servicio.create({ data: { empresaId: A.id, nombre: 'Peinado exclusivo', duracionMin: 30 } });
    const sala = await prisma.recurso.create({ data: { empresaId: A.id, nombre: 'Sala única' } });
    await prisma.recursoServicio.create({ data: { recursoId: sala.id, servicioId: unico.id } });
    const dias = await pedir(`/reservar/${SLUGS[0]}?servicio=${unico.id}`);
    const fecha = [...dias.texto.matchAll(/fecha=(\d{4}-\d{2}-\d{2})/g)].pop()[1];
    const horas = await pedir(`/reservar/${SLUGS[0]}?servicio=${unico.id}&fecha=${fecha}`);
    const hora = [...horas.texto.matchAll(/hora=(\d{2}%3A\d{2})/g)].pop()[1].replace('%3A', ':');
    const cuerpo = (n) => ({ servicio: unico.id, profesional: 0, personas: 1, fecha, hora, nombre: `Persona ${n}`, codigo: '591', telefono: unTel() });
    const [r1, r2] = await Promise.all([pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: cuerpo('Uno'), ip: '10.0.0.1' }), pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: cuerpo('Dos'), ip: '10.0.0.2' })]);
    const listas = [r1, r2].filter((r) => /\/listo\//.test(r.loc || ''));
    const ocupadas = [r1, r2].filter((r) => /e=ocupado/.test(r.loc || ''));
    assert.equal(listas.length, 1, 'una sola reserva');
    assert.equal(ocupadas.length, 1, 'la otra recibe el aviso de que se ocupó');
    assert.equal(await prisma.cita.count({ where: { empresaId: A.id, servicioId: unico.id, estado: 'CONFIRMADA' } }), 1);
  });

  test('un mismo teléfono no puede acaparar: máximo 3 reservas pendientes', async () => {
    const tel = unTel();
    const cliente = await prisma.clienteFinal.create({ data: { empresaId: A.id, telefono: `591${tel}`, nombre: 'Acaparador' } });
    for (let i = 0; i < 3; i++) {
      const inicio = new Date(Date.now() + (10 + i) * 86400000);
      await prisma.cita.create({ data: { empresaId: A.id, clienteId: cliente.id, servicioId: servicio.id, recursoId: ana.id, inicio, fin: new Date(inicio.getTime() + 1800000), estado: 'CONFIRMADA', origen: 'web' } });
    }
    const { fecha, hora } = await horaLibre();
    await rechaza(R.reservar(A, { servicioId: servicio.id, recursoId: 0, personas: 1, fecha, hora, nombre: 'Acaparador', codigo: '591', telefono: tel }), /3 reservas pendientes/);
  });

  test('un cliente que ya existe (mismo teléfono que en WhatsApp) no cambia de nombre por lo que escriban en la web', async () => {
    const tel = unTel();
    const existente = await prisma.clienteFinal.create({ data: { empresaId: A.id, telefono: `591${tel}`, nombre: 'Rosa Vega' } });
    const { fecha, hora } = await horaLibre();
    const { cita } = await R.reservar(A, { servicioId: servicio.id, recursoId: 0, personas: 1, fecha, hora, nombre: 'Otro Nombre', codigo: '591', telefono: tel });
    assert.equal((await prisma.clienteFinal.findUnique({ where: { id: existente.id } })).nombre, 'Rosa Vega');
    assert.equal(cita.clienteId, existente.id);
    assert.match((await prisma.cita.findUnique({ where: { id: cita.id } })).notas, /Reservó desde la web como "Otro Nombre"/);
  });
});

describe('confirmación y cancelación con token', () => {
  let ruta; let citaId; let token;
  before(async () => {
    const { fecha, hora } = await horaLibre();
    const r = await pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: { servicio: servicio.id, profesional: 0, personas: 1, fecha, hora, nombre: 'Gloria Mamani', codigo: '591', telefono: unTel() }, ip: '10.0.1.1' });
    ruta = r.loc.split('?')[0];
    citaId = Number(ruta.match(/listo\/(\d+)/)[1]);
    token = decodeURIComponent(r.loc.split('t=')[1]);
  });

  test('sin token, con un token ajeno o adivinando ids no se ve nada', async () => {
    assert.equal((await pedir(ruta)).status, 404);
    assert.equal((await pedir(`${ruta}?t=cualquiera`)).status, 404);
    assert.equal((await pedir(`/reservar/${SLUGS[0]}/listo/${citaId + 1}?t=${token}`)).status, 404, 'el token de una cita no abre otra');
    assert.equal((await pedir(`/reservar/${SLUGS[1]}/listo/${citaId}?t=${token}`)).status, 404, 'ni desde otro negocio');
    const cancelarMal = await pedir(`${ruta}/cancelar`, { metodo: 'POST', cuerpo: { t: 'falso' }, ip: '10.0.2.1' });
    assert.equal(cancelarMal.status, 404);
    assert.equal((await prisma.cita.findUnique({ where: { id: citaId } })).estado, 'CONFIRMADA', 'sigue intacta');
  });

  test('con su token el cliente cancela y el horario se libera; una segunda cancelación avisa que ya no está activa', async () => {
    const ok = await pedir(`${ruta}/cancelar`, { metodo: 'POST', cuerpo: { t: token }, ip: '10.0.3.1' });
    assert.equal(ok.status, 302);
    assert.match(ok.loc, /ok=cancelada/);
    assert.equal((await prisma.cita.findUnique({ where: { id: citaId } })).estado, 'CANCELADA');
    const vista = await pedir(ok.loc);
    assert.match(vista.texto, /Reserva cancelada/);
    assert.doesNotMatch(vista.texto, /Cancelar mi reserva/);
    const otra = await pedir(`${ruta}/cancelar`, { metodo: 'POST', cuerpo: { t: token }, ip: '10.0.3.1' });
    assert.match(decodeURIComponent(otra.loc), /ya no está activa/);
    assert.equal(await prisma.notificacion.count({ where: { empresaId: A.id, titulo: 'Reserva cancelada por el cliente (web)' } }), 1);
  });
});

describe('límites contra abuso', () => {
  test('muchas reservas desde la misma IP en una hora se frenan (429)', async () => {
    const { fecha, hora } = await horaLibre();
    let ultimo = 0;
    for (let i = 0; i < 8; i++) {
      const r = await pedir(`/reservar/${SLUGS[0]}`, { metodo: 'POST', cuerpo: { servicio: servicio.id, profesional: 0, personas: 1, fecha, hora, nombre: '1', codigo: '591', telefono: '1' }, ip: '10.9.9.9' });
      ultimo = r.status;
    }
    assert.equal(ultimo, 429);
  });
});
