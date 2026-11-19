// Informe retroactivo de créditos: lo que habría gastado cada empresa con los datos existentes. Solo lectura.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const H = require('../lib/services/creditosHistorico');
const tipoCambio = require('../lib/services/tipoCambio');

const SLUG = 'test-cred-hist';
let e; let agente;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  e = await prisma.empresa.create({ data: { nombre: 'Hist Test', slug: SLUG, agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
  agente = e.agentes[0];
  await tipoCambio.ponerManual({ valor: '10', fecha: tipoCambio.hoyBolivia(), nota: 'test historico' });
  for (let i = 0; i < 3; i++) await prisma.conversacion.create({ data: { agenteId: agente.id, telefonoCliente: `5917000000${i}` } });
  const uso = (extra) => prisma.usoIA.create({ data: { empresaId: e.id, proveedor: 'openai', modelo: 'm', promptTokens: 1, completionTokens: 1, costoUsd: 1, estado: 'COMPLETADA', ...extra } });
  await uso({ vuelta: 0 }); await uso({ vuelta: 0 }); await uso({ vuelta: 1, proposito: 'reintento_forzado' }); // 2 turnos + 1 reintento
  await uso({ servicio: 'embedding', vuelta: 0 }); // costo, pero no turno
  await uso({ vuelta: 0, estado: 'FALLIDA', costoUsd: null }); // no cuenta
  await prisma.pago.create({ data: { empresaId: e.id, tipo: 'MENSUALIDAD', monto: 100, moneda: 'BOB', estado: 'CONFIRMADO' } });
});
after(async () => { await prisma.empresa.delete({ where: { id: e.id } }).catch(() => {}); await prisma.tipoCambio.deleteMany({ where: { nota: 'test historico' } }); });

describe('informe retroactivo', () => {
  test('cuenta conversaciones, turnos (vuelta 0 de chat), créditos, costo en Bs y pagos', async () => {
    const r = await H.informe({ meses: 1 });
    const f = r.porEmpresa.find((x) => x.empresaId === e.id);
    assert.equal(f.conversaciones, 3); assert.equal(f.turnos, 2);
    assert.equal(f.creditos, 3 * 5 + 2 * 1);
    assert.equal(f.costoUsd, 4, 'suma todas las llamadas completadas: 2 turnos + reintento + embedding');
    assert.equal(f.costoBs, 40); assert.equal(f.ingresosBs, 100); assert.equal(f.margenBs, 60);
    assert.equal(f.costoBsPorCredito, Math.round((40 / 17) * 10000) / 10000);
  });
  test('agrupa por mes y los totales suman las empresas', async () => {
    const r = await H.informe({ meses: 1 });
    assert.equal(r.porMes.length, 1);
    assert.equal(r.totales.creditos, r.porEmpresa.reduce((a, x) => a + x.creditos, 0));
  });
  test('no escribe nada en el libro de créditos', async () => {
    const antes = await prisma.creditoMovimiento.count();
    await H.informe({ meses: 3 });
    assert.equal(await prisma.creditoMovimiento.count(), antes);
  });
  test('avisa desde cuándo hay registro de la IA', async () => {
    const r = await H.informe({ meses: 24 });
    assert.ok(r.cobertura.desde instanceof Date);
  });
});
