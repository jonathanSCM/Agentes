// Recordatorios de citas: reglas puras, barrido con un WhatsApp simulado (ventana de 24 h, plantilla, silencio, reintentos,
// sin duplicar), confirmación por botón, aviso de cancelación y los pedidos exactos a la API de Meta.
const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { cifrar } = require('../lib/crypto');
const R = require('../lib/services/recordatorios');
const WA = require('../lib/services/whatsapp');
const Bot = require('../lib/services/botCitas');
const { agendaDe } = require('../lib/services/configAgenda');

const HORA = 3600000;
const SLUGS = ['test-rec-a', 'test-rec-b'];
let A; let servicio; let seq = 0;

// ---------------------------------------------------------------- un WhatsApp simulado
function wafalso({ falla = false } = {}) {
  const enviados = [];
  return {
    enviados,
    enviarBotones: async (con, para, texto, botones) => { if (falla) return { ok: false, error: 'caído' }; enviados.push({ tipo: 'botones', para, texto, botones }); return { ok: true }; },
    enviarTexto: async (con, para, texto) => { if (falla) return { ok: false, error: 'caído' }; enviados.push({ tipo: 'texto', para, texto }); return { ok: true }; },
    enviarPlantilla: async (con, para, datos) => { if (falla) return { ok: false, error: 'caído' }; enviados.push({ tipo: 'plantilla', para, ...datos }); return { ok: true }; },
    crearPlantilla: async (con, def) => ({ ok: true, id: 'tpl1', estado: 'PENDING', def }),
    estadoPlantilla: async () => ({ ok: true, estado: 'APPROVED', motivo: null }),
  };
}

const unTel = () => `59171${String(Date.now()).slice(-5)}${String(seq += 1).padStart(1, '0')}`;
/** Una cita que arranca dentro de `horas`, reservada hace `anticipacionHoras` (para que no sea una reserva de último momento). */
async function cita(horas, { anticipacionHoras = 72, estado = 'CONFIRMADA', nombre = 'Ana Rojas', ventana = true, tel = unTel() } = {}) {
  const cliente = await prisma.clienteFinal.create({ data: { empresaId: A.empresa.id, telefono: tel, nombre } });
  const base = mediodia();
  if (ventana) {
    const conv = await prisma.conversacion.create({ data: { agenteId: A.agente.id, telefonoCliente: tel, ultimoMensajeAt: new Date() } });
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: 'hola', createdAt: new Date(base.getTime() - 2 * HORA) } });
  }
  const inicio = new Date(base.getTime() + horas * HORA);
  return prisma.cita.create({
    data: { empresaId: A.empresa.id, clienteId: cliente.id, servicioId: servicio.id, inicio, fin: new Date(inicio.getTime() + 1800000), estado, createdAt: new Date(inicio.getTime() - anticipacionHoras * HORA) },
  });
}
const rec = async (id) => (await prisma.cita.findUnique({ where: { id } })).recordatorios;
const mediodia = () => { const d = new Date(); d.setUTCHours(16, 0, 0, 0); return d; }; // 12:00 en La Paz (UTC-4): fuera del silencio

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  const e = await prisma.empresa.create({
    data: { nombre: 'Salón Rec', slug: SLUGS[0], modeloNegocio: 'CITAS', rubro: 'salon', zonaHoraria: 'America/La_Paz', configAgenda: { recordatorios: { activo: true, h24: true, h2: true } }, agentes: { create: { nombre: 'Agente', estado: 'ACTIVO' } } },
    include: { agentes: true },
  });
  const agente = e.agentes[0];
  await prisma.conexionWhatsApp.create({ data: { agenteId: agente.id, estado: 'CONECTADO', phoneNumberId: `pn-${Date.now()}`, tokenCifrado: cifrar('t'), wabaId: 'waba-1' } });
  await prisma.agenteConfig.create({ data: { agenteId: agente.id, direccionTienda: 'Av. Arce 100' } });
  servicio = await prisma.servicio.create({ data: { empresaId: e.id, nombre: 'Corte de pelo' } });
  A = { empresa: e, agente };
});
after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

