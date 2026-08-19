// Bug real reportado con capturas: el cliente escribio "hola tenes de
// casualidad ZAPATILLAS TEKKIRA CUP en venta" y el bot contesto que no pudo
// traerle las opciones. El producto EXISTIA y con stock.
//
// La secuencia en los logs era:
//   busqueda_por_nombre            -> conStock: 1   (lo encontro)
//   mostrar_bloqueado_faltan_datos -> ["Genero"]    (y lo bloqueo)
//
// El gate de "primero entender, despues mostrar" esta bien para una busqueda
// por categoria ("quiero zapatillas" no puede devolver tres tarjetas al
// azar), pero cuando el cliente NOMBRA el producto no hay nada que entender:
// preguntarle de que genero es el modelo que el mismo acaba de nombrar es el
// interrogatorio que el negocio prohibe.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');

const SLUG = 'test-pedido-por-nombre';
const TELEFONO = '000-test-por-nombre';

let empresaId;
let agenteId;
let categoriaId;
let tekkiraId;
let otroId;

function iaFalsa(respuestas) {
  let i = 0;
  return async () => {
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return { content: r.content || '', tool_calls: r.tool_calls || [] };
  };
}

const tool = (name, args = {}) => ({ id: `call_${name}`, name, arguments: args });

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Nombre', slug: SLUG, moneda: 'BOB',
      agentes: { create: [{ nombre: 'Raul', estado: 'ACTIVO', config: { create: { preguntasIniciales: [] } } }] },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;

  // Genero OBLIGATORIO, igual que la tienda donde se reporto el bug.
  const categoria = await prisma.categoria.create({
    data: {
      empresaId,
      nombre: 'Zapatillas',
      atributos: { create: [{ nombre: 'Genero', nivel: 'OBLIGATORIO', esDeVariante: false, orden: 0 }] },
    },
  });
  categoriaId = categoria.id;

  const tekkira = await prisma.producto.create({
    data: {
      empresaId, categoriaId, nombre: 'ZAPATILLAS TEKKIRA CUP', precio: 303, stock: 10,
      atributos: { Genero: 'Hombre' }, fotos: ['tekkira.jpg'],
    },
  });
  tekkiraId = tekkira.id;

  const otro = await prisma.producto.create({
    data: {
      empresaId, categoriaId, nombre: 'Drop Step low 2.0', precio: 309, stock: 20,
      atributos: { Genero: 'Hombre' }, fotos: ['drop.jpg'],
    },
  });
  otroId = otro.id;
});

after(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

// Cliente NUEVO en cada caso: sin genero declarado, como en la captura.
beforeEach(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.clienteFinal.create({
    data: { empresaId, telefono: TELEFONO, categoriaInteres: 'Zapatillas', categoriaId },
  });
});

describe('el cliente nombra un producto puntual', () => {
  test('se le muestra aunque falte un atributo OBLIGATORIO del catalogo', async () => {
    const llamar = iaFalsa([
      { tool_calls: [tool('buscar_producto', { nombre: 'ZAPATILLAS TEKKIRA CUP' })] },
      { tool_calls: [tool('mostrar_productos', { idsProductos: [tekkiraId] })] },
      { content: 'Ahi la tenes.' },
    ]);

    const salida = await generarRespuesta(
      agenteId, TELEFONO, [], 'hola tenes de casualidad ZAPATILLAS TEKKIRA CUP en venta',
      undefined, { llamarInyectado: llamar },
    );

    assert.equal(salida.fotos.length, 1, 'nombro un producto que existe: tiene que verlo');
    assert.match(salida.fotos[0].caption, /TEKKIRA CUP/);
  });

  test('y se le muestra SOLO ese, sin completar la pagina con otros', async () => {
    const llamar = iaFalsa([
      { tool_calls: [tool('buscar_producto', { nombre: 'ZAPATILLAS TEKKIRA CUP' })] },
      { tool_calls: [tool('mostrar_productos', { idsProductos: [tekkiraId] })] },
      { content: 'Ahi la tenes.' },
    ]);

    const salida = await generarRespuesta(
      agenteId, TELEFONO, [], 'tenes las TEKKIRA CUP?', undefined, { llamarInyectado: llamar },
    );

    assert.equal(salida.fotos.length, 1);
    assert.doesNotMatch(salida.fotos[0].caption, /Drop Step/);
  });

  test('el gate SIGUE bloqueando cuando la busqueda es por categoria, no por nombre', async () => {
    const llamar = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [tekkiraId, otroId] })] },
      { content: '¿Es para hombre o para mujer?' },
    ]);

    const salida = await generarRespuesta(
      agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamar },
    );

    assert.equal(salida.fotos.length, 0, 'sin nombrar nada, primero se entiende y despues se muestra');
  });
});
