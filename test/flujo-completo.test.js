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

// confirmar_pedido/crear_pedido ya NO aceptan una lista de items del modelo
// (bug real: el modelo mandaba solo lo ultimo que habia conversado y pisaba
// el carrito real, perdiendo productos) - el carrito es la unica fuente de
// verdad. Para probar el cierre hay que armar el carrito real primero, igual
// que lo haria agregar_al_carrito.
async function agregarAlCarrito(items) {
  const cliente = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
  const carritoItems = items.map((i) => ({
    productoId: i.idProducto, varianteId: i.idVariante || null,
    nombre: `Producto ${i.idProducto}`, precio: i.precio, cantidad: i.cantidad,
    agregadoEn: i.agregadoEn || undefined,
  }));
  await prisma.clienteFinal.update({
    where: { id: cliente.id },
    data: { contexto: { ...(cliente.contexto || {}), carrito: { conversacionId: null, items: carritoItems } } },
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
    // Sin producto puntual nombrado, el redirect de "solo tarjeta de
    // categoria" (Fix B) manda mostrar_productos hacia mostrar_tarjeta_categoria
    // antes de llegar al gate propio de mostrar_productos - pero esa tool
    // tiene el MISMO gate de atributos obligatorios, asi que el resultado de
    // fondo (nada se muestra, se pide Genero) es identico.
    assert.match(recibido.toolResults[0], /TODAVIA NO le (muestres productos|mandes esta tarjeta)/);
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

    // Nombra un producto puntual ("Zapatilla 1") para pasar el gate de "solo
    // tarjeta de categoria" (regla del negocio) y llegar a probar la
    // paginacion real, que es lo que este test verifica.
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'tenes la Zapatilla 1?', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TOOL_SUCCESS/);
    assert.equal(salida.fotos.length, 3, 'una pagina son 3 tarjetas, aunque el modelo pidiera 5');
    assert.match(recibido.toolResults[0], /total_matches = 5/);
    assert.match(recibido.toolResults[0], /quedan sin mostrar = 2/);
  });
});

