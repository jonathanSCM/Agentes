// Conexión por coexistence: configuración, firma del webhook, canje de código, elección del número, sincronización,
// orquestación completa (con Meta simulada) y ecos de la app del celular.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { prisma } = require('../lib/db');
const M = require('../lib/services/metaCoexistence');
const cripto = require('../lib/crypto');

const ENV = { META_APP_ID: '1111', META_APP_SECRET: 'secreto-de-la-app', META_EMBEDDED_SIGNUP_CONFIG_ID: '2222' };

/** Meta simulada: responde por ruta y guarda las llamadas. */
function metaFalsa(rutas) {
  const llamadas = [];
  const http = async (url, opts = {}) => {
    llamadas.push({ url, metodo: opts.method || 'GET', cuerpo: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers && opts.headers.Authorization });
    const clave = Object.keys(rutas).find((k) => url.includes(k));
    const r = clave ? rutas[clave] : { status: 404, body: { error: { message: 'ruta no simulada' } } };
    return { ok: !r.status || r.status < 400, status: r.status || 200, json: async () => r.body };
  };
  return { http, llamadas };
}

describe('configuración', () => {
  test('lista solo si están las tres variables; dice cuáles faltan; nunca expone el secreto', () => {
    assert.deepEqual(M.configuracion({}).faltan, ['META_APP_ID', 'META_APP_SECRET', 'META_EMBEDDED_SIGNUP_CONFIG_ID']);
    assert.equal(M.configuracion({ META_APP_ID: '1' }).listo, false);
    assert.equal(M.configuracion(ENV).listo, true);
    assert.equal(M.parametrosParaNavegador({}), null);
    const p = M.parametrosParaNavegador(ENV);
    assert.equal(p.appId, '1111');
    assert.equal(p.login.extras.featureType, 'whatsapp_business_app_onboarding');
    assert.equal(p.login.response_type, 'code');
    assert.equal(JSON.stringify(p).includes('secreto-de-la-app'), false);
  });
});

describe('firma del webhook', () => {
  const cuerpo = Buffer.from('{"entry":[]}');
  const firma = (c, s) => `sha256=${crypto.createHmac('sha256', s).update(c).digest('hex')}`;
  test('acepta la firma correcta y rechaza una alterada o ausente', () => {
    assert.deepEqual(M.verificarFirma(cuerpo, firma(cuerpo, 's1'), 's1'), { ok: true, verificada: true });
    assert.equal(M.verificarFirma(cuerpo, firma(cuerpo, 'otro'), 's1').ok, false);
    assert.equal(M.verificarFirma(Buffer.from('{"entry":[1]}'), firma(cuerpo, 's1'), 's1').ok, false);
    assert.equal(M.verificarFirma(cuerpo, '', 's1').ok, false);
    assert.equal(M.verificarFirma(cuerpo, 'sha256=abc', 's1').ok, false);
    assert.equal(M.verificarFirma(null, firma(cuerpo, 's1'), 's1').ok, false);
  });
  test('sin secreto cargado no se puede verificar (pasa, marcado como no verificada)', () => {
    assert.deepEqual(M.verificarFirma(cuerpo, '', ''), { ok: true, verificada: false });
  });
});