describe('reglas puras', () => {
  const cfg = agendaDe({ configAgenda: { recordatorios: { activo: true, h24: true, h2: true } } });
  const c = (horas, anticipacion = 72, rec = {}) => ({ inicio: new Date(Date.now() + horas * HORA), createdAt: new Date(Date.now() + (horas - anticipacion) * HORA), recordatorios: rec });

  test('de 24 h: cuando falta un día o menos (y más de 4 h); de 2 h: cuando faltan 2 o menos', () => {
    const ahora = new Date();
    assert.equal(R.queToca(c(30), cfg, ahora).enviar, null, 'todavía falta mucho');
    assert.equal(R.queToca(c(23), cfg, ahora).enviar, '24h');
    assert.equal(R.queToca(c(1.5), cfg, ahora).enviar, '2h');
    assert.equal(R.queToca(c(0.1), cfg, ahora).enviar, null, 'faltan minutos: ya no sirve avisar');
    assert.equal(R.queToca(c(3), cfg, ahora).enviar, null, 'entre las dos ventanas no se manda nada');
  });

  test('no se repite lo ya enviado y respeta lo que el negocio apagó', () => {
    const ahora = new Date();
    assert.equal(R.queToca(c(23, 72, { '24h': { estado: 'enviado' } }), cfg, ahora).enviar, null);
    const sin24 = agendaDe({ configAgenda: { recordatorios: { activo: true, h24: false, h2: true } } });
    assert.equal(R.queToca(c(23), sin24, ahora).enviar, null);
    assert.equal(R.queToca(c(1.5), sin24, ahora).enviar, '2h');
  });

  test('una reserva de último momento no recibe un recordatorio inútil', () => {
    const ahora = new Date();
    assert.equal(R.queToca(c(20, 5), cfg, ahora).enviar, null, 'reservó hace 5 h para dentro de 20: el de 24 h no tiene sentido');
    assert.equal(R.queToca(c(1.5, 2), cfg, ahora).enviar, null, 'reservó hace 2 h para dentro de 1,5: tampoco el de 2 h');
    assert.equal(R.queToca(c(1.5, 10), cfg, ahora).enviar, '2h');
  });

  test('si se juntan los dos (el sistema estuvo caído), se manda solo el más cercano y el otro queda superado', () => {
    const r = R.queToca(c(1.5), cfg, new Date());
    assert.equal(r.enviar, '2h');
    assert.deepEqual(r.superados, ['24h']);
  });

  test('horas de silencio: de 21:00 a 08:00 en la zona del negocio', () => {
    const utc = (h) => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return d; };
    assert.equal(R.enSilencio(utc(1), 'America/La_Paz'), true, '21:00 en La Paz');
    assert.equal(R.enSilencio(utc(11), 'America/La_Paz'), true, '07:00');
    assert.equal(R.enSilencio(utc(12), 'America/La_Paz'), false, '08:00');
    assert.equal(R.enSilencio(utc(16), 'America/La_Paz'), false, '12:00');
    assert.equal(R.enSilencio(utc(0), 'America/La_Paz'), false, '20:00: todavía se puede');
  });

  test('por defecto los recordatorios están apagados', () => {
    assert.equal(agendaDe({}).recordatorios.activo, false);
    assert.equal(agendaDe({ configAgenda: { recordatorios: { activo: true } } }).recordatorios.h24, true);
  });

  test('la plantilla para Meta: categoría UTILITY, 4 variables con ejemplo y 3 botones de respuesta rápida', () => {
    const d = R.definicionPlantilla();
    assert.equal(d.category, 'UTILITY');
    assert.equal(d.language, 'es');
    const cuerpo = d.components.find((x) => x.type === 'BODY');
    assert.match(cuerpo.text, /\{\{1\}\}.*\{\{4\}\}/);
    assert.equal(cuerpo.example.body_text[0].length, 4);
    assert.deepEqual(d.components.find((x) => x.type === 'BUTTONS').buttons.map((b) => b.text), ['Confirmo', 'Cambiar horario', 'Cancelar']);
  });
});

