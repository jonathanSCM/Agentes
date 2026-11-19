// Créditos en el uso real: cobro de conversación nueva, de turno con IA y de plantilla; sin saldo el agente sigue sin IA; avisos; acreditación.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const C = require('../lib/services/creditos');
const K = require('../lib/services/creditosConsumo');
const topeIA = require('../lib/services/topeIA');
const trazaIA = require('../lib/services/trazaIA');
const usoIA = require('../lib/services/usoIA');
const { procesarMensajeEntrante } = require('../lib/services/conversaciones');
const { registrarCompraPaquete } = require('../lib/services/suscripciones');

const SLUG = 'test-creditos-consumo';
const dia = 24 * 60 * 60 * 1000;
let empresa; let agente; let sus; let plan;
let n = 0;
const tel = () => `5917100${String(++n).padStart(5, '0')}`;
const saldo = async () => (await C.saldo(empresa.id)).total;
const modo = (m) => { if (m) process.env.CREDITOS_MODO = m; else delete process.env.CREDITOS_MODO; };

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  plan = await prisma.plan.findFirst({ where: { codigo: 'AGENTE_POS' } });
  empresa = await prisma.empresa.create({ data: { nombre: 'Tienda Créditos Uso', slug: SLUG, agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
  agente = empresa.agentes[0];
  sus = await prisma.suscripcion.create({ data: { empresaId: empresa.id, planId: plan.id, estado: 'ACTIVA', periodoInicio: new Date(Date.now() - 5 * dia), periodoFin: new Date(Date.now() + 25 * dia) } });
});
after(async () => { modo(null); await prisma.empresa.delete({ where: { id: empresa.id } }).catch(() => {}); });
beforeEach(async () => {
  modo(null);
  await prisma.creditoMovimiento.deleteMany({ where: { empresaId: empresa.id } });
  await prisma.creditoLote.deleteMany({ where: { empresaId: empresa.id } });
  await prisma.suscripcion.update({ where: { id: sus.id }, data: { estado: 'ACTIVA', ilimitado: false, avisosEnviados: {} } });
  await prisma.notificacion.deleteMany({ where: { empresaId: empresa.id } }).catch(() => {});
});
const plan30 = (cantidad) => C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad, clave: `p${Math.random()}`, vence: new Date(Date.now() + 25 * dia) });
const mensaje = (t) => procesarMensajeEntrante({ agenteId: agente.id, telefonoCliente: t, contenido: 'hola' });

describe('conversación nueva', () => {
  test('ACTIVO: cobra 5 créditos al abrir y no cobra al seguir en la misma conversación', async () => {
    modo('ACTIVO'); await plan30(100);
    const t = tel();
    const a = await mensaje(t); const b = await mensaje(t);
    assert.deepEqual([a.ok, a.cobrada, b.cobrada], [true, true, false]);
    assert.equal(await saldo(), 95);
    assert.equal((await C.verificarCuadre(empresa.id)).ok, true);
  });
  test('ACTIVO sin créditos: NO corta; la conversación se abre y se atiende sin IA', async () => {
    modo('ACTIVO');
    const r = await mensaje(tel());
    assert.equal(r.ok, true); assert.ok(r.conversacionId);
    assert.equal(await topeIA.revisar({ empresaId: empresa.id, telefono: tel() }).then((x) => x.motivo), 'SIN_CREDITOS');
  });
  test('ACTIVO con suscripción CANCELADA sí corta, aunque haya créditos', async () => {
    modo('ACTIVO'); await plan30(100);
    await prisma.suscripcion.update({ where: { id: sus.id }, data: { estado: 'CANCELADA' } });
    const r = await mensaje(tel());
    assert.deepEqual([r.ok, r.motivo], [false, 'SUSCRIPCION_CANCELADA']);
    assert.equal(await saldo(), 100);
  });
  test('un plan ilimitado no descuenta créditos', async () => {
    modo('ACTIVO'); await plan30(100);
    await prisma.suscripcion.update({ where: { id: sus.id }, data: { ilimitado: true } });
    assert.equal((await mensaje(tel())).ok, true);
    assert.equal(await saldo(), 100);
    assert.equal(await topeIA.revisar({ empresaId: empresa.id, telefono: tel() }).then((x) => x.ok), true);
  });
  test('SOMBRA: manda el sistema de conversaciones y los créditos solo anotan', async () => {
    modo('SOMBRA'); await plan30(100);
    const antes = await prisma.registroUso.count({ where: { suscripcionId: sus.id, tipo: 'CONSUMIDA' } });
    const r = await mensaje(tel());
    assert.equal(r.ok, true);
    assert.equal(await prisma.registroUso.count({ where: { suscripcionId: sus.id, tipo: 'CONSUMIDA' } }), antes + 1, 'se cobró como conversación');
    assert.equal(await saldo(), 100, 'los créditos no se movieron');
    const s = await prisma.creditoMovimiento.findFirst({ where: { empresaId: empresa.id, tipo: 'SOMBRA' } });
    assert.equal(s.accion, 'CONVERSACION_NUEVA'); assert.equal(s.cantidad, -5);
  });
  test('APAGADO: los créditos no hacen nada', async () => {
    await plan30(100);
    await mensaje(tel());
    assert.equal(await saldo(), 100);
    assert.equal(await prisma.creditoMovimiento.count({ where: { empresaId: empresa.id, tipo: { in: ['SOMBRA', 'CONSUMO'] } } }), 0);
  });
});

