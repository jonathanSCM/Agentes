// Los 12 casos de regresion que pide el punto 47 del documento
// "Instrucciones definitivas para el desarrollo del Agente de Ventas",
// uno por uno y en el mismo orden que el documento, para poder ir al caso
// exacto cuando alguien pregunte "¿el TEST 5 pasa?".
//
// Todos deterministas: sin base de datos, sin WhatsApp y sin proveedor de IA.
// Prueban el COMPORTAMIENTO DEL BACKEND (que es quien decide), no que el
// modelo "se acuerde" de las reglas.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  seccionProductos,
  fichaProducto,
  avisosDeFoto,
  resultadoDeEnvio,
  atributosFaltantes,
  filtrosCompletos,
} = require('../lib/services/agente');
const {
  buscarProductosFiltrados,
  buscarConFallback,
  paginar,
  fotoParaMostrar,
  RESULTADOS_POR_PAGINA,
} = require('../lib/services/catalogo');

function idDeCategoria(nombre) {
  let h = 0;
  for (const c of String(nombre)) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return h;
}

// Categoria con atributos configurados (nivel OBLIGATORIO/RECOMENDADO/OPCIONAL).
function categoria(nombre, atributos = []) {
  return {
    id: idDeCategoria(nombre),
    nombre,
    atributos: atributos.map((a, i) => ({
      nombre: a.nombre, nivel: a.nivel || 'OPCIONAL', esDeVariante: Boolean(a.esDeVariante), orden: i,
    })),
  };
}

function producto(overrides) {
  const base = {
    id: 1,
    nombre: 'Producto generico',
    categoria: 'Calzado',
    descripcion: '',
    precio: 100,
    stock: 5,
    fotos: [],
    caracteristicas: [],
    atributos: {},
    variantes: [],
    ...overrides,
  };
  if (typeof base.categoria === 'string') base.categoria = categoria(base.categoria);
  return base;
}

// ---------------------------------------------------------------------------

describe('TEST 1 - No mostrar antes de preguntar genero/talla', () => {
  const zapatillas = categoria('Zapatillas deportivas', [
    { nombre: 'Genero', nivel: 'OBLIGATORIO' },
    { nombre: 'Talla', nivel: 'OBLIGATORIO', esDeVariante: true },
  ]);
  const productos = [
    producto({ id: 1, nombre: 'Runner Pro', categoria: 'Zapatillas deportivas', variantes: [{ activa: true, atributos: { Talla: '42', Color: 'Negro' }, stock: 3 }] }),
    producto({ id: 2, nombre: 'Urban Flex', categoria: 'Zapatillas deportivas', variantes: [{ activa: true, atributos: { Talla: '41', Color: 'Blanco' }, stock: 2 }] }),
  ];

  test('el cliente dijo la categoria pero no genero ni talla: NO se le pasa ningun producto al modelo', () => {
    const lead = { categoriaInteres: 'Zapatillas deportivas', categoriaId: zapatillas.id, atributosLead: {} };
    const texto = seccionProductos(productos, lead, zapatillas);
    assert.match(texto, /TODAVIA NO PODES MOSTRAR PRODUCTOS/);
    assert.doesNotMatch(texto, /Runner Pro/, 'no puede filtrarse ni el nombre de un producto');
    assert.doesNotMatch(texto, /Urban Flex/);
  });

  test('dice exactamente que falta preguntar', () => {
    const lead = { categoriaInteres: 'Zapatillas deportivas', categoriaId: zapatillas.id, atributosLead: {} };
    const texto = seccionProductos(productos, lead, zapatillas);
    assert.match(texto, /Genero/);
    assert.match(texto, /Talla/);
  });

  test('con genero y talla ya sabidos, RECIEN AHI aparecen los productos', () => {
    const lead = { categoriaInteres: 'Zapatillas deportivas', categoriaId: zapatillas.id, talla: '42', atributosLead: { Genero: 'Hombre' }, contexto: {} };
    assert.equal(filtrosCompletos(lead, zapatillas), true);
    const texto = seccionProductos(productos, lead, zapatillas);
    assert.match(texto, /Runner Pro/);
    assert.match(texto, /mostrar_productos/);
  });

  test('muchos atributos RECOMENDADOS no se vuelcan todos al prompt (seria un interrogatorio)', () => {
    // Caso real del catalogo en produccion: 8 atributos marcados por categoria.
    const { construirSystem } = require('../lib/services/agente');
    const ocho = categoria('Casacas', ['Corte', 'Estilo', 'Genero', 'Material', 'Ocasion', 'Talla', 'Temporada', 'Tipo']
      .map((n) => ({ nombre: n, nivel: 'RECOMENDADO' })));
    const productos = [producto({ id: 1, nombre: 'Bomber', categoria: 'Casacas' })];
    productos[0].categoria = ocho;
    const lead = { categoriaInteres: 'Casacas', categoriaId: ocho.id, atributosLead: {}, contexto: {} };
    const system = construirSystem({ nombre: 'Tienda' }, productos, {}, lead, false, false, '');
    const linea = (system.match(/Datos que podrian afinar la recomendacion.*/) || [''])[0];
    assert.ok(linea, 'la linea de recomendados tiene que existir');
    // Solo interesa la lista que va despues de los dos puntos (la frase tiene
    // comas propias mas adelante).
    const listados = linea.split(': ')[1].split('.')[0].split(',').map((t) => t.trim());
    assert.ok(listados.length <= 3, `no puede listar los 8, listo ${listados.length}: ${linea}`);
    assert.ok(!listados.includes('Temporada'), 'no deberia llegar hasta el octavo atributo');
  });

  test('un atributo RECOMENDADO no bloquea (solo el OBLIGATORIO)', () => {
    const conRecomendado = categoria('Zapatillas deportivas', [
      { nombre: 'Genero', nivel: 'OBLIGATORIO' },
      { nombre: 'Uso', nivel: 'RECOMENDADO' },
    ]);
    const lead = { categoriaInteres: 'Zapatillas deportivas', categoriaId: conRecomendado.id, atributosLead: { Genero: 'Hombre' }, contexto: {} };
    assert.deepEqual(atributosFaltantes(conRecomendado, lead, 'OBLIGATORIO'), []);
    assert.deepEqual(atributosFaltantes(conRecomendado, lead, 'RECOMENDADO'), ['Uso']);
    assert.match(seccionProductos([producto({ id: 1, nombre: 'Runner Pro', categoria: 'Zapatillas deportivas' })], lead, conRecomendado), /Runner Pro/);
  });
});

