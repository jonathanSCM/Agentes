// Resiliencia ante caidas de la IA: clasificacion de errores, cortacircuitos,
// alertas y modo sin IA (lib/services/saludIA.js y modoSinIA.js).
// La parte de integracion corre contra la base real con una IA inyectada que falla.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');
const saludIA = require('../lib/services/saludIA');
const { respuestaPorReglas, pideAsesor } = require('../lib/services/modoSinIA');
const topeIA = require('../lib/services/topeIA');

const SLUG = 'test-resiliencia-ia';
const TELEFONO = '000-test-resiliencia';

const errorHttp = (status, extra = {}) => Object.assign(new Error(extra.message || `HTTP ${status}`), { status, ...extra });

describe('clasificarError', () => {
  const c = (e) => saludIA.clasificarError(e);
  test('saldo agotado llega como 429 pero NO es limite de velocidad', () => {
    assert.equal(c(errorHttp(429, { code: 'insufficient_quota', message: 'You exceeded your current quota' })), 'SIN_SALDO');
    assert.equal(c(errorHttp(400, { message: 'Your credit balance is too low to access the Anthropic API' })), 'SIN_SALDO');
  });
  test('limite de velocidad', () => assert.equal(c(errorHttp(429, { code: 'rate_limit_exceeded' })), 'LIMITE'));
  test('clave invalida', () => assert.equal(c(errorHttp(401, { code: 'invalid_api_key' })), 'CLAVE_INVALIDA'));
  test('caida: 5xx, sobrecarga y errores de red', () => {
    assert.equal(c(errorHttp(503)), 'CAIDA');
    assert.equal(c(errorHttp(529, { message: 'Overloaded' })), 'CAIDA');
    assert.equal(c(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'CAIDA');
    assert.equal(c(new Error('fetch failed')), 'CAIDA');
  });
  test('timeout', () => {
    assert.equal(c(Object.assign(new Error('x'), { code: 'IA_TIMEOUT' })), 'TIMEOUT');
    assert.equal(c(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })), 'TIMEOUT');
  });
  test('modelo inexistente o solicitud rechazada', () => assert.equal(c(errorHttp(404)), 'SOLICITUD_INVALIDA'));
  test('lo desconocido no se confunde con otra cosa', () => assert.equal(c(new Error('algo raro')), 'DESCONOCIDO'));
  test('el detalle que se loguea no filtra claves', () => {
    assert.doesNotMatch(saludIA.detalleSeguro(new Error('Incorrect API key provided: sk-abcdefghijklmnop1234')), /abcdefghijklmnop1234/);
  });
});

