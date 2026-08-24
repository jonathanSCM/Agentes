// Tests de regresion del motor de busqueda del agente de ventas.
// Puramente deterministas (sin base de datos ni proveedor de IA): cubren las
// reglas de negocio criticas del documento "Instrucciones para mejorar el
// Agente de Ventas" que no dependen de que un modelo de lenguaje "se acuerde"
// de seguirlas.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buscarProductosFiltrados,
  productosCandidatosAMostrar,
  extraerFiltros,
  resolverSeleccionMenu,
  seccionProductos,
  construirSystem,
  partesDelSystem,
  fichaProducto,
  limpiezaPorCambioDeCategoria,
  datosDeActualizacionDeLead,
  resumenPedidosPrevios,
  primeraPreguntaDeCierre,
} = require('../lib/services/agente');
const { coincideAtributosLead, buscarConFallback, buscarPorNombre, coloresConFotoDeVariantes, mensajeWhatsappProducto } = require('../lib/services/catalogo');

// Categoria ahora es una relacion ({id, nombre}), no texto libre. Los tests
// de este archivo siguen pasando `categoria: 'Zapatillas'` como string por
// comodidad - la factory la envuelve sola. Mismo nombre siempre da el mismo
// id (hash simple), asi dos productos de "la misma categoria" en un test
// quedan con el mismo categoria.id, como pasaria de verdad en la DB.
function idDeCategoria(nombre) {
  let h = 0;
  for (const c of String(nombre)) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return h;
}

function producto(overrides) {
  const base = {
    id: 1,
    nombre: 'Producto generico',
    categoria: 'Calzado',
    descripcion: '',
    precio: 100,
    stock: 5,
    caracteristicas: [],
    atributos: {},
    variantes: [],
    ...overrides,
  };
  if (typeof base.categoria === 'string') {
    base.categoria = { id: idDeCategoria(base.categoria), nombre: base.categoria };
  }
  return base;
}

describe('buscarProductosFiltrados', () => {
  test('categoria y presupuesto se usan JUNTOS, no el presupuesto solo (punto 5)', () => {
    const productos = [
      producto({ id: 1, categoria: 'Zapatillas', precio: 480 }),
      producto({ id: 2, categoria: 'Mochilas', precio: 480 }), // mismo precio, otra categoria
      producto({ id: 3, categoria: 'Zapatillas', precio: 900 }), // misma categoria, fuera de presupuesto
    ];
    const lead = { categoriaInteres: 'Zapatillas', presupuesto: 'hasta Bs 500' };
    const resultado = buscarProductosFiltrados(productos, lead);
    assert.deepEqual(resultado.map((p) => p.id), [1]);
  });

  test('nunca devuelve productos de otra categoria por defecto (punto 6)', () => {
    const productos = [
      producto({ id: 1, categoria: 'Electrodomesticos', precio: 9999 }), // fuera de presupuesto
      producto({ id: 2, categoria: 'Accesorios', precio: 50 }), // barato pero otra categoria
    ];
    const lead = { categoriaInteres: 'Electrodomesticos', presupuesto: 'Bs 100' };
    const resultado = buscarProductosFiltrados(productos, lead);
    assert.equal(resultado.length, 0, 'no debe colarse un producto de otra categoria aunque calce en presupuesto');
  });

  test('nunca muestra productos sin stock', () => {
    const productos = [producto({ id: 1, categoria: 'Zapatillas', stock: 0 })];
    const lead = { categoriaInteres: 'Zapatillas' };
    assert.deepEqual(buscarProductosFiltrados(productos, lead), []);
  });

  test('excluye productos ya descartados explicitamente por el cliente', () => {
    const productos = [
      producto({ id: 1, categoria: 'Zapatillas' }),
      producto({ id: 2, categoria: 'Zapatillas' }),
    ];
    const lead = { categoriaInteres: 'Zapatillas', productosDescartados: [1] };
    const resultado = buscarProductosFiltrados(productos, lead);
    assert.deepEqual(resultado.map((p) => p.id), [2]);
  });

  test('la talla es un filtro estricto (funcional), no se relaja por defecto', () => {
    const productos = [
      producto({ id: 1, categoria: 'Zapatillas', variantes: [{ activa: true, atributos: { Talla: '42' } }] }),
      producto({ id: 2, categoria: 'Zapatillas', variantes: [{ activa: true, atributos: { Talla: '38' } }] }),
    ];
    const lead = { categoriaInteres: 'Zapatillas', talla: '42' };
    const resultado = buscarProductosFiltrados(productos, lead);
    assert.deepEqual(resultado.map((p) => p.id), [1]);
  });

  test('talla se puede relajar EXPLICITAMENTE con la opcion ignorarTalla', () => {
    const productos = [
      producto({ id: 1, categoria: 'Zapatillas', variantes: [{ activa: true, atributos: { Talla: '38' } }] }),
    ];
    const lead = { categoriaInteres: 'Zapatillas', talla: '42' };
    assert.equal(buscarProductosFiltrados(productos, lead).length, 0);
    assert.equal(buscarProductosFiltrados(productos, lead, { ignorarTalla: true }).length, 1);
  });

  test('un producto con stock 0 pero variantes con stock SI debe encontrarse (bug real: ropa con stock solo en variantes)', () => {
    const productos = [
      producto({
        id: 1, categoria: 'Ropa', stock: 0,
        variantes: [
          { activa: true, atributos: { Talla: 'M', Color: 'Negro' }, stock: 4 },
          { activa: true, atributos: { Talla: 'L', Color: 'Negro' }, stock: 0 },
        ],
      }),
    ];
    const lead = { categoriaInteres: 'Ropa' };
    const resultado = buscarProductosFiltrados(productos, lead);
    assert.equal(resultado.length, 1, 'el stock de las variantes debe contar como stock del producto, no solo producto.stock');
  });

  test('un producto con stock 0 en el producto Y en todas sus variantes no aparece', () => {
    const productos = [
      producto({
        id: 1, categoria: 'Ropa', stock: 0,
        variantes: [{ activa: true, atributos: { Talla: 'M' }, stock: 0 }],
      }),
    ];
    const lead = { categoriaInteres: 'Ropa' };
    assert.equal(buscarProductosFiltrados(productos, lead).length, 0);
  });

  test('atributos libres del producto (ej. Marca) suman score y matchean lo que pide el cliente', () => {
    const productos = [
      producto({ id: 1, categoria: 'Ropa', atributos: { Marca: 'Nike' } }),
      producto({ id: 2, categoria: 'Ropa', atributos: { Marca: 'Adidas' } }),
    ];
    const lead = { categoriaInteres: 'Ropa', marca: 'Nike' };
    const resultado = buscarProductosFiltrados(productos, lead);
    // ambas quedan (marca no es filtro duro), pero la que matchea debe ir primero por score
    assert.equal(resultado.length, 2);
    assert.equal(resultado[0].id, 1, 'el producto con la marca pedida debe rankear primero');
  });

  test('atributos libres genericos (no solo marca/material, ej. Voltaje) tambien matchean via texto completo', () => {
    const productos = [
      producto({ id: 1, categoria: 'Electrodomesticos', atributos: { Voltaje: '220V', Capacidad: '15kg' } }),
    ];
    const lead = { categoriaInteres: 'Electrodomesticos', observaciones: '220V' };
    const resultado = buscarProductosFiltrados(productos, lead);
    assert.equal(resultado.length, 1, 'el producto debe encontrarse por categoria');
  });
});

