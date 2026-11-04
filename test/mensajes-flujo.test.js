// Los textos del flujo salen del catálogo de mensajes: el negocio los puede cambiar
// y el agente habla en el registro (vos / tú) que el negocio eligió.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');
const M = require('../lib/services/mensajes');

const TEL = '000-test-mensajes-flujo';

describe('flujo con mensajes del negocio', () => {
  let empresaId; let agenteId; let conv; let producto;
  const sinIA = { llamarInyectado: async () => { throw new Error('no debería usarse la IA'); } };

  async function toca(id, titulo) {
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: titulo } });
    return generarRespuesta(agenteId, TEL, [{ rol: 'AGENTE', contenido: 'Hola' }], titulo, conv.id, { ...sinIA, idBoton: id });
  }
  async function cliente(datos = {}) {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.clienteFinal.create({
      data: {
        empresaId, telefono: TEL, estadoConversacion: 'INTENCION_DE_COMPRA', productoFavoritoId: producto.id, ...datos,
        contexto: { carrito: { conversacionId: null, actualizadoEn: new Date().toISOString(), items: [{ productoId: producto.id, varianteId: null, nombre: producto.nombre, precio: 300, cantidad: 1, agregadoEn: new Date().toISOString() }] } },
      },
    });
  }

  before(async () => {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.deleteMany({ where: { slug: 'test-mensajes-flujo' } });
    const empresa = await prisma.empresa.create({
      data: {
        nombre: 'Tienda Mensajes Flujo', slug: 'test-mensajes-flujo', moneda: 'BOB',
        agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, aceptaQr: true, preguntasIniciales: [], flujoDeterminista: true } } }] },
      },
      include: { agentes: true },
    });
    empresaId = empresa.id;
    agenteId = empresa.agentes[0].id;
    conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TEL, ultimoMensajeAt: new Date() } });
    const cat = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
    producto = await prisma.producto.create({ data: { empresaId, categoriaId: cat.id, nombre: 'Zapatilla Runner', precio: 300, stock: 9, fotos: [] } });
  });
  beforeEach(async () => {
    await prisma.mensajeAgente.deleteMany({ where: { empresaId } });
    await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { registro: 'vos' } });
    M.invalidar();
  });
  after(async () => {
    M.invalidar();
    await prisma.pedido.deleteMany({ where: { empresaId } });
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  });

  test('sin personalizar, el flujo dice lo de siempre', async () => {
    await cliente();
    const r = await toca('mas:no', 'Finalizar');
    assert.equal(r.respuesta, '¿A nombre de quién hago el pedido?');
  });

  test('el texto que escribió el negocio reemplaza al de fábrica (y no hace falta reiniciar nada)', async () => {
    await prisma.mensajeAgente.create({ data: { empresaId, clave: 'pedir_nombre', texto: '¡Casi listo! ¿Me decís tu nombre para el pedido?' } });
    M.invalidar(empresaId);
    await cliente();
    const r = await toca('mas:no', 'Finalizar');
    assert.equal(r.respuesta, '¡Casi listo! ¿Me decís tu nombre para el pedido?');
  });

  test('un texto roto del negocio no deja al cliente sin respuesta: sale el de fábrica', async () => {
    const original = console.error; console.error = () => {};
    try {
      await prisma.mensajeAgente.create({ data: { empresaId, clave: 'pedir_nombre', texto: 'Hola {{variable_inexistente}}' } });
      M.invalidar(empresaId);
      await cliente();
      const r = await toca('mas:no', 'Finalizar');
      assert.equal(r.respuesta, '¿A nombre de quién hago el pedido?');
    } finally { console.error = original; }
  });

  test('el registro del agente (vos / tú) cambia cómo habla', async () => {
    const datos = { nombre: 'Ana Pérez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 123', ubicacionLat: -17.76, ubicacionLng: -63.18 };
    await cliente(datos);
    assert.equal((await toca('mas:no', 'Finalizar')).respuesta, '¿Cómo preferís pagar?');

    await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { registro: 'tu' } });
    await cliente(datos);
    assert.equal((await toca('mas:no', 'Finalizar')).respuesta, '¿Cómo prefieres pagar?');
  });

  test('el pedido creado también sale del catálogo, con su número', async () => {
    await cliente({ nombre: 'Ana Pérez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 123', ubicacionLat: -17.76, ubicacionLng: -63.18, formaPago: 'EFECTIVO' });
    await toca('mas:no', 'Finalizar');
    const r = await toca('cierre:confirmar', 'Confirmar ✅');
    assert.match(r.respuesta, /^¡Listo! Tu pedido #\d+ quedó registrado ✅ Un asesor va a coordinar la entrega con vos\.$/);
  });
});
