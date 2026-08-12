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
} = require('../lib/services/agente');

function producto(overrides) {
  return {
    id: 1,
    nombre: 'Producto generico',
    categoria: 'Calzado',
    descripcion: '',
    precio: 100,
    stock: 5,
    caracteristicas: [],
    variantes: [],
    ...overrides,
  };
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
