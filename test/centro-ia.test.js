// Centro de IA (superadmin): resumen, lista filtrable y detalle de un turno. Las pruebas del panel no cuentan.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { prisma } = require('../lib/db');
const C = require('../lib/services/centroIA');

const SLUG = 'test-centro-ia';
let empresa; let agente; let turnoError;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  empresa = await prisma.empresa.create({ data: { nombre: 'Tienda Centro IA', slug: SLUG, agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
  agente = empresa.agentes[0];
  const b = { empresaId: empresa.id, agenteId: agente.id, telefonoMasc: '5917***234' };
  await prisma.turnoIA.create({ data: { ...b, ruta: 'FLUJO', resultado: 'OK', latenciaMs: 200 } });
  await prisma.turnoIA.create({ data: { ...b, ruta: 'IA', resultado: 'OK', llamadasIA: 1, latenciaMs: 2000 } });
  turnoError = await prisma.turnoIA.create({ data: { ...b, ruta: 'IA', resultado: 'ERROR', fallidasIA: 1, error: 'IA_CAIDA', latenciaMs: 4000 } });
  await prisma.turnoIA.create({ data: { ...b, ruta: 'FLUJO', resultado: 'ERROR', prueba: true } });
  await prisma.eventoIA.create({ data: { empresaId: empresa.id, turnoId: turnoError.id, tipo: 'envio_fallido', gravedad: 'ERROR', detalle: { tipo: 'imagen' } } });
  await prisma.usoIA.create({ data: { empresaId: empresa.id, agenteId: agente.id, turnoId: turnoError.id, proveedor: 'openai', modelo: 'm', promptTokens: 0, completionTokens: 0, estado: 'FALLIDA', error: 'CAIDA' } });
});
after(async () => { await prisma.empresa.delete({ where: { id: empresa.id } }).catch(() => {}); });

describe('resumen', () => {
  test('cuenta turnos y problemas sin contar los de prueba', async () => {
    const r = await C.resumen({ dias: 7 });
    assert.ok(r.total >= 3);
    const mia = r.empresasProblema.find((e) => e.empresaId === empresa.id);
    assert.equal(mia.n, 1, 'solo el error real, no el de prueba');
    assert.ok(r.eventos.some((e) => e.tipo === 'envio_fallido' && e.gravedad === 'ERROR'));
    assert.ok(r.porRuta.find((x) => x.ruta === 'IA').n >= 2);
  });
});

describe('listarTurnos', () => {
  test('filtra por empresa, resultado y solo problemas; excluye pruebas', async () => {
    const todos = await C.listarTurnos({ empresaId: empresa.id });
    assert.equal(todos.total, 3);
    assert.equal((await C.listarTurnos({ empresaId: empresa.id, resultado: 'ERROR' })).total, 1);
    assert.equal((await C.listarTurnos({ empresaId: empresa.id, soloProblemas: true })).total, 1);
    assert.equal((await C.listarTurnos({ empresaId: empresa.id, ruta: 'FLUJO' })).total, 1);
    assert.equal((await C.listarTurnos({ empresaId: empresa.id, resultado: 'inventado' })).total, 3, 'un filtro inválido se ignora');
  });
  test('pagina y trae el nombre de la empresa', async () => {
    const l = await C.listarTurnos({ empresaId: empresa.id, pagina: 99 });
    assert.equal(l.filas.length, 0);
    const p = await C.listarTurnos({ empresaId: empresa.id });
    assert.equal(p.filas[0].empresa.nombre, 'Tienda Centro IA');
  });
});

describe('detalleTurno', () => {
  test('devuelve eventos y solicitudes a la IA del turno; null si no existe', async () => {
    const d = await C.detalleTurno(turnoError.id);
    assert.equal(d.turno.eventos.length, 1);
    assert.equal(d.usos.length, 1);
    assert.equal(await C.detalleTurno(999999999), null);
  });
});

describe('seguridad del historial', () => {
  test('las pantallas del Centro de IA no muestran teléfonos completos ni contenido de mensajes', () => {
    const fuente = ['ia.ejs', 'ia-turnos.ejs', 'ia-turno.ejs'].map((f) => fs.readFileSync(require.resolve(`../views/admin/${f}`), 'utf8')).join('\n');
    assert.doesNotMatch(fuente, /telefonoCliente|\.contenido/);
  });
});