describe('TEST 2 - Mantener filtros (o decir cual se flexibilizo)', () => {
  const productos = [
    producto({ id: 1, nombre: 'Nike negra 42', categoria: 'Zapatillas', precio: 480, atributos: { Marca: 'Nike', Genero: 'Hombre' }, variantes: [{ activa: true, atributos: { Talla: '42', Color: 'Negro' }, stock: 2 }] }),
    producto({ id: 2, nombre: 'Nike blanca 42', categoria: 'Zapatillas', precio: 490, atributos: { Marca: 'Nike', Genero: 'Hombre' }, variantes: [{ activa: true, atributos: { Talla: '42', Color: 'Blanco' }, stock: 2 }] }),
    producto({ id: 3, nombre: 'Zapatilla de mujer', categoria: 'Zapatillas', precio: 450, atributos: { Marca: 'Nike', Genero: 'Mujer' }, variantes: [{ activa: true, atributos: { Talla: '42', Color: 'Negro' }, stock: 5 }] }),
  ];
  const lead = {
    categoriaInteres: 'Zapatillas', marca: 'Nike', color: 'Negro', talla: '42',
    presupuestoMax: 500, atributosLead: { Genero: 'Hombre' },
  };

  test('con coincidencia exacta, todos los resultados respetan TODOS los filtros', () => {
    const { resultados, relajado } = buscarConFallback(productos, lead);
    assert.equal(relajado, null, 'no hizo falta aflojar nada');
    assert.deepEqual(resultados.map((p) => p.id), [1]);
  });

  test('el genero es filtro principal: nunca aparece un producto del otro genero', () => {
    const { resultados } = buscarConFallback(productos, lead);
    assert.ok(!resultados.some((p) => p.atributos.Genero === 'Mujer'));
  });

  test('el genero NO se afloja ni cuando no hay ninguna coincidencia', () => {
    const soloMujer = [producto({ id: 9, categoria: 'Zapatillas', atributos: { Genero: 'Mujer' }, stock: 4 })];
    const { resultados } = buscarConFallback(soloMujer, { categoriaInteres: 'Zapatillas', atributosLead: { Genero: 'Hombre' } });
    assert.deepEqual(resultados, []);
  });

  test('si hay que aflojar un filtro, el sistema dice EXACTAMENTE cual', () => {
    const sinNegras = [producto({ id: 2, nombre: 'Nike blanca 42', categoria: 'Zapatillas', precio: 490, atributos: { Marca: 'Nike', Genero: 'Hombre' }, variantes: [{ activa: true, atributos: { Talla: '42', Color: 'Blanco' }, stock: 2 }] })];
    const { resultados, relajado } = buscarConFallback(sinNegras, lead);
    assert.equal(relajado, 'color');
    assert.equal(resultados.length, 1);
  });

  test('afloja en el orden del documento: primero color, despues marca', () => {
    const soloOtraMarca = [producto({ id: 5, nombre: 'Adidas blanca', categoria: 'Zapatillas', precio: 480, atributos: { Marca: 'Adidas', Genero: 'Hombre' }, variantes: [{ activa: true, atributos: { Talla: '42', Color: 'Blanco' }, stock: 3 }] })];
    assert.equal(buscarConFallback(soloOtraMarca, lead).relajado, 'marca');
  });

  test('antes de mostrar alternativas aflojadas, el sistema exige PREGUNTAR primero', () => {
    const sinNegras = [producto({ id: 2, nombre: 'Nike blanca 42', categoria: 'Zapatillas', precio: 490, atributos: { Marca: 'Nike', Genero: 'Hombre' }, variantes: [{ activa: true, atributos: { Talla: '42', Color: 'Blanco' }, stock: 2 }] })];
    const texto = seccionProductos(sinNegras, { ...lead, contexto: {} }, null);
    assert.match(texto, /NO las muestres todavia/);
    assert.match(texto, /PREGUNTALE/);
  });
});

