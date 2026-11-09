// Pedidos de más conversaciones: el cliente pide con una nota, el superadmin aprueba o rechaza.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const S = require('../lib/services/solicitudesConv');
const { obtenerEstadoConsumo } = require('../lib/services/suscripciones');
const P = require('../lib/services/planesCliente');

const SLUG = 'test-solicitudes-conv';
let empresaId;
let planId;
let suscripcionId;

const falla = (fn, patron) => assert.rejects(fn, (e) => { assert.equal(e.codigo, 'SOLICITUD'); assert.match(e.message, patron); return true; });

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_SOL' } });
  empresaId = (await prisma.empresa.create({ data: { nombre: 'Cliente Pedidos', slug: SLUG } })).id;
  planId = (await prisma.plan.create({ data: { codigo: 'TEST_SOL', nombre: 'Plan sol', mensualidadBs: 1, implementacionBs: 0, primerPagoBs: 1, convIncluidas: 0, maxProductos: 5, maxUsuarios: 1 } })).id;
  suscripcionId = (await P.asignarPlan(empresaId, planId, { meses: 1 })).suscripcion.id;
});
after(async () => {
  await prisma.solicitudConversaciones.deleteMany({ where: { empresaId } });
  await prisma.compraPaquete.deleteMany({ where: { empresaId } });
  await prisma.registroUso.deleteMany({ where: { suscripcion: { empresaId } } });
  await prisma.suscripcion.deleteMany({ where: { empresaId } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_SOL' } });
});
beforeEach(async () => {
  await prisma.solicitudConversaciones.deleteMany({ where: { empresaId } });
  await prisma.compraPaquete.deleteMany({ where: { empresaId } });
  await prisma.notificacion.deleteMany({ where: { empresaId } });
});

describe('pedir conversaciones', () => {
  test('queda pendiente en el buzón y NO da saldo todavía', async () => {
    const s = await S.crear(empresaId, { cantidad: 1000, nota: 'Voy a pagar por transferencia hoy' });
    assert.equal(s.estado, 'PENDIENTE');
    assert.equal((await obtenerEstadoConsumo(suscripcionId)).totalDisponible, 0);
    const buzon = await S.listar({ estado: 'PENDIENTE' });
    assert.ok(buzon.some((x) => x.id === s.id && x.empresa.nombre === 'Cliente Pedidos'));
    assert.ok((await S.contarPendientes()) >= 1);
  });

  test('valida la cantidad, exige la nota y limita los pedidos pendientes', async () => {
    await falla(() => S.crear(empresaId, { cantidad: 5, nota: 'voy a pagar ya' }), /entre 100/);
    await falla(() => S.crear(empresaId, { cantidad: 'muchas', nota: 'voy a pagar ya' }), /entre 100/);
    await falla(() => S.crear(empresaId, { cantidad: 500, nota: '' }), /nota/);
    for (let i = 0; i < S.MAX_PENDIENTES; i += 1) await S.crear(empresaId, { cantidad: 500, nota: 'voy a pagar ya' });
    await falla(() => S.crear(empresaId, { cantidad: 500, nota: 'voy a pagar ya' }), /esperando respuesta/);
  });
});

describe('el superadmin resuelve', () => {
  test('aprobar carga el saldo (con su vigencia) y avisa al cliente', async () => {
    const s = await S.crear(empresaId, { cantidad: 1000, nota: 'Pagué por QR' });
    const r = await S.aprobar(s.id, { respuesta: 'Gracias por tu pago.' });
    assert.equal(r.estado, 'APROBADA');
    assert.equal(r.cantidadAprobada, 1000);
    assert.ok(r.compraPaqueteId);
    const e = await obtenerEstadoConsumo(suscripcionId);
    assert.equal(e.extraDisponible, 1000);
    assert.equal(e.puedeAtender, true);
    const compra = await prisma.compraPaquete.findUnique({ where: { id: r.compraPaqueteId } });
    const dias = Math.round((compra.fechaRenovacion - Date.now()) / 86400000);
    assert.ok(dias >= 89 && dias <= 90, `vigencia ${dias} días`);
    const aviso = await prisma.notificacion.findFirst({ where: { empresaId } });
    assert.match(aviso.mensaje, /1\.000 conversaciones|1,000 conversaciones|1000 conversaciones/);
  });

  test('se puede aprobar otra cantidad y otra vigencia', async () => {
    const s = await S.crear(empresaId, { cantidad: 2000, nota: 'Pago parcial' });
    const r = await S.aprobar(s.id, { cantidad: 500, vigenciaDias: 30 });
    assert.equal(r.cantidadAprobada, 500);
    assert.equal((await obtenerEstadoConsumo(suscripcionId)).extraDisponible, 500);
    const otra = await S.crear(empresaId, { cantidad: 500, nota: 'otra vez' });
    await falla(() => S.aprobar(otra.id, { cantidad: -3 }), /no es válida/);
  });

  test('un pedido no se puede resolver dos veces (no se carga el saldo doble)', async () => {
    const s = await S.crear(empresaId, { cantidad: 1000, nota: 'Pagué por QR' });
    await Promise.allSettled([S.aprobar(s.id), S.aprobar(s.id)]);
    assert.equal((await obtenerEstadoConsumo(suscripcionId)).extraDisponible, 1000, 'una sola carga aunque se aprieten dos veces');
    await falla(() => S.aprobar(s.id), /ya fue resuelto/);
    await falla(() => S.rechazar(s.id), /ya fue resuelto/);
  });

  test('rechazar no da saldo y avisa con el motivo', async () => {
    const s = await S.crear(empresaId, { cantidad: 1000, nota: 'Todavía no pagué' });
    const r = await S.rechazar(s.id, { respuesta: 'No encontramos tu pago.' });
    assert.equal(r.estado, 'RECHAZADA');
    assert.equal((await obtenerEstadoConsumo(suscripcionId)).extraDisponible, 0);
    assert.match((await prisma.notificacion.findFirst({ where: { empresaId } })).mensaje, /No encontramos tu pago/);
  });

  test('el cliente ve el historial de sus pedidos', async () => {
    await S.crear(empresaId, { cantidad: 500, nota: 'primer pedido' });
    const lista = await S.delCliente(empresaId);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].estado, 'PENDIENTE');
  });
});
