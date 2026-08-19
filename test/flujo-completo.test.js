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
let rubro;
let subcategoria;
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
    // Cada vuelta recibe el historial COMPLETO del turno, asi que hay que
    // quedarse solo con los resultados nuevos: si no, se duplican y los
    // indices dejan de corresponder al orden real de las tool calls.
    const tools = mensajes.filter((m) => m.role === 'tool').map((m) => String(m.content));
    recibido.toolResults = tools;
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
      agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [] } } }] },
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

  // Un rubro que se subdivide, para probar el menu de dos niveles.
  rubro = await prisma.categoria.create({ data: { empresaId, nombre: 'Calzado', orden: 1 } });
  subcategoria = await prisma.categoria.create({ data: { empresaId, nombre: 'Botas', padreId: rubro.id, orden: 1 } });
  const otraSub = await prisma.categoria.create({ data: { empresaId, nombre: 'Sandalias', padreId: rubro.id, orden: 2 } });
  for (const [nombre, catId] of [['Bota alta', subcategoria.id], ['Sandalia playa', otraSub.id]]) {
    await prisma.producto.create({
      data: { empresaId, categoriaId: catId, nombre, precio: 200, stock: 4, atributos: { Genero: 'Mujer' }, fotos: ['f.jpg'] },
    });
  }

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
  test('no manda la foto de otro color: avisa y ofrece la otra como referencia', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, color: 'Gris' });

    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('enviar_fotos_producto', { idProducto: productos[0].id })] },
      { content: 'Te mando la foto.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'mandame foto de la gris', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /NO SE ENVIO NINGUNA FOTO/);
    assert.match(r, /en Gris: ese color no tiene imagen cargada/);
    assert.match(r, /Ofrecele verla en Negro COMO REFERENCIA/);
    assert.match(r, /PROHIBIDO escribir "aqui tienes"/);
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

describe('tope duro de fotos por turno', () => {
  test('aunque el modelo llame dos veces, nunca se mandan mas de 3 fotos en un turno', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    // El modelo intenta mostrar en dos tandas dentro del mismo turno.
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: productos.map((p) => p.id) })] },
      { tool_calls: [tool('ver_mas_productos', {})] },
      { content: 'Ahi las tenes.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'mostrame todo', undefined, { llamarInyectado: llamar });

    assert.ok(salida.fotos.length <= 3, `se mandaron ${salida.fotos.length} fotos, el tope es 3`);
    assert.equal(salida.fotos.length, 3);
    const segundoResultado = recibido.toolResults[1] || '';
    assert.match(segundoResultado, /maximo para no llenarle el chat/);
  });

  test('el texto que se le pide al modelo ya no lo empuja a cerrar la venta', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Listo.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'mostrame', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /NO lo presiones para que compre/);
    assert.match(r, /NO le preguntes si alguna lo convencio/);
    assert.doesNotMatch(r, /CIERRE empujando el pedido/);
  });
});