describe('TEST 3 - "¿Tenes otros modelos?" con 13 en catalogo', () => {
  const trece = Array.from({ length: 13 }, (_, i) => producto({
    id: i + 1, nombre: `Modelo ${i + 1}`, categoria: 'Zapatillas', precio: 300 + i, stock: 4,
  }));
  const lead = { categoriaInteres: 'Zapatillas', contexto: {} };

  test('muestra pocas por vez, pero el total real son 13', () => {
    const { resultados, total } = buscarConFallback(trece, lead);
    assert.equal(total, 13);
    const { pagina, restantes, hayMas } = paginar(resultados, []);
    assert.equal(pagina.length, RESULTADOS_POR_PAGINA);
    assert.equal(restantes, 13 - RESULTADOS_POR_PAGINA);
    assert.equal(hayMas, true);
  });

  test('el prompt le dice al modelo el total_matches real, no solo lo mostrado', () => {
    const texto = seccionProductos(trece, lead, null);
    assert.match(texto, /total_matches = 13/);
  });

  test('PROHIBIDO decir "esos son todos" cuando quedan mas', () => {
    const texto = seccionProductos(trece, lead, null);
    assert.match(texto, /JAMAS le digas que "esas son todas"/);
    assert.match(texto, /ver_mas_productos/);
  });

  test('la segunda pagina trae modelos DISTINTOS (no repite los ya vistos)', () => {
    const { resultados } = buscarConFallback(trece, lead);
    const primera = paginar(resultados, []).pagina.map((p) => p.id);
    const segunda = paginar(resultados, primera).pagina.map((p) => p.id);
    assert.equal(segunda.length, RESULTADOS_POR_PAGINA);
    assert.equal(primera.filter((id) => segunda.includes(id)).length, 0, 'no puede repetir un producto ya mostrado');
  });

  test('recien cuando vio los 13, el sistema autoriza decir que no hay mas', () => {
    const { resultados } = buscarConFallback(trece, lead);
    const todos = resultados.map((p) => p.id);
    assert.equal(paginar(resultados, todos).hayMas, false);
    const texto = seccionProductos(trece, { ...lead, contexto: { fotosEnviadas: todos } }, null);
    assert.match(texto, /YA SE LOS MOSTRASTE/);
    assert.match(texto, /quedan por mostrar = 0/);
  });
});

describe('TEST 4 - Producto sin stock nunca se ofrece como disponible', () => {
  test('stock 0 en producto y en variantes: no aparece', () => {
    const productos = [producto({ id: 1, categoria: 'Zapatillas', stock: 0, variantes: [{ activa: true, atributos: { Talla: '42' }, stock: 0 }] })];
    assert.deepEqual(buscarProductosFiltrados(productos, { categoriaInteres: 'Zapatillas' }), []);
  });

  test('stock 0 en el producto pero SI en una variante: si aparece (el stock real vive en la variante)', () => {
    const productos = [producto({ id: 1, categoria: 'Zapatillas', stock: 0, variantes: [{ activa: true, atributos: { Talla: '42' }, stock: 3 }] })];
    assert.equal(buscarProductosFiltrados(productos, { categoriaInteres: 'Zapatillas' }).length, 1);
  });

  test('la ficha solo lista variantes con stock real', () => {
    const p = producto({
      id: 1, nombre: 'Bomber', categoria: 'Casacas', stock: 0,
      variantes: [
        { activa: true, atributos: { Talla: 'M', Color: 'Negro' }, stock: 2 },
        { activa: true, atributos: { Talla: 'L', Color: 'Verde' }, stock: 0 },
      ],
    });
    const ficha = fichaProducto(p, {});
    assert.match(ficha, /Negro/);
    assert.doesNotMatch(ficha, /Verde/, 'una talla/color agotado no se ofrece');
  });
});

