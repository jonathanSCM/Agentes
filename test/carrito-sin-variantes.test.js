// Regresion del pedido #26 (Tekkira Cup): producto SIN variantes cuya talla/color
// viven como atributo del producto ("8,9,9.5,10,10.5"). El cliente lo agrego
// desde la web sin elegir nada, despues dijo "la 10, en blanco, dame esa" en el
// chat, y el pedido salio "2x ZAPATILLAS TEKKIRA CUP" sin talla.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');
const { carritoDe } = require('../lib/services/carrito');

const SLUG = 'test-carrito-sin-variantes';
const TELEFONO = '000-test-sinvar';

let empresaId;
let agenteId;
let categoriaId;
let producto;

function iaFalsa(respuestas) {
  const recibido = { toolResults: [], llamadas: 0 };
  let i = 0;
  const llamar = async ({ mensajes }) => {
    recibido.llamadas += 1;
    recibido.toolResults = mensajes.filter((m) => m.role === 'tool').map((m) => String(m.content));
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return { content: r.content || '', tool_calls: r.tool_calls || [] };
  };
  return { llamar, recibido };
}
const tool = (name, args = {}) => ({ id: `call_${name}_${Math.random().toString(36).slice(2, 7)}`, name, arguments: args });

// Lo que deja la web: la linea del producto SIN seleccion.
const lineaDeLaWeb = () => ({
  productoId: producto.id, varianteId: null, nombre: 'ZAPATILLAS TEKKIRA CUP', precio: 303, cantidad: 1, agregadoEn: new Date().toISOString(),
});

async function reiniciarLead(items = [], datos = {}) {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.clienteFinal.create({
    data: {
      empresaId, telefono: TELEFONO, categoriaInteres: 'Zapatillas', categoriaId,
      contexto: { carrito: items.length ? { conversacionId: null, items, actualizadoEn: new Date().toISOString() } : null },
      ...datos,
    },
  });
}
const carritoActual = async () => carritoDe((await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } })).contexto || {}, null);
const agregar = async (args, texto = 'ok') => {
  const ia = iaFalsa([{ tool_calls: [tool('agregar_al_carrito', { idProducto: producto.id, ...args })] }, { content: 'Listo.' }]);
  await generarRespuesta(agenteId, TELEFONO, [], texto, undefined, { llamarInyectado: ia.llamar });
  return ia.recibido;
};

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Sin Variantes', slug: SLUG, moneda: 'BOB',
      agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [], direccionTienda: 'Av. Test 1' } } }] },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;
  const categoria = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
  categoriaId = categoria.id;
  producto = await prisma.producto.create({
    data: {
      empresaId, categoriaId, nombre: 'ZAPATILLAS TEKKIRA CUP', precio: 303, stock: 5, fotos: ['f.jpg'],
      atributos: { Color: 'Blanco nube', Talla: '8,9,9.5,10,10.5', Genero: 'Unisex' },
    },
  });
});