describe('menu de categorias en dos niveles', () => {
  test('"que vendes" devuelve los RUBROS, no las subcategorias ni un link', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_categorias', {})] },
      { content: '¿Cual te interesa?' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'cual es tu catalogo', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /TOOL_SUCCESS/);
    assert.match(r, /Calzado/, 'tiene que listar el rubro');
    assert.doesNotMatch(r, /Botas/, 'las subcategorias son del segundo nivel, no de este');
    assert.doesNotMatch(r, /http/, 'nunca mas un link al catalogo web');
  });

  test('elegido el rubro, el sistema NO muestra productos: ofrece los tipos', async () => {
    await reiniciarLead({ categoriaInteres: 'Calzado', categoriaId: rubro.id });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [] })] },
      { content: '¿Botas o sandalias?' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'quiero calzado', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TODAVIA NO le muestres productos/);
    assert.match(recibido.toolResults[0], /Botas, Sandalias/);
    assert.deepEqual(salida.fotos, [], 'no se mando ninguna tarjeta');
  });

  test('dentro del rubro, mostrar_categorias baja al segundo nivel', async () => {
    await reiniciarLead({ categoriaInteres: 'Calzado', categoriaId: rubro.id });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_categorias', {})] },
      { content: 'Estos tipos hay.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'que tipos tenes', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /Dentro de "Calzado"/);
    assert.match(r, /1\. Botas/);
    assert.match(r, /2\. Sandalias/);
  });

  test('elegida la subcategoria, RECIEN AHI aparecen los productos', async () => {
    await reiniciarLead({ categoriaInteres: 'Botas', categoriaId: subcategoria.id });
    const producto = await prisma.producto.findFirst({ where: { categoriaId: subcategoria.id } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [producto.id] })] },
      { content: 'Mira esta.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'botas', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TOOL_SUCCESS/);
    assert.equal(salida.fotos.length, 1);
    assert.match(salida.fotos[0].caption, /Bota alta/);
  });

  test('un rubro SIN subcategorias muestra sus productos directamente', async () => {
    // "Zapatillas" del fixture principal no se subdivide.
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Ahi van.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'mostrame', undefined, { llamarInyectado: llamar });
    assert.match(recibido.toolResults[0], /TOOL_SUCCESS/);
    assert.ok(salida.fotos.length > 0, 'sin subcategorias no hay paso intermedio');
  });
});