describe('paginacion real contra la base', () => {
  test('ver_mas_productos trae las que faltan y despues avisa que no hay mas', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });

    // Cada turno nombra un producto puntual (regla del negocio: sin nombre
    // puntual no hay tarjetas de producto, solo tarjeta de categoria) para
    // poder seguir probando la paginacion real de mostrar_productos/ver_mas_productos.
    const primera = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Mira estas.' },
    ]);
    const r1 = await generarRespuesta(agenteId, TELEFONO, [], 'tenes la Zapatilla 1?', undefined, { llamarInyectado: primera.llamar });
    assert.equal(r1.fotos.length, 3);
    const vistas1 = r1.fotos.map((f) => f.caption.split('\n')[0]);

    // Ojo: el mensaje NO nombra el producto completo esta vez a proposito
    // (para no disparar productoNombradoPorCliente, que forzaria mostrar_productos
    // con un solo ID y pisaria la paginacion que se quiere probar aca) - en
    // cambio, buscar_producto marca el pedido como puntual (idsPedidosPorNombre),
    // que alcanza para pasar el gate sin tocar como sigue la tool ver_mas_productos.
    const segunda = iaFalsa([
      { tool_calls: [tool('buscar_producto', { nombre: 'Zapatilla' })] },
      { tool_calls: [tool('ver_mas_productos', {})] },
      { content: 'Estas son las otras.' },
    ]);
    const r2 = await generarRespuesta(agenteId, TELEFONO, [], 'tenes mas modelos como esa?', undefined, { llamarInyectado: segunda.llamar });
    assert.equal(r2.fotos.length, 2, 'quedaban 2 de las 5');
    const vistas2 = r2.fotos.map((f) => f.caption.split('\n')[0]);
    assert.equal(vistas1.filter((v) => vistas2.includes(v)).length, 0, 'no puede repetir las que ya vio');

    const tercera = iaFalsa([
      { tool_calls: [tool('buscar_producto', { nombre: 'Zapatilla' })] },
      { tool_calls: [tool('ver_mas_productos', {})] },
      { content: 'Esas son todas.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'tenes mas modelos que esos?', undefined, { llamarInyectado: tercera.llamar });
    // toolResults[0] = buscar_producto, [1] = ver_mas_productos.
    assert.match(tercera.recibido.toolResults[1], /Ya le mostraste TODAS las opciones reales/);
    assert.match(tercera.recibido.toolResults[1], /total_matches = 5/);
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
      ubicacionLat: -17.767619, ubicacionLng: -63.181035,
    });
  });

  test('crear_pedido SIN confirmar antes se rechaza y no crea nada', async () => {
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id } });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: variante.id, cantidad: 1, precio: productos[0].precio }]);
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('crear_pedido', {})] },
      { content: 'Te confirmo.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'dale, lo quiero', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /el cliente no confirmo ESTE pedido exacto/);
    assert.equal(await prisma.pedido.count({ where: { empresaId } }), 0, 'no se creo ningun pedido');
  });

  test('confirmar_pedido arma el resumen real con precio y moneda de la base', async () => {
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id } });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: variante.id, cantidad: 2, precio: productos[0].precio }]);
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('confirmar_pedido', {})] },
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

  // "Sigue sumando productos" - el resumen tiene que avisar cuando un item
  // viene de una sesion vieja que no se llego a cerrar, para que el cliente
  // nunca se sorprenda con algo que ya se habia olvidado.
  test('un item agregado hace mas de 2 horas se marca en el resumen; uno recien agregado no', async () => {
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id } });
    const variante2 = await prisma.variante.findFirst({ where: { productoId: productos[1].id }, orderBy: { id: 'asc' } });
    const hace3Horas = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await agregarAlCarrito([
      { idProducto: productos[0].id, idVariante: variante.id, cantidad: 1, precio: productos[0].precio, agregadoEn: hace3Horas },
      { idProducto: productos[1].id, idVariante: variante2.id, cantidad: 1, precio: productos[1].precio, agregadoEn: new Date().toISOString() },
    ]);
    const { llamar, recibido } = iaFalsa([{ tool_calls: [tool('confirmar_pedido', {})] }, { content: '¿Confirmas?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'cerremos', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /Zapatilla 1.*\(ya lo tenia en el carrito de antes\)/);
    assert.doesNotMatch(r, /Zapatilla 2.*\(ya lo tenia en el carrito de antes\)/);
    assert.match(r, /Los items marcados.*mencionaselo con naturalidad/);
  });

  test('despues de confirmar, crear_pedido SI crea y descuenta el stock de la variante', async () => {
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[1].id }, orderBy: { id: 'asc' } });
    const stockAntes = variante.stock;
    await agregarAlCarrito([{ idProducto: productos[1].id, idVariante: variante.id, cantidad: 2, precio: productos[1].precio }]);

    const paso1 = iaFalsa([{ tool_calls: [tool('confirmar_pedido', {})] }, { content: '¿Esta todo bien?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero 2', undefined, { llamarInyectado: paso1.llamar });

    const paso2 = iaFalsa([{ tool_calls: [tool('crear_pedido', {})] }, { content: 'Listo, pedido tomado.' }]);
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

  test('una direccion escrita a mano (sin ubicacion real) NO deja avanzar: pide ubicacion o link de Maps', async () => {
    await reiniciarLead({
      atributosLead: { Genero: 'Hombre' }, nombre: 'Cesar Prueba', formaPago: 'EFECTIVO',
      tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av Ballivian 1234, casi esquina con el mercado',
      // Ojo: sin ubicacionLat/Lng - una direccion escrita sola, como pego el
      // cliente del transcript real, nunca debe alcanzar para cerrar.
    });
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id } });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: variante.id, cantidad: 1, precio: productos[0].precio }]);
    const antes = await prisma.pedido.count({ where: { empresaId } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('confirmar_pedido', {})] },
      { content: 'Un momento.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'dale', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /no es una ubicacion real/);
    assert.match(recibido.toolResults[0], /comparta su UBICACION/);
    assert.equal(await prisma.pedido.count({ where: { empresaId } }), antes, 'no se creo ningun pedido nuevo');
  });

  test('un link de Google Maps pegado como texto SI resuelve a coordenadas y deja avanzar', async () => {
    await reiniciarLead({
      atributosLead: { Genero: 'Hombre' }, nombre: 'Cesar Prueba', formaPago: 'EFECTIVO',
      tipoEntrega: 'DOMICILIO', direccionEntrega: 'Mi ubicacion: https://www.google.com/maps/@-17.767619,-63.181035,15z',
    });
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id } });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: variante.id, cantidad: 1, precio: productos[0].precio }]);
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('confirmar_pedido', {})] },
      { content: 'Un momento.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'dale', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TOOL_SUCCESS/);
    assert.match(recibido.toolResults[0], /Resumen REAL del pedido/);

    const lead = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    assert.ok(lead.ubicacionLat, 'el link se resolvio y quedo guardado para la proxima');
  });

  test('si pide retiro en tienda y el negocio no cargo su direccion, no se crea nada', async () => {
    await reiniciarLead({
      atributosLead: { Genero: 'Hombre' }, nombre: 'Cesar Prueba',
      formaPago: 'EFECTIVO', tipoEntrega: 'RECOJO',
    });
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[2].id } });
    await agregarAlCarrito([{ idProducto: productos[2].id, idVariante: variante.id, cantidad: 1, precio: productos[2].precio }]);
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('confirmar_pedido', {})] },
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
    // El modelo intenta mostrar en dos tandas dentro del mismo turno. El
    // mensaje NO nombra un producto puntual completo a proposito (evita que
    // productoNombradoPorCliente fuerce ver_mas_productos hacia un solo ID
    // ya mostrado) - buscar_producto marca el pedido como puntual igual,
    // que alcanza para pasar el gate de "solo tarjeta de categoria".
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('buscar_producto', { nombre: 'Zapatilla' }), tool('mostrar_productos', { idsProductos: productos.map((p) => p.id) })] },
      { tool_calls: [tool('ver_mas_productos', {})] },
      { content: 'Ahi las tenes.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'que modelos tenes?', undefined, { llamarInyectado: llamar });

    assert.ok(salida.fotos.length <= 3, `se mandaron ${salida.fotos.length} fotos, el tope es 3`);
    assert.equal(salida.fotos.length, 3);
    // toolResults[0] = buscar_producto, [1] = mostrar_productos, [2] = ver_mas_productos.
    const tercerResultado = recibido.toolResults[2] || '';
    assert.match(tercerResultado, /maximo para no llenarle el chat/);
  });

  test('el texto que se le pide al modelo ya no lo empuja a cerrar la venta', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Listo.' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'tenes la Zapatilla 1?', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /NO lo presiones para que compre/);
    assert.match(r, /NO le preguntes si alguna lo convencio/);
    assert.doesNotMatch(r, /CIERRE empujando el pedido/);
  });
});