describe('productosCandidatosAMostrar', () => {
  test('sin categoria definida, no sugiere nada todavia', () => {
    assert.deepEqual(productosCandidatosAMostrar([producto({})], {}), []);
  });

  test('NUNCA relaja la categoria automaticamente, ni como ultimo recurso (punto 6/7)', () => {
    const productos = [
      producto({ id: 1, categoria: 'Mochilas', precio: 100 }),
    ];
    const lead = { categoriaInteres: 'Zapatillas', presupuesto: 'Bs 100' };
    // No hay ninguna zapatilla; el sistema NO debe ofrecer la mochila.
    assert.deepEqual(productosCandidatosAMostrar(productos, lead), []);
  });

  test('caso exacto del bug reportado: categoria seleccionada + "que tienen" debe encontrar productos reales', () => {
    const productos = [
      producto({ id: 10, nombre: 'Licuadora', categoria: 'Electrodomesticos', precio: 350, stock: 6 }),
      producto({ id: 11, nombre: 'Plancha', categoria: 'Electrodomesticos', precio: 180, stock: 12 }),
    ];
    const lead = { categoriaInteres: 'Electrodomesticos' };
    const resultado = productosCandidatosAMostrar(productos, lead);
    assert.equal(resultado.length, 2, 'debe encontrar los productos reales de la categoria, no responder generico/vacio');
  });

  test('no vuelve a ofrecer como "candidato nuevo" un producto ya marcado como enviado', () => {
    const productos = [
      producto({ id: 10, categoria: 'Electrodomesticos' }),
      producto({ id: 11, categoria: 'Electrodomesticos' }),
    ];
    // simula que "yaEnviadas" (usado en ejecutarFuncion via clienteFinal.contexto)
    // ya tiene el 11: productosCandidatosAMostrar no filtra por yaEnviadas (esa
    // exclusion vive en ejecutarFuncion/seccionProductos), pero confirma que la
    // lista base sigue trayendo ambos para que el llamador decida.
    const lead = { categoriaInteres: 'Electrodomesticos' };
    const resultado = productosCandidatosAMostrar(productos, lead);
    assert.equal(resultado.length, 2);
  });
});

describe('seccionProductos - no repetir tarjetas ya enviadas (bug real de produccion)', () => {
  // pidioProductoPuntual=true en los 3 casos: estos tests verifican la
  // paginacion/no-repeticion de tarjetas, que es una capa aparte del gate de
  // "solo tarjeta de categoria salvo busqueda puntual" (ver describe de mas
  // abajo, "regla del negocio: nunca tarjetas sueltas..."). Sin el gate
  // salteado, seccionProductos ni siquiera llega a la logica de paginacion.
  test('primera vez: instruye a mostrar TODOS los productos con tarjeta', () => {
    const productos = [
      producto({ id: 10, nombre: 'Licuadora', categoria: 'Electrodomesticos' }),
      producto({ id: 11, nombre: 'Plancha', categoria: 'Electrodomesticos' }),
    ];
    const lead = { categoriaInteres: 'Electrodomesticos', contexto: {} };
    const texto = seccionProductos(productos, lead, null, 'BOB', null, false, true);
    assert.match(texto, /Licuadora/);
    assert.match(texto, /Plancha/);
    assert.match(texto, /mostrar_productos/);
  });

  test('si UN producto ya fue enviado, solo pide mostrar el que falta (no lo omite ni lo repite)', () => {
    const productos = [
      producto({ id: 10, nombre: 'Licuadora', categoria: 'Electrodomesticos' }),
      producto({ id: 11, nombre: 'Plancha', categoria: 'Electrodomesticos' }),
    ];
    // Este es el bug real: la plancha (11) ya estaba en fotosEnviadas de una
    // conversacion/prueba anterior, y el sistema solo mandaba la licuadora
    // en tarjeta pero el texto igual mencionaba la plancha sin tarjeta.
    const lead = { categoriaInteres: 'Electrodomesticos', contexto: { fotosEnviadas: [11] } };
    const texto = seccionProductos(productos, lead, null, 'BOB', null, false, true);
    assert.match(texto, /Licuadora/, 'la que falta por mostrar debe seguir apareciendo');
    assert.doesNotMatch(texto, /\[ID 11\]/, 'la que ya se mostro no debe volver a ofrecerse como "nueva" para tarjeta');
  });

  test('si TODOS los productos ya fueron enviados, lo dice y confirma que no queda nada mas', () => {
    const productos = [
      producto({ id: 10, nombre: 'Sandalia de verano', categoria: 'Calzado' }),
    ];
    const lead = { categoriaInteres: 'Calzado', contexto: { fotosEnviadas: [10] } };
    const texto = seccionProductos(productos, lead, null, 'BOB', null, false, true);
    assert.match(texto, /ya se los mostraste/i);
    assert.match(texto, /Estas son TODAS las opciones reales/);
    // Repetir una tarjeta que el cliente vuelve a pedir SI esta permitido:
    // negarsela porque "ya se la mostro" hace 20 mensajes lo trata mal.
    assert.match(texto, /mandasela de nuevo sin problema/);
  });
});

