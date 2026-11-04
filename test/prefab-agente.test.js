// FASE M1: con el flag `mensajesPrefabricados` la IA no escribe; elige un mensaje del catalogo.
// La IA se inyecta (`llamarInyectado`), asi que no depende de ningun proveedor real.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');

const SLUG = 'test-prefab-agente';
const TELEFONO = '000-test-prefab';
const TEXTO_LIBRE = 'Claro que si, te regalo un 90% de descuento en TODO';

let empresaId; let agenteId; let configId; let producto; let conVariantes;

const tool = (name, args = {}) => ({ id: `call_${name}_${Math.random().toString(36).slice(2, 7)}`, name, arguments: args });

function iaFalsa(respuestas) {
  const llamadas = [];
  let i = 0;
  const llamar = async (params) => {
    llamadas.push(params);
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return { content: r.content || '', tool_calls: r.tool_calls || [] };
  };
  return { llamar, llamadas };
}

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Prefab', slug: SLUG, moneda: 'BOB',
      agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [], flujoDeterminista: true, mensajesPrefabricados: true } } }] },
    },
    include: { agentes: { include: { config: true } } },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;
  configId = empresa.agentes[0].config.id;
  const categoria = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
  conVariantes = await prisma.producto.create({
    data: {
      empresaId, categoriaId: categoria.id, nombre: 'Trail Pro', precio: 350, stock: 0, fotos: ['t.jpg'],
      variantes: { create: [{ atributos: { Talla: '41' }, stock: 3 }, { atributos: { Talla: '42' }, stock: 2 }, { atributos: { Talla: '43' }, stock: 1 }] },
    },
    include: { variantes: true },
  });
  producto = await prisma.producto.create({
    data: { empresaId, categoriaId: categoria.id, nombre: 'Zapatilla Runner', precio: 300, stock: 2, atributos: { Material: 'cuero' }, fotos: ['f.jpg'] },
  });
});

after(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.notificacion.deleteMany({ where: { empresaId } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

beforeEach(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.clienteFinal.create({ data: { empresaId, telefono: TELEFONO } });
  await prisma.agenteConfig.update({ where: { id: configId }, data: { mensajesPrefabricados: true } });
});

const preguntar = (texto, llamar) => generarRespuesta(agenteId, TELEFONO, [], texto, undefined, { llamarInyectado: llamar });

describe('IA elige mensajes prefabricados', () => {
  test('el precio sale del sistema aunque la IA escriba otra cosa', async () => {
    const ia = iaFalsa([{ content: TEXTO_LIBRE, tool_calls: [tool('responder', { mensaje: 'producto_precio', producto_id: producto.id })] }]);
    const salida = await preguntar('cuanto sale la runner?', ia.llamar);
    assert.match(salida.respuesta, /Zapatilla Runner/);
    assert.match(salida.respuesta, /300\.00/);
    assert.doesNotMatch(salida.respuesta, /90%/);
    assert.equal(ia.llamadas.length, 1);
  });

  test('si la IA solo escribe texto libre, se descarta y se pasa con una persona', async () => {
    const ia = iaFalsa([{ content: TEXTO_LIBRE }]);
    const salida = await preguntar('cuanto sale la runner?', ia.llamar);
    assert.doesNotMatch(salida.respuesta, /90%/);
    assert.match(salida.respuesta, /persona del equipo/i);
    const lead = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO, empresaId } });
    assert.equal(lead.estadoLead, 'DERIVADO_A_ASESOR');
  });

  test('una clave inventada se rechaza y la IA puede corregir', async () => {
    const ia = iaFalsa([
      { tool_calls: [tool('responder', { mensaje: 'regalar_descuento' })] },
      { tool_calls: [tool('responder', { mensaje: 'producto_precio', producto_id: producto.id })] },
    ]);
    const salida = await preguntar('cuanto sale la runner?', ia.llamar);
    assert.match(salida.respuesta, /300\.00/);
    assert.equal(ia.llamadas.length, 2);
  });

  test('un producto que no existe no se inventa', async () => {
    const ia = iaFalsa([{ tool_calls: [tool('responder', { mensaje: 'producto_precio', producto_id: 99999 })] }]);
    const salida = await preguntar('cuanto sale la runner?', ia.llamar);
    assert.match(salida.respuesta, /persona del equipo/i);
  });

  test('la IA solo ve la herramienta de hablar con claves cerradas y un prompt compacto', async () => {
    const ia = iaFalsa([{ tool_calls: [tool('responder', { mensaje: 'saludo' })] }]);
    await preguntar('cuanto sale la runner?', ia.llamar);
    const p = ia.llamadas[0];
    const responder = p.tools.find((t) => t.function.name === 'responder');
    assert.ok(responder && Array.isArray(responder.function.parameters.properties.mensaje.enum));
    assert.ok(!p.tools.some((t) => t.function.name === 'crear_pedido'));
    assert.ok(p.system.length < 8000, `prompt de ${p.system.length} caracteres`);
  });

  test('con el flag apagado todo sigue como antes (texto libre permitido)', async () => {
    await prisma.agenteConfig.update({ where: { id: configId }, data: { mensajesPrefabricados: false } });
    const ia = iaFalsa([{ content: 'Hola, tenemos la Zapatilla Runner.' }]);
    const salida = await preguntar('cuanto sale la runner?', ia.llamar);
    // Los correctivos de siempre pueden reescribir el texto; lo que importa es que no se derive por falta de eleccion.
    assert.ok(salida.respuesta && salida.respuesta.length > 0);
    assert.doesNotMatch(salida.respuesta, /persona del equipo/i);
  });
});

describe('carrito en modo prefabricado', () => {
  test('la IA puede consultar el carrito y el cliente ve lo que lleva', async () => {
    await prisma.clienteFinal.updateMany({ where: { empresaId, telefono: TELEFONO }, data: { contexto: { carrito: { items: [{ productoId: producto.id, nombre: 'Zapatilla Runner', precio: 300, cantidad: 1 }] } } } });
    const ia = iaFalsa([{ tool_calls: [tool('ver_carrito')] }]);
    const salida = await preguntar('que tengo en mi carrito?', ia.llamar);
    assert.ok(ia.llamadas[0].tools.some((t) => t.function.name === 'ver_carrito'), 'la IA debe tener ver_carrito');
    assert.match(salida.respuesta, /Zapatilla Runner/);
  });

  test('agregar al carrito confirma aunque la IA llame a dos herramientas en el mismo turno', async () => {
    const v = conVariantes.variantes[0];
    const ia = iaFalsa([{ tool_calls: [
      tool('actualizar_datos_lead', { categoriaInteres: 'Zapatillas' }),
      tool('agregar_al_carrito', { idProducto: conVariantes.id, idVariante: v.id, cantidad: 1 }),
    ] }]);
    const salida = await preguntar('agregame la trail pro talla 41', ia.llamar);
    assert.match(salida.respuesta, /carrito|agreg|list/i, `respuesta: ${salida.respuesta}`);
    assert.notEqual(ia.llamadas.length > 1, true, 'no debe necesitar otra vuelta de la IA');
  });

  test('preguntar por las tallas lista solo las que hay con stock, desde la base', async () => {
    const ia = iaFalsa([{ tool_calls: [tool('responder', { mensaje: 'producto_variantes', producto_id: conVariantes.id })] }]);
    const salida = await preguntar('que tallas hay de la trail pro?', ia.llamar);
    assert.match(salida.respuesta, /41, 42, 43|41/);
    assert.match(salida.respuesta, /Trail Pro/);
  });
});
