// Aviso por WhatsApp cuando el cliente agrega algo desde la web (lib/services/avisoCarritoWeb.js).
// Se prueba contra la base real con un "WhatsApp" falso que solo anota lo que se le pide enviar.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const aviso = require('../lib/services/avisoCarritoWeb');

const SLUG = 'test-aviso-carrito-web';
const TEL = '000-test-aviso';

let empresaId;
let agenteId;
let conversacionId;
let mensajeCliente;
let producto;

function whatsappFalso({ fallaBotones = false } = {}) {
  const enviados = [];
  return {
    enviados,
    enviarBotones: async (_c, para, texto, botones) => {
      enviados.push({ tipo: 'botones', para, texto, botones });
      return fallaBotones ? { ok: false, error: 'rechazado' } : { ok: true };
    },
    enviarTexto: async (_c, para, texto) => { enviados.push({ tipo: 'texto', para, texto }); return { ok: true }; },
  };
}

async function prepararCliente({ flag = true, pendiente = true } = {}) {
  await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { flujoDeterminista: flag } });
  await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
  await prisma.clienteFinal.create({
    data: {
      empresaId, telefono: TEL,
      contexto: {
        carrito: { conversacionId, actualizadoEn: new Date().toISOString(), items: [{ productoId: producto.id, varianteId: null, nombre: 'Zapatilla Runner', precio: 303, cantidad: 2, agregadoEn: new Date().toISOString() }] },
        ...(pendiente ? { carritoWebPendiente: { productoId: producto.id, varianteId: null, agregadoEn: new Date().toISOString() } } : {}),
      },
    },
  });
}

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Aviso', slug: SLUG, moneda: 'BOB',
      agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [], flujoDeterminista: true } } }] },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;
  await prisma.conexionWhatsApp.create({ data: { agenteId, estado: 'CONECTADO', phoneNumberId: `test-phone-${Date.now()}`, tokenCifrado: 'x' } });
  producto = await prisma.producto.create({ data: { empresaId, nombre: 'Zapatilla Runner', precio: 303, stock: 9, fotos: [] } });
  const conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TEL, ultimoMensajeAt: new Date() } });
  conversacionId = conv.id;
});

beforeEach(async () => {
  aviso.cancelarTodos();
  await prisma.mensaje.deleteMany({ where: { conversacionId } });
  mensajeCliente = await prisma.mensaje.create({ data: { conversacionId, rol: 'CLIENTE', contenido: 'hola' } });
  await prisma.conversacion.update({ where: { id: conversacionId }, data: { ultimoMensajeAt: new Date() } });
  await prisma.conexionWhatsApp.updateMany({ where: { agenteId }, data: { estado: 'CONECTADO' } });
  await prepararCliente();
});