describe('seccionProductos - regla del negocio: nunca tarjetas sueltas sin producto puntual', () => {
  test('categoria generica, primera vez: fuerza mostrar_tarjeta_categoria, no mostrar_productos', () => {
    const productos = [
      producto({ id: 10, nombre: 'Licuadora', categoria: 'Electrodomesticos' }),
      producto({ id: 11, nombre: 'Plancha', categoria: 'Electrodomesticos' }),
    ];
    const lead = { categoriaInteres: 'Electrodomesticos', contexto: {} };
    const texto = seccionProductos(productos, lead);
    assert.match(texto, /mostrar_tarjeta_categoria/);
    assert.doesNotMatch(texto, /Llama.*mostrar_productos/);
  });

  test('categoria generica, ya se mostro la tarjeta antes: pide el nombre puntual, no repite ni muestra productos', () => {
    const productos = [
      producto({ id: 10, nombre: 'Licuadora', categoria: 'Electrodomesticos' }),
    ];
    const categoria = productos[0].categoria;
    const lead = { categoriaInteres: 'Electrodomesticos', contexto: { tarjetasCategoriaMostradas: [categoria.id] } };
    const texto = seccionProductos(productos, lead, categoria);
    assert.match(texto, /Ya le mostraste la tarjeta/);
    assert.doesNotMatch(texto, /Llama AHORA a mostrar_tarjeta_categoria/);
  });

  test('con pidioProductoPuntual=true, se salta el gate y muestra los productos como antes', () => {
    const productos = [producto({ id: 10, nombre: 'Licuadora', categoria: 'Electrodomesticos' })];
    const lead = { categoriaInteres: 'Electrodomesticos', contexto: {} };
    const texto = seccionProductos(productos, lead, null, 'BOB', null, false, true);
    assert.match(texto, /Licuadora/);
    assert.match(texto, /mostrar_productos/);
  });
});

describe('extraerFiltros', () => {
  test('detecta la categoria real del catalogo a partir del texto del cliente', () => {
    const productos = [producto({ categoria: 'Calzado' })];
    const cambios = extraerFiltros('Busco algo de calzado por favor', productos);
    assert.equal(cambios.categoriaInteres, 'Calzado');
  });

  test('no inventa una categoria si el texto no menciona ninguna real', () => {
    const productos = [producto({ categoria: 'Calzado' })];
    const cambios = extraerFiltros('Hola, buenas tardes', productos);
    assert.equal(cambios.categoriaInteres, undefined);
  });

  test('detecta la talla de forma deterministica (bug real: la IA a veces no llama actualizar_datos_lead)', () => {
    const productos = [
      producto({
        categoria: 'Casacas',
        variantes: [
          { activa: true, atributos: { Talla: 'S', Color: 'Negro' } },
          { activa: true, atributos: { Talla: 'M', Color: 'Negro' } },
          { activa: true, atributos: { Talla: 'L', Color: 'Negro' } },
          { activa: true, atributos: { Talla: 'XL', Color: 'Negro' } },
        ],
      }),
    ];
    const cambios = extraerFiltros('Busco casacas de hombre en talla L y XL', productos);
    assert.equal(cambios.talla, 'L, XL');
  });

  test('no confunde conectores de 1 letra ("y", "a") con una talla, aunque el catalogo tenga tallas cortas', () => {
    const productos = [
      producto({
        categoria: 'Casacas',
        variantes: [{ activa: true, atributos: { Talla: 'S', Color: 'Negro' } }],
      }),
    ];
    const cambios = extraerFiltros('Voy a ver que tienen', productos);
    assert.equal(cambios.talla, undefined);
  });
});

describe('resolverSeleccionMenu', () => {
  test('resuelve un numero suelto contra el menu que ofrecio el agente', () => {
    const ultimoMensaje = '1. Electrodomesticos\n2. Accesorios\n3. Calzado';
    assert.equal(resolverSeleccionMenu('2', ultimoMensaje), 'Accesorios');
  });

  test('devuelve null si el texto no es un numero suelto', () => {
    assert.equal(resolverSeleccionMenu('quiero el segundo', 'algo'), null);
  });
});