describe('el barrido', () => {
  test('dentro de las 24 h: texto con botones, queda en el historial del chat y no se repite', async () => {
    const c = await cita(23);
    const wa = wafalso();
    const r = await R.procesar({ ahora: mediodia(), deps: { wa } });
    assert.equal(r.enviadas >= 1, true);
    const telCliente = (await prisma.clienteFinal.findUnique({ where: { id: c.clienteId } })).telefono;
    const envio = wa.enviados.find((e) => e.para === telCliente);
    assert.equal(envio.tipo, 'botones');
    assert.match(envio.texto, /Hola Ana 👋 Te recordamos tu turno de Corte de pelo/);
    assert.deepEqual(envio.botones.map((b) => b.titulo), ['Confirmo', 'Cambiar horario', 'Cancelar']);
    assert.deepEqual(envio.botones.map((b) => b.id), [`ct:rok:0:0:1:0:${c.id}:`, `ct:rep:0:0:1:0:${c.id}:`, `ct:can:0:0:1:0:${c.id}:`]);
    assert.equal((await rec(c.id))['24h'].estado, 'enviado');
    assert.equal((await rec(c.id))['24h'].via, 'ventana');
    const guardado = await prisma.mensaje.findFirst({ where: { conversacion: { telefonoCliente: (await prisma.clienteFinal.findUnique({ where: { id: c.clienteId } })).telefono }, rol: 'AGENTE' } });
    assert.match(guardado.contenido, /• Confirmo/, 'el panel ve lo que se mandó');
    const antes = wa.enviados.length;
    await R.procesar({ ahora: mediodia(), deps: { wa } });
    assert.equal(wa.enviados.length, antes, 'segunda pasada: no se manda de nuevo');
  });

  test('el de 2 h dice la hora y la dirección', async () => {
    const c = await cita(1.5);
    const wa = wafalso();
    await R.procesar({ ahora: mediodia(), deps: { wa } });
    const tel = (await prisma.clienteFinal.findUnique({ where: { id: c.clienteId } })).telefono;
    const envio = wa.enviados.find((e) => e.para === tel);
    assert.match(envio.texto, /es hoy a las \d{2}:\d{2}\. ¡Te esperamos! 📍 Av\. Arce 100/);
    assert.equal((await rec(c.id))['2h'].estado, 'enviado');
  });

  test('fuera de las 24 h y sin plantilla aprobada: no se manda nada y queda anotado', async () => {
    const c = await cita(23, { ventana: false });
    const wa = wafalso();
    await R.procesar({ ahora: mediodia(), deps: { wa } });
    const tel = (await prisma.clienteFinal.findUnique({ where: { id: c.clienteId } })).telefono;
    assert.equal(wa.enviados.some((e) => e.para === tel), false);
    assert.deepEqual([(await rec(c.id))['24h'].estado, (await rec(c.id))['24h'].motivo], ['omitido', 'sin_plantilla']);
  });

  test('fuera de las 24 h con plantilla aprobada: se manda la plantilla con sus variables y los payloads de los botones', async () => {
    await prisma.empresa.update({ where: { id: A.empresa.id }, data: { configAgenda: { recordatorios: { activo: true, h24: true, h2: true }, plantilla: { nombre: 'recordatorio_cita', estado: 'APPROVED' } } } });
    try {
      const c = await cita(23, { ventana: false, nombre: 'Beatriz Quispe' });
      const wa = wafalso();
      await R.procesar({ ahora: mediodia(), deps: { wa } });
      const tel = (await prisma.clienteFinal.findUnique({ where: { id: c.clienteId } })).telefono;
      const envio = wa.enviados.find((e) => e.para === tel);
      assert.equal(envio.tipo, 'plantilla');
      assert.equal(envio.nombre, 'recordatorio_cita');
      assert.deepEqual(envio.variables.slice(0, 3), ['Beatriz', 'turno', 'Corte de pelo']);
      assert.match(envio.variables[3], /\d{2}:\d{2}/);
      assert.deepEqual(envio.botones, [`ct:rok:0:0:1:0:${c.id}:`, `ct:rep:0:0:1:0:${c.id}:`, `ct:can:0:0:1:0:${c.id}:`]);
      assert.equal((await rec(c.id))['24h'].via, 'plantilla');
    } finally {
      await prisma.empresa.update({ where: { id: A.empresa.id }, data: { configAgenda: { recordatorios: { activo: true, h24: true, h2: true } } } });
    }
  });

  test('de noche no se manda; con el negocio apagado tampoco', async () => {
    const c = await cita(23);
    const wa = wafalso();
    const noche = new Date(mediodia().getTime() + 10 * HORA); // 22:00 en La Paz del mismo dia
    await R.procesar({ ahora: noche, deps: { wa } });
    assert.equal(wa.enviados.length, 0);
    assert.deepEqual(await rec(c.id), {}, 'no se reclamó: se manda al abrir el horario');
    await prisma.empresa.update({ where: { id: A.empresa.id }, data: { configAgenda: { recordatorios: { activo: false } } } });
    try {
      await R.procesar({ ahora: mediodia(), deps: { wa } });
      assert.equal(wa.enviados.length, 0, 'apagado: no sale ningún mensaje');
    } finally { await prisma.empresa.update({ where: { id: A.empresa.id }, data: { configAgenda: { recordatorios: { activo: true, h24: true, h2: true } } } }); }
  });

  test('citas canceladas o reservadas de último momento no reciben recordatorio', async () => {
    const cancelada = await cita(23, { estado: 'CANCELADA' });
    const apurada = await cita(20, { anticipacionHoras: 4 });
    const wa = wafalso();
    await R.procesar({ ahora: mediodia(), deps: { wa } });
    for (const x of [cancelada, apurada]) assert.deepEqual(await rec(x.id), {});
  });

  test('si WhatsApp falla se reintenta; al tercer fallo queda como fallido y no insiste más', async () => {
    const c = await cita(23);
    const wa = wafalso({ falla: true });
    for (let i = 0; i < 4; i++) await R.procesar({ ahora: mediodia(), deps: { wa } });
    const r = await rec(c.id);
    assert.equal(r['24h'].estado, 'fallo');
    assert.equal(r['24h'].motivo, 'caído');
  });

  test('dos barridos a la vez no mandan dos veces (reclamo atómico)', async () => {
    const c = await cita(23);
    const wa = wafalso();
    const tel = (await prisma.clienteFinal.findUnique({ where: { id: c.clienteId } })).telefono;
    const [x, y] = await Promise.all([R.procesar({ ahora: mediodia(), deps: { wa } }), R.procesar({ ahora: mediodia(), deps: { wa } })]);
    assert.ok(x.ocupado || y.ocupado, 'el segundo barrido espera su turno');
    assert.equal(wa.enviados.filter((e) => e.para === tel).length, 1);
  });

  test('un barrido ya reclamado por otro proceso no se vuelve a mandar', async () => {
    const c = await cita(23);
    assert.equal(await R.reclamar(c.id, '24h', new Date()), true);
    assert.equal(await R.reclamar(c.id, '24h', new Date()), false);
  });
});