after(async () => {
  aviso.cancelarTodos();
  await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

describe('armarAviso', () => {
  const items = [{ nombre: 'Zapatilla Runner (Talla: 42)', precio: 303, cantidad: 1 }];
  const fmt = (m) => `Bs ${Number(m).toFixed(2)}`;
  test('con botones: detalle, total y los tres botones del flujo', () => {
    const a = aviso.armarAviso(items, fmt, true);
    assert.match(a.texto, /Agregado a tu carrito/);
    assert.match(a.texto, /1x Zapatilla Runner \(Talla: 42\)/);
    assert.match(a.texto, /Total: Bs 303\.00/);
    assert.deepEqual(a.botones.map((b) => b.id), ['mas:si', 'mas:no', 'mas:ver']);
  });
  test('sin botones: texto que explica como seguir', () => {
    const a = aviso.armarAviso(items, fmt, false);
    assert.equal(a.botones, null);
    assert.match(a.texto, /finalizar/);
  });
});

describe('enviarAviso', () => {
  test('con el flujo activo manda el detalle con botones, lo deja en el historial y limpia la marca', async () => {
    const wa = whatsappFalso();
    const r = await aviso.enviarAviso({ empresaId, telefono: TEL, deps: { wa } });
    assert.equal(r.enviado, true);
    assert.equal(wa.enviados.length, 1);
    assert.equal(wa.enviados[0].tipo, 'botones');
    assert.match(wa.enviados[0].texto, /2x Zapatilla Runner — Bs 303\.00 c\/u/);
    assert.match(wa.enviados[0].texto, /Total: Bs 606\.00/);
    const msg = await prisma.mensaje.findFirst({ where: { conversacionId, rol: 'AGENTE' } });
    assert.match(msg.contenido, /Agregado a tu carrito/, 'queda en el historial para la IA y el panel');
    const cli = await prisma.clienteFinal.findFirst({ where: { telefono: TEL } });
    assert.equal(cli.contexto.carritoWebPendiente, null, 'el bot no vuelve a "reaccionar" a algo que ya se le aviso');
    assert.equal(cli.contexto.carrito.items.length, 1, 'el carrito no se toca');
  });

  test('con el flujo apagado manda solo texto', async () => {
    await prepararCliente({ flag: false });
    const wa = whatsappFalso();
    await aviso.enviarAviso({ empresaId, telefono: TEL, deps: { wa } });
    assert.equal(wa.enviados[0].tipo, 'texto');
  });

  test('si el cliente ya escribio "Quiero X" y el bot confirmo (sin marca pendiente), NO se duplica', async () => {
    await prepararCliente({ pendiente: false });
    const wa = whatsappFalso();
    const r = await aviso.enviarAviso({ empresaId, telefono: TEL, deps: { wa } });
    assert.deepEqual([r.enviado, r.motivo], [false, 'YA_CONFIRMADO_EN_EL_CHAT']);
    assert.equal(wa.enviados.length, 0);
  });

  test('pasadas las 24 h del ultimo mensaje del cliente NO se manda (haria falta plantilla paga)', async () => {
    await prisma.mensaje.update({ where: { id: mensajeCliente.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    const wa = whatsappFalso();
    const r = await aviso.enviarAviso({ empresaId, telefono: TEL, deps: { wa } });
    assert.deepEqual([r.enviado, r.motivo], [false, 'FUERA_DE_24H']);
    assert.equal(wa.enviados.length, 0);
  });

  test('sin WhatsApp conectado NO se manda', async () => {
    await prisma.conexionWhatsApp.updateMany({ where: { agenteId }, data: { estado: 'EN_PROCESO' } });
    const wa = whatsappFalso();
    const r = await aviso.enviarAviso({ empresaId, telefono: TEL, deps: { wa } });
    assert.deepEqual([r.enviado, r.motivo], [false, 'SIN_CONEXION']);
  });

  test('un cliente que nunca escribio por WhatsApp NO recibe nada', async () => {
    const wa = whatsappFalso();
    const r = await aviso.enviarAviso({ empresaId, telefono: '000-nunca-escribio', deps: { wa } });
    assert.deepEqual([r.enviado, r.motivo], [false, 'SIN_CHAT_PREVIO']);
  });

  test('si Meta rechaza los botones, cae a texto con las opciones escritas', async () => {
    const wa = whatsappFalso({ fallaBotones: true });
    const r = await aviso.enviarAviso({ empresaId, telefono: TEL, deps: { wa } });
    assert.equal(r.enviado, true);
    assert.deepEqual(wa.enviados.map((e) => e.tipo), ['botones', 'texto']);
    assert.match(wa.enviados[1].texto, /• Seguir comprando/);
  });
});

describe('programarAviso - agrupa lo que agrega seguido', () => {
  test('tres agregados seguidos = UN solo mensaje', async () => {
    const wa = whatsappFalso();
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await aviso.programarAviso({ empresaId, telefono: TEL, esperaMs: 60, deps: { wa } }), true);
    }
    assert.equal(aviso.pendientes(), 1, 'un solo temporizador por cliente');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(wa.enviados.length, 1);
    assert.equal(aviso.pendientes(), 0);
  });

  test('si no se puede avisar (fuera de las 24 h) devuelve false y no agenda nada', async () => {
    await prisma.mensaje.update({ where: { id: mensajeCliente.id }, data: { createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) } });
    assert.equal(await aviso.programarAviso({ empresaId, telefono: TEL, esperaMs: 10, deps: { wa: whatsappFalso() } }), false);
    assert.equal(aviso.pendientes(), 0);
  });
});
