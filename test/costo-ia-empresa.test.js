// Detalle del costo de IA de una empresa: en qué se fue (tipo de token, para qué, herramientas, modelos, turnos más caros).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const D = require('../lib/services/costoIAEmpresa');
const usoIA = require('../lib/services/usoIA');
const trazaIA = require('../lib/services/trazaIA');

const SLUG = 'test-costo-ia-empresa';
let e; let agente; let tarifa;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  e = await prisma.empresa.create({ data: { nombre: 'Costo Detalle', slug: SLUG, agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
  agente = e.agentes[0];
  tarifa = await prisma.tarifaIA.findFirst({ where: { servicio: 'chat', vigenteHasta: null } });
  assert.ok(tarifa, 'hace falta una tarifa de chat cargada');
  const llamar = (extra) => usoIA.registrar({ empresaId: e.id, agenteId: agente.id, proveedor: tarifa.proveedor, modelo: tarifa.modelo, promptTokens: 1000, cachedTokens: 400, completionTokens: 100, ...extra });
  // Turno 1: con herramienta (buscar_producto): principal + continuación
  await trazaIA.conTurno({ empresaId: e.id, agenteId: agente.id, telefono: '59170001111' }, async () => {
    await llamar({ vuelta: 0 }); await llamar({ vuelta: 1 });
    trazaIA.desdeEtapa('tool_ejecutada', { tool: 'buscar_producto', fallidos: 0 });
    return { ok: true, respuesta: 'x' };
  });
  // Turno 2: con corrección automática
  await trazaIA.conTurno({ empresaId: e.id, agenteId: agente.id, telefono: '59170002222' }, async () => {
    await llamar({ vuelta: 0 }); await llamar({ vuelta: 1, proposito: 'reintento_forzado' });
    return { ok: true, respuesta: 'x' };
  });
  // Búsqueda semántica
  const emb = await prisma.tarifaIA.findFirst({ where: { servicio: 'embedding', vigenteHasta: null } });
  if (emb) await usoIA.registrar({ empresaId: e.id, proveedor: emb.proveedor, modelo: emb.modelo, servicio: 'embedding', promptTokens: 50, completionTokens: 0 });
});
after(async () => { await prisma.empresa.delete({ where: { id: e.id } }).catch(() => {}); });

describe('detalle del costo de IA', () => {
  test('el costo por tipo de token suma el total y separa entrada, caché y salida', async () => {
    const d = await D.detalle(e.id);
    assert.equal(d.llamadas >= 4, true);
    const suma = d.porToken.reduce((a, x) => a + x.usd, 0);
    assert.ok(Math.abs(suma - d.totalUsd) < 0.00001, `${suma} vs ${d.totalUsd}`);
    const entrada = d.porToken.find((x) => x.clave === 'entrada'); const cache = d.porToken.find((x) => x.clave === 'cache'); const salida = d.porToken.find((x) => x.clave === 'salida');
    assert.ok(entrada.tokens >= 2400 && cache.tokens >= 1600 && salida.tokens >= 400, 'separa los tokens nuevos de los cacheados');
    assert.ok(entrada.pct + cache.pct + salida.pct > 99 && entrada.pct + cache.pct + salida.pct < 101);
  });
  test('reparte las llamadas por uso: principal, continuación, corrección y búsqueda', async () => {
    const d = await D.detalle(e.id);
    const k = (c) => (d.porEtapa.find((x) => x.clave === c) || { llamadas: 0 }).llamadas;
    assert.equal(k('PRINCIPAL'), 2); assert.equal(k('CONTINUACION'), 1); assert.equal(k('CORRECCION'), 1);
    assert.equal(d.porEtapa.reduce((a, x) => a + x.llamadas, 0), d.llamadas);
  });
  test('por herramienta: el costo de los turnos donde se usó, con nombre legible', async () => {
    const d = await D.detalle(e.id);
    const h = d.herramientas.find((x) => x.tool === 'buscar_producto');
    assert.equal(h.nombre, 'Buscar un producto'); assert.equal(h.turnos, 1);
    assert.ok(h.usd > 0 && h.tokens > 0);
  });
  test('lista los turnos más caros con enlace a su detalle', async () => {
    const d = await D.detalle(e.id);
    assert.ok(d.masCaros.length >= 2);
    assert.ok(d.masCaros[0].usd >= d.masCaros[1].usd);
    assert.match(d.masCaros.find((c) => c.herramientas).herramientas, /Buscar un producto/);
  });
  test('una empresa que no existe devuelve null y los períodos inválidos usan 30 días', async () => {
    assert.equal(await D.detalle(999999999), null);
    assert.equal((await D.detalle(e.id, { dias: 5 })).dias, 30);
  });
});