describe('menu de categorias en dos niveles', () => {
  test('"que vendes" devuelve los RUBROS, no las subcategorias ni un link (backend, sin llamar a la IA)', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null });
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'cual es tu catalogo', undefined, { llamarInyectado: async () => { throw new Error('no deberia llamarse a la IA'); } });

    assert.match(salida.respuesta, /Calzado/, 'tiene que listar el rubro');
    assert.doesNotMatch(salida.respuesta, /Botas/, 'las subcategorias son del segundo nivel, no de este');
    assert.doesNotMatch(salida.respuesta, /http/, 'nunca mas un link al catalogo web');
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

  // Bug real reportado: si el rubro tiene un atributo obligatorio propio
  // (ej. Genero) ademas de subcategorias, este handler listaba los tipos
  // directo, sin preguntar el atributo antes - mismo bug que el de
  // seccionProductos, pero en el camino de mostrar_categorias.
  test('si el rubro tiene un atributo obligatorio propio, se pregunta ANTES de listar los tipos', async () => {
    await prisma.categoriaAtributo.create({ data: { categoriaId: rubro.id, nombre: 'Genero', nivel: 'OBLIGATORIO', esDeVariante: false, orden: 0 } });
    try {
      await reiniciarLead({ categoriaInteres: 'Calzado', categoriaId: rubro.id, atributosLead: {} });
      const { llamar, recibido } = iaFalsa([
        { tool_calls: [tool('mostrar_categorias', {})] },
        { content: '¿Para hombre o para mujer?' },
      ]);
      await generarRespuesta(agenteId, TELEFONO, [], 'que tipos tenes', undefined, { llamarInyectado: llamar });

      const r = recibido.toolResults[0];
      assert.match(r, /falta saber Genero/);
      assert.doesNotMatch(r, /Dentro de "Calzado"/, 'no puede listar los tipos antes de saber el genero');
      assert.doesNotMatch(r, /Botas/);
    } finally {
      await prisma.categoriaAtributo.deleteMany({ where: { categoriaId: rubro.id, nombre: 'Genero' } });
    }
  });

  test('elegida la subcategoria por primera vez, sale la tarjeta de esa subcategoria (regla del negocio: backend, no la IA)', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null });
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'botas', undefined, { llamarInyectado: async () => { throw new Error('no deberia llamarse a la IA'); } });

    assert.equal(salida.fotos.length, 1, 'tarjeta de la subcategoria Botas, no un producto individual');
    assert.match(salida.fotos[0].caption, /Botas/);
  });

  test('si el cliente pide ver todo el catalogo, mostrar_categorias sale del rubro actual', async () => {
    // Bug real: con categoriaInteres ya fijado en un rubro con subcategorias
    // ("Calzado"), el cliente pregunto "que mas venden?" y el bot siguio
    // devolviendo solo los tipos de calzado en vez del catalogo completo.
    await reiniciarLead({ categoriaInteres: 'Calzado', categoriaId: rubro.id });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_categorias', {})] },
      { content: '¿Cual te interesa?' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'que mas venden?', undefined, { llamarInyectado: llamar });

    const r = recibido.toolResults[0];
    assert.match(r, /TOOL_SUCCESS/);
    assert.match(r, /Calzado/, 'tiene que listar los rubros, no los tipos');
    assert.doesNotMatch(r, /Dentro de "Calzado"/, 'no debe quedarse en el drill-down del rubro anterior');
    assert.doesNotMatch(r, /Botas/, 'las subcategorias son del segundo nivel, no de este');
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

// Pedido explicito del dueño despues de varios bugs reales seguidos donde el
// modelo no llamaba a mostrar_tarjeta_categoria (a veces no llamaba a NINGUNA
// tool y describia la categoria en texto plano, a veces intentaba
// mostrar_productos sin categoria elegida): el backend manda la tarjeta el
// mismo, ANTES de preguntarle a la IA, para el caso deterministico (categoria
// ya elegida, nada puntual nombrado, tarjeta todavia no vista). La IA ya no
// decide esto - ver "DECISION DETERMINISTICA" en agente.js, justo antes del
// loop de vueltas.
describe('la tarjeta de categoria la manda el backend, sin preguntarle a la IA', () => {
  test('categoria recien elegida EN ESTE MENSAJE: la tarjeta sale SIN llamar nunca a la IA', async () => {
    // categoriaId null a proposito: lo que importa es que el mensaje de
    // ESTE turno sea el que recien resuelve la categoria (detectados.categoriaId),
    // no una que ya estuviera fijada de antes (ver el comentario del gate en
    // agente.js - ese es justo el bug que este test previene).
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: { Genero: 'Hombre' } });
    let llamadasALaIA = 0;
    const llamarQueNoDeberiaUsarse = async () => { llamadasALaIA += 1; return { content: 'no deberia llegar aca', tool_calls: [] }; };

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamarQueNoDeberiaUsarse });

    assert.equal(llamadasALaIA, 0, 'el turno se resuelve entero en codigo, la IA nunca deberia haberse llamado');
    assert.equal(salida.fotos.length, 1, 'la tarjeta de categoria (una imagen), no tarjetas de producto sueltas');
    assert.doesNotMatch(salida.respuesta, /tarjeta/i);
  });

  test('categoria ya elegida de un turno anterior, mensaje de seguimiento SIN nombrarla: el bloque nuevo no intercepta', async () => {
    // Este es el caso que rompio la primera version del gate: con la
    // categoria ya fijada de antes, cualquier mensaje de seguimiento
    // ("mandame foto de la gris", "confirmo el pedido") no debe disparar la
    // tarjeta pre-emptiva solo porque no nombra un producto por su nombre
    // completo - eso lo sigue interpretando la IA como corresponde.
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    let llamadasALaIA = 0;
    const llamar = async () => { llamadasALaIA += 1; return { content: 'segui la conversacion normal.', tool_calls: [] }; };

    await generarRespuesta(agenteId, TELEFONO, [], 'y el envio cuanto sale?', undefined, { llamarInyectado: llamar });

    assert.ok(llamadasALaIA > 0, 'un mensaje de seguimiento que no vuelve a nombrar la categoria tiene que seguir yendo por la IA');
  });

  test('categoria recien nombrada pero con atributo obligatorio faltante: el bloque nuevo no intercepta, sigue el flujo normal', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: {} }); // sin Genero: falta el obligatorio de "Zapatillas"
    const { llamar, recibido } = iaFalsa([{ content: '¿Para hombre o para mujer?' }]);

    await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamar });

    assert.equal(recibido.systems.length, 1, 'la IA SI se llamo (el bloque nuevo no aplica sin el atributo obligatorio)');
    assert.match(recibido.systems[0], /TODAVIA NO PODES MOSTRAR PRODUCTOS/);
  });

  test('categoria recien nombrada pero la tarjeta ya se habia mostrado antes: el bloque nuevo no la repite, sigue el flujo normal', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: { Genero: 'Hombre' }, contexto: { tarjetasCategoriaMostradas: [categoriaId] } });
    const { llamar, recibido } = iaFalsa([{ content: '¿Cual modelo te interesa?' }]);

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas de nuevo', undefined, { llamarInyectado: llamar });

    assert.equal(recibido.systems.length, 1, 'la IA SI se llamo (ya se habia mostrado, no hay nada deterministico que hacer)');
    assert.equal(salida.fotos.length, 0, 'no se repite la tarjeta sola');
  });

  test('producto puntual nombrado: el bloque nuevo no aplica, sigue el flujo de la IA', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('buscar_producto', { nombre: 'Zapatilla 1' })] },
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Ahi la tenes.' },
    ]);

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'tenes la Zapatilla 1?', undefined, { llamarInyectado: llamar });

    assert.ok(recibido.systems.length > 0, 'la IA SI se llamo (nombro un producto puntual, es interpretacion real)');
    assert.equal(salida.fotos.length, 1);
    assert.match(salida.fotos[0].caption, /Zapatilla 1/);
  });

  // Bug real detectado probando en vivo (chat de prueba del panel, sin
  // WhatsApp real conectado): una categoria sin NINGUNA foto cargada (ni en
  // la categoria, ni en ninguno de sus productos) hacia que el texto con
  // precio/cantidad/link se perdiera entero - no entraba en ninguna de las
  // ramas de envio de mostrar_tarjeta_categoria, y el bot igual confirmaba
  // "TOOL_SUCCESS" y le decia al cliente "echale un vistazo" a algo que
  // nunca le llego (ni imagen ni texto).
  test('categoria SIN ninguna foto cargada: el texto con los datos reales no se pierde', async () => {
    const catSinFotos = await prisma.categoria.create({ data: { empresaId, nombre: 'Gorras' } });
    const prodSinFoto = await prisma.producto.create({
      data: { empresaId, categoriaId: catSinFotos.id, nombre: 'Gorra clasica', precio: 80, stock: 5, fotos: [] },
    });
    try {
      await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: {} });
      const salida = await generarRespuesta(agenteId, TELEFONO, [], 'quiero gorras', undefined, { llamarInyectado: async () => { throw new Error('no deberia llamarse a la IA'); } });

      assert.equal(salida.fotos.length, 1, 'tiene que haber una entrada, aunque sea sin imagen, para no perder el texto');
      assert.equal(salida.fotos[0].url, null);
      assert.match(salida.fotos[0].caption, /Gorras/);
      assert.match(salida.fotos[0].caption, /Bs 80/, 'el precio real no puede perderse');
    } finally {
      await prisma.producto.delete({ where: { id: prodSinFoto.id } });
      await prisma.categoria.delete({ where: { id: catSinFotos.id } });
    }
  });

  // Bug real reportado por WhatsApp: "Hola" -> "que productos tienes?" ->
  // "Hombre" -> el bot respondia "Parece que tuve un problema..." antes de
  // mostrar el menu. Reproduce la conversacion completa, turno por turno,
  // confirmando que nunca hace falta la IA para el camino feliz.
  test('BUG real: Hola -> que productos tienes -> Hombre -> elegir categoria, sin ningun "tuve un problema"', async () => {
    await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { preguntasIniciales: ['Genero'] } });
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: {} });
    const llamarQueNoDeberia = async () => { throw new Error('no deberia llamarse a la IA en este camino'); };

    const r1 = await generarRespuesta(agenteId, TELEFONO, [], 'Hola', undefined, { llamarInyectado: llamarQueNoDeberia });
    assert.doesNotMatch(r1.respuesta, /problema|confundi|error/i);

    const h1 = [{ rol: 'CLIENTE', contenido: 'Hola' }, { rol: 'AGENTE', contenido: r1.respuesta }];
    const r2 = await generarRespuesta(agenteId, TELEFONO, h1, 'que productos tienes?', undefined, { llamarInyectado: llamarQueNoDeberia });
    assert.doesNotMatch(r2.respuesta, /problema|confundi|error/i);

    // Con "Hombre" contestado, el fixture principal queda con UN SOLO rubro
    // visible ("Zapatillas" - "Calzado" es todo de Mujer), asi que este
    // mismo turno ya resuelve categoria + tarjeta (menu_rubro_unico_auto):
    // no hace falta un turno extra eligiendo de una lista.
    const h2 = [...h1, { rol: 'CLIENTE', contenido: 'que productos tienes?' }, { rol: 'AGENTE', contenido: r2.respuesta }];
    const r3 = await generarRespuesta(agenteId, TELEFONO, h2, 'Hombre', undefined, { llamarInyectado: llamarQueNoDeberia });
    assert.doesNotMatch(r3.respuesta, /problema|confundi|error/i);
    assert.ok(r3.fotos.length > 0, 'la tarjeta de la categoria tiene que salir de verdad, no un texto vacio');

    await prisma.agenteConfig.updateMany({ where: { agenteId }, data: { preguntasIniciales: [] } });
  });
});

