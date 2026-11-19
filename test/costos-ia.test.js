// Costos de IA completos: tarifas versionadas, registro de cada solicitud (completada y fallida) y tipo de cambio con fuente y fecha.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const tarifas = require('../lib/services/tarifasIA');
const usoIA = require('../lib/services/usoIA');
const tc = require('../lib/services/tipoCambio');
const { generarRespuesta } = require('../lib/services/agente');
const saludIA = require('../lib/services/saludIA');

const SLUG = 'test-costos-ia';
const TEL = '000-test-costos-ia';
let empresa; let agente; let conv;
const MODELO = 'modelo-de-prueba-costos';

before(async () => {
  await prisma.usoIA.deleteMany({ where: { empresa: { slug: SLUG } } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  await prisma.tarifaIA.deleteMany({ where: { modelo: MODELO } });
  await prisma.tipoCambio.deleteMany({});
  empresa = await prisma.empresa.create({ data: { nombre: 'Costos IA', slug: SLUG, moneda: 'BOB', agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } }, include: { agentes: true } });
  agente = empresa.agentes[0];
  conv = await prisma.conversacion.create({ data: { agenteId: agente.id, telefonoCliente: TEL, ultimoMensajeAt: new Date() } });
});
after(async () => {
  await prisma.usoIA.deleteMany({ where: { empresaId: empresa.id } });
  await prisma.empresa.delete({ where: { id: empresa.id } }).catch(() => {});
  await prisma.tarifaIA.deleteMany({ where: { modelo: MODELO } });
  await prisma.tipoCambio.deleteMany({});
  tarifas.limpiarCache();
});
beforeEach(() => { tarifas.limpiarCache(); saludIA.reiniciar(); });

describe('tarifas versionadas', () => {
  test('el costo suma entrada (sin caché), caché y salida, con 6 decimales', () => {
    const t = { entradaUsdPorM: 2.5, cacheUsdPorM: 1.25, salidaUsdPorM: 10 };
    assert.equal(tarifas.costo(t, { promptTokens: 1000, cachedTokens: 400, completionTokens: 200 }), (600 * 2.5 + 400 * 1.25 + 200 * 10) / 1e6);
    assert.equal(tarifas.costo(t, {}), 0);
    assert.equal(tarifas.costo(null, { promptTokens: 5 }), null, 'sin tarifa no se inventa un costo');
  });
  test('las tarifas iniciales salieron del código a la base', async () => {
    const t = await tarifas.vigente({ proveedor: 'openai', modelo: 'gpt-4o-mini' });
    assert.equal(Number(t.entradaUsdPorM), 0.15);
    assert.equal(Number(t.salidaUsdPorM), 0.6);
    const e = await tarifas.vigente({ proveedor: 'openai', modelo: 'text-embedding-3-small', servicio: 'embedding' });
    assert.equal(Number(e.entradaUsdPorM), 0.02);
    assert.equal(await tarifas.vigente({ proveedor: 'openai', modelo: 'no-existe' }), null);
  });
  test('cambiar un precio cierra la vigente y abre la nueva: cada fecha usa SU tarifa', async () => {
    const inicio = new Date('2026-01-01T00:00:00Z');
    await tarifas.cambiar({ proveedor: 'openai', modelo: MODELO, entradaUsdPorM: 1, salidaUsdPorM: 2, desde: inicio });
    await tarifas.cambiar({ proveedor: 'openai', modelo: MODELO, entradaUsdPorM: 3, salidaUsdPorM: 6, cacheUsdPorM: 0.5, desde: new Date('2026-06-01T00:00:00Z') });
    const antes = await tarifas.vigente({ proveedor: 'openai', modelo: MODELO, fecha: new Date('2026-03-01T00:00:00Z') });
    const despues = await tarifas.vigente({ proveedor: 'openai', modelo: MODELO, fecha: new Date('2026-07-01T00:00:00Z') });
    assert.equal(Number(antes.entradaUsdPorM), 1);
    assert.equal(Number(despues.entradaUsdPorM), 3);
    assert.equal(Number(despues.cacheUsdPorM), 0.5);
    assert.equal(Number(antes.cacheUsdPorM), 1, 'sin precio de caché usa el de entrada');
    assert.ok(antes.vigenteHasta, 'la anterior quedó cerrada');
    assert.equal(await tarifas.vigente({ proveedor: 'openai', modelo: MODELO, fecha: new Date('2025-12-31T00:00:00Z') }), null, 'antes de la primera no hay tarifa');
  });
  test('valida: valores, fechas y que la nueva empiece después de la vigente', async () => {
    await assert.rejects(tarifas.cambiar({ proveedor: '', modelo: 'x', entradaUsdPorM: 1, salidaUsdPorM: 1 }), /proveedor y el modelo/);
    await assert.rejects(tarifas.cambiar({ proveedor: 'openai', modelo: MODELO, entradaUsdPorM: -1, salidaUsdPorM: 1 }), /números de 0 o más/);
    await assert.rejects(tarifas.cambiar({ proveedor: 'openai', modelo: MODELO, entradaUsdPorM: 'abc', salidaUsdPorM: 1 }), /números de 0 o más/);
    await assert.rejects(tarifas.cambiar({ proveedor: 'openai', modelo: MODELO, entradaUsdPorM: 1, salidaUsdPorM: 1, desde: new Date('2026-01-01T00:00:00Z') }), /después de la que está vigente/);
    await assert.rejects(tarifas.cambiar({ proveedor: 'openai', modelo: MODELO, entradaUsdPorM: 1, salidaUsdPorM: 1, desde: 'no-es-fecha' }), /fecha de vigencia/);
  });
});

describe('registro de cada solicitud', () => {
  test('una completada guarda tokens, costo con la tarifa vigente, id del proveedor, latencia y agente', async () => {
    const u = await usoIA.registrar({ empresaId: empresa.id, agenteId: agente.id, conversacionId: conv.id, proveedor: 'openai', modelo: 'gpt-4o-mini', promptTokens: 2000, cachedTokens: 500, completionTokens: 300, solicitudId: 'chatcmpl-abc', latenciaMs: 850 });
    assert.equal(u.estado, 'COMPLETADA');
    // 1500 x 0,15 + 500 x 0,075 + 300 x 0,60 = 442,5 millonésimos de dólar: la columna guarda 6 decimales (0,000443).
    assert.equal(Number(u.costoUsd), 0.000443);
    assert.equal(u.solicitudId, 'chatcmpl-abc');
    assert.equal(u.latenciaMs, 850);
    assert.equal(u.agenteId, agente.id);
    assert.ok(u.tarifaId);
    assert.equal(u.costoFuente, 'CALCULADO');
  });
  test('una fallida deja fila SIN costo ni tokens (no se inventa un importe)', async () => {
    const u = await usoIA.registrar({ empresaId: empresa.id, proveedor: 'openai', modelo: 'gpt-4o-mini', promptTokens: 999, estado: 'FALLIDA', error: 'CAIDA', latenciaMs: 15000 });
    assert.equal(u.estado, 'FALLIDA');
    assert.equal(u.costoUsd, null);
    assert.equal(u.tarifaId, null);
    assert.equal(u.promptTokens, 0);
    assert.equal(u.error, 'CAIDA');
  });
  test('un modelo sin tarifa queda sin costo; el embedding usa su propia tarifa', async () => {
    const sin = await usoIA.registrar({ empresaId: empresa.id, proveedor: 'openai', modelo: 'modelo-sin-tarifa', promptTokens: 100, completionTokens: 10 });
    assert.equal(sin.costoUsd, null);
    const emb = await usoIA.registrar({ empresaId: empresa.id, proveedor: 'openai', modelo: 'text-embedding-3-small', servicio: 'embedding', promptTokens: 1000000 });
    assert.equal(Number(emb.costoUsd), 0.02);
    assert.equal(emb.servicio, 'embedding');
  });
  test('registrarSinRiesgo nunca rompe: ante un error devuelve null', async () => {
    assert.equal(await usoIA.registrarSinRiesgo({ empresaId: 999999999, proveedor: 'openai', modelo: 'gpt-4o-mini' }), null);
  });
  test('los topes propios y el circuito abierto no son solicitudes al proveedor', () => {
    assert.equal(usoIA.huboLlamada({ tipoIA: 'TOPE_EMPRESA' }), false);
    assert.equal(usoIA.huboLlamada({ tipoIA: 'TOPE_CLIENTE' }), false);
    assert.equal(usoIA.huboLlamada({ tipoIA: 'CIRCUITO_ABIERTO' }), false);
    assert.equal(usoIA.huboLlamada({ tipoIA: 'CAIDA' }), true);
    assert.equal(usoIA.huboLlamada(new Error('x')), true);
  });
});

describe('el agente registra cada llamada (de verdad, por el camino real)', () => {
  const escribe = async (texto, llamar) => {
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: texto } });
    return generarRespuesta(agente.id, TEL, [{ rol: 'AGENTE', contenido: 'Hola' }], texto, conv.id, { llamarInyectado: llamar, baseUrl: 'https://tienda.test' });
  };
  beforeEach(async () => { await prisma.usoIA.deleteMany({ where: { empresaId: empresa.id } }); });

  test('una llamada que responde deja una fila completada con costo, latencia y el id del proveedor', async () => {
    await prisma.clienteFinal.upsert({ where: { empresaId_telefono: { empresaId: empresa.id, telefono: TEL } }, update: {}, create: { empresaId: empresa.id, telefono: TEL } });
    await escribe('hola, me podés contar qué venden por favor', async () => ({ content: 'Contame qué necesitás 🙂', tool_calls: [], usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 200 } }, solicitudId: 'req-123' }));
    const filas = await prisma.usoIA.findMany({ where: { empresaId: empresa.id } });
    assert.ok(filas.length > 0, 'el turno tenía que llamar a la IA y registrar el uso');
    const f = filas[0];
    assert.equal(f.estado, 'COMPLETADA');
    assert.equal(f.agenteId, agente.id);
    assert.equal(f.conversacionId, conv.id);
    assert.equal(f.solicitudId, 'req-123');
    assert.ok(f.latenciaMs >= 0);
    assert.equal(f.promptTokens, 1200);
    assert.equal(f.cachedTokens, 200);
    const t = await tarifas.vigente({ proveedor: f.proveedor, modelo: f.modelo });
    if (t) assert.equal(Number(f.costoUsd), tarifas.costo(t, { promptTokens: 1200, cachedTokens: 200, completionTokens: 80 }));
  });
  test('una llamada que FALLA también deja fila (estado fallida, tipo de error, sin costo)', async () => {
    await escribe('hola, me podés contar qué venden por favor', async () => { const e = new Error('Service unavailable'); e.status = 503; throw e; });
    const filas = await prisma.usoIA.findMany({ where: { empresaId: empresa.id, estado: 'FALLIDA' } });
    assert.ok(filas.length > 0, 'la llamada fallida tenía que quedar registrada');
    assert.equal(filas[0].error, 'CAIDA');
    assert.equal(filas[0].costoUsd, null);
    assert.equal(filas[0].agenteId, agente.id);
  });
});