after(async () => {
  await prisma.pedido.deleteMany({ where: { empresaId } });
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

describe('producto sin variantes con talla/color como atributo', () => {
  beforeEach(() => reiniciarLead([lineaDeLaWeb()]));

  test('elegir la talla en el chat COMPLETA la linea de la web: no la duplica', async () => {
    await agregar({ talla: '10' }, 'Ok, en talla 10, que colores tienes?');
    const carrito = await carritoActual();
    assert.equal(carrito.length, 1, 'sigue siendo UNA sola linea');
    assert.equal(carrito[0].cantidad, 1, 'la cantidad NO sube a 2');
    assert.equal(carrito[0].seleccion, 'Talla: 10, Color: Blanco nube', 'el color unico se completa solo');
    assert.match(carrito[0].nombre, /Talla: 10/);
  });

  test('sin talla (ni valida en el lead) NO agrega nada y le pide la talla al modelo', async () => {
    const r = await agregar({}, 'dame esa');
    const carrito = await carritoActual();
    assert.equal(carrito.length, 1);
    assert.equal(carrito[0].cantidad, 1);
    assert.equal(carrito[0].seleccion, undefined);
    assert.match(r.toolResults[0], /TODAVIA NO lo agregues/);
    assert.match(r.toolResults[0], /Talla: 8, 9, 9\.5, 10, 10\.5/);
  });

  test('una talla que no existe en el producto se rechaza', async () => {
    const r = await agregar({ talla: '12' });
    assert.match(r.toolResults[0], /TODAVIA NO lo agregues/);
    assert.equal((await carritoActual())[0].seleccion, undefined);
  });

  test('la talla que ya tenia el lead de OTRO producto (ej. "L") no se cuela', async () => {
    await reiniciarLead([lineaDeLaWeb()], { talla: 'L' });
    const r = await agregar({});
    assert.match(r.toolResults[0], /TODAVIA NO lo agregues/);
  });

  test('la talla que el lead ya tenia SI vale si es una de las del producto', async () => {
    await reiniciarLead([lineaDeLaWeb()], { talla: '9.5' });
    await agregar({});
    assert.equal((await carritoActual())[0].seleccion, 'Talla: 9.5, Color: Blanco nube');
  });

  test('"dame esa" otra vez, sin cantidad, NO suma una unidad', async () => {
    await agregar({ talla: '10' });
    const r = await agregar({ talla: '10' }, 'ok, dame esa');
    const carrito = await carritoActual();
    assert.equal(carrito.length, 1);
    assert.equal(carrito[0].cantidad, 1, 'confirmar lo que ya tiene no es pedir otra');
    assert.match(r.toolResults[0], /NO se agrego nada/);
  });

  test('pedir de verdad otra unidad (cantidad explicita) si suma', async () => {
    await agregar({ talla: '10' });
    await agregar({ talla: '10', cantidad: 1 }, 'agregame otra igual');
    const carrito = await carritoActual();
    assert.equal(carrito.length, 1);
    assert.equal(carrito[0].cantidad, 2);
  });

  test('otra talla es OTRA linea (se pueden llevar dos tallas)', async () => {
    await agregar({ talla: '10' });
    await agregar({ talla: '9' }, 'tambien una talla 9');
    const carrito = await carritoActual();
    assert.equal(carrito.length, 2);
    assert.deepEqual(carrito.map((i) => i.seleccion).sort(), ['Talla: 10, Color: Blanco nube', 'Talla: 9, Color: Blanco nube']);
  });
});

describe('cierre del pedido con producto sin variantes', () => {
  test('no se puede confirmar un pedido con una linea sin talla: se le pide al cliente', async () => {
    await reiniciarLead([lineaDeLaWeb()], { nombre: 'Juan Perez', tipoEntrega: 'RECOJO', formaPago: 'EFECTIVO' });
    const ia = iaFalsa([{ tool_calls: [tool('confirmar_pedido', {})] }, { content: '¿Que talla?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero cerrar', undefined, { llamarInyectado: ia.llamar });
    assert.match(ia.recibido.toolResults[0], /falta saber talla/);
    assert.doesNotMatch(ia.recibido.toolResults[0], /Resumen REAL del pedido/);
  });

  test('con la talla elegida el resumen y el pedido llevan la talla y el color', async () => {
    await reiniciarLead([lineaDeLaWeb()], { nombre: 'Juan Perez', tipoEntrega: 'RECOJO', formaPago: 'EFECTIVO' });
    await agregar({ talla: '10' });

    const conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TELEFONO, ultimoMensajeAt: new Date() } });
    // el carrito quedo guardado con conversacionId null (adoptable) y se lee igual
    const turno = (t) => prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: t } });

    await turno('quiero cerrar');
    const a = iaFalsa([{ tool_calls: [tool('confirmar_pedido', {})] }, { content: '¿Todo bien?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero cerrar', conv.id, { llamarInyectado: a.llamar });
    assert.match(a.recibido.toolResults[0], /1x ZAPATILLAS TEKKIRA CUP \(Talla: 10, Color: Blanco nube\)/);

    await turno('si');
    const b = iaFalsa([{ tool_calls: [tool('crear_pedido', {})] }, { content: 'Listo.' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'si', conv.id, { llamarInyectado: b.llamar });

    const pedido = await prisma.pedido.findFirst({ where: { empresaId }, include: { items: true }, orderBy: { id: 'desc' } });
    assert.ok(pedido, 'el pedido se creo');
    assert.equal(pedido.items.length, 1);
    assert.equal(pedido.items[0].cantidad, 1, 'UNA unidad, no dos');
    assert.match(pedido.items[0].nombre, /Talla: 10, Color: Blanco nube/, 'el negocio sabe que talla enviar');
  });
});
