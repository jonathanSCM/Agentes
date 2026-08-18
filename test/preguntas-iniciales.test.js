// Regresion del bucle de la pregunta inicial (reportado con capturas).
//
// El cliente escribia "hombre" tres veces seguidas y el bot le seguia
// preguntando el genero con otras palabras ("¿es para vos o para regalar?",
// "¿y que genero estas buscando?", "una ultima cosita, ¿podes decirme el
// genero?"), sin mostrar nunca un producto.
//
// Causa: el gate de `preguntasIniciales` solo se destrababa si el modelo
// llamaba a `actualizar_datos_lead` con la clave EXACTA configurada. No habia
// ningun respaldo en codigo que leyera la respuesta del cliente, la clave se
// comparaba literal (una tilde de mas y no matcheaba), y el gate se activaba
// aunque el catalogo no tuviera con que responder la pregunta.
const test = require('node:test');
const assert = require('node:assert');

const { valoresRealesDeAtributo, resolverValorDeAtributo } = require('../lib/services/catalogo');
const {
  preguntasInicialesFaltantes,
  resolverDatosIniciales,
  leadYaTiene,
  datosDeActualizacionDeLead,
  MAX_INTENTOS_PREGUNTA_INICIAL,
} = require('../lib/services/agente');

// --- Catalogos de prueba -----------------------------------------------------

function producto(id, nombre, atributos, stock = 5) {
  return { id, nombre, precio: 300, stock, activo: true, atributos, variantes: [], categoria: { id: 1, nombre: 'Zapatillas urbanas' } };
}

// Tienda mixta: el genero SI es una pregunta que vale la pena.
const catalogoMixto = [
  producto(1, 'Park St 2.0', { Genero: 'Hombre' }),
  producto(2, 'Ginger Tav', { Genero: 'Mujer' }),
  producto(3, 'Retro Line', { Genero: 'Masculino' }),
];

// La tienda de la captura: "Zapatillas Urbanas Para Hombre". Un solo genero.
const catalogoSoloHombre = [
  producto(1, 'Park St 2.0', { Genero: 'Hombre' }),
  producto(2, 'Retro Line', { Genero: 'Hombre' }),
];

// Tienda Demo tal como esta en produccion: ningun producto tiene atributos.
const catalogoSinAtributos = [
  producto(1, 'Park St 2.0', {}),
  producto(2, 'Retro Line', {}),
];

const config = { preguntasIniciales: ['Genero'] };

// --- Lectura de valores reales del catalogo ----------------------------------

test('valoresRealesDeAtributo encuentra el atributo sin importar tildes ni mayusculas', () => {
  assert.deepEqual(valoresRealesDeAtributo(catalogoMixto, 'Genero'), ['Hombre', 'Masculino', 'Mujer']);
  assert.deepEqual(valoresRealesDeAtributo(catalogoMixto, 'género'), ['Hombre', 'Masculino', 'Mujer']);
  assert.deepEqual(valoresRealesDeAtributo(catalogoMixto, 'GENERO'), ['Hombre', 'Masculino', 'Mujer']);
});

test('valoresRealesDeAtributo devuelve vacio si el catalogo no carga ese atributo', () => {
  assert.deepEqual(valoresRealesDeAtributo(catalogoSinAtributos, 'Genero'), []);
});

// --- Leer la respuesta del cliente EN CODIGO ---------------------------------

test('"hombre" resuelve al valor real del catalogo, sin depender del modelo', () => {
  assert.equal(resolverValorDeAtributo('hombre', 'Genero', catalogoMixto), 'Hombre');
});

test('resuelve tambien dentro de una frase y con sinonimos del negocio', () => {
  assert.equal(resolverValorDeAtributo('es para hombre', 'Genero', catalogoMixto), 'Hombre');
  assert.equal(resolverValorDeAtributo('busco algo de mujer', 'Genero', catalogoMixto), 'Mujer');
  // "caballero" no esta en el catalogo, pero es equivalente a Masculino/Hombre.
  assert.ok(['Hombre', 'Masculino'].includes(resolverValorDeAtributo('para caballero', 'Genero', catalogoMixto)));
});

test('una respuesta que NO contesta la pregunta no inventa un valor', () => {
  // "para mi" fue lo que el cliente contesto a "¿es para vos o para regalar?".
  assert.equal(resolverValorDeAtributo('para mi', 'Genero', catalogoMixto), null);
  assert.equal(resolverValorDeAtributo('hola', 'Genero', catalogoMixto), null);
  assert.equal(resolverValorDeAtributo('que modelos tienes', 'Genero', catalogoMixto), null);
});

