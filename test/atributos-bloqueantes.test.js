// Regresion: el bot obligaba a elegir un COLOR antes de mostrar nada, y si el
// cliente contestaba "cualquiera" le respondia que no, que tenia que escoger.
//
// Lo acordado con el negocio es al reves: la talla y el color VAN EN LA
// TARJETA. El cliente los lee ahi y elige. Preguntarlos antes de que haya
// visto una sola foto es el interrogatorio que se quiere evitar.
//
// Eran dos fallas distintas:
//   1. atributosFaltantes trataba los atributos de VARIANTE (talla, color)
//      como bloqueantes, al reves que el panel al guardar un producto
//      (atributosObligatoriosFaltantes filtra por esDeVariante: false).
//   2. "cualquiera" no se reconocia como respuesta, asi que el dato seguia
//      faltando para siempre.
const test = require('node:test');
const assert = require('node:assert');

const { expresaSinPreferencia } = require('../lib/services/catalogo');
const { atributosFaltantes, leadYaTiene, sinPreferenciaDe } = require('../lib/services/agente');

// Categoria tal como la configuro la tienda que reporto el bug: el Color esta
// marcado OBLIGATORIO, pero vive en la variante (es lo que se ve en la ficha).
const categoria = {
  id: 1,
  nombre: 'Zapatillas urbanas',
  atributos: [
    { nombre: 'Genero', nivel: 'OBLIGATORIO', esDeVariante: false },
    { nombre: 'Color', nivel: 'OBLIGATORIO', esDeVariante: true },
    { nombre: 'Talla', nivel: 'OBLIGATORIO', esDeVariante: true },
    { nombre: 'Uso', nivel: 'RECOMENDADO', esDeVariante: false },
  ],
};

// --- 1) Los atributos de variante no bloquean --------------------------------

test('el color y la talla NO bloquean aunque esten marcados obligatorio', () => {
  const lead = { atributosLead: { Genero: 'Hombre' }, contexto: {} };
  assert.deepEqual(
    atributosFaltantes(categoria, lead, 'OBLIGATORIO'),
    [],
    'con el genero sabido ya se puede mostrar: color y talla salen en la tarjeta',
  );
});

test('un obligatorio de nivel PRODUCTO si sigue bloqueando', () => {
  const lead = { atributosLead: {}, contexto: {} };
  assert.deepEqual(atributosFaltantes(categoria, lead, 'OBLIGATORIO'), ['Genero']);
});

test('en RECOMENDADO los de variante si aparecen (son sugerencias, no bloqueo)', () => {
  const soloRecomendados = {
    id: 2,
    nombre: 'Casacas',
    atributos: [
      { nombre: 'Color', nivel: 'RECOMENDADO', esDeVariante: true },
      { nombre: 'Uso', nivel: 'RECOMENDADO', esDeVariante: false },
    ],
  };
  const lead = { atributosLead: {}, contexto: {} };
  assert.deepEqual(atributosFaltantes(soloRecomendados, lead, 'RECOMENDADO'), ['Color', 'Uso']);
});

// --- 2) "cualquiera" es una respuesta ----------------------------------------

test('reconoce las formas normales de decir que no hay preferencia', () => {
  for (const frase of [
    'cualquiera',
    'cualquier color',
    'cualquiera esta bien',
    'me da igual',
    'da lo mismo',
    'no importa',
    'indistinto',
    'el que sea',
    'lo que sea',
    'el que tengas',
    'como quieras',
    'vos elegi',
  ]) {
    assert.equal(expresaSinPreferencia(frase), true, `deberia detectar: "${frase}"`);
  }
});

test('no confunde una respuesta real con falta de preferencia', () => {
  for (const frase of [
    'hombre',
    'negro',
    'talla 42',
    'quiero ver zapatillas',
    'hola',
    'no se cuales tenes',      // este NO es "me da igual": necesita que le muestren
    'importa mucho el precio',
  ]) {
    assert.equal(expresaSinPreferencia(frase), false, `NO deberia detectar: "${frase}"`);
  }
});

test('"no se" no cuenta como sin preferencia: ese cliente necesita ver opciones', () => {
  assert.equal(expresaSinPreferencia('no se'), false);
  assert.equal(expresaSinPreferencia('no tengo idea'), false);
});

// --- 3) Un dato marcado "sin preferencia" deja de faltar ---------------------

test('lo anotado como sin preferencia cuenta como sabido', () => {
  const lead = { atributosLead: {}, contexto: { sinPreferencia: ['Genero'] } };
  assert.equal(leadYaTiene(lead, 'Genero'), true);
  assert.deepEqual(atributosFaltantes(categoria, lead, 'OBLIGATORIO'), []);
});

test('funciona sin importar tildes ni mayusculas en el nombre anotado', () => {
  const lead = { atributosLead: {}, contexto: { sinPreferencia: ['género'] } };
  assert.equal(leadYaTiene(lead, 'Genero'), true);
});

test('sinPreferenciaDe nunca rompe si el contexto viene vacio', () => {
  assert.deepEqual(sinPreferenciaDe({}), []);
  assert.deepEqual(sinPreferenciaDe({ contexto: {} }), []);
  assert.deepEqual(sinPreferenciaDe({ contexto: { sinPreferencia: ['Color'] } }), ['color']);
});

// --- 4) El caso reportado, de punta a punta ----------------------------------

test('el cliente que dice "cualquiera" no vuelve a recibir la misma pregunta', () => {
  // Antes: el bot contestaba "no, tenes que escoger un color antes de seguir".
  const antes = { atributosLead: {}, contexto: {} };
  assert.deepEqual(atributosFaltantes(categoria, antes, 'OBLIGATORIO'), ['Genero'], 'antes de contestar, falta el genero');

  assert.equal(expresaSinPreferencia('cualquiera'), true);

  // generarRespuesta anota los pendientes en contexto.sinPreferencia.
  const despues = { atributosLead: {}, contexto: { sinPreferencia: ['Genero'] } };
  assert.deepEqual(atributosFaltantes(categoria, despues, 'OBLIGATORIO'), [], 'ya no se le vuelve a preguntar');
});

test('el color nunca fue motivo para frenar la venta', () => {
  // Aunque el cliente no diga NADA del color, el catalogo se muestra igual.
  const lead = { atributosLead: { Genero: 'Hombre' }, contexto: {} };
  assert.ok(!atributosFaltantes(categoria, lead, 'OBLIGATORIO').includes('Color'));
  assert.ok(!atributosFaltantes(categoria, lead, 'OBLIGATORIO').includes('Talla'));
});
