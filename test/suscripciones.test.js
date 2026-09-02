// Bug real de produccion: una empresa MOROSA con saldo de paquete extra ya
// pagado no debia dejar de responder por WhatsApp (el saldo ya esta cobrado,
// no depende de si la cuota mensual del plan esta al dia). Ver
// consumirConversacion / puedeEditarCatalogo en lib/services/suscripciones.js.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { consumirConversacion, obtenerEstadoConsumo, puedeEditarCatalogo, registrarCompraPaquete } = require('../lib/services/suscripciones');

const SLUG = 'test-suscripciones-temp';
let empresaId;
let planId;
let suscripcionId;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  const plan = await prisma.plan.findFirst({ where: { codigo: 'PRO' } });
  planId = plan.id;
  const empresa = await prisma.empresa.create({ data: { nombre: 'Test Suscripciones', slug: SLUG } });
  empresaId = empresa.id;
});

after(async () => {
  await prisma.compraPaquete.deleteMany({ where: { empresaId } });
  await prisma.registroUso.deleteMany({ where: { suscripcion: { empresaId } } });
  await prisma.suscripcion.deleteMany({ where: { empresaId } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

async function fijarSuscripcion(estado, { periodoFin } = {}) {
  await prisma.compraPaquete.deleteMany({ where: { empresaId } });
  await prisma.registroUso.deleteMany({ where: { suscripcion: { empresaId } } });
  await prisma.suscripcion.deleteMany({ where: { empresaId } });
  const sub = await prisma.suscripcion.create({
    data: {
      empresaId, planId, estado,
      periodoInicio: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      periodoFin: periodoFin || new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
    },
  });
  suscripcionId = sub.id;
}

describe('consumirConversacion - el saldo pagado manda, salvo CANCELADA', () => {
  test('MOROSA con saldo extra ya pagado: SI debe seguir respondiendo', async () => {
    await fijarSuscripcion('MOROSA', { periodoFin: new Date(Date.now() - 1000) });
    await registrarCompraPaquete({ empresaId, cantidad: 10, precioUsd: 5 });

    const r = await consumirConversacion(suscripcionId, 'test');
    assert.equal(r.ok, true);
    assert.equal(r.origen, 'EXTRA');
  });

  test('MOROSA sin ningun saldo extra: no responde, motivo SUSCRIPCION_INACTIVA', async () => {
    await fijarSuscripcion('MOROSA', { periodoFin: new Date(Date.now() - 1000) });
    const r = await consumirConversacion(suscripcionId, 'test');
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'SUSCRIPCION_INACTIVA');
  });

  test('CANCELADA con saldo extra: corta igual, sin importar el saldo', async () => {
    await fijarSuscripcion('CANCELADA');
    await registrarCompraPaquete({ empresaId, cantidad: 10, precioUsd: 5 });

    const r = await consumirConversacion(suscripcionId, 'test');
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'SUSCRIPCION_CANCELADA');
  });

  test('ACTIVA normal: consume primero de lo incluido (sin cambios de comportamiento)', async () => {
    await fijarSuscripcion('ACTIVA');
    const r = await consumirConversacion(suscripcionId, 'test');
    assert.equal(r.ok, true);
    assert.equal(r.origen, 'INCLUIDA');
  });

  test('periodo vencido pero estado ACTIVA, con saldo extra: sigue respondiendo del extra', async () => {
    await fijarSuscripcion('ACTIVA', { periodoFin: new Date(Date.now() - 1000) });
    await registrarCompraPaquete({ empresaId, cantidad: 3, precioUsd: 5 });
    const r = await consumirConversacion(suscripcionId, 'test');
    assert.equal(r.ok, true);
    assert.equal(r.origen, 'EXTRA');
  });
});

describe('obtenerEstadoConsumo.puedeAtender - alineado con consumirConversacion', () => {
  test('MOROSA con saldo extra: puedeAtender true', async () => {
    await fijarSuscripcion('MOROSA', { periodoFin: new Date(Date.now() - 1000) });
    await registrarCompraPaquete({ empresaId, cantidad: 10, precioUsd: 5 });
    const consumo = await obtenerEstadoConsumo(suscripcionId);
    assert.equal(consumo.puedeAtender, true);
    assert.equal(consumo.vigente, false);
  });

  test('CANCELADA con saldo extra: puedeAtender false', async () => {
    await fijarSuscripcion('CANCELADA');
    await registrarCompraPaquete({ empresaId, cantidad: 10, precioUsd: 5 });
    const consumo = await obtenerEstadoConsumo(suscripcionId);
    assert.equal(consumo.puedeAtender, false);
  });
});

describe('puedeEditarCatalogo - bloquea alta de productos/categorias si no esta al dia', () => {
  test('MOROSA no puede editar catalogo, aunque tenga saldo de conversaciones', async () => {
    await fijarSuscripcion('MOROSA', { periodoFin: new Date(Date.now() - 1000) });
    await registrarCompraPaquete({ empresaId, cantidad: 10, precioUsd: 5 });
    assert.equal(await puedeEditarCatalogo(empresaId), false);
  });

  test('ACTIVA si puede editar catalogo', async () => {
    await fijarSuscripcion('ACTIVA');
    assert.equal(await puedeEditarCatalogo(empresaId), true);
  });
});
