// Historial de actividad del agente: turnos, eventos, enmascarado de telefono y retencion de 120 dias con resumen previo.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const { prisma } = require('../lib/db');
const T = require('../lib/services/trazaIA');
const usoIA = require('../lib/services/usoIA');

const SLUG = 'test-historial-ia';
let empresa; let agente;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  empresa = await prisma.empresa.create({ data: { nombre: 'Tienda Historial', slug: SLUG, agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
  agente = empresa.agentes[0];
});
after(async () => { await prisma.empresa.delete({ where: { id: empresa.id } }).catch(() => {}); });

const datosTurno = (o = {}) => ({ empresaId: empresa.id, agenteId: agente.id, telefono: '59170001234', ...o });

describe('enmascarar', () => {
  test('deja solo el inicio y el final', () => {
    assert.equal(T.enmascarar('59170001234'), '5917***234');
    assert.equal(T.enmascarar('+591 7000-1234'), '5917***234');
    assert.equal(T.enmascarar('12345'), '1***');
    assert.equal(T.enmascarar(''), null);
  });
});

describe('conTurno', () => {
  test('un turno sin IA queda como FLUJO/OK, con el teléfono enmascarado', async () => {
    const salida = await T.conTurno(datosTurno(), async () => ({ ok: true, respuesta: 'hola' }));
    assert.equal(salida.respuesta, 'hola');
    const t = await prisma.turnoIA.findFirst({ where: { empresaId: empresa.id }, orderBy: { id: 'desc' } });
    assert.equal(t.ruta, 'FLUJO'); assert.equal(t.resultado, 'OK'); assert.equal(t.telefonoMasc, '5917***234'); assert.equal(t.entrada, 'TEXTO');
    assert.ok(t.latenciaMs >= 0);
  });
  test('suma las llamadas a la IA, liga usos_ia al turno y guarda eventos', async () => {
    await T.conTurno(datosTurno(), async () => {
      await usoIA.registrar({ empresaId: empresa.id, agenteId: agente.id, proveedor: 'openai', modelo: 'modelo-sin-tarifa-x', promptTokens: 100, completionTokens: 20, estado: 'COMPLETADA' });
      await usoIA.registrar({ empresaId: empresa.id, agenteId: agente.id, proveedor: 'openai', modelo: 'modelo-sin-tarifa-x', estado: 'FALLIDA', error: 'CAIDA' });
      T.desdeEtapa('tool_ejecutada', { tool: 'buscar_productos', fallidos: 0 });
      T.desdeEtapa('etapa_desconocida', { x: 1 });
      return { ok: true, respuesta: 'listo' };
    });
    const t = await prisma.turnoIA.findFirst({ where: { empresaId: empresa.id }, orderBy: { id: 'desc' }, include: { eventos: true } });
    assert.equal(t.ruta, 'IA'); assert.equal(t.llamadasIA, 1); assert.equal(t.fallidasIA, 1); assert.equal(t.tokensEntrada, 100); assert.equal(t.tokensSalida, 20);
    assert.deepEqual(t.eventos.map((e) => e.tipo), ['herramienta'], 'las etapas desconocidas no generan evento');
    assert.equal(await prisma.usoIA.count({ where: { turnoId: t.id } }), 2);
  });
  test('derivación, error y sin respuesta se distinguen; cita y prueba se marcan', async () => {
    await T.conTurno(datosTurno(), async () => { T.desdeEtapa('derivacion', { tipo: 'HUMANO' }); return { ok: true, respuesta: 'te paso con alguien' }; });
    assert.equal((await prisma.turnoIA.findFirst({ where: { empresaId: empresa.id }, orderBy: { id: 'desc' } })).resultado, 'DERIVADO');
    await T.conTurno(datosTurno(), async () => ({ ok: false, error: 'IA_CAIDA' }));
    assert.equal((await prisma.turnoIA.findFirst({ where: { empresaId: empresa.id }, orderBy: { id: 'desc' } })).resultado, 'ERROR');
    await T.conTurno(datosTurno(), async () => ({ ok: true, respuesta: null }));
    assert.equal((await prisma.turnoIA.findFirst({ where: { empresaId: empresa.id }, orderBy: { id: 'desc' } })).resultado, 'SIN_RESPUESTA');
    await T.conTurno(datosTurno({ citas: true, prueba: true }), async () => ({ ok: true, respuesta: 'x' }));
    const t = await prisma.turnoIA.findFirst({ where: { empresaId: empresa.id }, orderBy: { id: 'desc' } });
    assert.equal(t.ruta, 'CITAS'); assert.equal(t.entrada, 'PRUEBA'); assert.equal(t.prueba, true);
  });
  test('si la atención lanza una excepción, el turno queda en ERROR y la excepción sigue su camino', async () => {
    await assert.rejects(() => T.conTurno(datosTurno(), async () => { throw new Error('boom'); }), /boom/);
    const t = await prisma.turnoIA.findFirst({ where: { empresaId: empresa.id }, orderBy: { id: 'desc' } });
    assert.equal(t.resultado, 'ERROR'); assert.equal(t.error, 'boom');
  });
  test('fuera de un turno los eventos de etapa se ignoran y usoIA no falla', async () => {
    const antes = await prisma.eventoIA.count({ where: { empresaId: empresa.id } });
    T.desdeEtapa('derivacion', { tipo: 'X' });
    const u = await usoIA.registrar({ empresaId: empresa.id, proveedor: 'openai', modelo: 'm', promptTokens: 1, completionTokens: 1 });
    assert.equal(u.turnoId, null);
    assert.equal(await prisma.eventoIA.count({ where: { empresaId: empresa.id } }), antes);
  });
  test('evento suelto (media no soportada) se guarda sin turno', async () => {
    await T.eventoSuelto({ empresaId: empresa.id, agenteId: agente.id, tipo: 'media_no_soportada', detalle: { tipo: 'audio' } });
    const e = await prisma.eventoIA.findFirst({ where: { empresaId: empresa.id, tipo: 'media_no_soportada' } });
    assert.equal(e.turnoId, null); assert.equal(e.detalle.tipo, 'audio');
  });
});

describe('retención de 120 días', () => {
  test('resume antes de borrar, borra lo viejo, conserva lo reciente y es idempotente', async () => {
    const vieja = DateTime.now().minus({ days: 130 }).toJSDate();
    const reciente = DateTime.now().minus({ days: 10 }).toJSDate();
    const base = { empresaId: empresa.id, agenteId: agente.id };
    const v1 = await prisma.turnoIA.create({ data: { ...base, ruta: 'IA', resultado: 'OK', llamadasIA: 2, tokensEntrada: 100, tokensSalida: 50, costoUsd: 0.001, latenciaMs: 1000, createdAt: vieja } });
    await prisma.turnoIA.create({ data: { ...base, ruta: 'FLUJO', resultado: 'ERROR', latenciaMs: 3000, createdAt: vieja } });
    await prisma.turnoIA.create({ data: { ...base, ruta: 'FLUJO', resultado: 'OK', prueba: true, createdAt: vieja } });
    await prisma.eventoIA.create({ data: { ...base, turnoId: v1.id, tipo: 'herramienta', createdAt: vieja } });
    const r1 = await prisma.turnoIA.create({ data: { ...base, resultado: 'OK', createdAt: reciente } });

    const r = await T.purgar();
    assert.ok(r.turnosBorrados >= 3 && r.eventosBorrados >= 1);
    assert.equal(await prisma.turnoIA.count({ where: { id: v1.id } }), 0);
    assert.equal(await prisma.turnoIA.count({ where: { id: r1.id } }), 1, 'lo reciente se conserva');

    const fecha = new Date(`${DateTime.fromJSDate(vieja).setZone('America/La_Paz').toFormat('yyyy-MM-dd')}T00:00:00.000Z`);
    const res = await prisma.resumenIADiario.findUnique({ where: { fecha_empresaId: { fecha, empresaId: empresa.id } } });
    assert.ok(res, 'el resumen existe');
    assert.equal(res.turnos, 2, 'los turnos de prueba no cuentan');
    assert.equal(res.errores, 1); assert.equal(res.llamadasIA, 2); assert.equal(res.tokens, 150);
    assert.equal(res.porRuta.IA, 1); assert.equal(res.porRuta.FLUJO, 1);
    assert.equal(Number(res.costoUsd), 0.001);

    const r2 = await T.purgar();
    assert.equal(r2.turnosBorrados, 0);
    assert.equal((await prisma.resumenIADiario.findUnique({ where: { fecha_empresaId: { fecha, empresaId: empresa.id } } })).turnos, 2, 'el resumen no se pisa al repetir');
  });
});