describe('turno con IA', () => {
  const turno = (fn, extra = {}) => trazaIA.conTurno({ empresaId: empresa.id, agenteId: agente.id, telefono: tel(), ...extra }, fn);
  const conIA = async () => { await usoIA.registrar({ empresaId: empresa.id, proveedor: 'openai', modelo: 'm', promptTokens: 10, completionTokens: 5 }); await K.cobrarTurnoIA({ empresaId: empresa.id }); return { ok: true, respuesta: 'x' }; };

  test('ACTIVO: un turno que usó la IA cuesta 1 crédito; uno sin IA no cuesta', async () => {
    modo('ACTIVO'); await plan30(10);
    await turno(conIA);
    assert.equal(await saldo(), 9);
    await turno(async () => { await K.cobrarTurnoIA({ empresaId: empresa.id }); return { ok: true, respuesta: 'menú' }; });
    assert.equal(await saldo(), 9, 'sin IA no cuesta');
  });
  test('el chat de prueba no cuesta', async () => {
    modo('ACTIVO'); await plan30(10);
    await turno(async () => { await usoIA.registrar({ empresaId: empresa.id, proveedor: 'openai', modelo: 'm', promptTokens: 1, completionTokens: 1 }); await K.cobrarTurnoIA({ empresaId: empresa.id, modoPrueba: true }); return { ok: true, respuesta: 'x' }; }, { prueba: true });
    assert.equal(await saldo(), 10);
  });
  test('cobrar dos veces el mismo turno descuenta una sola vez', async () => {
    modo('ACTIVO'); await plan30(10);
    await turno(async () => { await usoIA.registrar({ empresaId: empresa.id, proveedor: 'openai', modelo: 'm', promptTokens: 1, completionTokens: 1 }); await K.cobrarTurnoIA({ empresaId: empresa.id }); await K.cobrarTurnoIA({ empresaId: empresa.id }); return { ok: true, respuesta: 'x' }; });
    assert.equal(await saldo(), 9);
  });
  test('SOMBRA anota el turno sin mover créditos', async () => {
    modo('SOMBRA'); await plan30(10);
    await turno(conIA);
    assert.equal(await saldo(), 10);
    assert.equal(await prisma.creditoMovimiento.count({ where: { empresaId: empresa.id, tipo: 'SOMBRA', accion: 'TURNO_IA' } }), 1);
  });
  test('con saldo, la IA está permitida; con el saldo justo se permite y después se frena', async () => {
    modo('ACTIVO'); await plan30(1);
    assert.equal(await C.puedeUsarIA(empresa.id), true);
    await turno(conIA);
    assert.equal(await C.puedeUsarIA(empresa.id), false);
  });
});