describe('TEST 5 - Color disponible pero SIN foto de ese color', () => {
  const camiseta = producto({
    id: 1, nombre: 'Camiseta basica', categoria: 'Camisetas', fotos: ['generica.jpg'],
    variantes: [
      { activa: true, atributos: { Talla: 'M', Color: 'Blanco' }, stock: 3, fotos: ['blanco_frente.jpg'] },
      { activa: true, atributos: { Talla: 'M', Color: 'Gris' }, stock: 2, fotos: [] },
    ],
  });

  test('el sistema distingue "hay stock gris" de "hay foto gris"', () => {
    const foto = fotoParaMostrar(camiseta, { color: 'Gris' });
    assert.equal(foto.esDelColorPedido, false);
    assert.deepEqual(foto.coloresConFoto, ['Blanco']);
    assert.deepEqual(foto.coloresSinFoto, ['Gris']);
  });

  test('NO se manda la foto de otro color: se avisa y se ofrece como referencia', () => {
    const foto = fotoParaMostrar(camiseta, { color: 'Gris' });
    assert.equal(foto.url, null, 'no se manda ninguna imagen del color equivocado');
    const avisos = avisosDeFoto(camiseta, foto).join(' ');
    assert.match(avisos, /NO SE ENVIO NINGUNA FOTO/);
    assert.match(avisos, /SI hay stock/);
    assert.match(avisos, /COMO REFERENCIA/);
    assert.match(avisos, /PROHIBIDO escribir "aqui tienes"/);
  });

  test('tambien le dice que colores SI tienen foto (para poder ofrecerlos)', () => {
    const avisos = avisosDeFoto(camiseta, fotoParaMostrar(camiseta, { color: 'Gris' })).join(' ');
    assert.match(avisos, /De estos colores SI tenes foto: Blanco/);
    assert.match(avisos, /SIN foto cargada: Gris/);
  });
});

describe('TEST 6 - Nunca hacer pasar la foto de un color por otro', () => {
  const camiseta = producto({
    id: 1, nombre: 'Camiseta basica', categoria: 'Camisetas', fotos: ['generica.jpg'],
    variantes: [
      { activa: true, atributos: { Talla: 'M', Color: 'Blanco' }, stock: 3, fotos: ['blanco_frente.jpg'] },
      { activa: true, atributos: { Talla: 'M', Color: 'Negro' }, stock: 2, fotos: [] },
    ],
  });

  test('si pide negro y solo hay foto blanca, NO se manda nada y se marca el desvio', () => {
    const foto = fotoParaMostrar(camiseta, { color: 'Negro' });
    assert.equal(foto.url, null, 'jamas se manda la blanca haciendola pasar por negra');
    assert.equal(foto.esDelColorPedido, false);
    assert.equal(foto.colorPedido, 'Negro');
    assert.equal(foto.referenciaDisponible, 'Blanco', 'pero se puede OFRECER la blanca como referencia');
  });

  test('el aviso nombra los dos colores, para que el bot no pueda confundirlos', () => {
    const avisos = avisosDeFoto(camiseta, fotoParaMostrar(camiseta, { color: 'Negro' })).join(' ');
    assert.match(avisos, /en Negro: ese color no tiene imagen cargada/);
    assert.match(avisos, /Ofrecele verla en Blanco COMO REFERENCIA/);
  });

  test('si SI existe la foto del color pedido, se manda esa y sin aclaracion de referencia', () => {
    const foto = fotoParaMostrar(camiseta, { color: 'Blanco' });
    assert.equal(foto.url, 'blanco_frente.jpg');
    assert.equal(foto.esDelColorPedido, true);
    const avisos = avisosDeFoto(camiseta, foto).join(' ');
    assert.doesNotMatch(avisos, /solo de referencia/i);
  });
});

describe('TEST 7 - Si el envio de la foto FALLA, el bot no puede decir que la mando', () => {
  test('sin ningun envio exitoso, el resultado es TOOL_FAILED', () => {
    const r = resultadoDeEnvio({ enviados: 0, fallidos: ['Camiseta basica (Error HTTP 500)'] });
    assert.match(r, /TOOL_FAILED/);
    assert.doesNotMatch(r, /TOOL_SUCCESS/);
  });

  test('le prohibe explicitamente afirmar que le llego algo', () => {
    const r = resultadoDeEnvio({ enviados: 0, fallidos: ['Camiseta basica'] });
    assert.match(r, /NO le digas al cliente que le mandaste algo/);
  });

  test('si se mandaron 2 de 3, los que fallaron se marcan como NO enviados', () => {
    const r = resultadoDeEnvio({ enviados: 2, fallidos: ['Bomber ligera'], resumen: 'A; B', total: 3, quedan: 0 });
    assert.match(r, /TOOL_SUCCESS/);
    assert.match(r, /NO se pudieron enviar: Bomber ligera/);
    assert.match(r, /no menciones esos como enviados/);
  });

  test('un producto sin ninguna foto cargada tampoco puede contarse como "te mande la foto"', () => {
    const sinFotos = producto({ id: 1, nombre: 'Sin fotos', categoria: 'Casacas', fotos: [] });
    const avisos = avisosDeFoto(sinFotos, fotoParaMostrar(sinFotos, {})).join(' ');
    assert.match(avisos, /No digas que le mandaste una foto/);
  });
});