// Bug real reportado con capturas de WhatsApp: el cliente contesto el genero
// que le pidio la tienda pero TODAVIA no habia elegido ninguna categoria. El
// modelo igual intento mostrar_productos, el redirect de "solo tarjeta de
// categoria" (Fix B) lo mando a mostrar_tarjeta_categoria - pero sin
// categoria elegida esa tool no tiene de que categoria ser, fallaba, y el
// cliente terminaba con "Perdon, no pude traerte las opciones" sin haber
// visto ni el menu de rubros.
describe('BUG - sin categoria elegida todavia, no se rompe intentando la tarjeta', () => {
  // Nota: con atributosLead Genero=Hombre, el fixture principal queda con UN
  // SOLO rubro visible ("Zapatillas" - "Calzado" es todo de Mujer), asi que
  // el camino real es menu_rubro_unico_auto (tambien arreglado: usa
  // mostrar_tarjeta_categoria) en vez del menu de varios rubros. Lo que se
  // verifica es lo que de verdad importa: NUNCA "no pude traerte las
  // opciones" sin haber mostrado nada, sea cual sea el camino.
  test('mostrar_productos sin categoria elegida no termina en "no pude traerte las opciones" (ahora resuelto por el backend, sin la IA)', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: { Genero: 'Hombre' } });
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Soy hombre', undefined, { llamarInyectado: async () => { throw new Error('no deberia llamarse a la IA'); } });

    assert.doesNotMatch(salida.respuesta, /no pude traerte las opciones/i);
    assert.ok(salida.fotos.length > 0, 'algo real se le tiene que haber mostrado');
  });

  test('si el modelo insiste con texto vago sin categoria, el rescate de ultima vuelta tambien resuelve algo real', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: { Genero: 'Hombre' } });
    const { llamar } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Aca tenes las opciones.' },
      { content: 'Dejame mostrarte lo que tenemos.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Soy hombre', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(salida.respuesta, /no pude traerte las opciones/i);
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

  // Comportamiento nuevo, pedido explicito del dueño: el menu de NOMBRES de
  // categorias nunca depende de datos del cliente - eso solo importa para
  // filtrar PRODUCTOS adentro de una categoria puntual (ver el siguiente
  // test). Antes esto bloqueaba TAMBIEN el menu, lo cual dejaba al cliente
  // sin poder ver ni que rubros existen hasta contestar una pregunta que no
  // tenia nada que ver con eso.
  test('el MENU de rubros SI sale sin saber el genero (backend, sin llamar a la IA)', async () => {
    await reiniciarLead({ categoriaInteres: null, categoriaId: null, atributosLead: {} });
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'cual es tu catalogo', undefined, { llamarInyectado: async () => { throw new Error('no deberia llamarse a la IA'); } });

    assert.match(salida.respuesta, /Calzado|Zapatillas/);
  });

  test('tampoco productos, aunque el cliente nombre una categoria', async () => {
    await reiniciarLead({ atributosLead: {} });
    const { llamar, recibido } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: productos.map((p) => p.id) })] },
      { content: '¿Para quien es?' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'quiero zapatillas', undefined, { llamarInyectado: llamar });

    assert.match(recibido.toolResults[0], /TODAVIA NO le (muestres productos|mandes esta tarjeta)/);
    assert.match(recibido.toolResults[0], /Genero/);
    assert.deepEqual(salida.fotos, []);
  });

  test('el prompt le dice que pregunte UNA sola cosa y de forma natural', async () => {
    await reiniciarLead({ atributosLead: {} });
    const { llamar, recibido } = iaFalsa([{ content: '¿Para hombre o para mujer?' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'hola', undefined, { llamarInyectado: llamar });

    const system = recibido.systems[0];
    assert.match(system, /TODAVIA NO PODES MOSTRAR PRODUCTOS/);
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
    // Nombra un producto puntual para pasar el gate de "solo tarjeta de
    // categoria" y llegar al bloque de resultados que arma esta lista.
    await generarRespuesta(agenteId, TELEFONO, [], 'tenes la Zapatilla 1?', undefined, { llamarInyectado: llamar });

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

  // Ambos turnos nombran el producto puntual ("Park St 2.0") para pasar el
  // gate de "solo tarjeta de categoria" (regla del negocio) y seguir
  // probando el mecanismo que motivo este test: el permiso de filtro
  // relajado no debe pedirse en bucle en una conversacion larga.
  test('la primera vez SI pide permiso (la talla no calza)', async () => {
    const r = await turnoDelCliente('tenes la Park St 2.0?');
    assert.equal(r.bloqueado, true);
    assert.deepEqual(r.salida.fotos, []);
  });

  test('cuando el cliente dice que si, MUESTRA (antes volvia a preguntar para siempre)', async () => {
    const r = await turnoDelCliente('si, dale, mostrame la Park St 2.0');
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
    assert.doesNotMatch(a.recibido.toolResults[0], /Tambien hay stock de esto/, 'cross-sell eliminado: nunca sugiere relacionados');

    // 2) dice que si y agrega otro (con su variante: el cliente la vio en la tarjeta)
    const variante2 = await prisma.variante.findFirst({ where: { productoId: productos[1].id }, orderBy: { id: 'asc' } });
    const b = iaFalsa([{ tool_calls: [tool('agregar_al_carrito', { idProducto: productos[1].id, idVariante: variante2.id, cantidad: 2 })] }, { content: 'Listo.' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'agregame tambien la otra', conv.id, { llamarInyectado: b.llamar });
    assert.match(b.recibido.toolResults[0], /Zapatilla 1/, 'el primero sigue en el carrito');
    assert.match(b.recibido.toolResults[0], /Zapatilla 2/);
    assert.doesNotMatch(b.recibido.toolResults[0], /Tambien hay stock de esto/, 'ya esta cerrando: no sugiere mas productos fuera de contexto');

    // 3) cierra
    await prisma.clienteFinal.updateMany({
      where: { telefono: TELEFONO },
      data: {
        nombre: 'Juan Perez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 123', formaPago: 'EFECTIVO',
        ubicacionLat: -17.767619, ubicacionLng: -63.181035,
      },
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
    await reiniciarLead({
      atributosLead: { Genero: 'Hombre' }, nombre: 'Juan', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 1', formaPago: 'EFECTIVO',
      ubicacionLat: -17.767619, ubicacionLng: -63.181035,
    });
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

  // ACTUALIZADO (regla del negocio, pedido explicito del dueño): explorando
  // sin nombrar nada puntual, el sistema YA NO rellena la pagina con
  // tarjetas de producto - redirige a la tarjeta de categoria (Fix B),
  // aunque el modelo haya intentado mostrar_productos. Las tarjetas de
  // producto individuales quedan reservadas a busquedas puntuales.
  test('explorando sin nombrar nada, se redirige a la tarjeta de categoria (nunca tarjetas sueltas)', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });

    const { llamar } = iaFalsa([
      { tool_calls: [tool('mostrar_productos', { idsProductos: [productos[0].id] })] },
      { content: 'Mira esto.' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'que modelos tenes?', undefined, { llamarInyectado: llamar });

    assert.equal(salida.fotos.length, 1, 'una sola imagen: la tarjeta de categoria, no tarjetas de producto');
  });
});

// Bug reportado con capturas: el cliente contesto "si" a "¿alguna te
// interesa?" y el bot salto directo a "¿te lo enviamos a domicilio?" sin
// preguntarle nunca talla ni color. El pedido se armaba a ciegas.
describe('no se cierra sin saber que se lleva el cliente', () => {
  test('si el bot pide datos de entrega sin variante elegida, se lo frena y pregunta la talla', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, productosMostrados: [productos[0].id] });

    const { llamar } = iaFalsa([
      { content: '¡Listo! Para la entrega, ¿te gustaría que lo enviemos a domicilio?' },
      { content: '¿En qué talla lo querés?' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'si', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(salida.respuesta, /domicilio/i, 'no puede pasar al cierre sin saber la combinacion');
    assert.match(salida.respuesta, /talla/i);
  });

  test('si insiste hasta la ultima vuelta, la pregunta la arma el codigo con las tallas reales', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, productosMostrados: [productos[0].id] });

    const { llamar } = iaFalsa([
      { content: '¿Te lo enviamos a domicilio?' },
      { content: 'Perfecto, ¿cuál es tu nombre?' },
      { content: '¿Y la forma de pago?' },
    ]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'si', undefined, { llamarInyectado: llamar });

    assert.match(salida.respuesta, /talla/i);
    assert.match(salida.respuesta, /42/, 'lista las tallas que existen de verdad');
  });

  test('con algo YA en el carrito, preguntar la entrega es correcto y no se frena', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, productosMostrados: [productos[0].id] });

    const conVariante = iaFalsa([
      { tool_calls: [tool('agregar_al_carrito', { idProducto: productos[0].id, idVariante: productos[0].variantes[0].id })] },
      { content: '¿Te lo enviamos a domicilio?' },
    ]);
    await generarRespuesta(agenteId, TELEFONO, [], 'quiero la 42 negra', undefined, { llamarInyectado: conVariante.llamar });

    const cierre = iaFalsa([{ content: 'Para la entrega, ¿te lo enviamos a domicilio?' }]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'dale', undefined, { llamarInyectado: cierre.llamar });

    assert.match(salida.respuesta, /domicilio/i, 'ya sabe que se lleva: el cierre tiene que avanzar');
  });
});

// Bug real reportado en produccion: el ciclo de venta nunca cerraba - el bot
// volvia a mandar tarjetas de producto una y otra vez despues de que el
// cliente ya tenia cosas en el carrito y estaba en pleno cierre. La causa
// real era el "rescate de ultima vuelta": si el modelo respondia con texto
// vago (ej. "voy a revisar eso") y no quedaban mas vueltas, el codigo
// forzaba el mismo un llamado a mostrar_productos sin mirar si el cliente
// ya estaba cerrando.
// Bug real reportado: "Dentro de Poleras tenemos varios tipos - ¿cuál te
// interesa?" sin listar ninguna opcion real - el rescate de ultima vuelta
// tenia un texto generico hardcodeado en vez de armar la lista de verdad.
describe('BUG - rescate de ultima vuelta con rubro sin elegir: lista los tipos reales', () => {
  test('rubro con subcategorias: el rescate lista los tipos reales, nunca una pregunta abierta sin opciones', async () => {
    // El nombre del producto menciona "Calzado" a proposito - asi es como
    // pasa en la tienda real: buscarConFallback matchea por nombre de
    // categoria O por nombre de producto, y ese texto compartido es lo que
    // hace que candidatosActuales no este vacio parado en el rubro (sin
    // eso, el rescate ni siquiera entra a este camino, cae al de "sin
    // candidatos" que es un texto todavia mas generico).
    const productoTextMatch = await prisma.producto.create({
      data: { empresaId, categoriaId: subcategoria.id, nombre: 'Bota de Calzado urbano', precio: 250, stock: 4, atributos: { Genero: 'Hombre' } },
    });
    try {
      await reiniciarLead({ categoriaInteres: 'Calzado', categoriaId: rubro.id, atributosLead: { Genero: 'Hombre' } });
      const { llamar } = iaFalsa([{ content: 'Voy a revisar eso para vos.' }]);
      const salida = await generarRespuesta(agenteId, TELEFONO, [], 'que tipos hay', undefined, { llamarInyectado: llamar });

      // "Sandalias" no deberia aparecer: en el fixture, sus productos son
      // todos de Genero Mujer, y el lead pidio Hombre - la lista sale
      // correctamente filtrada por ese dato (subcategoriasDe ya lo hace).
      assert.match(salida.respuesta, /Botas/);
      assert.doesNotMatch(salida.respuesta, /Sandalias/);
      assert.doesNotMatch(salida.respuesta, /tenemos varios tipos/i, 'no puede ser la pregunta generica sin opciones reales');
    } finally {
      await prisma.producto.delete({ where: { id: productoTextMatch.id } });
    }
  });
});

describe('BUG - durante el cierre, el rescate de ultima vuelta no debe reabrir el catalogo', () => {
  test('con carrito activo y estadoConversacion en cierre, pregunta datos de cierre en vez de mostrar productos', async () => {
    // estadoConversacion en cierre pero SIN productoFavoritoId: exactamente
    // el estado real cuando el favorito se limpio por un cambio de
    // categoria a mitad del cierre (limpiezaPorCambioDeCategoria).
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, estadoConversacion: 'DATOS_DE_PEDIDO' });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: productos[0].variantes[0].id, cantidad: 1, precio: productos[0].precio }]);

    // El modelo insiste con texto vago (dispara pareceAnuncioDeBusqueda) en
    // las 3 vueltas - se agota el MAX_VUELTAS y entra el rescate forzado.
    const { llamar, recibido } = iaFalsa([{ content: 'Voy a revisar eso para vos.' }]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'y que mas tenes', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(salida.respuesta, /Estas son las opciones|¿Alguna te interesa|opciones que tenemos/i, 'no debe reabrir el catalogo durante el cierre');
    assert.doesNotMatch(recibido.systems.at(-1) || '', /TODAVIA NO PODES MOSTRAR PRODUCTOS/, 'seccionProductos no deberia bloquear durante el cierre');
  });

  // Bug real reportado con capturas de WhatsApp: en pleno cierre (carrito con
  // algo), el cliente pedia explicitamente ver otra cosa ("quiero ver
  // camisas para hombre", "no puedo ver otra categoria?", "quiero seguir
  // mirando que tienes") y el bot repetia SIEMPRE la misma pregunta de
  // cierre ("¿confirmas que esta todo bien?"), sin importar la respuesta -
  // el cliente quedaba sin forma de seguir mirando el catalogo.
  test('si el cliente pide explicitamente ver otra cosa durante el cierre, se le muestra en vez de repetir la pregunta de cierre', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, estadoConversacion: 'DATOS_DE_PEDIDO' });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: productos[0].variantes[0].id, cantidad: 1, precio: productos[0].precio }]);

    // Mismo texto vago que el test de arriba (dispara pareceAnuncioDeBusqueda
    // en las 3 vueltas) - lo que cambia es el mensaje del cliente.
    const { llamar } = iaFalsa([{ content: 'Voy a revisar eso para vos.' }]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Quiero seguir mirando que tienes en la tienda', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(salida.respuesta, /confirmas que esta todo bien|ya tengo todo listo/i, 'no debe repetir la pregunta de cierre cuando el cliente pidio explicitamente ver otra cosa');
    // El lead ya tenia "Zapatillas" fijada (reiniciarLead): sin nombrar una
    // categoria nueva en este mensaje, se le vuelve a mostrar ESA (util
    // igual, no rompe el contexto) en vez del menu de rubros - lo que
    // importa para este test es que muestre algo real, nunca la pregunta de
    // cierre generica.
    assert.match(salida.respuesta, /Echale un vistazo a zapatillas|Esto es lo que tenemos/i, 'debe mostrar algo real para navegar');
  });

  test('si ya vio la tarjeta de su categoria y pide seguir mirando sin nombrar otra, se le manda el menu de rubros', async () => {
    await reiniciarLead({
      atributosLead: { Genero: 'Hombre' },
      estadoConversacion: 'DATOS_DE_PEDIDO',
      contexto: { tarjetasCategoriaMostradas: [categoriaId] },
    });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: productos[0].variantes[0].id, cantidad: 1, precio: productos[0].precio }]);

    const { llamar } = iaFalsa([{ content: 'Voy a revisar eso para vos.' }]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Quiero seguir mirando que tienes en la tienda', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(salida.respuesta, /confirmas que esta todo bien|ya tengo todo listo/i);
    assert.match(salida.respuesta, /Esto es lo que tenemos/i, 'ya vio esa tarjeta: cae al menu real de rubros');
  });

  test('si el cliente nombra una categoria puntual durante el cierre, se le manda la tarjeta de ESA categoria sin perder el carrito', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' }, estadoConversacion: 'DATOS_DE_PEDIDO' });
    await agregarAlCarrito([{ idProducto: productos[0].id, idVariante: productos[0].variantes[0].id, cantidad: 1, precio: productos[0].precio }]);

    const { llamar } = iaFalsa([{ content: 'Voy a revisar eso para vos.' }]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Quiero ver botas', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(salida.respuesta, /confirmas que esta todo bien|ya tengo todo listo/i);
    assert.match(salida.respuesta, /botas/i, 'debe mostrar la tarjeta de la categoria pedida, no la que ya estaba en el lead');

    const cliente = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    const carrito = (cliente.contexto && cliente.contexto.carrito && cliente.contexto.carrito.items) || [];
    assert.equal(carrito.length, 1, 'el carrito no debe tocarse solo por mostrarle otra categoria');
  });

  // ACTUALIZADO (regla del negocio): fuera de cierre, sin producto puntual
  // nombrado, el rescate YA NO fuerza mostrar_productos - fuerza la tarjeta
  // de categoria (Fix C), consistente con que nunca se manden tarjetas de
  // producto sueltas sin una busqueda puntual.
  test('sin estar en cierre (explorando) y sin nombrar nada puntual, el rescate fuerza la tarjeta de categoria', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar } = iaFalsa([{ content: 'Voy a revisar eso para vos.' }]);
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'mostrame zapatillas', undefined, { llamarInyectado: llamar });

    assert.match(salida.respuesta, /zapatillas que tenemos/i, 'fuera de cierre, el rescate manda la tarjeta de categoria');
    assert.equal(salida.fotos.length, 1, 'una sola imagen: la tarjeta de categoria');
  });
});