describe('llamadas a Meta', () => {
  test('canjea el código por el token con el ID y el secreto de la app', async () => {
    const { http, llamadas } = metaFalsa({ '/oauth/access_token': { body: { access_token: 'TOKEN-NEGOCIO' } } });
    assert.equal(await M.canjearCodigo('CODIGO', { http, env: ENV }), 'TOKEN-NEGOCIO');
    assert.match(llamadas[0].url, /client_id=1111/);
    assert.match(llamadas[0].url, /client_secret=secreto-de-la-app/);
    assert.match(llamadas[0].url, /code=CODIGO/);
  });
  test('sin configuración, sin código o con error de Meta: avisa claro', async () => {
    await assert.rejects(M.canjearCodigo('X', { http: async () => {}, env: {} }), /Falta configurar Meta/);
    await assert.rejects(M.canjearCodigo('', { http: async () => {}, env: ENV }), /código de autorización/);
    const { http } = metaFalsa({ '/oauth/access_token': { status: 400, body: { error: { message: 'Code was already used', code: 100 } } } });
    await assert.rejects(M.canjearCodigo('X', { http, env: ENV }), /Code was already used/);
    await assert.rejects(M.canjearCodigo('X', { http: async () => { throw new Error('sin red'); }, env: ENV }), /No se pudo comunicar con Meta: sin red/);
  });
  test('elige el número: el indicado, el único, o por el número que dijo el cliente', () => {
    const dos = [{ id: '10', numero: '+591 70000001', nombre: 'A' }, { id: '20', numero: '+591 70000002', nombre: 'B' }];
    assert.equal(M.elegirNumero(dos, { phoneNumberId: '20' }).id, '20');
    assert.equal(M.elegirNumero([dos[0]]).id, '10');
    assert.equal(M.elegirNumero(dos, { numeroVisible: '70000002' }).id, '20');
    assert.throws(() => M.elegirNumero(dos), /varios números/);
    assert.throws(() => M.elegirNumero([]), /no tiene números/);
    assert.throws(() => M.elegirNumero(dos, { phoneNumberId: '99' }), /no pertenece/);
  });
  test('pide la sincronización de contactos e historial; si una falla, no rompe y lo cuenta', async () => {
    const ok = metaFalsa({ '/smb_app_data': { body: { success: true } } });
    const r = await M.pedirSincronizacion('10', 'T', { http: ok.http });
    assert.deepEqual([r.contactos, r.historial, r.error], ['solicitado', 'solicitado', null]);
    assert.deepEqual(ok.llamadas.map((l) => l.cuerpo.sync_type), ['smb_app_state_sync', 'history']);
    assert.ok(ok.llamadas.every((l) => l.auth === 'Bearer T' && l.cuerpo.messaging_product === 'whatsapp'));
    let n = 0;
    const mixto = async () => { n += 1; return n === 2 ? { ok: false, status: 400, json: async () => ({ error: { message: 'History sync is turned off' } }) } : { ok: true, status: 200, json: async () => ({}) }; };
    const r2 = await M.pedirSincronizacion('10', 'T', { http: mixto });
    assert.deepEqual([r2.contactos, r2.historial], ['solicitado', 'error']);
    assert.match(r2.error, /History sync is turned off/);
  });
});

const SLUGS = ['test-coex-a', 'test-coex-b'];
let A; let B; let agA; let agB;
const rutasOk = (numeros) => ({
  '/oauth/access_token': { body: { access_token: 'TOKEN-1' } },
  '/subscribed_apps': { body: { success: true } },
  '/phone_numbers': { body: { data: numeros } },
  '/smb_app_data': { body: { success: true } },
});

// Las empresas de prueba viven todo el archivo (los dos bloques de abajo las comparten).
before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  A = await prisma.empresa.create({ data: { nombre: 'Coex A', slug: SLUGS[0], agentes: { create: { nombre: 'Agente A' } } }, include: { agentes: true } });
  B = await prisma.empresa.create({ data: { nombre: 'Coex B', slug: SLUGS[1], agentes: { create: { nombre: 'Agente B' } } }, include: { agentes: true } });
  agA = A.agentes[0]; agB = B.agentes[0];
});
after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });

describe('conectar un agente', () => {

  test('flujo completo: canjea, suscribe, elige el número, pide la sincronización y guarda el token CIFRADO', async () => {
    const meta = metaFalsa(rutasOk([{ id: '9001', display_phone_number: '+591 70011122', verified_name: 'Mi negocio' }]));
    const r = await M.conectar(agA.id, { code: 'C1', wabaId: '123456789' }, { http: meta.http, env: ENV });
    assert.equal(r.conexion.estado, 'CONECTADO');
    assert.equal(r.conexion.modo, 'COEXISTENCE');
    assert.equal(r.conexion.phoneNumberId, '9001');
    assert.equal(r.conexion.wabaId, '123456789');
    assert.equal(r.conexion.numeroVisible, '+591 70011122');
    assert.notEqual(r.conexion.tokenCifrado, 'TOKEN-1');
    assert.equal(cripto.descifrar(r.conexion.tokenCifrado), 'TOKEN-1');
    assert.equal(r.sincronizacion.contactos, 'solicitado');
    assert.ok(r.conexion.conectadoAt);
    assert.deepEqual(meta.llamadas.filter((l) => l.metodo === 'POST').map((l) => l.url.split('/').slice(-1)[0].split('?')[0]), ['subscribed_apps', 'smb_app_data', 'smb_app_data']);
  });
  test('repetirla con el mismo número no vuelve a pedir la sincronización (solo se puede una vez)', async () => {
    const meta = metaFalsa(rutasOk([{ id: '9001', display_phone_number: '+591 70011122' }]));
    const r = await M.conectar(agA.id, { code: 'C2', wabaId: '123456789' }, { http: meta.http, env: ENV });
    assert.equal(meta.llamadas.some((l) => l.url.includes('smb_app_data')), false);
    assert.equal(r.sincronizacion.contactos, 'solicitado', 'conserva lo ya pedido');
    assert.equal(await prisma.conexionWhatsApp.count({ where: { agenteId: agA.id } }), 1);
  });
  test('un número ya conectado a otra cuenta de Proshop se rechaza', async () => {
    const meta = metaFalsa(rutasOk([{ id: '9001', display_phone_number: '+591 70011122' }]));
    await assert.rejects(M.conectar(agB.id, { code: 'C3', wabaId: '123456789' }, { http: meta.http, env: ENV }), /ya está conectado a otra cuenta/);
    assert.equal(await prisma.conexionWhatsApp.count({ where: { agenteId: agB.id } }), 0);
  });
  test('datos inválidos o Meta caída: error claro y no se guarda nada', async () => {
    const meta = metaFalsa(rutasOk([{ id: '9500', display_phone_number: '+591 1' }]));
    await assert.rejects(M.conectar(agB.id, { code: 'C', wabaId: 'no-es-un-id' }, { http: meta.http, env: ENV }), /cuenta de WhatsApp Business/);
    await assert.rejects(M.conectar(agB.id, { code: 'C', wabaId: '123456789' }, { http: metaFalsa({}).http, env: ENV }), /ruta no simulada/);
    await assert.rejects(M.conectar(agB.id, { code: 'C', wabaId: '123456789', phoneNumberId: '777' }, { http: meta.http, env: ENV }), /no pertenece/);
    assert.equal(await prisma.conexionWhatsApp.count({ where: { agenteId: agB.id } }), 0);
  });
});

