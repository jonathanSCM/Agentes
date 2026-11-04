// M2: lo que el panel "Mensajes del agente" guarda en la base y como lo usa el motor.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const panel = require('../lib/services/mensajesPanel');
const mensajes = require('../lib/services/mensajes');
const turnoPrefab = require('../lib/services/turnoPrefab');

const SLUG = 'test-mensajes-panel';
let empresaId;

const ctx = async () => mensajes.cargarContexto({ empresa: { id: empresaId, nombre: 'Tienda Panel' }, config: { registro: 'vos' } });
const falla = async (fn, patron) => assert.rejects(fn, (e) => { assert.equal(e.codigo, 'MENSAJES'); assert.match(e.message, patron); return true; });

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  empresaId = (await prisma.empresa.create({ data: { nombre: 'Tienda Panel', slug: SLUG } })).id;
});
after(async () => {
  mensajes.invalidar(empresaId);
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

describe('mensajes de fábrica', () => {
  test('el negocio cambia un texto y el agente lo usa; volver al original lo deshace', async () => {
    await panel.guardarTexto(empresaId, 'saludo', '¡Buenas! Esto es {{negocio}}, ¿qué necesitás?');
    assert.match((await ctx()).t('saludo'), /¡Buenas! Esto es Tienda Panel/);
    await panel.restaurar(empresaId, 'saludo');
    assert.match((await ctx()).t('saludo'), /Bienvenido a Tienda Panel/);
  });

  test('rechaza variables que el mensaje no tiene, bloques sin cerrar y textos vacíos', async () => {
    await falla(() => panel.guardarTexto(empresaId, 'saludo', 'Hola {{precio}}'), /no se puede usar/);
    await falla(() => panel.guardarTexto(empresaId, 'saludo', '{{#x}}hola'), /sin cerrar/);
    await falla(() => panel.guardarTexto(empresaId, 'saludo', '   '), /vacío/);
    await falla(() => panel.guardarTexto(empresaId, 'no_existe', 'hola'), /no existe/);
  });

  test('un texto igual al de fábrica no crea una personalización', async () => {
    const f = require('../lib/services/mensajesBase').obtenerFabrica('saludo');
    await panel.guardarTexto(empresaId, 'saludo', f.texto);
    assert.equal(await prisma.mensajeAgente.count({ where: { empresaId, clave: 'saludo' } }), 0);
  });
});

describe('datos del negocio', () => {
  test('un dato se usa dentro de los mensajes y no se borra mientras algún mensaje lo use', async () => {
    const k = await panel.guardarDato(empresaId, { etiqueta: 'Garantía', valor: '30 días' });
    assert.equal(k, 'garantia');
    await panel.guardarTexto(empresaId, 'saludo', 'Hola. Garantía: {{dato.garantia}}');
    assert.match((await ctx()).t('saludo'), /Garantía: 30 días/);
    await falla(() => panel.eliminarDato(empresaId, 'garantia'), /usa este dato/);
    await panel.restaurar(empresaId, 'saludo');
    await panel.eliminarDato(empresaId, 'garantia');
    assert.equal(await prisma.datoNegocio.count({ where: { empresaId } }), 0);
  });

  test('un mensaje no puede usar un dato que no existe', async () => {
    await falla(() => panel.guardarTexto(empresaId, 'saludo', 'Hola {{dato.fantasma}}'), /no existe en/);
  });
});

describe('mensajes propios', () => {
  test('se crean, la IA los puede elegir por su descripción y se renderizan con el motor', async () => {
    const clave = await panel.crearPropio(empresaId, { nombre: 'Política de cambios', descripcion: 'El cliente pregunta si puede cambiar o devolver', texto: 'Cambios hasta 7 días en {{negocio}}.' });
    assert.equal(clave, 'propio_politica_de_cambios');
    const c = await ctx();
    const elegibles = turnoPrefab.mensajesElegibles(c);
    assert.ok(elegibles.some((e) => e.clave === clave));
    const r = turnoPrefab.resolverEleccion({ mensaje: clave }, { ctx: c, productos: [], elegibles });
    assert.equal(r.texto, 'Cambios hasta 7 días en Tienda Panel.');
  });

  test('desactivar un propio lo saca de lo que la IA puede elegir', async () => {
    await panel.editarPropio(empresaId, 'propio_politica_de_cambios', { activo: false });
    assert.ok(!turnoPrefab.mensajesElegibles(await ctx()).some((e) => e.clave === 'propio_politica_de_cambios'));
    await panel.editarPropio(empresaId, 'propio_politica_de_cambios', { activo: true });
  });

  test('exige descripción y no acepta variables del sistema', async () => {
    await falla(() => panel.crearPropio(empresaId, { nombre: 'Algo', descripcion: 'corta', texto: 'hola' }), /Explicá cuándo/);
    await falla(() => panel.crearPropio(empresaId, { nombre: 'Algo', descripcion: 'Cuando preguntan algo raro', texto: 'Hola {{precio}}' }), /no se puede usar/);
  });

  test('respeta el tope del plan', async () => {
    const tope = await panel.topePropios(empresaId);
    const hay = await prisma.mensajeAgente.count({ where: { empresaId, origen: 'PROPIO' } });
    await prisma.mensajeAgente.createMany({
      data: Array.from({ length: tope - hay }, (_, i) => ({ empresaId, clave: `propio_relleno_${i}`, texto: 'x', descripcion: 'relleno de prueba', origen: 'PROPIO' })),
    });
    await falla(() => panel.crearPropio(empresaId, { nombre: 'Uno más', descripcion: 'Cuando preguntan otra cosa', texto: 'Hola' }), /tope de/);
    await prisma.mensajeAgente.deleteMany({ where: { empresaId, clave: { startsWith: 'propio_relleno_' } } });
  });

  test('borrar un propio no toca los de fábrica', async () => {
    await panel.eliminarPropio(empresaId, 'propio_politica_de_cambios');
    await panel.eliminarPropio(empresaId, 'saludo');
    assert.ok((await ctx()).existe('saludo'));
  });
});

describe('lo que el agente no supo contestar', () => {
  test('lista las notificaciones SIN_RESPUESTA de la empresa', async () => {
    await prisma.notificacion.create({ data: { empresaId, tipo: 'SIN_RESPUESTA', titulo: 'El agente no supo contestar', mensaje: 'Ana: "¿hacen facturas?"' } });
    const items = await panel.sinRespuesta(empresaId);
    assert.equal(items.length, 1);
    assert.match(items[0].mensaje, /facturas/);
  });
});
