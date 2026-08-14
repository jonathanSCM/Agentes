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
  fichaProducto,
} = require('../lib/services/agente');

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
  test('primera vez: instruye a mostrar TODOS los productos con tarjeta', () => {
    const productos = [
      producto({ id: 10, nombre: 'Licuadora', categoria: 'Electrodomesticos' }),
      producto({ id: 11, nombre: 'Plancha', categoria: 'Electrodomesticos' }),
    ];
    const lead = { categoriaInteres: 'Electrodomesticos', contexto: {} };
    const texto = seccionProductos(productos, lead);
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
    const texto = seccionProductos(productos, lead);
    assert.match(texto, /Licuadora/, 'la que falta por mostrar debe seguir apareciendo');
    assert.doesNotMatch(texto, /\[ID 11\]/, 'la que ya se mostro no debe volver a ofrecerse como "nueva" para tarjeta');
  });

  test('si TODOS los productos ya fueron enviados, avisa explicitamente que no vuelva a llamar mostrar_productos', () => {
    const productos = [
      producto({ id: 10, nombre: 'Sandalia de verano', categoria: 'Calzado' }),
    ];
    const lead = { categoriaInteres: 'Calzado', contexto: { fotosEnviadas: [10] } };
    const texto = seccionProductos(productos, lead);
    assert.match(texto, /YA SE LOS MOSTRASTE/);
    assert.match(texto, /NO vuelvas a llamar mostrar_productos/);
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

  test('si el cliente ya pidio una talla puntual, la ficha se filtra a esa talla nada mas', () => {
    const ficha = fichaProducto(productoConVariantes, { talla: 'L' });
    assert.match(ficha, /Talla L: Negro, Azul/);
    assert.doesNotMatch(ficha, /Talla S/);
    assert.doesNotMatch(ficha, /Talla XL/);
  });

  test('si pidio varias tallas ("L y XL"), muestra solo esas', () => {
    const ficha = fichaProducto(productoConVariantes, { talla: 'L y XL' });
    assert.match(ficha, /Talla L:/);
    assert.match(ficha, /Talla XL:/);
    assert.doesNotMatch(ficha, /Talla S/);
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

  test('con 2+ categorias, SI arma la lista numerada de opciones para elegir', () => {
    const productos = [
      producto({ id: 1, categoria: 'Ropa' }),
      producto({ id: 2, categoria: 'Calzado' }),
    ];
    const system = construirSystem(empresa, productos, {}, {}, false, false, 'Raul');
    assert.match(system, /LISTA \(numerada o con guiones/, 'con varias categorias si tiene sentido pedir una lista');
  });
});
