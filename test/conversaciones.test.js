// Test de regresion CRITICO: al abrirse una conversacion nueva (paso la
// ventana de 24h desde el ultimo mensaje) NO se debe borrar todo
// ClienteFinal.contexto. Un bug real hacia exactamente eso (`contexto: {}`),
// lo que en un caso real se llevo puesto un carrito con un producto ya
// agregado. Usa la base de datos local real, con datos propios que se
// limpian al final (mismo patron que test/regresion-agente.test.js).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { procesarMensajeEntrante } = require('../lib/services/conversaciones');

const SLUG = 'test-conversaciones-reset-contexto';
const TELEFONO = '000-test-reset-contexto';

let empresaId;
let agenteId;
let planId;

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_RESET_CTX' } });

  const plan = await prisma.plan.create({
    data: {
      codigo: 'TEST_RESET_CTX',
      nombre: 'Plan de prueba (reset contexto)',
      mensualidadBs: 0,
      implementacionBs: 0,
      primerPagoBs: 0,
      convIncluidas: 10,
      maxProductos: 10,
      maxUsuarios: 1,
      activo: false,
      features: [],
    },
  });
  planId = plan.id;

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Empresa de test (reset contexto)',
      slug: SLUG,
      suscripcion: {
        create: {
          planId: plan.id,
          estado: 'ACTIVA',
          periodoFin: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      },
      agentes: { create: { nombre: 'Agente de test', estado: 'ACTIVO' } },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;
});

after(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  await prisma.plan.delete({ where: { id: planId } }).catch(() => {});
});

describe('procesarMensajeEntrante - el reset de conversacion nueva NO borra todo el contexto', () => {
  test('al abrirse una conversacion nueva, se preserva el carrito y otros datos del lead; solo se limpia el anti-spam', async () => {
    // 1) Primer mensaje: crea ClienteFinal + Conversacion 1.
    const r1 = await procesarMensajeEntrante({
      agenteId, telefonoCliente: TELEFONO, contenido: 'Hola, buscaba zapatillas',
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.cobrada, true);
    const conv1Id = r1.conversacionId;

    // 2) Simula el estado real de una venta en curso: un carrito con un
    // producto agregado, mas otros datos del lead que NO son anti-spam.
    const carritoConItem = {
      conversacionId: conv1Id,
      items: [{ productoId: 1, varianteId: null, nombre: 'Zapatillas Park St 2.0', precio: 379, cantidad: 1 }],
    };
    await prisma.clienteFinal.update({
      where: { empresaId_telefono: { empresaId, telefono: TELEFONO } },
      data: {
        contexto: {
          carrito: carritoConItem,
          categoriaInteres: 'Calzado',
          sinPreferencia: false,
          fotosEnviadas: ['ya-mostrada.jpg'],
          tarjetasCategoriaMostradas: ['Calzado'],
        },
      },
    });

    // 3) Fuerza que la conversacion 1 haya quedado fuera de la ventana de
    // 24h, para que el proximo mensaje dispare la rama de "conversacion
    // nueva" (la que hace el upsert con reset).
    await prisma.conversacion.update({
      where: { id: conv1Id },
      data: { ultimoMensajeAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    // 4) Segundo mensaje del mismo cliente: abre conversacion nueva.
    const r2 = await procesarMensajeEntrante({
      agenteId, telefonoCliente: TELEFONO, contenido: 'Sigo interesado',
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.cobrada, true, 'una conversacion nueva se cobra');
    assert.notEqual(r2.conversacionId, conv1Id, 'debe ser una conversacion distinta');

    // 5) El contexto NO debe haberse borrado entero: el carrito y el resto
    // de los datos del lead siguen ahi (el bug real perdia el carrito).
    const clienteFinal = await prisma.clienteFinal.findUnique({
      where: { empresaId_telefono: { empresaId, telefono: TELEFONO } },
    });
    assert.deepEqual(clienteFinal.contexto.carrito, carritoConItem, 'el carrito no debe desaparecer del contexto');
    assert.equal(clienteFinal.contexto.categoriaInteres, 'Calzado', 'otros datos del lead se mantienen');
    assert.equal(clienteFinal.contexto.sinPreferencia, false, 'otros datos del lead se mantienen');

    // 6) Solo lo que es anti-spam DENTRO de un chat activo se resetea.
    assert.deepEqual(clienteFinal.contexto.fotosEnviadas, []);
    assert.deepEqual(clienteFinal.contexto.tarjetasCategoriaMostradas, []);
    assert.deepEqual(clienteFinal.productosMostrados, []);
  });
});