describe('fichaProducto - la tarjeta del cliente no debe saturarlo de datos internos', () => {
  const productoConVariantes = producto({
    id: 1,
    nombre: 'Bomber ligera',
    categoria: 'Casacas',
    precio: 280,
    atributos: { Marca: 'Nomada', Genero: 'Hombre', Estilo: 'Urbano', Ocasion: 'Noche, Diario', Temporada: 'Verano', Material: 'Nylon' },
    variantes: [
      { activa: true, atributos: { Talla: 'S', Color: 'Negro' }, stock: 3 },
      { activa: true, atributos: { Talla: 'S', Color: 'Gris' }, stock: 2 },
      { activa: true, atributos: { Talla: 'L', Color: 'Negro' }, stock: 4 },
      { activa: true, atributos: { Talla: 'L', Color: 'Azul' }, stock: 1 },
      { activa: true, atributos: { Talla: 'XL', Color: 'Negro' }, stock: 5 },
    ],
  });

  test('no muestra categoria/genero/estilo/ocasion/temporada (ruido interno, no le sirve al cliente)', () => {
    const ficha = fichaProducto(productoConVariantes, {});
    assert.doesNotMatch(ficha, /Categoria/);
    assert.doesNotMatch(ficha, /Genero/);
    assert.doesNotMatch(ficha, /Estilo/);
    assert.doesNotMatch(ficha, /Ocasion/);
    assert.doesNotMatch(ficha, /Temporada/);
  });

  test('si muestra Marca y Material (datos utiles para decidir la compra)', () => {
    const ficha = fichaProducto(productoConVariantes, {});
    assert.match(ficha, /Marca.*Nomada/);
    assert.match(ficha, /Material.*Nylon/);
  });

  test('agrupa las variantes por talla (una linea por talla, colores juntos) en vez de una linea por cada combinacion', () => {
    const ficha = fichaProducto(productoConVariantes, {});
    assert.match(ficha, /Talla S: Negro, Gris/);
    assert.match(ficha, /Talla L: Negro, Azul/);
    assert.match(ficha, /Talla XL: Negro/);
    // 3 lineas de talla (S, L, XL), no 5 lineas de combinacion individual
    const lineasTalla = (ficha.match(/· Talla /g) || []).length;
    assert.equal(lineasTalla, 3);
  });

  // El dueño reporto que un producto con 6 variantes se veia con una sola
  // linea porque la ficha se recortaba a lo que el cliente habia pedido. Ahora
  // se muestra TODO el abanico y aparte se le dice si lo suyo esta o no.
  test('la ficha muestra TODAS las tallas con stock, no solo la pedida', () => {
    const ficha = fichaProducto(productoConVariantes, { talla: 'L' });
    assert.match(ficha, /Talla L: Negro, Azul/);
    assert.match(ficha, /Talla S/, 'el cliente tiene que ver el abanico real');
    assert.match(ficha, /Talla XL/);
  });

  test('y le dice explicitamente si lo que pidio esta disponible', () => {
    const ficha = fichaProducto(productoConVariantes, { talla: 'L' });
    assert.ok(ficha.includes('Lo que buscabas* (talla L): disponible'), ficha);
  });

  test('si lo que pidio NO tiene stock, se lo dice y le muestra lo que si hay', () => {
    const ficha = fichaProducto(productoConVariantes, { talla: 'XXL' });
    assert.ok(ficha.includes('Lo que buscabas* (talla XXL): sin stock'), ficha);
    assert.match(ficha, /Talla S/);
  });
});

describe('construirSystem - "que vendes" no debe listar 1 sola categoria como menu', () => {
  const empresa = { nombre: 'Tienda Demo', marca: 'Tienda Demo' };

  test('con 1 sola categoria, NO arma una lista numerada de un solo item ni pregunta "cual te interesa"', () => {
    const productos = [producto({ id: 1, categoria: 'Ropa' })];
    const system = construirSystem(empresa, productos, {}, {}, false, false, 'Raul');
    assert.doesNotMatch(system, /1\. Ropa/, 'no debe numerar la unica categoria como si fuera un menu');
    assert.match(system, /UN SOLO rubro/i, 'debe reconocer explicitamente que es un solo rubro');
  });

  test('con 2+ categorias, delega la lista en la herramienta (no la arma de memoria)', () => {
    const productos = [
      producto({ id: 1, categoria: 'Ropa' }),
      producto({ id: 2, categoria: 'Calzado' }),
    ];
    const system = construirSystem(empresa, productos, {}, {}, false, false, 'Raul');
    assert.match(system, /llama a \*\*mostrar_categorias\*\*/);
    assert.match(system, /NUNCA armes vos la lista de memoria/);
  });

  test('ya no le ofrece mandar un link a una pagina: el cliente compra dentro de WhatsApp', () => {
    const productos = [producto({ id: 1, categoria: 'Ropa' }), producto({ id: 2, categoria: 'Calzado' })];
    const system = construirSystem(empresa, productos, {}, {}, false, false, 'Raul');
    assert.doesNotMatch(system, /mostrar_catalogo/);
    assert.match(system, /PROHIBIDO mandarle un link/);
  });
});

describe('construirSystem - primer mensaje: menos vueltas si ya se detecto interes', () => {
  const empresa = { nombre: 'Tienda Demo', marca: 'Tienda Demo' };
  const productos = [producto({ id: 1, categoria: 'Zapatillas' })];

  test('primer mensaje SIN interes detectado: fuerza la bienvenida generica', () => {
    const system = construirSystem(empresa, productos, {}, {}, false, true, 'Raul');
    assert.match(system, /TOMA LA INICIATIVA/);
    assert.doesNotMatch(system, /YA DIJO QUE ANDA BUSCANDO/);
  });

  test('primer mensaje CON categoria ya detectada en ese mismo mensaje: se salta la bienvenida generica', () => {
    const lead = { categoriaInteres: 'Zapatillas' };
    const system = construirSystem(empresa, productos, {}, lead, false, true, 'Raul');
    assert.match(system, /YA DIJO QUE ANDA BUSCANDO/);
    assert.doesNotMatch(system, /TOMA LA INICIATIVA/);
  });

  test('primer mensaje CON producto favorito ya detectado: tambien se salta la bienvenida generica', () => {
    const lead = { productoFavoritoId: 1 };
    const system = construirSystem(empresa, productos, {}, lead, false, true, 'Raul');
    assert.match(system, /YA DIJO QUE ANDA BUSCANDO/);
  });

  test('si NO es el primer mensaje, el interes detectado no cambia nada (esa rama ni se evalua)', () => {
    const lead = { categoriaInteres: 'Zapatillas' };
    const system = construirSystem(empresa, productos, {}, lead, false, false, 'Raul');
    assert.match(system, /COMO ARRANCA LA CONVERSACION/);
    assert.doesNotMatch(system, /YA DIJO QUE ANDA BUSCANDO/);
  });
});