describe('ecos: lo que el dueño escribe desde la app del celular', () => {
  let conv;
  before(async () => {
    conv = await prisma.conversacion.create({ data: { agenteId: agA.id, telefonoCliente: '59170005555', modo: 'IA' } });
  });

  test('se leen los ecos de texto y de otros tipos; sin destino o sin id se descartan', () => {
    const ecos = M.leerEcos({ message_echoes: [
      { id: 'w1', to: '+591 70005555', type: 'text', text: { body: 'Hola, ya te lo envío' }, timestamp: '1760000000' },
      { id: 'w2', to: '59170005555', type: 'image' },
      { id: 'w3', type: 'text', text: { body: 'sin destino' } },
      { to: '59170005555', type: 'text', text: { body: 'sin id' } },
    ] });
    assert.equal(ecos.length, 2);
    assert.equal(ecos[0].para, '59170005555');
    assert.equal(ecos[0].texto, 'Hola, ya te lo envío');
    assert.match(ecos[1].texto, /Foto · enviado desde la app/);
  });
  test('se guardan como mensaje del equipo, el chat pasa a manos de una persona y los reenvíos no duplican', async () => {
    const vistos = new Set();
    const emitidos = [];
    const opciones = { yaVisto: (id) => { const v = vistos.has(id); vistos.add(id); return v; }, emitir: (c, p) => emitidos.push(p) };
    const ecos = M.leerEcos({ message_echoes: [{ id: 'wamid.A', to: '59170005555', type: 'text', text: { body: 'Te espero mañana' } }] });
    assert.equal(await M.registrarEcos(agA, ecos, opciones), 1);
    assert.equal(await M.registrarEcos(agA, ecos, opciones), 0, 'el mismo id no se repite');
    const msgs = await prisma.mensaje.findMany({ where: { conversacionId: conv.id } });
    assert.equal(msgs.length, 1);
    assert.deepEqual([msgs[0].rol, msgs[0].contenido, msgs[0].meta.desdeApp], ['AGENTE', 'Te espero mañana', true]);
    assert.equal((await prisma.conversacion.findUnique({ where: { id: conv.id } })).modo, 'HUMANO');
    assert.equal(emitidos[0].usuarioNombre, 'App de WhatsApp');
  });
  test('un eco igual a lo que el agente acaba de mandar por la API no se duplica ni cambia el chat', async () => {
    const c2 = await prisma.conversacion.create({ data: { agenteId: agA.id, telefonoCliente: '59170006666', modo: 'IA' } });
    await prisma.mensaje.create({ data: { conversacionId: c2.id, rol: 'AGENTE', contenido: 'Tu pedido está listo' } });
    const ecos = M.leerEcos({ message_echoes: [{ id: 'wamid.B', to: '59170006666', type: 'text', text: { body: 'Tu pedido está listo' } }] });
    assert.equal(await M.registrarEcos(agA, ecos), 0);
    assert.equal((await prisma.conversacion.findUnique({ where: { id: c2.id } })).modo, 'IA');
  });
  test('un eco de un chat que no existe en Proshop no inventa conversaciones', async () => {
    const ecos = M.leerEcos({ message_echoes: [{ id: 'wamid.C', to: '59179999999', type: 'text', text: { body: 'hola' } }] });
    assert.equal(await M.registrarEcos(agA, ecos), 0);
    assert.equal(await prisma.conversacion.count({ where: { agenteId: agA.id, telefonoCliente: '59179999999' } }), 0);
  });
});
