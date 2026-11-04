// Referencias a lo que ya se mostró ("la más barata", "la negra", "la segunda"), resueltas sin IA.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');
const { resolverReferencia, preguntaDeAclaracion } = require('../lib/services/referencias');

const prod = (nombre, precio, colores, categoria = 'Zapatillas') => ({
  nombre, precio, categoria: { nombre: categoria }, variantes: colores.map((c) => ({ atributos: { Color: c, Talla: '42' } })),
});
const RUNNER = prod('Zapatilla Runner', 300, ['Negro']);
const URBANA = prod('Zapatilla Urbana', 250, ['Blanco']);
const TRAIL = prod('Zapatilla Trail', 650, ['Negro']);
const MOSTRADOS = [RUNNER, URBANA, TRAIL];

describe('resolverReferencia', () => {
  const nombre = (t, m = MOSTRADOS) => { const r = resolverReferencia(t, m); return r && r.producto ? r.producto.nombre : r && r.ambiguos ? r.ambiguos.map((p) => p.nombre) : null; };

  test('superlativos por precio', () => {
    assert.equal(nombre('la más barata'), 'Zapatilla Urbana');
    assert.equal(nombre('me llevo la más cara'), 'Zapatilla Trail');
    assert.equal(nombre('la menos cara por favor'), 'Zapatilla Urbana');
  });
  test('por posición', () => {
    assert.equal(nombre('la primera'), 'Zapatilla Runner');
    assert.equal(nombre('quiero la segunda'), 'Zapatilla Urbana');
    assert.equal(nombre('la última'), 'Zapatilla Trail');
    assert.equal(nombre('me interesa la 3'), 'Zapatilla Trail');
  });
  test('por lo que la distingue: color o precio', () => {
    assert.equal(nombre('me gusta la blanca'), 'Zapatilla Urbana');
    assert.equal(nombre('la de 650'), 'Zapatilla Trail');
    assert.equal(nombre('quiero la de 250'), 'Zapatilla Urbana');
  });
  test('si calzan dos, no elige: devuelve las dos para preguntar', () => {
    assert.deepEqual(nombre('la negra'.replace('la negra', 'me gusta la negra')), ['Zapatilla Runner', 'Zapatilla Trail']);
  });
  test('un empate de precio también pregunta', () => {
    assert.deepEqual(nombre('la más barata', [prod('A', 100, ['Rojo']), prod('B', 100, ['Azul'])]), ['A', 'B']);
  });
  test('lo que NO es una referencia devuelve null', () => {
    for (const t of ['hola', 'quiero ver zapatillas', 'cuánto cuesta el envío', 'sí', 'la tienen en talla 43?', 'dónde están']) assert.equal(nombre(t), null, t);
  });
  test('con menos de 2 opciones mostradas no hay a qué referirse', () => assert.equal(nombre('la más barata', [RUNNER]), null));
  test('mira solo las últimas 3 mostradas', () => {
    const viejas = [prod('Vieja uno', 10, ['Rojo']), prod('Vieja dos', 20, ['Azul'])];
    assert.equal(nombre('la más barata', [...viejas, ...MOSTRADOS]), 'Zapatilla Urbana');
  });
  test('la pregunta de aclaración numera las opciones', () => {
    const q = preguntaDeAclaracion([RUNNER, TRAIL], (m) => `Bs ${m.toFixed(2)}`);
    assert.match(q, /1\) Zapatilla Runner — Bs 300\.00\n2\) Zapatilla Trail — Bs 650\.00/);
  });
});

describe('generarRespuesta: referencias a lo mostrado', () => {
  const TEL = '000-test-referencias';
  let empresaId; let agenteId; let conv; let ids = {};

  before(async () => {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.deleteMany({ where: { slug: 'test-referencias' } });
    const empresa = await prisma.empresa.create({
      data: { nombre: 'Tienda Ref', slug: 'test-referencias', moneda: 'BOB', agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] } },
      include: { agentes: true },
    });
    empresaId = empresa.id;
    agenteId = empresa.agentes[0].id;
    conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TEL, ultimoMensajeAt: new Date() } });
    const cat = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
    const crear = async (nombre, precio, color) => prisma.producto.create({
      data: { empresaId, categoriaId: cat.id, nombre, precio, stock: 0, atributos: {}, fotos: [], variantes: { create: [{ atributos: { Color: color }, stock: 5, fotos: [] }] } },
    });
    ids = { cat: cat.id, runner: (await crear('Zapatilla Runner', 300, 'Negro')).id, urbana: (await crear('Zapatilla Urbana', 250, 'Blanco')).id, trail: (await crear('Zapatilla Trail', 650, 'Negro')).id };
  });
  after(async () => {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  });

  async function escribe(texto, mostrados) {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.clienteFinal.create({
      data: { empresaId, telefono: TEL, categoriaId: ids.cat, categoriaInteres: 'Zapatillas', productosMostrados: mostrados, contexto: { tarjetasCategoriaMostradas: [ids.cat] } },
    });
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: texto } });
    const vistos = [];
    const llamar = async ({ mensajes }) => { vistos.push(mensajes[mensajes.length - 1].content); return { content: 'Listo, avisame si necesitas algo mas.', tool_calls: [] }; };
    const salida = await generarRespuesta(agenteId, TEL, [{ rol: 'AGENTE', contenido: 'Hola' }], texto, conv.id, { llamarInyectado: llamar });
    return { salida, vistos };
  }

  test('"la más barata": el motor ya sabe cuál es y se lo dice al resto del flujo', async () => {
    const { vistos } = await escribe('me gusta la más barata', [ids.runner, ids.urbana, ids.trail]);
    assert.ok(vistos.length > 0, 'siguió el camino normal con la IA');
    assert.match(vistos[0], /me refiero a Zapatilla Urbana/);
  });

  test('"la negra" con dos negras: pregunta cuál, sin IA', async () => {
    const { salida, vistos } = await escribe('me gusta la negra', [ids.runner, ids.urbana, ids.trail]);
    assert.equal(vistos.length, 0);
    assert.match(salida.respuesta, /¿Cuál de estas\?/);
    assert.match(salida.respuesta, /Zapatilla Runner/);
    assert.match(salida.respuesta, /Zapatilla Trail/);
    assert.doesNotMatch(salida.respuesta, /Urbana/);
  });
});