describe('resumenPedidosPrevios - memoria de compras reales (nunca inventa)', () => {
  test('sin pedidos previos, devuelve vacio', () => {
    assert.equal(resumenPedidosPrevios([]), '');
    assert.equal(resumenPedidosPrevios(), '');
  });

  test('arma un resumen corto con fecha, cantidad, nombre, talla y categoria reales', () => {
    const pedidos = [
      {
        createdAt: new Date('2026-08-15T10:00:00Z'),
        items: [
          { cantidad: 1, nombre: 'Zapatillas Park St 2.0', variante: { atributos: { Talla: '42' } }, producto: { categoria: { nombre: 'Zapatillas' } } },
        ],
      },
    ];
    const r = resumenPedidosPrevios(pedidos);
    assert.match(r, /2026-08-15/);
    assert.match(r, /1x Zapatillas Park St 2\.0/);
    assert.match(r, /talla 42/);
    assert.match(r, /categoria: Zapatillas/);
  });

  test('sin variante ni producto (dato viejo o borrado), no inventa talla ni categoria', () => {
    const pedidos = [{ createdAt: new Date('2026-08-15T10:00:00Z'), items: [{ cantidad: 2, nombre: 'Producto sin variante', variante: null, producto: null }] }];
    const r = resumenPedidosPrevios(pedidos);
    assert.match(r, /2x Producto sin variante/);
    assert.doesNotMatch(r, /talla/);
    assert.doesNotMatch(r, /categoria/);
  });

  test('construirSystem inyecta el resumen solo si hay pedidos previos, y nunca inventa si no hay', () => {
    const empresa = { nombre: 'Tienda Demo', marca: 'Tienda Demo' };
    const productos = [producto({ id: 1, categoria: 'Zapatillas' })];
    const pedidos = [{ createdAt: new Date('2026-08-15T10:00:00Z'), items: [{ cantidad: 1, nombre: 'Jean Slim Azul Indigo', variante: null, producto: null }] }];

    const conHistorial = partesDelSystem(empresa, productos, {}, {}, false, false, 'Raul', false, pedidos);
    assert.match(conHistorial.variable, /Compras reales anteriores/);
    assert.match(conHistorial.variable, /Jean Slim Azul Indigo/);

    const sinHistorial = partesDelSystem(empresa, productos, {}, {}, false, false, 'Raul', false, []);
    assert.doesNotMatch(sinHistorial.variable, /Compras reales anteriores/);
  });
});

describe('partesDelSystem - el bloque fijo es cacheable de verdad (prompt caching)', () => {
  // Este test protege la optimizacion de costo: si alguien mete sin querer
  // algo que cambia por turno (memoria del lead, resultados del catalogo)
  // dentro de "fijo", el prompt caching de OpenAI/Anthropic deja de servir
  // para ese contenido y el ahorro desaparece en silencio.
  const empresa = { nombre: 'Tienda Demo', marca: 'Tienda Demo', moneda: 'BOB' };
  const productos = [
    producto({ id: 1, categoria: 'Zapatillas', nombre: 'Runner' }),
    producto({ id: 2, categoria: 'Zapatillas', nombre: 'Trail' }),
  ];

  test('mismo turno1/config, leads y catalogo distintos -> "fijo" es byte a byte identico', () => {
    const a = partesDelSystem(empresa, productos, {}, { categoriaInteres: 'Zapatillas', talla: '40' }, false, false, 'Raul');
    const b = partesDelSystem(empresa, productos, {}, { categoriaInteres: 'Zapatillas', color: 'negro', productoFavoritoId: 1 }, false, false, 'Raul');
    assert.equal(a.fijo, b.fijo);
  });

  test('"fijo" nunca incluye datos del lead ni resultados del catalogo (esos van en "variable")', () => {
    const { fijo, variable } = partesDelSystem(empresa, productos, {}, { talla: '42', color: 'rojo furioso' }, false, false, 'Raul');
    assert.doesNotMatch(fijo, /rojo furioso/);
    assert.match(variable, /rojo furioso|42/);
  });

  test('construirSystem (wrapper) sigue devolviendo el mismo contenido que fijo + variable concatenados', () => {
    const partes = partesDelSystem(empresa, productos, {}, { talla: '40' }, false, false, 'Raul');
    const completo = construirSystem(empresa, productos, {}, { talla: '40' }, false, false, 'Raul');
    assert.equal(completo, `${partes.fijo}\n\n${partes.variable}`);
  });

  test('distintas empresas nunca comparten el bloque fijo (cada una tiene su marca en el texto)', () => {
    const a = partesDelSystem({ nombre: 'Tienda A', marca: 'Tienda A' }, productos, {}, {}, false, false, '');
    const b = partesDelSystem({ nombre: 'Tienda B', marca: 'Tienda B' }, productos, {}, {}, false, false, '');
    assert.notEqual(a.fijo, b.fijo);
  });
});