describe('tipo de cambio', () => {
  const HTML_BCB = `<section><style>.x{color:red}</style><h2>TIPO DE CAMBIO OFICIAL DEL DÓLAR ESTADOUNIDENSE</h2><p>Última cotización Bs 11,68/$us FECHA DE CORTE: MIÉRCOLES 18 DE NOVIEMBRE DE 2026</p>
    <div>El TCO de Bs 11,68/$us tiene vigencia el jueves 19 de noviembre de 2026</div></section>`;

  test('lee el número boliviano (coma decimal, punto de miles)', () => {
    assert.equal(tc.aNumeroBO('11,68'), 11.68);
    assert.equal(tc.aNumeroBO('1.234,56'), 1234.56);
    assert.equal(tc.aNumeroBO('6.96'), 6.96);
    assert.ok(Number.isNaN(tc.aNumeroBO('')));
  });
  test('lee la página del BCB: valor y fecha de vigencia', () => {
    assert.deepEqual(tc.leerBCB(HTML_BCB), { valor: 11.68, fecha: '2026-11-19' });
    assert.equal(tc.leerBCB('<p>sin cotización</p>'), null);
    assert.equal(tc.leerBCB('El TCO de Bs 11,68/$us tiene vigencia el jueves 19 de nomes de 2026'), null);
    assert.equal(tc.leerBCB('El TCO de Bs 999,00/$us tiene vigencia el jueves 19 de noviembre de 2026'), null, 'un valor absurdo es un error de lectura');
  });
  test('lee la API de respaldo', () => {
    assert.equal(tc.leerAPI({ result: 'success', rates: { BOB: 11.7 } }).valor, 11.7);
    assert.equal(tc.leerAPI({ result: 'error' }), null);
    assert.equal(tc.leerAPI({ result: 'success', rates: {} }), null);
  });

  const http = (rutas) => async (url) => {
    const k = Object.keys(rutas).find((x) => url.includes(x));
    const r = k ? rutas[k] : { status: 500 };
    if (r.lanza) throw new Error(r.lanza);
    return { ok: !r.status || r.status < 400, status: r.status || 200, text: async () => r.html || '', json: async () => r.json || {}, arrayBuffer: async () => new TextEncoder().encode(r.html || '').buffer };
  };

  test('actualizar: usa el BCB si se puede leer', async () => {
    await prisma.tipoCambio.deleteMany({});
    const r = await tc.actualizar({ http: http({ 'bcb.gob.bo': { html: HTML_BCB }, 'er-api.com': { json: { result: 'success', rates: { BOB: 11.7 } } } }) });
    assert.deepEqual([r.ok, r.fuente, r.valor, r.fecha], [true, 'BCB', 11.68, '2026-11-19']);
    assert.equal(await prisma.tipoCambio.count({ where: { fuente: 'API' } }), 0, 'la API no se usa si el BCB responde');
  });
  test('actualizar: si el BCB no se puede leer, usa la API de respaldo y lo avisa', async () => {
    await prisma.tipoCambio.deleteMany({});
    const r = await tc.actualizar({ http: http({ 'bcb.gob.bo': { html: '<p>cambió el formato</p>' }, 'er-api.com': { json: { result: 'success', rates: { BOB: 11.7 } } } }) });
    assert.deepEqual([r.ok, r.fuente, r.valor], [true, 'API', 11.7]);
    assert.match(r.errores[0], /BCB/);
    const r2 = await tc.actualizar({ http: http({ 'bcb.gob.bo': { lanza: 'sin red' }, 'er-api.com': { json: { result: 'success', rates: { BOB: 11.71 } } } }) });
    assert.equal(r2.fuente, 'API');
  });
  test('actualizar: si todo falla, no guarda nada y explica por qué', async () => {
    await prisma.tipoCambio.deleteMany({});
    const r = await tc.actualizar({ http: http({ 'bcb.gob.bo': { status: 503 }, 'er-api.com': { lanza: 'caída' } }) });
    assert.equal(r.ok, false);
    assert.equal(r.errores.length, 2);
    assert.equal(await prisma.tipoCambio.count(), 0);
  });
  test('del día: el último publicado hasta esa fecha; el manual manda sobre el BCB y el BCB sobre la API', async () => {
    await prisma.tipoCambio.deleteMany({});
    const d = (iso) => new Date(`${iso}T00:00:00.000Z`);
    await prisma.tipoCambio.createMany({ data: [
      { fecha: d('2026-11-10'), bobPorUsd: 11.5, fuente: 'BCB' },
      { fecha: d('2026-11-12'), bobPorUsd: 11.6, fuente: 'API' },
      { fecha: d('2026-11-12'), bobPorUsd: 11.62, fuente: 'BCB' },
      { fecha: d('2026-11-12'), bobPorUsd: 11.7, fuente: 'MANUAL' },
    ] });
    assert.deepEqual(await tc.delDia('2026-11-10'), { bobPorUsd: 11.5, fecha: '2026-11-10', fuente: 'BCB', diasAntiguedad: 0 });
    const x = await tc.delDia('2026-11-12');
    assert.deepEqual([x.bobPorUsd, x.fuente], [11.7, 'MANUAL']);
    const y = await tc.delDia('2026-11-15');
    assert.deepEqual([y.fecha, y.diasAntiguedad], ['2026-11-12', 3]);
    assert.equal(await tc.delDia('2026-11-01'), null, 'antes del primer dato no hay cambio');
  });
  test('convierte USD a Bs con el cambio de SU fecha, y sin cambio devuelve null', async () => {
    assert.equal(await tc.usdABs(10, '2026-11-10'), 115);
    assert.equal(await tc.usdABs(10, '2026-11-12'), 117);
    assert.equal(await tc.usdABs(10, '2026-11-01'), null);
    assert.equal(await tc.usdABs(null, '2026-11-12'), null);
  });
  test('el valor manual se valida y tiene prioridad', async () => {
    await assert.rejects(tc.ponerManual({ valor: 'abc' }), /entre 1 y 100/);
    await assert.rejects(tc.ponerManual({ valor: '0,5' }), /entre 1 y 100/);
    await assert.rejects(tc.ponerManual({ valor: '11,9', fecha: '19/11/2026' }), /fecha no es válida/);
    await tc.ponerManual({ valor: '11,90', fecha: '2026-11-20', nota: 'corrección' });
    assert.equal((await tc.delDia('2026-11-20')).bobPorUsd, 11.9);
  });
});