describe('cortacircuitos y alertas', () => {
  let enviados;
  beforeEach(() => {
    saludIA.reiniciar();
    enviados = [];
    saludIA.configurar({ enviar: async (t) => { enviados.push(t); } });
  });
  after(() => { saludIA.configurar({ enviar: null }); saludIA.reiniciar(); });

  test('tres fallas seguidas abren el circuito; antes no', () => {
    assert.equal(saludIA.registrarFalla('CAIDA').abrio, false);
    assert.equal(saludIA.registrarFalla('CAIDA').abrio, false);
    assert.equal(saludIA.iaDisponible(), true);
    assert.equal(saludIA.registrarFalla('TIMEOUT').abrio, true);
    assert.equal(saludIA.iaDisponible(), false);
  });
  test('sin saldo abre de inmediato', () => {
    assert.equal(saludIA.registrarFalla('SIN_SALDO').abrio, true);
    assert.equal(saludIA.iaDisponible(), false);
  });
  test('pasada la pausa deja pasar UNA sonda; si sale bien se cierra', () => {
    const t0 = Date.now();
    saludIA.registrarFalla('SIN_SALDO', {}, t0);
    const despues = t0 + saludIA.cfg.pausaSinSaldoMs + 1;
    assert.equal(saludIA.iaDisponible(despues), true, 'la sonda');
    assert.equal(saludIA.iaDisponible(despues + 1), false, 'los demas esperan el resultado de la sonda');
    assert.equal(saludIA.registrarExito(despues + 2), true);
    assert.equal(saludIA.iaDisponible(despues + 3), true);
  });
  test('las alertas iguales se agrupan: una cada 30 min', async () => {
    const t0 = Date.now();
    assert.equal((await saludIA.alertar('x', 'T', 'cuerpo', t0)).enviada, true);
    assert.equal((await saludIA.alertar('x', 'T', 'cuerpo', t0 + 60000)).enviada, false);
    assert.equal((await saludIA.alertar('x', 'T', 'cuerpo', t0 + 31 * 60000)).enviada, true);
    assert.equal(enviados.length, 2);
  });
  test('proteger: sin saldo alerta de inmediato y deja el tipo en el error', async () => {
    await assert.rejects(
      saludIA.proteger(async () => { throw errorHttp(429, { code: 'insufficient_quota' }); }, { proveedor: 'openai', modelo: 'gpt-x' }),
      (e) => e.tipoIA === 'SIN_SALDO',
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(enviados.length, 1);
    assert.match(enviados[0], /sin saldo/i);
  });
  test('proteger: con el circuito abierto NO llama a la IA', async () => {
    saludIA.registrarFalla('SIN_SALDO');
    let llamadas = 0;
    await assert.rejects(saludIA.proteger(async () => { llamadas += 1; return 1; }), (e) => e.tipoIA === 'CIRCUITO_ABIERTO');
    assert.equal(llamadas, 0);
  });
  test('proteger: una IA colgada se corta por tiempo', async () => {
    saludIA.configurar({ timeoutMs: 20 });
    try {
      await assert.rejects(saludIA.proteger(() => new Promise(() => {})), (e) => e.tipoIA === 'TIMEOUT');
    } finally { saludIA.configurar({ timeoutMs: 15000 }); }
  });
  test('proteger: cuando vuelve la IA avisa la recuperacion', async () => {
    saludIA.registrarFalla('SIN_SALDO', {}, Date.now() - saludIA.cfg.pausaSinSaldoMs - 5);
    await saludIA.proteger(async () => 'ok');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(enviados.some((t) => /volvió a responder/.test(t)));
    assert.equal(saludIA.resumen().estado, 'OK');
  });
  test('la simulacion de caidas funciona sin tocar la red', async () => {
    saludIA.simular('saldo');
    try {
      await assert.rejects(saludIA.proteger(async () => 'nunca'), (e) => e.tipoIA === 'SIN_SALDO');
    } finally { saludIA.simular(null); }
  });
});

describe('respuestas por reglas (sin IA, con datos reales de la configuracion)', () => {
  const config = { aceptaQr: true, aceptaEfectivo: true, aceptaTarjeta: false, direccionTienda: 'Av. Siempre Viva 123' };
  const empresa = { nombre: 'Tienda X' };
  test('formas de pago salen de la configuracion', () => {
    assert.match(respuestaPorReglas('¿Qué formas de pago aceptan?', { config, empresa }), /QR y efectivo/);
    assert.doesNotMatch(respuestaPorReglas('como puedo pagar', { config, empresa }), /tarjeta/);
  });
  test('direccion: la real, y sin direccion no inventa', () => {
    assert.match(respuestaPorReglas('donde estan ubicados', { config, empresa }), /Av\. Siempre Viva 123/);
    assert.match(respuestaPorReglas('donde estan ubicados', { config: {}, empresa }), /asesor/);
  });
  test('envio, horario y plazo: nunca inventa costos ni horas, deriva', () => {
    assert.match(respuestaPorReglas('hacen envios?', { config, empresa }), /asesor/);
    const h = respuestaPorReglas('a que hora abren', { config, empresa });
    assert.match(h, /asesor/);
    assert.doesNotMatch(h, /\d\d?:\d\d|\d+ ?(am|pm|hs)/i);
  });
  test('gracias y despedida', () => {
    assert.match(respuestaPorReglas('muchas gracias', { config, empresa }), /Con gusto/);
    assert.match(respuestaPorReglas('chao', { config, empresa }), /Con gusto/);
  });
  test('una consulta de producto NO la contestan las reglas', () => {
    assert.equal(respuestaPorReglas('tienen zapatillas negras talla 42 para correr', { config, empresa }), null);
  });
  test('pedir un asesor', () => {
    assert.equal(pideAsesor('quiero hablar con un asesor'), true);
    assert.equal(pideAsesor('hola'), false);
  });
});

describe('modo sin IA (integracion)', () => {
  let empresaId;
  let agenteId;
  let conv;
  let producto;
  let catZapas;

  const iaQueFalla = (err) => {
    let llamadas = 0;
    return { llamar: async () => { llamadas += 1; throw err; }, llamadas: () => llamadas };
  };
  async function escribe(texto, ia, extra = {}) {
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: texto } });
    // Con historial vacio el motor lo toma por un primer mensaje (menu de bienvenida, sin IA):
    // una conversacion ya iniciada tiene al menos una respuesta previa del agente.
    const historial = extra.primero ? [] : [{ rol: 'AGENTE', contenido: 'Hola, ¿en qué te ayudo?' }];
    return generarRespuesta(agenteId, TELEFONO, historial, texto, conv.id, { llamarInyectado: ia.llamar, ...extra });
  }

  // El primer mensaje de un cliente nuevo lo contesta el menu de bienvenida (sin IA);
  // los siguientes son los que llegan a la IA.
  // Un cliente sin categoria recibe el menu por codigo (sin IA); la IA entra cuando ya eligio una.
  async function primerContacto() {
    await prisma.clienteFinal.create({
      data: { empresaId, telefono: TELEFONO, categoriaId: catZapas.id, categoriaInteres: 'Zapatillas', productosMostrados: [producto.id] },
    });
  }
  const LIBRE = 'mmm no se que me conviene';

  before(async () => {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
    await prisma.empresa.deleteMany({ where: { slug: SLUG } });
    const empresa = await prisma.empresa.create({
      data: {
        nombre: 'Tienda Resiliencia', slug: SLUG, moneda: 'BOB',
        // flujoDeterminista APAGADO a proposito: el modo sin IA funciona igual.
        agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, aceptaQr: true, preguntasIniciales: [], flujoDeterminista: false } } }] },
      },
      include: { agentes: true },
    });
    empresaId = empresa.id;
    agenteId = empresa.agentes[0].id;
    conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TELEFONO, ultimoMensajeAt: new Date() } });
    const cat1 = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
    catZapas = cat1;
    const cat2 = await prisma.categoria.create({ data: { empresaId, nombre: 'Gorras' } });
    producto = await prisma.producto.create({ data: { empresaId, categoriaId: cat1.id, nombre: 'Zapatilla Runner', precio: 300, stock: 9, fotos: [] } });
    await prisma.producto.create({ data: { empresaId, categoriaId: cat2.id, nombre: 'Gorra Sol', precio: 80, stock: 9, fotos: [] } });
  });

  beforeEach(async () => {
    saludIA.reiniciar();
    topeIA.reiniciar();
    saludIA.configurar({ enviar: async () => {} });
    await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
    await prisma.notificacion.deleteMany({ where: { empresaId } });
  });

  after(async () => {
    saludIA.configurar({ enviar: null });
    saludIA.reiniciar();
    await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
    await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  });

  test('si la IA se cae, el cliente recibe el menu de categorias (no un error)', async () => {
    await primerContacto();
    const r = await escribe(LIBRE, iaQueFalla(errorHttp(503)));
    assert.equal(r.modoSinIA, true);
    assert.equal(r.error, undefined);
    assert.ok(r.lista, 'menu como lista');
    assert.match(r.respuesta, /menú/);
    assert.match(r.respuesta, /asesor/);
    assert.doesNotMatch(r.respuesta, /No pude consultar la disponibilidad/);
  });

  test('sin saldo: no reintenta con el modelo barato (fallaria igual) y responde sin IA', async () => {
    const ia = iaQueFalla(errorHttp(429, { code: 'insufficient_quota' }));
    await primerContacto();
    const r = await escribe(LIBRE, ia);
    assert.equal(r.modoSinIA, true);
    assert.equal(ia.llamadas(), 1, 'una sola llamada, sin rescate con otro modelo');
  });

  test('con limite de velocidad si hace el rescate con el modelo economico', async () => {
    let llamadas = 0;
    const llamar = async ({ modelo }) => {
      llamadas += 1;
      if (llamadas === 1) throw errorHttp(429, { code: 'rate_limit_exceeded' });
      return { content: `ok con ${modelo}`, tool_calls: [] };
    };
    await primerContacto();
    const r = await escribe(LIBRE, { llamar });
    // Si el turno ya usaba el modelo economico no hay otro al que rescatar: responde sin IA.
    // Si usaba uno mas caro, el rescate funciona y el cliente ni se entera.
    assert.equal(r.error, undefined);
    if (llamadas === 2) assert.equal(r.modoSinIA, undefined);
    else assert.equal(r.modoSinIA, true);
  });

  test('con el circuito abierto responde sin siquiera llamar a la IA', async () => {
    saludIA.registrarFalla('SIN_SALDO');
    await primerContacto();
    const ia = iaQueFalla(new Error('no deberia llamarse'));
    const r = await escribe(LIBRE, ia);
    assert.equal(r.modoSinIA, true);
    assert.equal(ia.llamadas(), 0);
  });

  test('cambiar de categoria con la IA caida muestra la tarjeta nueva', async () => {
    saludIA.simular('5xx');
    try {
      await primerContacto();
      const r = await escribe('ahora quiero ver gorras', iaQueFalla(new Error('no')));
      assert.match(r.respuesta, /gorras/i);
      assert.equal(r.error, undefined);
    } finally { saludIA.simular(null); }
  });

  test('pedir un asesor deriva y avisa al negocio', async () => {
    await primerContacto();
    const r = await escribe('quiero hablar con un asesor', iaQueFalla(errorHttp(503)));
    assert.equal(r.modoSinIA, true);
    assert.match(r.respuesta, /asesor/i);
    const cli = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    assert.equal(cli.estadoLead, 'DERIVADO_A_ASESOR');
  });

  test('preguntas frecuentes se contestan con datos reales, sin IA', async () => {
    await primerContacto();
    const r = await escribe('que formas de pago aceptan', iaQueFalla(errorHttp(503)));
    assert.match(r.respuesta, /QR y efectivo/);
  });

  test('el cliente puede armar el carrito y cerrar el pedido con la IA caida (botones)', async () => {
    await prisma.clienteFinal.create({
      data: {
        empresaId, telefono: TELEFONO, estadoConversacion: 'INTENCION_DE_COMPRA', productoFavoritoId: producto.id,
        nombre: 'Ana Pérez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 123', ubicacionLat: -17.76, ubicacionLng: -63.18, formaPago: 'EFECTIVO',
        contexto: { carrito: { conversacionId: null, actualizadoEn: new Date().toISOString(), items: [{ productoId: producto.id, varianteId: null, nombre: producto.nombre, precio: 300, cantidad: 1, agregadoEn: new Date().toISOString() }] } },
      },
    });
    const ia = iaQueFalla(errorHttp(503));
    const resumen = await escribe('Finalizar', ia, { idBoton: 'mas:no' });
    assert.match(resumen.respuesta, /resumen de tu pedido/i);
    const pedido = await escribe('Confirmar', ia, { idBoton: 'cierre:confirmar' });
    assert.match(pedido.respuesta, /pedido/i);
    assert.equal(await prisma.pedido.count({ where: { empresaId } }), 1, 'se creo el pedido sin IA');
  });

  test('el negocio recibe UN aviso en la campanita, sin duplicar', async () => {
    const ia = iaQueFalla(errorHttp(503));
    await primerContacto();
    await escribe(LIBRE, ia);
    await escribe(`${LIBRE} otra vez`, ia);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await prisma.notificacion.count({ where: { empresaId, tipo: 'IA_NO_DISPONIBLE' } }), 1);
  });

  test('el aviso "atiendo con menu" no se repite en cada mensaje', async () => {
    const ia = iaQueFalla(errorHttp(503));
    await primerContacto();
    const a = await escribe(LIBRE, ia);
    const b = await escribe('sigo sin saber', ia);
    assert.match(a.respuesta, /atendiendo con menú/);
    assert.doesNotMatch(b.respuesta, /atendiendo con menú/);
  });

  test('el texto libre sin resolver queda anotado como pendiente para el equipo', async () => {
    await primerContacto();
    await escribe('me sirve para correr 10 km si tengo pie plano?', iaQueFalla(errorHttp(503)));
    const cli = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    assert.match(cli.contexto.pendienteIA.texto, /pie plano/);
  });
  test('con el flujo activo, una pregunta de pago se contesta por reglas: 0 llamadas a la IA', async () => {
    await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { flujoDeterminista: true } });
    try {
      await primerContacto();
      const ia = iaQueFalla(new Error('no deberia llamarse'));
      const r = await escribe('¿qué formas de pago aceptan?', ia);
      assert.match(r.respuesta, /QR y efectivo/);
      assert.equal(ia.llamadas(), 0);
      assert.equal(r.modoSinIA, undefined, 'no es una contingencia: es ahorro');
    } finally {
      await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { flujoDeterminista: false } });
    }
  });

  test('un cliente que se pasa del tope por hora sigue atendido, sin IA', async () => {
    const original = topeIA.cfg.maxLlamadasClienteHora;
    topeIA.configurar({ maxLlamadasClienteHora: 2 });
    try {
      await primerContacto();
      let llamadas = 0;
      const ok = { llamar: async () => { llamadas += 1; return { content: 'Listo, avisame si necesitas algo mas.', tool_calls: [] }; } };
      await escribe(LIBRE, ok);
      await escribe(LIBRE, ok);
      const tercero = await escribe(LIBRE, ok);
      assert.equal(llamadas, 2, 'la tercera no llega a la IA');
      assert.equal(tercero.modoSinIA, true);
    } finally { topeIA.configurar({ maxLlamadasClienteHora: original }); topeIA.reiniciar(); }
  });
});