describe('TEST 8 - Si el envio SI funciona, recien ahi puede confirmarlo', () => {
  test('con envio exitoso el resultado es TOOL_SUCCESS', () => {
    const r = resultadoDeEnvio({ enviados: 1, resumen: 'Runner Pro (Bs 480.00)', total: 1, quedan: 0 });
    assert.match(r, /TOOL_SUCCESS/);
    assert.doesNotMatch(r, /TOOL_FAILED/);
  });

  test('sin fallos, no aparece ninguna advertencia de envio fallido', () => {
    const r = resultadoDeEnvio({ enviados: 1, resumen: 'Runner Pro', total: 1, quedan: 0 });
    assert.doesNotMatch(r, /NO se pudieron enviar/);
  });
});

describe('TEST 9 - La moneda la decide el backend, nunca la IA', () => {
  const p = producto({ id: 1, nombre: 'Gym Flex', categoria: 'Zapatillas', precio: 80 });

  test('un precio en BOB se escribe "Bs 80.00", nunca "$80"', () => {
    const ficha = fichaProducto(p, {}, 'BOB');
    assert.match(ficha, /Bs 80\.00/);
    assert.doesNotMatch(ficha, /\$\s?80/);
  });

  test('el mismo numero en USD se escribe con SU simbolo, no con el de bolivianos', () => {
    const ficha = fichaProducto(p, {}, 'USD');
    assert.match(ficha, /US\$ 80\.00/);
    assert.doesNotMatch(ficha, /Bs/);
  });

  test('el precio NUNCA sale pelado sin moneda (era el bug: "370.00" y el modelo elegia el simbolo)', () => {
    const ficha = fichaProducto(p, {});
    assert.doesNotMatch(ficha, /\*Precio\*: 80\.00/);
  });

  test('el bloque que ve el modelo tambien lleva la moneda en cada precio', () => {
    const texto = seccionProductos([p], { categoriaInteres: 'Zapatillas', contexto: {} }, null, 'BOB');
    assert.match(texto, /Precio: Bs 80\.00/);
  });
});

describe('TEST 10 - Dato tecnico que no existe en la ficha', () => {
  test('el prompt obliga a admitir que no tiene el dato, en vez de inventarlo', () => {
    const { construirSystem } = require('../lib/services/agente');
    const system = construirSystem(
      { nombre: 'Tienda Demo', moneda: 'BOB' },
      [producto({ id: 1, categoria: 'Camisetas', atributos: { Material: '100% algodon' } })],
      {}, {}, false, false, 'Raul',
    );
    assert.match(system, /SI NO SABES ALGO, DECILO/);
    assert.match(system, /no tengo registrado el tipo exacto/);
    assert.match(system, /PROHIBIDO rellenar con adjetivos que no estan en los datos/);
  });

  test('tampoco puede inventar justificaciones de precio', () => {
    const { construirSystem } = require('../lib/services/agente');
    const system = construirSystem({ nombre: 'Tienda Demo' }, [producto({ id: 1 })], {}, {}, false, false, '');
    assert.match(system, /solo podes usar atributos reales de la ficha, nunca justificaciones inventadas/);
  });
});

describe('TEST 11 - Cierre completo: producto -> variante -> precio -> datos -> entrega -> confirmacion', () => {
  const { construirSystem } = require('../lib/services/agente');

  test('la ficha muestra el precio real antes de cualquier intento de cierre', () => {
    const p = producto({ id: 1, nombre: 'Gym Flex', categoria: 'Zapatillas', precio: 370 });
    assert.match(fichaProducto(p, {}, 'BOB'), /Bs 370\.00/);
  });

  test('el bloque de resultados expone las variantes con su ID, para que el pedido apunte a una', () => {
    const p = producto({
      id: 1, nombre: 'Gym Flex', categoria: 'Zapatillas', precio: 370,
      variantes: [{ id: 55, activa: true, atributos: { Talla: '42', Color: 'Negro' }, stock: 3 }],
    });
    const texto = seccionProductos([p], { categoriaInteres: 'Zapatillas', contexto: {} }, null, 'BOB');
    assert.match(texto, /\[Variante ID 55\]/);
    assert.match(texto, /NUNCA llames crear_pedido sin antes preguntarle al cliente cual elige|preguntale cual de estas elige ANTES de crear el pedido/);
  });

  test('el prompt exige pasar por confirmar_pedido antes de crear nada', () => {
    const system = construirSystem({ nombre: 'Tienda Demo' }, [producto({ id: 1 })], {}, {}, false, false, '');
    assert.match(system, /llama a confirmar_pedido/);
    assert.match(system, /Recien despues llama a crear_pedido/);
  });

  test('sin direccion de tienda cargada, el bot solo puede ofrecer entrega a domicilio', () => {
    const system = construirSystem({ nombre: 'Tienda Demo' }, [producto({ id: 1 })], {}, {}, false, false, '');
    assert.match(system, /nunca inventes una direccion de tienda/);
    assert.doesNotMatch(system, /retiro en la tienda/);
  });

  test('con direccion cargada, el retiro en tienda pasa a ser una opcion real', () => {
    const config = { direccionTienda: 'Av. Ballivian 1234' };
    const system = construirSystem({ nombre: 'Tienda Demo' }, [producto({ id: 1 })], config, {}, false, false, '');
    assert.match(system, /retiro en la tienda/);
    assert.match(system, /vos NUNCA la escribas de memoria/);
  });
});

