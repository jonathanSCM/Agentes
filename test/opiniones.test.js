// Pedir comentarios: reglas puras (1.ª, 2.ª y 3.ª vez, separación), programación al entregar/completar, envío con un WhatsApp simulado
// (ventana de 24 h, silencio, sin duplicar, apagado por defecto) y el resumen del panel.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../lib/db');
const { cifrar } = require('../lib/crypto');
const O = require('../lib/services/opiniones');
const citasPanel = require('../lib/services/citasPanel');

const HORA = 3600000; const DIA = 24 * HORA;
const SLUG = 'test-opiniones';
let E; let agente; let servicio; let seq = 0;
const mediodia = () => { const d = new Date(); d.setUTCHours(16, 0, 0, 0); return d; }; // 12:00 en La Paz
const AHORA = mediodia();

function wafalso({ falla = false } = {}) {
  const enviados = [];
  return { enviados, enviarTexto: async (con, para, texto) => { if (falla) return { ok: false, error: 'caído' }; enviados.push({ para, texto }); return { ok: true }; } };
}
async function cliente({ ventana = true } = {}) {
  const tel = `59172${String(Date.now()).slice(-6)}${seq += 1}`;
  const c = await prisma.clienteFinal.create({ data: { empresaId: E.id, telefono: tel, nombre: 'Ana Rojas' } });
  if (ventana) {
    // El mensaje del cliente es de "hace una hora" respecto del reloj real, para estar dentro de las 24 h en cualquier momento del día.
    const conv = await prisma.conversacion.create({ data: { agenteId: agente.id, telefonoCliente: tel, ultimoMensajeAt: new Date() } });
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: 'hola', createdAt: new Date(AHORA.getTime() - HORA) } });
  }
  return c;
}
const pedidoEntregado = (c) => prisma.pedido.create({ data: { empresaId: E.id, clienteId: c.id, estado: 'ENTREGADO', total: 50, direccionEntrega: 'x' } });
const citaDe = (c, estado = 'COMPLETADA') => prisma.cita.create({ data: { empresaId: E.id, clienteId: c.id, servicioId: servicio.id, inicio: new Date(AHORA.getTime() - 3 * HORA), fin: new Date(AHORA.getTime() - 2 * HORA), estado } });
const activar = (v) => prisma.empresa.update({ where: { id: E.id }, data: { pedirOpiniones: v } });
const delCliente = (c) => prisma.solicitudOpinion.findFirst({ where: { clienteId: c.id } });
const enviadosA = (wa, c) => wa.enviados.filter((e) => e.para === c.telefono);

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  E = await prisma.empresa.create({ data: { nombre: 'Salón Opiniones', slug: SLUG, modeloNegocio: 'CITAS', rubro: 'salon', zonaHoraria: 'America/La_Paz', agentes: { create: { nombre: 'Agente', estado: 'ACTIVO' } } }, include: { agentes: true } });
  agente = E.agentes[0];
  await prisma.conexionWhatsApp.create({ data: { agenteId: agente.id, estado: 'CONECTADO', phoneNumberId: `pn-${Date.now()}`, tokenCifrado: cifrar('t'), wabaId: 'waba-1' } });
  await prisma.agenteConfig.create({ data: { agenteId: agente.id } });
  servicio = await prisma.servicio.create({ data: { empresaId: E.id, nombre: 'Corte de pelo' } });
});
after(async () => { await prisma.empresa.deleteMany({ where: { slug: SLUG } }); });

describe('reglas puras', () => {
  test('se pide en la 1.ª, 2.ª y 3.ª vez; a la 4.ª ya no', () => {
    for (const n of [1, 2, 3]) assert.equal(O.correspondePedir({ numero: n, ahora: AHORA }).pedir, true);
    assert.deepEqual(O.correspondePedir({ numero: 4, ahora: AHORA }), { pedir: false, motivo: 'YA_NO_SE_PIDE' });
  });
  test('no se pide dos veces en menos de una semana', () => {
    assert.equal(O.correspondePedir({ numero: 2, ultimaSolicitudAt: new Date(AHORA.getTime() - 3 * DIA), ahora: AHORA }).pedir, false);
    assert.equal(O.correspondePedir({ numero: 2, ultimaSolicitudAt: new Date(AHORA.getTime() - 8 * DIA), ahora: AHORA }).pedir, true);
  });
});

