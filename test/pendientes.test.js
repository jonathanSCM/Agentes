// Mensajes pendientes recuperables (lib/services/pendientes.js): lo que la IA no pudo contestar
// se marca, y se contesta cuando la IA vuelve o cuando el dueño lo pide.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarYRegistrarRespuesta } = require('../lib/services/conversaciones');
const saludIA = require('../lib/services/saludIA');
const pendientes = require('../lib/services/pendientes');

const SLUG = 'test-pendientes';
const TEL = '59170001234';
const PREGUNTA = 'me sirve esta zapatilla para correr 10 km con pie plano?';

describe('mensajes pendientes recuperables', () => {
  let empresaId; let agenteId; let conv; let catId; let conexionId;

  const envios = [];
  const enviarFalso = async (_c, para, salida) => { envios.push({ para, salida }); return { ok: true }; };
  const iaBuena = { llamarInyectado: async () => ({ content: 'Es una zapatilla liviana y con buen amortiguado.', tool_calls: [] }) };

  async function clienteEscribe(texto, extra = {}) {
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: texto } });
    await prisma.conversacion.update({ where: { id: conv.id }, data: { ultimoMensajeAt: new Date() } });
    return generarYRegistrarRespuesta(agenteId, TEL, conv.id, texto, 'http://localhost:3000', false, extra);
  }
  const ultimoDelAgente = () => prisma.mensaje.findFirst({ where: { conversacionId: conv.id, rol: 'AGENTE' }, orderBy: { id: 'desc' } });

  before(async () => {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.deleteMany({ where: { slug: SLUG } });
    const empresa = await prisma.empresa.create({
      data: { nombre: 'Tienda Pendientes', slug: SLUG, moneda: 'BOB', agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } },
      include: { agentes: true },
    });
    empresaId = empresa.id;
    agenteId = empresa.agentes[0].id;
    const cat = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
    catId = cat.id;
    await prisma.producto.create({ data: { empresaId, categoriaId: cat.id, nombre: 'Zapatilla Runner', precio: 300, stock: 9, fotos: [] } });
    const c = await prisma.conexionWhatsApp.create({ data: { agenteId, estado: 'CONECTADO', phoneNumberId: `test-pend-${Date.now()}`, tokenCifrado: 'x' } });
    conexionId = c.id;
  });

  beforeEach(async () => {
    saludIA.reiniciar();
    saludIA.configurar({ enviar: async () => {} });
    envios.length = 0;
    await prisma.mensaje.deleteMany({ where: { conversacion: { agenteId } } });
    await prisma.conversacion.deleteMany({ where: { agenteId } });
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TEL, ultimoMensajeAt: new Date() } });
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'AGENTE', contenido: 'Hola, ¿en qué te ayudo?' } });
    await prisma.clienteFinal.create({ data: { empresaId, telefono: TEL, categoriaId: catId, categoriaInteres: 'Zapatillas', contexto: { tarjetasCategoriaMostradas: [catId] } } });
  });

  after(async () => {
    saludIA.configurar({ enviar: null });
    saludIA.reiniciar();
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  });

  test('con la IA caída, el texto libre queda marcado como pendiente (y el cliente igual recibe el menú)', async () => {
    saludIA.simular('5xx');
    const salida = await clienteEscribe(PREGUNTA);
    assert.equal(salida.modoSinIA, true);
    const a = await ultimoDelAgente();
    assert.equal(a.meta.pendienteIA, true);
    assert.equal(a.meta.texto, PREGUNTA);
    const p = await pendientes.pendienteDe(conv.id);
    assert.equal(p.texto, PREGUNTA);
  });

  test('un pedido largo SIN signo de pregunta que solo dispara la tarjeta también queda pendiente; uno corto no', async () => {
    saludIA.simular('5xx');
    await clienteEscribe('busco zapatillas');
    assert.equal((await ultimoDelAgente()).meta, null, 'una categoría nombrada se contesta con su tarjeta: no hay nada pendiente');
    await clienteEscribe('quiero zapatillas para correr diez kilómetros todas las mañanas con mucho amortiguado');
    const a = await ultimoDelAgente();
    assert.equal(a.meta && a.meta.pendienteIA, true);
  });

  test('un toque de botón y el chat de prueba NO quedan pendientes', async () => {
    saludIA.simular('5xx');
    await clienteEscribe('Ver categorías', { idBoton: 'menu:rubros' });
    assert.equal((await ultimoDelAgente()).meta, null);
  });

  test('si el cliente siguió escribiendo después, ya no es pendiente', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    assert.ok(await pendientes.pendienteDe(conv.id));
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: 'hola?' } });
    assert.equal(await pendientes.pendienteDe(conv.id), null);
  });

  test('pasada la ventana de WhatsApp (23 h) tampoco', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    const a = await ultimoDelAgente();
    await prisma.mensaje.update({ where: { id: a.id }, data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    assert.equal(await pendientes.pendienteDe(conv.id), null);
  });

  test('con la IA de vuelta: contesta lo pendiente con disculpa, lo manda por WhatsApp y lo marca recuperado', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    saludIA.simular(null);
    saludIA.reiniciar();

    const r = await pendientes.recuperar({ conversacionId: conv.id, enviar: enviarFalso, opciones: iaBuena });
    assert.equal(r.ok, true);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].para, TEL);
    assert.match(envios[0].salida.respuesta, /^Perdón la demora 🙏 /);
    assert.match(envios[0].salida.respuesta, /liviana/);

    const a = await ultimoDelAgente();
    assert.equal(a.meta.recuperacion, true);
    assert.match(a.contenido, /Perdón la demora/);
    assert.equal(await pendientes.pendienteDe(conv.id), null, 'ya no queda nada pendiente');
    const r2 = await pendientes.recuperar({ conversacionId: conv.id, enviar: enviarFalso, opciones: iaBuena });
    assert.equal(r2.motivo, 'NADA_PENDIENTE', 'no contesta dos veces');
  });

  test('la IA no recibe la pregunta duplicada (una vez como historial y otra como mensaje actual)', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    saludIA.simular(null);
    saludIA.reiniciar();
    let vistos = null;
    await pendientes.recuperar({
      conversacionId: conv.id, enviar: enviarFalso,
      opciones: { llamarInyectado: async ({ mensajes }) => { vistos = mensajes; return { content: 'Respuesta.', tool_calls: [] }; } },
    });
    const cuantas = vistos.filter((m) => m.content === PREGUNTA).length;
    assert.equal(cuantas, 1);
  });

  test('si la IA sigue caída: no manda nada, cuenta el intento y a los 5 abandona', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    for (let i = 0; i < 5; i += 1) {
      saludIA.reiniciar(); // que cada intento llegue a la IA y falle de verdad
      saludIA.simular('5xx');
      const r = await pendientes.recuperar({ conversacionId: conv.id, enviar: enviarFalso, forzar: true });
      assert.equal(r.motivo, 'IA_NO_DISPONIBLE');
    }
    assert.equal(envios.length, 0);
    assert.equal(await pendientes.pendienteDe(conv.id), null, 'abandonado tras 5 intentos');
  });

  test('con el circuito en pausa no se intenta (salvo que el dueño lo pida a mano)', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    saludIA.registrarFalla('SIN_SALDO');
    saludIA.simular(null);
    const r = await pendientes.recuperar({ conversacionId: conv.id, enviar: enviarFalso, opciones: iaBuena });
    assert.equal(r.motivo, 'IA_NO_DISPONIBLE');
    assert.equal(envios.length, 0);
    const todos = await pendientes.recuperarTodos({ enviar: enviarFalso, opciones: iaBuena });
    assert.equal(todos.intentadas, 0);
  });

  test('un humano con el control del chat: no se mete', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    await prisma.conversacion.update({ where: { id: conv.id }, data: { modo: 'HUMANO' } });
    saludIA.simular(null);
    saludIA.reiniciar();
    const r = await pendientes.recuperar({ conversacionId: conv.id, enviar: enviarFalso, opciones: iaBuena });
    assert.equal(r.motivo, 'EN_MANOS_HUMANAS');
    assert.equal(envios.length, 0);
  });

  test('recuperarTodos contesta lo pendiente de varias conversaciones cuando la IA vuelve', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    saludIA.simular(null);
    saludIA.reiniciar();
    const r = await pendientes.recuperarTodos({ enviar: enviarFalso, opciones: iaBuena });
    assert.equal(r.recuperadas >= 1, true);
    assert.equal(envios.length >= 1, true);
  });

  test('sin WhatsApp conectado no se intenta enviar', async () => {
    saludIA.simular('5xx');
    await clienteEscribe(PREGUNTA);
    await prisma.conexionWhatsApp.update({ where: { id: conexionId }, data: { estado: 'EN_PROCESO' } });
    saludIA.simular(null);
    saludIA.reiniciar();
    try {
      const r = await pendientes.recuperar({ conversacionId: conv.id, enviar: enviarFalso, opciones: iaBuena });
      assert.equal(r.motivo, 'SIN_WHATSAPP');
    } finally { await prisma.conexionWhatsApp.update({ where: { id: conexionId }, data: { estado: 'CONECTADO' } }); }
  });
});