describe('el cliente responde', () => {
  test('"Confirmo" anota la asistencia (y una cita por confirmar pasa a confirmada); la cita de otra persona no se toca', async () => {
    const mia = await cita(23, { estado: 'PENDIENTE', nombre: 'Gloria Mamani' });
    const ajena = await cita(23, { nombre: 'Otra Persona' });
    const tel = (await prisma.clienteFinal.findUnique({ where: { id: mia.clienteId } })).telefono;
    const responder = (texto, idBoton) => Bot.responderCitas({ empresa: A.empresa, config: null, telefonoCliente: tel, texto, idBoton });
    const ok = await responder('Confirmo', `ct:rok:0:0:1:0:${mia.id}:`);
    assert.match(ok.respuesta, /¡Gracias Gloria! Quedó confirmada tu asistencia ✅/);
    const despues = await prisma.cita.findUnique({ where: { id: mia.id } });
    assert.equal(despues.estado, 'CONFIRMADA');
    assert.ok(despues.recordatorios.confirmada);
    const intruso = await responder('Confirmo', `ct:rok:0:0:1:0:${ajena.id}:`);
    assert.match(intruso.respuesta, /ya no está disponible/);
    assert.equal((await rec(ajena.id)).confirmada, undefined, 'la cita ajena no cambió');
  });

  test('el toque de un botón de plantilla llega como un toque normal', async () => {
    const c = await cita(23);
    const tel = (await prisma.clienteFinal.findUnique({ where: { id: c.clienteId } })).telefono;
    const s = await Bot.responderCitas({ empresa: A.empresa, config: null, telefonoCliente: tel, texto: 'Cancelar', idBoton: `ct:can:0:0:1:0:${c.id}:` });
    assert.match(s.respuesta, /cancelar tu turno/);
  });
});