// El cross-sell se elimino por completo (causaba que el bot insistiera con
// productos fuera de contexto): ni al agregar al carrito por chat, ni al
// agregar desde el catalogo web, se sugiere nada mas.
describe('BUG - cross-sell eliminado por completo', () => {
  test('el aviso de "agregaste algo desde la web" ya no sugiere productos relacionados', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const cliente = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    await prisma.clienteFinal.update({
      where: { id: cliente.id },
      data: {
        contexto: {
          ...(cliente.contexto || {}),
          carritoWebPendiente: { productoId: productos[0].id, varianteId: null, agregadoEn: new Date().toISOString() },
        },
      },
    });

    let mensajesRecibidos = null;
    const llamar = async ({ mensajes }) => {
      if (!mensajesRecibidos) mensajesRecibidos = mensajes;
      return { content: '¡Buena elección!', tool_calls: [] };
    };
    await generarRespuesta(agenteId, TELEFONO, [], 'hola', undefined, { llamarInyectado: llamar });

    const avisoWeb = mensajesRecibidos.find((m) => m.role === 'user' && /ACABA de agregar/.test(m.content));
    assert.ok(avisoWeb, 'deberia inyectar el aviso de carrito web');
    assert.doesNotMatch(avisoWeb.content, /Tambien hay stock de esto/);
  });
});