describe('TEST 12 - No repetir preguntas que ya tienen respuesta', () => {
  const ropa = categoria('Ropa', [
    { nombre: 'Genero', nivel: 'OBLIGATORIO' },
    { nombre: 'Talla', nivel: 'OBLIGATORIO', esDeVariante: true },
    { nombre: 'Color', nivel: 'RECOMENDADO', esDeVariante: true },
  ]);

  test('lo que el cliente ya dijo deja de figurar como faltante', () => {
    const lead = { categoriaInteres: 'Ropa', categoriaId: ropa.id, talla: 'L', atributosLead: { Genero: 'Hombre' } };
    assert.deepEqual(atributosFaltantes(ropa, lead, 'OBLIGATORIO'), []);
  });

  test('solo se pide lo que realmente falta, no toda la lista de nuevo', () => {
    const lead = { categoriaInteres: 'Ropa', categoriaId: ropa.id, atributosLead: { Genero: 'Hombre' } };
    assert.deepEqual(atributosFaltantes(ropa, lead, 'OBLIGATORIO'), ['Talla']);
  });

  test('un atributo guardado en su campo propio (talla) cuenta igual que uno libre', () => {
    const lead = { categoriaInteres: 'Ropa', categoriaId: ropa.id, talla: 'L', color: 'Negro', atributosLead: {} };
    assert.deepEqual(atributosFaltantes(ropa, lead, 'OBLIGATORIO'), ['Genero']);
    assert.deepEqual(atributosFaltantes(ropa, lead, 'RECOMENDADO'), []);
  });

  test('el prompt le pasa al modelo todo lo que ya sabe, para que no lo vuelva a preguntar', () => {
    const { construirSystem } = require('../lib/services/agente');
    const lead = { categoriaInteres: 'Ropa', talla: 'L', color: 'Negro', atributosLead: { Genero: 'Hombre' } };
    const system = construirSystem({ nombre: 'Tienda Demo' }, [producto({ id: 1, categoria: 'Ropa' })], {}, lead, false, false, '');
    assert.match(system, /Talla: L/);
    assert.match(system, /Color preferido: Negro/);
    assert.match(system, /Genero: Hombre/);
    assert.match(system, /no preguntar dos veces lo mismo/);
  });
});

// Punto 4 del documento ("no hacer un interrogatorio") + reporte real del
// dueño con capturas: el bot pregunto marca, ocasion y talla juntas, y despues
// prometio buscar sin mostrar nada.
describe('PUNTO 4 - el bot no puede interrogar ni prometer sin entregar', () => {
  const { pareceInterrogatorio, pareceAnuncioDeBusqueda, construirSystem } = require('../lib/services/agente');

  test('tres preguntas juntas se detectan como interrogatorio', () => {
    // Mensaje real que mando el bot en produccion (captura del dueño).
    const real = [
      '¡Que lindo detalle! Para ayudarte necesito saber algunos detalles:',
      '• ¿Alguna marca o estilo especifico que le guste?',
      '• ¿Es para alguna ocasion especial?',
      '• ¿Que talla suele usar?',
    ].join('\n');
    assert.equal(pareceInterrogatorio(real), true);
  });

  test('dos preguntas en un parrafo tambien', () => {
    assert.equal(pareceInterrogatorio('¿Es para alguna ocasion especial o te gustaria algun estilo en particular? ¿Que talla usa?'), true);
  });

  test('una sola pregunta es lo correcto y NO se rechaza', () => {
    assert.equal(pareceInterrogatorio('Perfecto 😊 ¿Que talla usa ella?'), false);
    assert.equal(pareceInterrogatorio('Contame para que ocasion la queres.'), false);
  });

  test('"dame un momento" se detecta como promesa vacia', () => {
    const real = '¡Perfecto! Voy a buscar algunas opciones de vestidos de la marca Patito en talla M, ideales para una cena. 🚀 Dame un momento.';
    assert.equal(pareceAnuncioDeBusqueda(real), true);
  });

  test('otras variantes de la misma promesa', () => {
    assert.equal(pareceAnuncioDeBusqueda('Ya te muestro las opciones'), true);
    assert.equal(pareceAnuncioDeBusqueda('Estoy buscando lo que me pediste'), true);
    assert.equal(pareceAnuncioDeBusqueda('Enseguida te paso las fotos'), true);
  });

  test('un mensaje que SI entrega no se confunde con una promesa', () => {
    assert.equal(pareceAnuncioDeBusqueda('Te muestro estas tres, todas talla M.'), false);
    assert.equal(pareceAnuncioDeBusqueda('Aca van las opciones que tenemos.'), false);
  });

  test('el prompt prohibe explicitamente las tres conductas de las capturas', () => {
    const system = construirSystem({ nombre: 'Tienda' }, [producto({ id: 1 })], {}, {}, false, false, '');
    assert.match(system, /UNA SOLA PREGUNTA POR MENSAJE/);
    assert.match(system, /NUNCA ANUNCIES QUE VAS A BUSCAR/);
    assert.match(system, /NUNCA digas que "tenemos varias opciones" sin mostrarlas/);
  });

  test('los atributos recomendados NO se preguntan antes de mostrar', () => {
    const cat = categoria('Vestidos', [{ nombre: 'Ocasion', nivel: 'RECOMENDADO' }, { nombre: 'Estilo', nivel: 'RECOMENDADO' }]);
    const productos = [producto({ id: 1, nombre: 'Vestido', categoria: 'Vestidos' })];
    productos[0].categoria = cat;
    const lead = { categoriaInteres: 'Vestidos', categoriaId: cat.id, atributosLead: {}, contexto: {} };
    const system = construirSystem({ nombre: 'Tienda' }, productos, {}, lead, false, false, '');
    assert.match(system, /NO los preguntes antes de mostrar productos/);
  });
});