describe('preguntas iniciales: nada se muestra hasta responderlas', () => {
  before(async () => {
    // Esta tienda pide saber el genero antes de cualquier cosa.
    await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { preguntasIniciales: ['Genero'] } });
  });
  after(async () => {
    await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { preguntasIniciales: [] } });
  });

  test('ni siquiera el MENU de rubros sale antes de saber el genero', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: {} });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_categorias', {})] },
      { content: '¿Para hombre o para mujer?' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'cual es tu catalogo', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TODAVIA NO le muestres el menu/);
    assert.match(recibido.toolResults[0], /Genero/);
  });

  test('tampoco productos, aunque el cliente nombre una categoria', async () => {
    await reiniciarLead({ atributosLead: {} });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: productos.map((p) => p.id) })] },
      { content: '¿Para quien es?' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TODAVIA NO le muestres productos/);
    assert.match(recibido.toolResults[0], /Genero/);
    assert.deepEqual(salida.fotos, []);
  });

  test('el prompt le dice que pregunte UNA sola cosa y de forma natural', async () => {
    await reiniciarLead({ atributosLead: {} });
    const { llamar, recibido } = iaFalsa([{ content: '¿Para hombre o para mujer?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'hola', undefined, { llamarInyectado: llamar });

    const system = recibido.systems[0];
    assert.match(system, /TODAVIA NO PODES MOSTRAR NADA/);
    assert.match(system, /preguntá UNA sola cosa/);
    assert.match(system, /NUNCA como un formulario/);
  });

  test('respondido el genero, el catalogo se habilita', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_categorias', {})] },
      { content: 'Esto tenemos.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'que tenes', undefined, { llamarInyectado: llamar });
    assert.match(recibido.toolResults[0], /TOOL_SUCCESS/);
  });
});

describe('el bot ofrece los valores REALES, no pregunta al aire', () => {
  test('cuando falta un dato obligatorio, le pasa las opciones que existen', async () => {
    // Caso real: el bot pedia un color sin decir cuales habia, y ante
    // "no se que colores tenes" devolvia la pregunta.
    await prisma.categoriaAtributo.updateMany({
      where: { categoriaId, nombre: 'Genero' }, data: { nivel: 'OBLIGATORIO' },
    });
    await reiniciarLead({ atributosLead: {} });
    const { llamar, recibido } = iaFalsa([{ content: '¿Para quien es?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamar });

    const system = recibido.systems[0];
    assert.match(system, /VALORES REALES DISPONIBLES/);
    assert.match(system, /Genero: Hombre/);
    // La lista existe para responder y para ofrecer opciones concretas cuando
    // SI corresponde preguntar, nunca para interrogar antes de mostrar.
    assert.match(system, /ofrece estas opciones concretas/);
  });

  test('con productos en pantalla, tambien le pasa colores y tallas reales', async () => {
    await prisma.categoriaAtributo.updateMany({
      where: { categoriaId, nombre: 'Genero' }, data: { nivel: 'RECOMENDADO' },
    });
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([{ content: 'Mira estas.' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'mostrame', undefined, { llamarInyectado: llamar });

    const system = recibido.systems[0];
    assert.match(system, /VALORES REALES DISPONIBLES/);
    assert.match(system, /Color: Gris, Negro/);
    assert.match(system, /Talla: 42/);
  });
});

// Bucle real de produccion: el bot pedia permiso para mostrar alternativas, el
// cliente decia "si quiero ver" tres veces, y el bot volvia a pedir permiso.
describe('BUG - pedir permiso en bucle en una conversacion larga', () => {
  let convId;
  let prodId;

  before(async () => {
    const cat = await prisma.categoria.create({ data: { empresaId, nombre: 'Urbanas' } });
    const p = await prisma.producto.create({
      data: {
        empresaId, categoriaId: cat.id, nombre: 'Park St 2.0', precio: 379, stock: 20,
        atributos: { Talla: '8,9,10', Color: 'Blanco nube' }, fotos: ['f.jpg'],
      },
    });
    prodId = p.id;
    const conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TELEFONO, ultimoMensajeAt: new Date() } });
    convId = conv.id;
    // Mas de 20 mensajes: es lo que hacia que el contador de turno se clavara.
    for (let i = 0; i < 30; i += 1) {
      await prisma.mensaje.create({ data: { conversacionId: convId, rol: i % 2 ? 'AGENTE' : 'CLIENTE', contenido: 'relleno ' + i } });
    }
    await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
    await prisma.clienteFinal.create({
      data: { empresaId, telefono: TELEFONO, categoriaInteres: 'Urbanas', categoriaId: cat.id, talla: '42' },
    });
  });

  const historialCorto = async () => (await prisma.mensaje.findMany({
    where: { conversacionId: convId }, orderBy: { createdAt: 'desc' }, take: 20,
  })).reverse().map((m) => ({ rol: m.rol, contenido: m.contenido }));

  async function turnoDelCliente(texto) {
    await prisma.mensaje.create({ data: { conversacionId: convId, rol: 'CLIENTE', contenido: texto } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [prodId] })] },
      { content: 'ok' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, await historialCorto(), texto, convId, { llamarInyectado: llamar });
    await prisma.mensaje.create({ data: { conversacionId: convId, rol: 'AGENTE', contenido: 'resp' } });
    return { salida, bloqueado: /NO se mostro nada todavia/.test(recibido.toolResults[0] || '') };
  }

  test('la primera vez SI pide permiso (la talla no calza)', async () => {
    const r = await turnoDelCliente('quiero urbanas');
    assert.equal(r.bloqueado, true);
    assert.deepEqual(r.salida.fotos, []);
  });

  test('cuando el cliente dice que si, MUESTRA (antes volvia a preguntar para siempre)', async () => {
    const r = await turnoDelCliente('si muestrame todas las urbanas');
    assert.equal(r.bloqueado, false, 'no puede volver a pedir permiso: el cliente ya dijo que si');
    assert.equal(r.salida.fotos.length, 1);
  });
});

// El recorrido completo acordado con el negocio: categorias -> tarjetas ->
// elige de la tarjeta -> carrito -> "¿algo mas?" -> cierre con resumen.
describe('recorrido de venta acordado con el negocio', () => {
  test('el cliente compra DOS productos distintos y el pedido los tiene a los dos', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TELEFONO, ultimoMensajeAt: new Date() } });
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id }, orderBy: { id: 'asc' } });

    // 1) agrega el primero
    const a = iaFalsa([{ tool_calls: [tool('agregar_al_carrito', { idProducto: productos[0].id, idVariante: variante.id, cantidad: 1 })] }, { content: '¿Deseas ver algo mas?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'me interesa la primera', conv.id, { llamarInyectado: a.llamar });
    assert.match(a.recibido.toolResults[0], /agregado al carrito/);
    assert.match(a.recibido.toolResults[0], /DESEA VER ALGO MAS/);

    // 2) dice que si y agrega otro (con su variante: el cliente la vio en la tarjeta)
    const variante2 = await prisma.variante.findFirst({ where: { productoId: productos[1].id }, orderBy: { id: 'asc' } });
    const b = iaFalsa([{ tool_calls: [tool('agregar_al_carrito', { idProducto: productos[1].id, idVariante: variante2.id, cantidad: 2 })] }, { content: 'Listo.' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'agregame tambien la otra', conv.id, { llamarInyectado: b.llamar });
    assert.match(b.recibido.toolResults[0], /Zapatilla 1/, 'el primero sigue en el carrito');
    assert.match(b.recibido.toolResults[0], /Zapatilla 2/);

    // 3) cierra
    await prisma.clienteFinal.updateMany({
      where: { telefono: TELEFONO },
      data: { nombre: 'Juan Perez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 123', formaPago: 'EFECTIVO' },
    });
    const c = iaFalsa([{ tool_calls: [tool('confirmar_pedido', {})] }, { content: '¿Esta todo bien?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'no, eso es todo', conv.id, { llamarInyectado: c.llamar });
    assert.match(c.recibido.toolResults[0], /Resumen REAL del pedido/);

    const d = iaFalsa([{ tool_calls: [tool('crear_pedido', {})] }, { content: 'Pedido tomado.' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'si', conv.id, { llamarInyectado: d.llamar });

    const pedido = await prisma.pedido.findFirst({ where: { empresaId }, include: { items: true }, orderBy: { id: 'desc' } });
    assert.equal(pedido.items.length, 2, 'el pedido tiene los DOS productos que agrego');

    const lead = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    assert.deepEqual((lead.contexto || {}).carrito, null, 'el carrito se vacia al comprar');
  });

  test('no se puede confirmar con el carrito vacio', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, nombre: 'Juan', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 1', formaPago: 'EFECTIVO' });
    const { llamar, recibido } = iaFalsa([{ tool_calls: [tool('confirmar_pedido', {})] }, { content: 'ok' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'cerra el pedido', undefined, { llamarInyectado: llamar });
    assert.match(recibido.toolResults[0], /carrito esta vacio/);
  });

  test('no deja agregar mas unidades de las que hay en stock', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id }, orderBy: { id: 'asc' } });
    const { llamar, recibido } = iaFalsa([{ tool_calls: [tool('agregar_al_carrito', { idProducto: productos[0].id, idVariante: variante.id, cantidad: 999 })] }, { content: 'ok' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero 999', undefined, { llamarInyectado: llamar });
    assert.match(recibido.toolResults[0], /No hay stock suficiente/);
  });
});

// Dos bugs reportados con capturas desde WhatsApp real, el mismo dia.
describe('el cliente recibe exactamente lo que pidio', () => {
  test('nombro un producto: se le muestra SOLO ese, sin rellenar la pagina', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });

    const { llamar } = iaFalsa([
      { tool_calls: [tool('buscar_producto', { nombre: 'Zapatilla 3' })] },
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[2].id] })] },
      { content: 'Ahi la tenes.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'tenes la Zapatilla 3?', undefined, { llamarInyectado: llamar });

    // Antes llegaban 3 tarjetas: la pedida y dos de relleno, la suya ultima.
    assert.equal(salida.fotos.length, 1, 'pidio una sola, no se le agregan otras');
    assert.match(salida.fotos[0].caption, /Zapatilla 3/);
  });

  test('explorando sin nombrar nada, se sigue completando la pagina', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });

    const { llamar } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Mira estas.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'que modelos tenes?', undefined, { llamarInyectado: llamar });

    assert.equal(salida.fotos.length, 3, 'sin pedido puntual el relleno tiene que seguir vivo');
  });
});
