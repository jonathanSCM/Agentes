// Bug (hallazgo 3 del audit): el link del catalogo web vive 24 h pero una
// conversacion se renueva a las 6 h. Si el carrito de la web se guardaba con
// el id de conversacion firmado en el link, quedaba atado a una conversacion
// vieja (invisible para el bot) y pisaba el de la actual.
// conversacionParaCarritoWeb devuelve la conversacion ABIERTA del cliente (o
// null si no hay ninguna).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { conversacionParaCarritoWeb, VENTANA_HORAS } = require('../lib/services/conversaciones');

const SLUG = 'test-carrito-web-conv';
const TEL = '000-test-carrito-web';
let empresaId;
let agenteId;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  const empresa = await prisma.empresa.create({
    data: { nombre: 'Tienda Carrito Web', slug: SLUG, agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO' }] } },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;
});

after(async () => {
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

describe('conversacionParaCarritoWeb', () => {
  test('sin ninguna conversacion devuelve null', async () => {
    assert.equal(await conversacionParaCarritoWeb(empresaId, TEL), null);
  });

  test('con una conversacion vencida (mas de la ventana) devuelve null', async () => {
    const vieja = new Date(Date.now() - (VENTANA_HORAS + 1) * 60 * 60 * 1000);
    await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TEL, ultimoMensajeAt: vieja } });
    assert.equal(await conversacionParaCarritoWeb(empresaId, TEL), null);
  });

  test('con una conversacion abierta devuelve ESA (no la vieja)', async () => {
    const abierta = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TEL, ultimoMensajeAt: new Date() } });
    assert.equal(await conversacionParaCarritoWeb(empresaId, TEL), abierta.id);
  });

  test('otro telefono no ve conversaciones ajenas', async () => {
    assert.equal(await conversacionParaCarritoWeb(empresaId, '000-otro-cliente'), null);
  });
});
