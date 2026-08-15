// Verificacion de punta a punta de los caminos que TOCAN LA BASE DE DATOS.
//
// El resto de los tests son puros (deciden sin Postgres). Estos ejercitan lo
// que solo se puede probar de verdad contra una base: el gate de "primero
// entender", la paginacion real, el aviso de foto de otro color, y el cierre
// del pedido con confirmacion previa.
//
// La IA se inyecta (`llamarInyectado`): es una funcion determinista que emite
// las tool calls que queremos probar, asi el test no depende de ningun
// proveedor real ni de que un modelo "se porte bien".
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');

const SLUG = 'test-flujo-completo';
const TELEFONO = '000-test-flujo';

let empresaId;
let agenteId;
let categoriaId;
let productos = [];

/**
 * IA falsa: devuelve una respuesta por vuelta, en orden. Guarda todo lo que
 * recibe para poder inspeccionar el system prompt y los resultados de tools.
 */
function iaFalsa(respuestas) {
  const recibido = { systems: [], toolResults: [] };
  let i = 0;
  const llamar = async ({ system, mensajes }) => {
    recibido.systems.push(system);
    for (const m of mensajes) {
      if (m.role === 'tool') recibido.toolResults.push(String(m.content));
    }
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return { content: r.content || '', tool_calls: r.tool_calls || [] };
  };
  return { llamar, recibido };
}

const tool = (name, args = {}) => ({ id: `call_${name}_${Math.random().toString(36).slice(2, 7)}`, name, arguments: args });

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Flujo', slug: SLUG, moneda: 'BOB',
      agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true } } }] },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;

  const categoria = await prisma.categoria.create({
    data: {
      empresaId,
      nombre: 'Zapatillas',
      atributos: {
        create: [
          { nombre: 'Genero', nivel: 'OBLIGATORIO', esDeVariante: false, orden: 0 },
          { nombre: 'Uso', nivel: 'RECOMENDADO', esDeVariante: false, orden: 1 },
        ],
      },
    },
  });
  categoriaId = categoria.id;

  // 5 productos de hombre: alcanzan para 2 paginas (3 + 2).
  for (let n = 1; n <= 5; n += 1) {
    const p = await prisma.producto.create({
      data: {
        empresaId, categoriaId, nombre: `Zapatilla ${n}`, precio: 300 + n, stock: 0,
        atributos: { Genero: 'Hombre' }, fotos: ['generica.jpg'],
        variantes: {
          create: [
            { atributos: { Talla: '42', Color: 'Negro' }, stock: 5, fotos: ['negro.jpg'] },
            { atributos: { Talla: '42', Color: 'Gris' }, stock: 4, fotos: [] },
          ],
        },
      },
      include: { variantes: true },
    });
    productos.push(p);
  }
});

after(async () => {
  await prisma.pedido.deleteMany({ where: { empresaId } });
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

// Cada bloque arranca con el cliente "limpio" pero con la categoria ya elegida.
async function reiniciarLead(datos = {}) {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.clienteFinal.create({
    data: {
      empresaId, telefono: TELEFONO,
      categoriaInteres: 'Zapatillas', categoriaId,
      ...datos,
    },
  });
}

describe('gate real: primero entender, despues mostrar', () => {
  beforeEach(async () => { await reiniciarLead(); });

  test('sin el atributo OBLIGATORIO, mostrar_productos se rechaza y NO se envia ninguna tarjeta', async () => {
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: productos.map((p) => p.id) })] },
      { content: 'Contame, ¿es para hombre o para mujer?' },
    ]);

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamar });

    assert.equal(salida.ok, true);
    assert.match(recibido.toolResults[0], /TODAVIA NO le muestres productos/);
    assert.match(recibido.toolResults[0], /Genero/);
    assert.deepEqual(salida.fotos, [], 'no se mando ninguna tarjeta');

    const lead = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    assert.deepEqual(lead.productosMostrados, [], 'no puede quedar ningun producto como mostrado');
  });

  test('el prompt tampoco le filtra los productos mientras falta el dato', async () => {
    const { llamar, recibido } = iaFalsa([{ content: '¿Para hombre o para mujer?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamar });
    assert.match(recibido.systems[0], /TODAVIA NO PODES MOSTRAR PRODUCTOS/);
    assert.doesNotMatch(recibido.systems[0], /Zapatilla 1/);
  });

  test('con el dato cargado, la misma llamada SI muestra (y solo una pagina de 3)', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: productos.map((p) => p.id) })] },
      { content: 'Estas son las que mejor te quedan.' },
    ]);

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'mostrame', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TOOL_SUCCESS/);
    assert.equal(salida.fotos.length, 3, 'una pagina son 3 tarjetas, aunque el modelo pidiera 5');
    assert.match(recibido.toolResults[0], /total_matches = 5/);
    assert.match(recibido.toolResults[0], /quedan sin mostrar = 2/);
  });
});