describe('faltantes de categoria dejan de pedirse una vez que el cliente ya eligio/esta cerrando', () => {
  // Bug real con capturas: el bot le pregunto "genero" a mitad del cierre
  // (ya habia dado nombre, ubicacion y forma de pago QR) porque faltantes se
  // recalculaba SIEMPRE por categoria, sin mirar que el cliente ya tenia un
  // producto favorito y estaba en INTENCION_DE_COMPRA.
  const empresa = { nombre: 'Tienda Demo', marca: 'Tienda Demo' };
  const jeans = { id: 1, nombre: 'Jeans', atributos: [{ nombre: 'Genero', nivel: 'OBLIGATORIO' }] };
  const productos = [{ id: 10, nombre: 'Jean Slim', categoria: jeans, variantes: [] }];

  test('sin favorito ni cierre: SI pide el atributo obligatorio (comportamiento normal)', () => {
    const system = construirSystem(empresa, productos, {}, { categoriaInteres: 'Jeans', categoriaId: 1 }, false, false, '');
    assert.match(system, /LO UNICO QUE TE FALTA.*Genero/s);
  });

  test('con productoFavoritoId ya seteado: NUNCA vuelve a pedir el atributo', () => {
    const system = construirSystem(empresa, productos, {}, { categoriaInteres: 'Jeans', categoriaId: 1, productoFavoritoId: 10 }, false, false, '');
    assert.doesNotMatch(system, /LO UNICO QUE TE FALTA/);
  });

  test('con estadoConversacion en cualquier etapa de cierre: NUNCA vuelve a pedir el atributo', () => {
    for (const estado of ['INTENCION_DE_COMPRA', 'LISTO_PARA_COMPRAR', 'DATOS_DE_PEDIDO', 'ENTREGA', 'PEDIDO_COMPLETADO']) {
      const system = construirSystem(empresa, productos, {}, { categoriaInteres: 'Jeans', categoriaId: 1, estadoConversacion: estado }, false, false, '');
      assert.doesNotMatch(system, /LO UNICO QUE TE FALTA/, `no deberia pedirlo en estado ${estado}`);
    }
  });

  // Bug real de la transcripcion: el cliente cambio de categoria a mitad
  // del cierre (nombro un color de una prenda nueva), eso limpia
  // productoFavoritoId (ver limpiezaPorCambioDeCategoria) - pero
  // estadoConversacion sigue en cierre. seccionProductos tiene sus PROPIOS
  // gates (independientes de "LO UNICO QUE TE FALTA" de arriba) que antes
  // no miraban esto y volvian a pedir el atributo obligatorio con el
  // carrito lleno.
  test('sin favorito (se limpio) pero con estadoConversacion en cierre: seccionProductos tampoco vuelve a pedir el atributo', () => {
    for (const estado of ['INTENCION_DE_COMPRA', 'LISTO_PARA_COMPRAR', 'DATOS_DE_PEDIDO', 'ENTREGA', 'PEDIDO_COMPLETADO']) {
      const system = construirSystem(empresa, productos, {}, { categoriaInteres: 'Jeans', categoriaId: 1, estadoConversacion: estado }, false, false, '');
      assert.doesNotMatch(system, /TODAVIA NO PODES MOSTRAR PRODUCTOS/, `seccionProductos no deberia bloquear en estado ${estado}`);
      assert.match(system, /NO le muestres productos nuevos ni le preguntes atributos/, `deberia usar el texto de cierre en estado ${estado}`);
    }
  });

  test('sin favorito y SIN estar en cierre: seccionProductos sigue pidiendo el atributo normalmente', () => {
    const system = construirSystem(empresa, productos, {}, { categoriaInteres: 'Jeans', categoriaId: 1 }, false, false, '');
    assert.match(system, /TODAVIA NO PODES MOSTRAR PRODUCTOS.*falta saber Genero/s);
  });
});

