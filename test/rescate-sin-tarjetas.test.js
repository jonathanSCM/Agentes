// Bug real reportado con capturas: el bot mando "Estas son las opciones que
// tenemos 👆 ¿Alguna te interesa?" y el cliente no recibio ninguna tarjeta.
//
// Pasaba en el rescate de la ultima vuelta (agente.js): cuando el modelo
// insiste con texto vago, el codigo fuerza mostrar_productos... pero
// descartaba su resultado y mandaba el texto afirmativo igual. Y esa funcion
// tiene varios caminos donde no manda nada (cupo de fotos del turno agotado,
// ids ya mostrados, envio rechazado por WhatsApp).
//
// Se reproduce agotando el cupo de fotos del turno con enviar_fotos_producto,
// que NO cuenta como tarjeta: el rescate se queda sin margen para mandar.
// Por eso el producto necesita 3 fotos DISTINTAS (con urls repetidas el
// control de duplicados corta antes y el cupo nunca se agota).
//
// El cliente nombra el producto puntual por su nombre a proposito: con la
// regla nueva de "solo tarjeta de categoria salvo busqueda puntual", el
// rescate generico (sin nombre) fuerza mostrar_tarjeta_categoria en vez de
// mostrar_productos - una imagen distinta, no sujeta a este mismo cupo de
// fotos de producto. Este test sigue probando el camino que SI sigue usando
// mostrar_productos (busqueda puntual), que es donde el cupo aplica.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');

const SLUG = 'test-rescate-sin-tarjetas';
const TELEFONO = '000-test-rescate';

let empresaId;
let agenteId;
let productoId;

function iaFalsa(respuestas) {
  let i = 0;
  return async () => {
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return { content: r.content || '', tool_calls: r.tool_calls || [] };
  };
}

const tool = (name, args = {}) => ({ id: `call_${name}`, name, arguments: args });

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Rescate', slug: SLUG, moneda: 'BOB',
      agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { preguntasIniciales: [] } } }] },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;

  // Sin atributos OBLIGATORIOS: el gate de "primero entender" no es lo que se
  // esta probando aca.
  const categoria = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });

  const producto = await prisma.producto.create({
    data: {
      empresaId, categoriaId: categoria.id, nombre: 'Zapatilla Rescate', precio: 300, stock: 5,
      fotos: ['uno.jpg', 'dos.jpg', 'tres.jpg'],
    },
  });
  productoId = producto.id;

  await prisma.clienteFinal.create({
    data: { empresaId, telefono: TELEFONO, categoriaInteres: 'Zapatillas', categoriaId: categoria.id },
  });
});

after(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

describe('rescate de la ultima vuelta', () => {
  test('si no logro mostrar ninguna tarjeta, el bot NO dice que mostro opciones', async () => {
    const llamar = iaFalsa([
      // Gasta el cupo de fotos del turno (3 fotos distintas, 0 tarjetas).
      { tool_calls: [tool('enviar_fotos_producto', { idProducto: productoId })] },
      // Texto vago dos veces: la ultima vuelta fuerza mostrar_productos, que
      // ya no tiene cupo para mandar nada.
      { content: 'Voy a revisar y te aviso.' },
      { content: 'Dame un momento, ya te muestro las opciones.' },
    ]);

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'tenes la Zapatilla Rescate?', undefined, { llamarInyectado: llamar });

    assert.doesNotMatch(
      salida.respuesta,
      /Estas son las opciones/,
      'no puede afirmar que mostro tarjetas si no salio ninguna',
    );
    assert.match(salida.respuesta, /no pude traerte las opciones/);
  });
});