describe('plantillas', () => {
  test('ACTIVO: cuesta 2; sin saldo no se envía; una devolución restituye', async () => {
    modo('ACTIVO'); await plan30(3);
    const a = await K.cobrarPlantilla({ empresaId: empresa.id, referencia: 'cita1-24h' });
    assert.equal(a.permitido, true); assert.equal(await saldo(), 1);
    assert.equal((await K.cobrarPlantilla({ empresaId: empresa.id, referencia: 'cita2-24h' })).permitido, false);
    await K.devolverPlantilla({ empresaId: empresa.id, referencia: 'cita1-24h' });
    assert.equal(await saldo(), 3);
  });
  test('APAGADO: se envía y no cobra', async () => {
    assert.equal((await K.cobrarPlantilla({ empresaId: empresa.id, referencia: 'x' })).permitido, true);
  });
});

describe('avisos', () => {
  test('80 %, 95 % y 100 % se mandan una sola vez cada uno', async () => {
    modo('ACTIVO'); await plan30(100);
    await C.consumir({ empresaId: empresa.id, accion: 'TURNO_IA', cantidad: 80, clave: 'a' });
    assert.deepEqual(await K.revisarAvisos(empresa.id), ['creditos80']);
    assert.deepEqual(await K.revisarAvisos(empresa.id), []);
    await C.consumir({ empresaId: empresa.id, accion: 'TURNO_IA', cantidad: 15, clave: 'b' });
    assert.deepEqual(await K.revisarAvisos(empresa.id), ['creditos95']);
    await C.consumir({ empresaId: empresa.id, accion: 'TURNO_IA', cantidad: 5, clave: 'c' });
    assert.deepEqual(await K.revisarAvisos(empresa.id), ['creditos100']);
    assert.equal(await K.avisarSinCreditos(empresa.id), true);
    assert.equal(await K.avisarSinCreditos(empresa.id), false);
  });
  test('al entrar créditos nuevos los avisos se vuelven a habilitar', async () => {
    modo('ACTIVO'); await plan30(100);
    await C.consumir({ empresaId: empresa.id, accion: 'TURNO_IA', cantidad: 85, clave: 'a' });
    await K.revisarAvisos(empresa.id);
    await K.reiniciarAvisos(empresa.id);
    assert.deepEqual(await K.revisarAvisos(empresa.id), ['creditos80']);
  });
});

describe('acreditación', () => {
  test('un paquete comprado se acredita una sola vez (por defecto conversaciones x 5) y vence en 12 meses', async () => {
    modo('ACTIVO');
    const compra = await registrarCompraPaquete({ empresaId: empresa.id, cantidad: 10, precioUsd: 5 });
    assert.equal(await saldo(), 50);
    assert.equal((await K.acreditarCompra(compra.id)).repetido, true);
    assert.equal(await saldo(), 50);
    const lote = await prisma.creditoLote.findFirst({ where: { empresaId: empresa.id, origen: 'COMPRA' } });
    assert.ok(lote.vence.getTime() > Date.now() + 300 * dia);
  });
  test('sin ACTIVO una compra no genera lote', async () => {
    await registrarCompraPaquete({ empresaId: empresa.id, cantidad: 10, precioUsd: 5 });
    assert.equal(await prisma.creditoLote.count({ where: { empresaId: empresa.id } }), 0);
  });
  test('los créditos del plan se entregan una vez por período (conversaciones incluidas x 5 si no hay creditosMes)', async () => {
    await prisma.suscripcion.update({ where: { id: sus.id }, data: { creditosMes: 300 } });
    await K.otorgarPlanes(new Date(), { empresaId: empresa.id }); await K.otorgarPlanes(new Date(), { empresaId: empresa.id });
    const lotes = await prisma.creditoLote.findMany({ where: { empresaId: empresa.id, origen: 'PLAN' } });
    assert.equal(lotes.length, 1); assert.equal(lotes[0].cantidadInicial, 300);
    assert.ok(lotes[0].vence > new Date());
    await prisma.suscripcion.update({ where: { id: sus.id }, data: { creditosMes: null } });
  });
});