test('las equivalencias de una letra no resuelven el atributo por accidente', () => {
  // "m" vale por "hombre" en el diccionario de equivalencias: suelta en una
  // frase cualquiera no puede destrabar el gate.
  assert.equal(resolverValorDeAtributo('quiero ver algo m', 'Genero', catalogoMixto), null);
});

// --- Cuando NO hay que preguntar --------------------------------------------

test('no se pregunta el genero si el catalogo no tiene ese atributo cargado', () => {
  // Tienda Demo: preguntar es puro tramite, la respuesta no cambia nada.
  assert.deepEqual(preguntasInicialesFaltantes(config, { atributosLead: {} }, catalogoSinAtributos), []);
});

test('no se pregunta el genero si toda la tienda vende un solo genero', () => {
  assert.deepEqual(preguntasInicialesFaltantes(config, { atributosLead: {} }, catalogoSoloHombre), []);
});

test('si hay mas de un valor real, si se pregunta', () => {
  assert.deepEqual(preguntasInicialesFaltantes(config, { atributosLead: {} }, catalogoMixto), ['Genero']);
});

test('en una tienda de un solo genero el dato se completa solo, sin preguntar', () => {
  const patch = resolverDatosIniciales('hola', config, { atributosLead: {} }, catalogoSoloHombre);
  assert.deepEqual(patch.atributosLead, { Genero: 'Hombre' });
});

// --- La clave guardada no tiene por que coincidir caracter por caracter ------

test('un atributo guardado con tilde cuenta como sabido', () => {
  const lead = { atributosLead: { 'Género': 'Hombre' } };
  assert.equal(leadYaTiene(lead, 'Genero'), true);
  assert.deepEqual(preguntasInicialesFaltantes(config, lead, catalogoMixto), []);
});

test('el modelo escribiendo la clave distinta no crea un duplicado', () => {
  const clienteFinal = { atributosLead: { Genero: 'Hombre' } };
  const datos = datosDeActualizacionDeLead({ atributosCategoria: { 'género': 'Mujer' } }, clienteFinal, []);
  // Se reusa la clave que ya existia: una sola entrada, con el valor nuevo.
  assert.deepEqual(datos.atributosLead, { Genero: 'Mujer' });
});

// --- Anti-bucle duro ---------------------------------------------------------

test('tras N intentos fallidos el gate se libera y deja ver el catalogo', () => {
  const lead = { atributosLead: {}, contexto: { intentosPreguntaInicial: MAX_INTENTOS_PREGUNTA_INICIAL } };
  assert.deepEqual(preguntasInicialesFaltantes(config, lead, catalogoMixto), []);
});

test('antes del tope el gate sigue activo', () => {
  const lead = { atributosLead: {}, contexto: { intentosPreguntaInicial: MAX_INTENTOS_PREGUNTA_INICIAL - 1 } };
  assert.deepEqual(preguntasInicialesFaltantes(config, lead, catalogoMixto), ['Genero']);
});

// --- El caso completo de la captura -----------------------------------------

test('el cliente contesta "hombre" UNA vez y el gate queda resuelto', () => {
  const lead = { atributosLead: {}, contexto: {} };
  assert.deepEqual(preguntasInicialesFaltantes(config, lead, catalogoMixto), ['Genero'], 'antes de contestar, el gate bloquea');

  // El modelo NO llama a actualizar_datos_lead (es lo que pasaba en produccion):
  // el respaldo en codigo lee la respuesta igual.
  const patch = resolverDatosIniciales('hombre', config, lead, catalogoMixto);
  const leadActualizado = { ...lead, ...patch };

  assert.deepEqual(patch.atributosLead, { Genero: 'Hombre' });
  assert.deepEqual(
    preguntasInicialesFaltantes(config, leadActualizado, catalogoMixto),
    [],
    'despues de contestar una vez, no se vuelve a preguntar',
  );
});

test('la tienda de la captura no pregunta nada y muestra de entrada', () => {
  // "Tienda Demo - Zapatillas Urbanas Para Hombre": un solo genero en todo el
  // catalogo. El cliente dice "que modelos tienes" y tiene que ver productos,
  // no un cuestionario.
  const lead = { atributosLead: {}, contexto: {} };
  const patch = resolverDatosIniciales('que modelos tienes', config, lead, catalogoSoloHombre);
  const leadActualizado = { ...lead, ...patch };
  assert.deepEqual(preguntasInicialesFaltantes(config, leadActualizado, catalogoSoloHombre), []);
});