describe('paginacion real contra la base', () => {
  test('ver_mas_productos trae las que faltan y despues avisa que no hay mas', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });

    const primera = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Mira estas.' },
    ]);
    const r1 = await generarRespuesta(agenteId, TELEFONO, [], 'mostrame', undefined, { llamarInyectado: primera.llamar });
    assert.equal(r1.fotos.length, 3);
    const vistas1 = r1.fotos.map((f) => f.caption.split('\n')[0]);

    const segunda = iaFalsa([
      { tool_calls: [tool('ver_mas_productos', {})] },
      { content: 'Estas son las otras.' },
    ]);
    const r2 = await generarRespuesta(agenteId, TELEFONO, [], 'tenes otros modelos?', undefined, { llamarInyectado: segunda.llamar });
    assert.equal(r2.fotos.length, 2, 'quedaban 2 de las 5');
    const vistas2 = r2.fotos.map((f) => f.caption.split('\n')[0]);
    assert.equal(vistas1.filter((v) => vistas2.includes(v)).length, 0, 'no puede repetir las que ya vio');

    const tercera = iaFalsa([
      { tool_calls: [tool('ver_mas_productos', {})] },
      { content: 'Esas son todas.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'y mas?', undefined, { llamarInyectado: tercera.llamar });
    assert.match(tercera.recibido.toolResults[0], /Ya le mostraste TODAS las opciones reales/);
    assert.match(tercera.recibido.toolResults[0], /total_matches = 5/);
  });
});

describe('foto de un color sin imagen cargada', () => {
  test('avisa que la foto es de otro color y cual color no tiene imagen', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, color: 'Gris' });

    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('enviar_fotos_producto', { idProducto: productos[0].id })] },
      { content: 'Te mando la foto.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'mandame foto de la gris', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /TOOL_SUCCESS/);
    assert.match(r, /el cliente pidio Gris y NO hay foto cargada de ese color/);
    assert.match(r, /La foto que se envio es del color Negro/);
    assert.match(r, /SIN foto cargada: Gris/);
  });
});

describe('cierre del pedido: confirmacion obligatoria', () => {
  beforeEach(async () => {
    await reiniciarLead({
      atributosLead: { Genero: 'Hombre' },
      nombre: 'Cesar Prueba', formaPago: 'EFECTIVO',
      tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av Siempre Viva 123',
    });
  });

  test('crear_pedido SIN confirmar antes se rechaza y no crea nada', async () => {
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('crear_pedido', { items: [{ idProducto: productos[0].id, idVariante: variante.id, cantidad: 1 }] })] },
      { content: 'Te confirmo.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'dale, lo quiero', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /el cliente no confirmo ESTE pedido exacto/);
    assert.equal(await prisma.pedido.count({ where: { empresaId } }), 0, 'no se creo ningun pedido');
  });

  test('confirmar_pedido arma el resumen real con precio y moneda de la base', async () => {
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('confirmar_pedido', { items: [{ idProducto: productos[0].id, idVariante: variante.id, cantidad: 2 }] })] },
      { content: '¿Confirmas?' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero 2', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /TOOL_SUCCESS/);
    assert.match(r, /2x Zapatilla 1/);
    assert.match(r, /Bs 301\.00 c\/u/, 'el precio sale de la base, con la moneda de la empresa');
    assert.match(r, /Total: Bs 602\.00/);
    assert.match(r, /Av Siempre Viva 123/);
    assert.match(r, /NO llames a crear_pedido en este turno/);
    assert.equal(await prisma.pedido.count({ where: { empresaId } }), 0, 'confirmar no crea todavia');
  });

  test('despues de confirmar, crear_pedido SI crea y descuenta el stock de la variante', async () => {
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[1].id }, orderBy: { id: 'asc' } });
    const stockAntes = variante.stock;
    const items = [{ idProducto: productos[1].id, idVariante: variante.id, cantidad: 2 }];

    const paso1 = iaFalsa([{ tool_calls: [tool('confirmar_pedido', { items })] }, { content: '¿Esta todo bien?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero 2', undefined, { llamarInyectado: paso1.llamar });

    const paso2 = iaFalsa([{ tool_calls: [tool('crear_pedido', { items })] }, { content: 'Listo, pedido tomado.' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'si, esta todo bien', undefined, { llamarInyectado: paso2.llamar });

    assert.match(paso2.recibido.toolResults[0], /TOOL_SUCCESS: pedido #\d+ creado/);

    const pedido = await prisma.pedido.findFirst({ where: { empresaId }, include: { items: true }, orderBy: { id: 'desc' } });
    assert.ok(pedido, 'el pedido tiene que existir en la base');
    assert.equal(pedido.tipoEntrega, 'DOMICILIO');
    assert.equal(Number(pedido.total), 2 * Number(productos[1].precio));
    assert.equal(pedido.items[0].varianteId, variante.id, 'el pedido apunta a la variante exacta');

    const despues = await prisma.variante.findUnique({ where: { id: variante.id } });
    assert.equal(despues.stock, stockAntes - 2, 'el stock se descuenta al crear');

    const lead = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    assert.equal(lead.estadoConversacion, 'PEDIDO_COMPLETADO', 'usa un estado del enum nuevo');
  });

  test('si pide retiro en tienda y el negocio no cargo su direccion, no se crea nada', async () => {
    await reiniciarLead({
      atributosLead: { Genero: 'Hombre' }, nombre: 'Cesar Prueba',
      formaPago: 'EFECTIVO', tipoEntrega: 'RECOJO',
    });
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[2].id } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('confirmar_pedido', { items: [{ idProducto: productos[2].id, idVariante: variante.id, cantidad: 1 }] })] },
      { content: 'Un momento.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'paso a buscarlo', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /no tiene cargada la direccion de su local/);
    assert.match(recibido.toolResults[0], /NUNCA inventes una direccion/);
  });
});
