// Solo texto: audios, fotos, videos, documentos y stickers no se procesan (costo cero) y el cliente recibe un aviso breve y amable.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const M = require('../lib/services/mediaEntrante');
const mensajesBase = require('../lib/services/mensajesBase');

const SLUG = 'test-media-entrante';
let empresa; let agente; let conexion;
const TEL = '59170007777';

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  empresa = await prisma.empresa.create({ data: { nombre: 'Tienda Media', slug: SLUG, agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
  agente = empresa.agentes[0];
  conexion = { agente: { id: agente.id, empresaId: empresa.id } };
});
after(async () => { await prisma.empresa.delete({ where: { id: empresa.id } }).catch(() => {}); });
beforeEach(() => M.reiniciar());

describe('qué se considera no soportado', () => {
  test('audio, foto, video, documento y sticker sí; texto, ubicación y botones no', () => {
    for (const t of ['audio', 'image', 'video', 'document', 'sticker']) assert.equal(M.tipoNoSoportado({ type: t }), t);
    for (const t of ['text', 'location', 'interactive', 'button', 'contacts', undefined]) assert.equal(M.tipoNoSoportado({ type: t }), null, String(t));
    assert.equal(M.tipoNoSoportado(null), null);
  });
  test('está apagado por defecto y se reactiva con MEDIA_ENTRANTE_ACTIVA=1', () => {
    assert.equal(M.mediaActiva({}), false);
    assert.equal(M.mediaActiva({ MEDIA_ENTRANTE_ACTIVA: '0' }), false);
    assert.equal(M.mediaActiva({ MEDIA_ENTRANTE_ACTIVA: '1' }), true);
  });
  test('el mensaje existe en el catálogo editable del negocio', () => {
    const m = mensajesBase.CATALOGO.find((x) => x.clave === 'media_no_soportada');
    assert.ok(m);
    assert.match(m.texto, /solo puedo leer mensajes de texto/);
  });
});

describe('responder', () => {
  test('responde al cliente con el mensaje del catálogo, sin abrir conversación ni cobrar', async () => {
    const enviados = [];
    const r = await M.responder({ conexion, telefono: TEL, tipo: 'audio' }, { enviar: async (c, para, t) => { enviados.push([para, t]); return { ok: true }; } });
    assert.equal(r.respondido, true);
    assert.equal(r.conversacionId, null);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0][0], TEL);
    assert.match(enviados[0][1], /Por ahora solo puedo leer mensajes de texto/);
    assert.equal(await prisma.conversacion.count({ where: { agenteId: agente.id, telefonoCliente: TEL } }), 0, 'no se abre una conversación (no se cobra)');
  });
  test('con una conversación abierta, el intento queda en el chat del panel y no cobra', async () => {
    const conv = await prisma.conversacion.create({ data: { agenteId: agente.id, telefonoCliente: '59170008888', ultimoMensajeAt: new Date() } });
    const r = await M.responder({ conexion, telefono: '59170008888', tipo: 'image' }, { enviar: async () => ({ ok: true }) });
    assert.equal(r.conversacionId, conv.id);
    const msgs = await prisma.mensaje.findMany({ where: { conversacionId: conv.id }, orderBy: { id: 'asc' } });
    assert.deepEqual(msgs.map((x) => x.rol), ['CLIENTE', 'AGENTE']);
    assert.match(msgs[0].contenido, /envió una foto: por ahora no se procesa/);
    assert.match(msgs[1].contenido, /solo puedo leer mensajes de texto/);
    assert.equal(msgs[0].meta.mediaNoSoportada, 'image');
  });
  test('no responde en bucle: el aviso se repite como mucho cada 10 minutos por cliente', async () => {
    const enviar = async () => ({ ok: true });
    const t0 = Date.now();
    assert.equal((await M.responder({ conexion, telefono: TEL, tipo: 'audio' }, { enviar, ahora: t0 })).respondido, true);
    const otra = await M.responder({ conexion, telefono: TEL, tipo: 'image' }, { enviar, ahora: t0 + 60 * 1000 });
    assert.deepEqual([otra.respondido, otra.motivo], [false, 'YA_AVISADO']);
    assert.equal((await M.responder({ conexion, telefono: TEL, tipo: 'audio' }, { enviar, ahora: t0 + M.AVISO_CADA_MS + 1000 })).respondido, true);
    assert.equal((await M.responder({ conexion, telefono: '59170009999', tipo: 'audio' }, { enviar, ahora: t0 + 1000 })).respondido, true, 'otro cliente sí recibe el aviso');
  });
  test('datos incompletos no rompen', async () => {
    assert.deepEqual(await M.responder({ conexion: null, telefono: TEL, tipo: 'audio' }), { ok: false, respondido: false, motivo: 'SIN_DATOS' });
    assert.equal((await M.responder({ conexion: { agente: { id: 999999999 } }, telefono: TEL, tipo: 'audio' }, { enviar: async () => ({ ok: true }) })).motivo, 'SIN_AGENTE');
  });
  test('nada de esto toca la IA ni descarga archivos (el módulo no los usa)', () => {
    const fuente = require('node:fs').readFileSync(require.resolve('../lib/services/mediaEntrante'), 'utf8');
    assert.doesNotMatch(fuente.replace(/\/\/.*$/gm, ''), /obtenerMedia|transcribirAudio|analizarImagen|usoIA|openai/i);
  });
});