// Bug real de produccion: el negocio tenia 4 zapatillas cargadas y el bot le
// juraba al cliente que solo existia una.
describe('BUG - "es el unico modelo que tenemos" siendo mentira', () => {
  const { coincideAtributosLead } = require('../lib/services/catalogo');

  const zapa = (nombre, genero, stock) => producto({
    id: Math.floor(Math.random() * 100000), nombre, categoria: 'Zapatillas', stock, atributos: genero ? { Genero: genero } : {},
  });

  test('"Masculino" y "hombre" son el mismo genero (era lo que escondia productos)', () => {
    assert.equal(coincideAtributosLead(zapa('A', 'Masculino', 3), { atributosLead: { Genero: 'Hombre' } }), true);
    assert.equal(coincideAtributosLead(zapa('B', 'Varon', 3), { atributosLead: { Genero: 'hombre' } }), true);
    assert.equal(coincideAtributosLead(zapa('C', 'Caballero', 3), { atributosLead: { Genero: 'Hombre' } }), true);
    assert.equal(coincideAtributosLead(zapa('D', 'Femenino', 3), { atributosLead: { Genero: 'Mujer' } }), true);
    assert.equal(coincideAtributosLead(zapa('E', 'Dama', 3), { atributosLead: { Genero: 'mujer' } }), true);
  });

  test('pero sigue separando de verdad los generos distintos', () => {
    assert.equal(coincideAtributosLead(zapa('F', 'Femenino', 3), { atributosLead: { Genero: 'Hombre' } }), false);
    assert.equal(coincideAtributosLead(zapa('G', 'Masculino', 3), { atributosLead: { Genero: 'Mujer' } }), false);
  });

  test('un producto para ambos generos le sirve a los dos', () => {
    assert.equal(coincideAtributosLead(zapa('H', 'Hombre, Mujer', 3), { atributosLead: { Genero: 'Mujer' } }), true);
    assert.equal(coincideAtributosLead(zapa('I', 'Unisex', 3), { atributosLead: { Genero: 'Unisex' } }), true);
  });

  test('un producto sin genero cargado no se esconde (no hay dato que lo contradiga)', () => {
    assert.equal(coincideAtributosLead(zapa('J', null, 3), { atributosLead: { Genero: 'Hombre' } }), true);
  });

  test('el prompt le prohibe al bot decir que el inventario entero es un solo modelo', () => {
    const cat = categoria('Zapatillas', []);
    const productos = [
      producto({ id: 1, nombre: 'Park St', categoria: 'Zapatillas', stock: 3, atributos: { Genero: 'Hombre' } }),
      producto({ id: 2, nombre: 'Superstar', categoria: 'Zapatillas', stock: 0, atributos: { Genero: 'Hombre' } }),
      producto({ id: 3, nombre: 'Tendencia', categoria: 'Zapatillas', stock: 0, atributos: { Genero: 'Hombre' } }),
    ];
    productos.forEach((p) => { p.categoria = cat; });
    const lead = { categoriaInteres: 'Zapatillas', categoriaId: cat.id, atributosLead: { Genero: 'Hombre' }, contexto: {} };
    const texto = seccionProductos(productos, lead, cat, 'BOB');

    assert.match(texto, /PANORAMA REAL/);
    assert.match(texto, /3 producto\(s\) cargado\(s\) en total/);
    assert.match(texto, /2 esta\(n\) sin stock/);
    assert.match(texto, /PROHIBIDO decir "es el unico modelo que tenemos"/);
  });
});