// "Que recuerde los pedidos, tallas y todo que ha usado el cliente" - memoria
// de compras reales anteriores inyectada en el prompt (con DB real: el
// pedido tiene que existir de verdad, nunca se inventa).
describe('memoria de compras anteriores del cliente (con DB real)', () => {
  test('con un pedido real anterior, el prompt del turno actual incluye ese resumen', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const cliente = await prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
    const variante = await prisma.variante.findFirst({ where: { productoId: productos[0].id }, orderBy: { id: 'asc' } });

    await prisma.pedido.create({
      data: {
        empresaId, clienteId: cliente.id, total: productos[0].precio, estado: 'ENTREGADO',
        items: { create: [{ productoId: productos[0].id, varianteId: variante.id, nombre: productos[0].nombre, precio: productos[0].precio, cantidad: 1 }] },
      },
    });

    const { llamar, recibido } = iaFalsa([{ content: 'Hola de nuevo!' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'hola', undefined, { llamarInyectado: llamar });

    assert.match(recibido.systems[0], /Compras reales anteriores/);
    assert.match(recibido.systems[0], new RegExp(productos[0].nombre));

    await prisma.pedido.deleteMany({ where: { empresaId, clienteId: cliente.id } });
  });

  test('un cliente nuevo sin pedidos anteriores no ve ninguna mencion inventada', async () => {
    await reiniciarLead({ atributosLead: { Genero: 'Hombre' } });
    const { llamar, recibido } = iaFalsa([{ content: 'Hola!' }]);
    await generarRespuesta(agenteId, TELEFONO, [], 'hola', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(recibido.systems[0], /Compras reales anteriores/);
  });
});