describe('primeraPreguntaDeCierre - la unica cosa que falta para cerrar, nunca inventada', () => {
  test('sin nombre: pide el nombre', () => {
    assert.match(primeraPreguntaDeCierre({}, {}), /nombre/i);
  });

  test('con nombre pero sin tipoEntrega: pregunta como quiere recibirlo', () => {
    const r = primeraPreguntaDeCierre({ nombre: 'Ron Valdez' }, {});
    assert.match(r, /domicilio/i);
  });

  test('domicilio sin ubicacion real (sin ubicacionLat): pide la ubicacion, no "la direccion"', () => {
    const r = primeraPreguntaDeCierre({ nombre: 'Ron Valdez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av Ballivian 123' }, {});
    assert.match(r, /ubicaci[oó]n/i);
    assert.doesNotMatch(r, /direcci[oó]n/i);
  });

  test('domicilio con ubicacionLat real: no pide ubicacion, pasa a forma de pago', () => {
    const r = primeraPreguntaDeCierre({ nombre: 'Ron Valdez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'x', ubicacionLat: -17.7 }, {});
    assert.match(r, /pagar/i);
  });

  test('con todo salvo forma de pago: pregunta como quiere pagar', () => {
    const r = primeraPreguntaDeCierre({ nombre: 'Ron Valdez', tipoEntrega: 'RECOJO' }, { direccionTienda: 'Av Principal 1' });
    assert.match(r, /pagar/i);
  });

  test('con todos los datos completos: devuelve null (no falta nada, hay que confirmar el resumen)', () => {
    const r = primeraPreguntaDeCierre({
      nombre: 'Ron Valdez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'x', ubicacionLat: -17.7, formaPago: 'QR',
    }, {});
    assert.equal(r, null);
  });
});

describe('coloresConFotoDeVariantes - "tambien disponible en" del catalogo web', () => {
  test('un color con foto en alguna variante trae esa foto', () => {
    const p = {
      variantes: [
        { activa: true, atributos: { Color: 'Negro', Talla: '40' }, fotos: ['negro.jpg'] },
        { activa: true, atributos: { Color: 'Negro', Talla: '41' }, fotos: [] },
      ],
    };
    assert.deepEqual(coloresConFotoDeVariantes(p), [{ color: 'Negro', foto: 'negro.jpg' }]);
  });

  test('un color sin ninguna foto en ninguna variante trae foto: null', () => {
    const p = { variantes: [{ activa: true, atributos: { Color: 'Rojo' }, fotos: [] }] };
    assert.deepEqual(coloresConFotoDeVariantes(p), [{ color: 'Rojo', foto: null }]);
  });

  test('variantes inactivas o sin color no cuentan', () => {
    const p = {
      variantes: [
        { activa: false, atributos: { Color: 'Azul' }, fotos: ['azul.jpg'] },
        { activa: true, atributos: {}, fotos: ['x.jpg'] },
      ],
    };
    assert.deepEqual(coloresConFotoDeVariantes(p), []);
  });

  test('sin variantes, devuelve vacio (no revienta)', () => {
    assert.deepEqual(coloresConFotoDeVariantes({}), []);
  });
});

describe('mensajeWhatsappProducto - mensaje prellenado del boton "volver a WhatsApp"', () => {
  const producto = { nombre: 'Zapatillas Park St 2.0' };

  test('sin variante ni cantidad: solo el nombre, con la accion por defecto', () => {
    assert.equal(mensajeWhatsappProducto(producto), 'Estoy viendo *Zapatillas Park St 2.0*');
  });

  test('con variante: agrega el detalle real entre parentesis', () => {
    const variante = { atributos: { Talla: '42', Color: 'Negro' } };
    const r = mensajeWhatsappProducto(producto, { variante, accion: 'Quiero' });
    assert.equal(r, 'Quiero *Zapatillas Park St 2.0* (Talla: 42, Color: Negro)');
  });

  test('con cantidad mayor a 1: antepone "Nx" al nombre', () => {
    const r = mensajeWhatsappProducto(producto, { cantidad: 3, accion: 'Quiero' });
    assert.equal(r, 'Quiero *3x Zapatillas Park St 2.0*');
  });

  test('cantidad 1 no antepone nada (no es distinto de no mandar cantidad)', () => {
    assert.equal(mensajeWhatsappProducto(producto, { cantidad: 1 }), mensajeWhatsappProducto(producto));
  });

  test('variante sin atributos no rompe ni agrega parentesis vacios', () => {
    const r = mensajeWhatsappProducto(producto, { variante: { atributos: {} } });
    assert.equal(r, 'Estoy viendo *Zapatillas Park St 2.0*');
  });
});

describe('el cliente cambia de opinion de categoria (punto 46 del documento)', () => {
  const zapatillas = { id: 1, nombre: 'Zapatillas', atributos: [{ nombre: 'Genero', nivel: 'OBLIGATORIO' }] };
  const camisas = { id: 2, nombre: 'Camisas', atributos: [{ nombre: 'Genero', nivel: 'OBLIGATORIO' }, { nombre: 'Cuello', nivel: 'RECOMENDADO' }] };
  const productos = [
    { id: 10, nombre: 'Runner', categoria: zapatillas, variantes: [] },
    { id: 20, nombre: 'Camisa lisa', categoria: camisas, variantes: [] },
  ];

  test('suelta el producto favorito de la categoria vieja (no sigue empujando esa venta)', () => {
    const cliente = { productoFavoritoId: 10, varianteFavoritaId: 99, productosDescartados: [11], atributosLead: { Genero: 'Hombre' }, contexto: {} };
    const limpieza = limpiezaPorCambioDeCategoria(cliente, productos, camisas.id);
    assert.equal(limpieza.productoFavoritoId, null);
    assert.equal(limpieza.varianteFavoritaId, null);
    assert.deepEqual(limpieza.productosDescartados, [], 'lo descartado era de la otra categoria');
  });

  test('CONSERVA lo que sigue siendo valido (el genero existe tambien en la categoria nueva)', () => {
    const cliente = { atributosLead: { Genero: 'Hombre' }, contexto: {} };
    const limpieza = limpiezaPorCambioDeCategoria(cliente, productos, camisas.id);
    assert.deepEqual(limpieza.atributosLead, { Genero: 'Hombre' });
  });

  test('descarta los atributos que solo tenian sentido en la categoria vieja', () => {
    const cliente = { atributosLead: { Genero: 'Hombre', Pisada: 'Neutra' }, contexto: {} };
    const limpieza = limpiezaPorCambioDeCategoria(cliente, productos, camisas.id);
    assert.deepEqual(limpieza.atributosLead, { Genero: 'Hombre' }, 'Pisada no existe en Camisas');
  });

  test('resetea la confirmacion de pedido pendiente (era de otro producto)', () => {
    const cliente = { atributosLead: {}, contexto: { resumenConfirmado: '10:0:1', fotosEnviadas: [10] } };
    const limpieza = limpiezaPorCambioDeCategoria(cliente, productos, camisas.id);
    assert.equal(limpieza.contexto.resumenConfirmado, null);
    assert.deepEqual(limpieza.contexto.fotosEnviadas, [10], 'lo que ya vio sigue siendo cierto, no se borra');
  });
});

describe('datosDeActualizacionDeLead - la memoria del cliente', () => {
  const zapatillas = { id: 1, nombre: 'Zapatillas', atributos: [{ nombre: 'Genero', nivel: 'OBLIGATORIO' }, { nombre: 'Pisada', nivel: 'OPCIONAL' }] };
  const camisas = { id: 2, nombre: 'Camisas', atributos: [{ nombre: 'Genero', nivel: 'OBLIGATORIO' }, { nombre: 'Cuello', nivel: 'RECOMENDADO' }] };
  const productos = [
    { id: 10, nombre: 'Runner', categoria: zapatillas, variantes: [] },
    { id: 20, nombre: 'Camisa lisa', categoria: camisas, variantes: [] },
  ];

  test('el presupuesto en texto se guarda TAMBIEN como rango numerico', () => {
    const datos = datosDeActualizacionDeLead({ presupuesto: 'hasta Bs 500' }, {}, productos);
    assert.equal(datos.presupuesto, 'hasta Bs 500');
    assert.equal(datos.presupuestoMax, 500);
  });

  test('entiende un rango ("entre 300 y 500")', () => {
    const datos = datosDeActualizacionDeLead({ presupuesto: 'entre 300 y 500' }, {}, productos);
    assert.equal(datos.presupuestoMin, 300);
    assert.equal(datos.presupuestoMax, 500);
  });

  test('cambiar de categoria Y dar un atributo nuevo en el MISMO mensaje no resucita los atributos viejos', () => {
    // Bug real: el bloque de atributosCategoria acumulaba sobre el valor viejo
    // del cliente y deshacia la limpieza por cambio de categoria.
    const cliente = { categoriaId: zapatillas.id, atributosLead: { Genero: 'Hombre', Pisada: 'Neutra' }, contexto: {} };
    const datos = datosDeActualizacionDeLead(
      { categoriaInteres: 'Camisas', atributosCategoria: { Cuello: 'Mao' } },
      cliente, productos,
    );
    assert.deepEqual(datos.atributosLead, { Genero: 'Hombre', Cuello: 'Mao' });
    assert.ok(!('Pisada' in datos.atributosLead), 'Pisada no existe en Camisas: no puede sobrevivir al cambio');
  });

  test('lo mismo con los descartados: cambiar de categoria los limpia aunque vengan nuevos', () => {
    const cliente = { categoriaId: zapatillas.id, productosDescartados: [10, 11], atributosLead: {}, contexto: {} };
    const datos = datosDeActualizacionDeLead(
      { categoriaInteres: 'Camisas', productosDescartadosIds: [20] },
      cliente, productos,
    );
    assert.deepEqual(datos.productosDescartados, [20], 'los descartados de zapatillas no aplican a camisas');
  });

  test('sin cambio de categoria, los descartados SI se acumulan como siempre', () => {
    const cliente = { categoriaId: zapatillas.id, productosDescartados: [10], atributosLead: {}, contexto: {} };
    const datos = datosDeActualizacionDeLead({ productosDescartadosIds: [11] }, cliente, productos);
    assert.deepEqual(datos.productosDescartados, [10, 11]);
  });

  test('sin cambio de categoria, los atributos SI se acumulan como siempre', () => {
    const cliente = { categoriaId: zapatillas.id, atributosLead: { Genero: 'Hombre' }, contexto: {} };
    const datos = datosDeActualizacionDeLead({ atributosCategoria: { Pisada: 'Neutra' } }, cliente, productos);
    assert.deepEqual(datos.atributosLead, { Genero: 'Hombre', Pisada: 'Neutra' });
  });

  test('el tipo de entrega se normaliza al enum de la base', () => {
    assert.equal(datosDeActualizacionDeLead({ tipoEntrega: 'recojo' }, {}, productos).tipoEntrega, 'RECOJO');
    assert.equal(datosDeActualizacionDeLead({ tipoEntrega: 'domicilio' }, {}, productos).tipoEntrega, 'DOMICILIO');
  });
});

// Bug real de produccion: el panel mostraba "ZAPATILLAS TEKKIRA CUP, stock 10,
// lo ofrece" y el bot le juraba al cliente que no la tenian. Estaba cargada
// como "Genero: Unisex" y el cliente habia dicho "hombre": el filtro la
// descartaba porque unisex != hombre. Un producto unisex es justamente el que
// le sirve a todos.
describe('un producto Unisex tiene que verlo cualquiera', () => {
  const zapatilla = (genero) => ({
    id: 1, nombre: 'ZAPATILLAS TEKKIRA CUP', precio: 350,
    atributos: genero ? { Genero: genero } : {},
    variantes: [{ id: 10, activa: true, stock: 10, atributos: { Talla: '40' } }],
  });

  for (const pidio of ['Hombre', 'Mujer']) {
    test(`el cliente que pidio "${pidio}" ve la unisex`, () => {
      assert.equal(coincideAtributosLead(zapatilla('Unisex'), { atributosLead: { Genero: pidio } }), true);
    });
  }

  test('"ambos" y "todos" valen igual que unisex', () => {
    for (const valor of ['ambos', 'Todos', 'UNISEX']) {
      assert.equal(coincideAtributosLead(zapatilla(valor), { atributosLead: { Genero: 'Hombre' } }), true, valor);
    }
  });

  test('pero hombre y mujer siguen sin mezclarse', () => {
    assert.equal(coincideAtributosLead(zapatilla('Mujer'), { atributosLead: { Genero: 'Hombre' } }), false);
    assert.equal(coincideAtributosLead(zapatilla('Masculino'), { atributosLead: { Genero: 'Mujer' } }), false);
  });

  test('la unisex aparece en la busqueda real, no solo en el filtro', () => {
    const { resultados } = buscarConFallback([zapatilla('Unisex')], { atributosLead: { Genero: 'Hombre' } });
    assert.equal(resultados.length, 1);
    assert.equal(resultados[0].nombre, 'ZAPATILLAS TEKKIRA CUP');
  });
});

// El cliente nombra un producto puntual ("¿no tenes de casualidad las Tekkira
// Cup?"). Antes el bot solo veia el bloque de resultados ya filtrado por lo
// que venia pidiendo, asi que respondia "no lo tenemos" sobre cosas que si
// estaban cargadas. buscar_producto mira TODO el catalogo.
describe('buscarPorNombre - antes de decir "no lo tenemos"', () => {
  const productos = [
    { id: 1, nombre: 'ZAPATILLAS TEKKIRA CUP', variantes: [{ id: 1, activa: true, stock: 10 }] },
    { id: 2, nombre: 'ZAPATILLAS GINGER TAV', variantes: [{ id: 2, activa: true, stock: 0 }] },
    { id: 3, nombre: 'POLERA BASICA', variantes: [{ id: 3, activa: true, stock: 5 }] },
  ];
  const nombres = (lista) => lista.map((p) => p.nombre);

  test('lo encuentra por una parte del nombre', () => {
    assert.deepEqual(nombres(buscarPorNombre(productos, 'tekkira').conStock), ['ZAPATILLAS TEKKIRA CUP']);
  });

  test('gana la coincidencia mas especifica, no la palabra generica compartida', () => {
    // "ZAPATILLAS" lo comparten dos productos: no debe colar el que no pidio.
    const r = buscarPorNombre(productos, 'ZAPATILLAS TEKKIRA CUP');
    assert.deepEqual(nombres(r.conStock), ['ZAPATILLAS TEKKIRA CUP']);
    assert.deepEqual(nombres(r.agotados), []);
  });

  test('distingue "existe pero sin stock" de "no existe"', () => {
    const agotado = buscarPorNombre(productos, 'ginger tav');
    assert.deepEqual(nombres(agotado.agotados), ['ZAPATILLAS GINGER TAV']);
    assert.deepEqual(agotado.conStock, []);

    const inexistente = buscarPorNombre(productos, 'nike air max');
    assert.deepEqual(inexistente.conStock, []);
    assert.deepEqual(inexistente.agotados, []);
  });

  test('no explota con nombre vacio', () => {
    assert.deepEqual(buscarPorNombre(productos, '').conStock, []);
    assert.deepEqual(buscarPorNombre(null, 'algo').conStock, []);
  });
});