// Bug real: el cliente pidio las fotos en blanco de un producto que ya se le
// habia mostrado en tarjeta, y el bot respondio "ya te las envie" sin mandar
// nada. El control de duplicados era por producto en vez de por foto.
describe('BUG - pedir otro color de un producto ya mostrado', () => {
  const conColores = producto({
    id: 1, nombre: 'Park St 2.0', categoria: 'Urbanas', fotos: ['generica.jpg'],
    variantes: [
      { activa: true, atributos: { Talla: '9', Color: 'blanco' }, stock: 2, fotos: ['blanco-1.jpg', 'blanco-2.jpg'] },
      { activa: true, atributos: { Talla: '10', Color: 'Gris' }, stock: 6, fotos: ['gris-1.jpg'] },
    ],
  });

  test('pedir un color devuelve TODAS las fotos de ese color, no una sola', () => {
    const foto = fotoParaMostrar(conColores, { color: 'blanco' });
    assert.deepEqual(foto.urls, ['blanco-1.jpg', 'blanco-2.jpg']);
    assert.equal(foto.esDelColorPedido, true);
  });

  test('cada color trae las suyas, no las del otro', () => {
    assert.deepEqual(fotoParaMostrar(conColores, { color: 'gris' }).urls, ['gris-1.jpg']);
  });

  test('sin color pedido, la tarjeta usa la foto generica del producto', () => {
    const foto = fotoParaMostrar(conColores, {});
    assert.equal(foto.url, 'generica.jpg');
  });

  test('un color sin foto propia NO manda otra: la ofrece como referencia', () => {
    const sinFotoNegro = producto({
      id: 2, nombre: 'Otro', categoria: 'Urbanas', fotos: [],
      variantes: [
        { activa: true, atributos: { Color: 'blanco' }, stock: 2, fotos: ['blanco.jpg'] },
        { activa: true, atributos: { Color: 'negro' }, stock: 2, fotos: [] },
      ],
    });
    const foto = fotoParaMostrar(sinFotoNegro, { color: 'negro' });
    assert.equal(foto.esDelColorPedido, false);
    assert.equal(foto.url, null);
    assert.equal(foto.referenciaDisponible, 'blanco');
    assert.match(avisosDeFoto(sinFotoNegro, foto).join(' '), /NO SE ENVIO NINGUNA FOTO/);
  });
});

// Bug real: el cliente escribe "blancas" (como se dice de unas zapatillas) y
// el catalogo tiene el color cargado como "blanco". La comparacion literal
// fallaba y el bot terminaba mandando la foto negra.
describe('BUG - "blancas" no matcheaba con "blanco"', () => {
  const { valoresEquivalentes, fotoParaMostrar: foto } = require('../lib/services/catalogo');

  test('plural y genero no rompen el match de color', () => {
    assert.equal(valoresEquivalentes('blancas', 'blanco'), true);
    assert.equal(valoresEquivalentes('negras', 'Negro'), true);
    assert.equal(valoresEquivalentes('grises', 'Gris'), true);
    assert.equal(valoresEquivalentes('azules', 'Azul marino'), true);
    assert.equal(valoresEquivalentes('blancas', 'Blanco nube'), true);
  });

  test('pero sigue distinguiendo colores distintos', () => {
    assert.equal(valoresEquivalentes('blancas', 'negro'), false);
    assert.equal(valoresEquivalentes('negro', 'Blanco nube'), false);
  });

  const zapa = producto({
    id: 1, nombre: 'Park St', categoria: 'Urbanas', fotos: [],
    variantes: [
      { activa: true, atributos: { Talla: '9', Color: 'blanco' }, stock: 2, fotos: ['blanco-1.jpg', 'blanco-2.jpg'] },
      { activa: true, atributos: { Talla: '9', Color: 'negro' }, stock: 5, fotos: ['negro-1.jpg'] },
    ],
  });

  test('pedir "blancas" trae las BLANCAS, no la primera que tenga foto', () => {
    const f = foto(zapa, { color: 'blancas' });
    assert.deepEqual(f.urls, ['blanco-1.jpg', 'blanco-2.jpg']);
    assert.equal(f.esDelColorPedido, true);
  });

  test('la ficha tambien respeta el color pedido en plural', () => {
    const ficha = fichaProducto(zapa, { color: 'blancas', talla: '9' }, 'BOB');
    assert.match(ficha, /Talla 9: blanco/);
    assert.doesNotMatch(ficha, /negro/);
  });

  test('el prompt prohibe decir "aqui tienes" sin haber mandado nada', () => {
    const { construirSystem } = require('../lib/services/agente');
    const system = construirSystem({ nombre: 'T' }, [producto({ id: 1 })], {}, {}, false, false, '');
    assert.match(system, /"AQUI TIENES" SOLO SI DE VERDAD MANDASTE ALGO/);
    assert.match(system, /usa "tenemos", "ahora mismo contamos con"/);
  });
});