describe('cuando el negocio cancela', () => {
  test('dentro de las 24 h se le avisa al cliente; fuera de ellas no se puede y se informa', async () => {
    const dentro = await cita(48);
    const fuera = await cita(48, { ventana: false });
    const wa = wafalso();
    const a1 = await R.avisarCancelacion(A.empresa, dentro, { deps: { wa } });
    assert.equal(a1.avisado, true);
    assert.match(wa.enviados[0].texto, /tuvimos que cancelar tu turno del/);
    assert.equal(wa.enviados[0].botones[0].id, 'ct:agendar:0:0:1:0::');
    const a2 = await R.avisarCancelacion(A.empresa, fuera, { deps: { wa } });
    assert.equal(a2.avisado, false);
    assert.equal(wa.enviados.length, 1, 'fuera de la ventana no se manda texto libre');
  });
});

describe('plantilla en Meta', () => {
  test('crearla guarda su estado pendiente y consultarla lo actualiza', async () => {
    const wa = wafalso();
    const c = await R.crearPlantillaEnMeta(A.empresa, { deps: { wa } });
    assert.equal(c.ok, true);
    assert.equal(c.plantilla.estado, 'PENDING');
    const e = await R.actualizarEstadoPlantilla(A.empresa, { deps: { wa } });
    assert.equal(e.plantilla.estado, 'APPROVED');
    assert.equal((await prisma.empresa.findUnique({ where: { id: A.empresa.id } })).configAgenda.plantilla.estado, 'APPROVED');
    assert.equal(agendaDe(await prisma.empresa.findUnique({ where: { id: A.empresa.id } })).recordatorios.activo, true, 'no pisa los demás ajustes');
  });
});

describe('pedidos exactos a la API de Meta', () => {
  const conexion = () => ({ phoneNumberId: '555', wabaId: 'W1', tokenCifrado: cifrar('tok') });

  test('enviarPlantilla arma cuerpo y botones con sus payloads y limpia las variables', async () => {
    let cuerpo; let url;
    global.fetch = mock.fn(async (u, o) => { url = u; cuerpo = JSON.parse(o.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; });
    const r = await WA.enviarPlantilla(conexion(), '+591 7123-4567', { nombre: 'recordatorio_cita', variables: ['Ana\nPérez', 'turno', 'Corte', 'jueves,   10:30'], botones: ['ct:rok:1', 'ct:rep:1', 'ct:can:1'] });
    assert.equal(r.ok, true);
    assert.match(url, /\/555\/messages$/);
    assert.equal(cuerpo.to, '59171234567');
    assert.equal(cuerpo.type, 'template');
    assert.deepEqual(cuerpo.template.language, { code: 'es' });
    assert.deepEqual(cuerpo.template.components[0].parameters.map((p) => p.text), ['Ana Pérez', 'turno', 'Corte', 'jueves,   10:30']);
    assert.deepEqual(cuerpo.template.components.slice(1).map((c) => [c.sub_type, c.index, c.parameters[0].payload]), [['quick_reply', '0', 'ct:rok:1'], ['quick_reply', '1', 'ct:rep:1'], ['quick_reply', '2', 'ct:can:1']]);
  });

  test('crearPlantilla y estadoPlantilla usan el WABA, y un error de la API no revienta', async () => {
    let url; let cuerpo;
    global.fetch = mock.fn(async (u, o) => { url = u; cuerpo = o && o.body ? JSON.parse(o.body) : null; return { ok: true, json: async () => (o && o.method === 'POST' ? { id: 'T1', status: 'PENDING' } : { data: [{ name: 'recordatorio_cita', status: 'REJECTED', rejected_reason: 'INCORRECT_CATEGORY' }] }) }; });
    const c = await WA.crearPlantilla(conexion(), R.definicionPlantilla());
    assert.equal(c.ok, true);
    assert.match(url, /\/W1\/message_templates$/);
    assert.equal(cuerpo.name, 'recordatorio_cita');
    const e = await WA.estadoPlantilla(conexion(), 'recordatorio_cita');
    assert.deepEqual([e.estado, e.motivo], ['REJECTED', 'INCORRECT_CATEGORY']);
    global.fetch = mock.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Parámetro inválido' } }) }));
    assert.deepEqual(await WA.crearPlantilla(conexion(), R.definicionPlantilla()), { ok: false, error: 'Parámetro inválido' });
    assert.match((await WA.crearPlantilla({ phoneNumberId: '1', tokenCifrado: cifrar('x') }, {})).error, /WABA/);
  });
});