describe('programar', () => {
  test('apagado por defecto: no programa nada', async () => {
    const c = await cliente(); const p = await pedidoEntregado(c);
    assert.deepEqual(await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA }), { programada: false, motivo: 'APAGADO' });
    assert.equal(await prisma.solicitudOpinion.count({ where: { clienteId: c.id } }), 0);
  });
  test('activado: programa una hora después y no duplica', async () => {
    await activar(true);
    const c = await cliente(); const p = await pedidoEntregado(c);
    assert.equal((await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA })).programada, true);
    const s = await delCliente(c);
    assert.equal(s.programadaPara.getTime(), AHORA.getTime() + HORA); assert.equal(s.numeroServicio, 1);
    assert.equal((await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA })).programada, false);
  });
  test('al completar una cita desde el panel se programa el pedido', async () => {
    await activar(true);
    const c = await cliente(); const ct = await citaDe(c, 'CONFIRMADA');
    await citasPanel.cambiarEstado(E, ct.id, 'COMPLETADA');
    await new Promise((r) => setTimeout(r, 500));
    const s = await prisma.solicitudOpinion.findFirst({ where: { clienteId: c.id, tipo: 'CITA' } });
    assert.ok(s && s.estado === 'PROGRAMADA');
  });
  test('un cliente con 4 servicios ya no recibe el pedido', async () => {
    await activar(true);
    const c = await cliente();
    for (let i = 0; i < 3; i += 1) await pedidoEntregado(c);
    const ultimo = await citaDe(c);
    assert.deepEqual(await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'CITA', refId: ultimo.id, ahora: AHORA }), { programada: false, motivo: 'YA_NO_SE_PIDE' });
  });
  test('la segunda vez usa el texto de cliente recurrente', async () => {
    await activar(true);
    const c = await cliente(); await pedidoEntregado(c); const p2 = await pedidoEntregado(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p2.id, ahora: AHORA });
    const wa = wafalso();
    await O.procesar({ ahora: new Date(AHORA.getTime() + 2 * HORA), deps: { wa } });
    const m = enviadosA(wa, c)[0];
    assert.ok(m && /segunda vez/.test(m.texto), m && m.texto);
  });
});

describe('envío', () => {
  test('manda el texto y lo deja como enviado; no se manda dos veces', async () => {
    await activar(true);
    const c = await cliente(); const ct = await citaDe(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'CITA', refId: ct.id, ahora: AHORA });
    const wa = wafalso(); const luego = new Date(AHORA.getTime() + 2 * HORA);
    await O.procesar({ ahora: luego, deps: { wa } });
    assert.equal(enviadosA(wa, c).length, 1); assert.match(enviadosA(wa, c)[0].texto, /Corte de pelo/);
    assert.equal((await delCliente(c)).estado, 'ENVIADA');
    await O.procesar({ ahora: luego, deps: { wa } });
    assert.equal(enviadosA(wa, c).length, 1);
  });
  test('todavía no es la hora: no manda', async () => {
    await activar(true);
    const c = await cliente(); const p = await pedidoEntregado(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA });
    const wa = wafalso(); await O.procesar({ ahora: new Date(AHORA.getTime() + 30 * 60000), deps: { wa } });
    assert.equal(enviadosA(wa, c).length, 0);
  });
  test('de noche no manda; sigue programada', async () => {
    await activar(true);
    const c = await cliente(); const p = await pedidoEntregado(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA });
    const noche = new Date(AHORA.getTime() + 10 * HORA); // 02:00 UTC = 22:00 en La Paz
    const wa = wafalso(); await O.procesar({ ahora: noche, deps: { wa } });
    assert.equal(enviadosA(wa, c).length, 0);
    assert.equal((await delCliente(c)).estado, 'PROGRAMADA');
  });
  test('si el cliente no escribió en 24 h queda omitida y se explica', async () => {
    await activar(true);
    const c = await cliente({ ventana: false }); const p = await pedidoEntregado(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA });
    const wa = wafalso(); await O.procesar({ ahora: new Date(AHORA.getTime() + 2 * HORA), deps: { wa } });
    const s = await delCliente(c);
    assert.equal(s.estado, 'OMITIDA'); assert.equal(s.motivo, 'SIN_CHAT_PREVIO'); assert.equal(enviadosA(wa, c).length, 0);
  });
  test('si el envío falla queda como fallo', async () => {
    await activar(true);
    const c = await cliente(); const p = await pedidoEntregado(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA });
    await O.procesar({ ahora: new Date(AHORA.getTime() + 2 * HORA), deps: { wa: wafalso({ falla: true }) } });
    assert.equal((await delCliente(c)).estado, 'FALLO');
  });
  test('si el negocio apaga la opción antes del envío, no se manda', async () => {
    await activar(true);
    const c = await cliente(); const p = await pedidoEntregado(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA });
    await activar(false);
    const wa = wafalso(); await O.procesar({ ahora: new Date(AHORA.getTime() + 2 * HORA), deps: { wa } });
    assert.equal(enviadosA(wa, c).length, 0);
  });
});

describe('resumen del panel', () => {
  test('cuenta los pedidos enviados y muestra lo que el cliente respondió después', async () => {
    await activar(true);
    const c = await cliente(); const p = await pedidoEntregado(c);
    await O.programar({ empresaId: E.id, clienteId: c.id, tipo: 'PEDIDO', refId: p.id, ahora: AHORA });
    await O.procesar({ ahora: new Date(AHORA.getTime() + 2 * HORA), deps: { wa: wafalso() } });
    const sol = await delCliente(c);
    const conv = await prisma.conversacion.findFirst({ where: { agenteId: agente.id, telefonoCliente: c.telefono } });
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: 'Todo muy bien, llegó rápido', createdAt: new Date(sol.enviadaAt.getTime() + 10 * 60000) } });
    const r = await O.resumen(E.id, { ahora: new Date(AHORA.getTime() + 3 * HORA) });
    assert.ok(r.enviadas >= 1);
    assert.ok(r.respuestas.some((x) => x.contenido === 'Todo muy bien, llegó rápido' && x.nombre === 'Ana Rojas'));
  });
});
