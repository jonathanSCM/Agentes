// Test de regresion CRITICO (punto 15 del documento "Instrucciones para
// mejorar el Agente de Ventas"): si falla la consulta al catalogo o el
// proveedor de IA, el agente JAMAS debe fabricar una respuesta que afirme
// disponibilidad. Usa la base de datos local real (igual que el resto del
// proyecto) con datos de prueba propios que se limpian al final.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');

const SLUG = 'test-regresion-agente';
const TELEFONO = '000-test-regresion';

let empresaId;
let agenteId;
let productoId;

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Empresa de Test',
      slug: SLUG,
      agentes: {
        create: [
          { nombre: 'Agente de test', estado: 'ACTIVO', config: { create: {} } },
        ],
      },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;

  const categoria = await prisma.categoria.create({ data: { empresaId, nombre: 'Calzado' } });
  const producto = await prisma.producto.create({
    data: { empresaId, nombre: 'Zapatilla de test', categoriaId: categoria.id, precio: 300, stock: 5 },
  });
  productoId = producto.id;
});

after(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

describe('generarRespuesta - anti-invento en errores (punto 9/10)', () => {
  test('si el proveedor de IA falla, responde honestamente y NO fabrica disponibilidad', async () => {
    const llamarInyectado = async () => {
      throw new Error('Simulacion de falla del proveedor (rate limit, timeout, etc).');
    };

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Que productos tienen?', undefined, { llamarInyectado });

    assert.equal(salida.ok, true);
    assert.equal(salida.error, true, 'debe marcarse explicitamente como error tecnico');
    assert.equal(salida.demo, false, 'NO debe caer en el heuristico de modo demo');
    // La respuesta debe ser el mensaje honesto, nunca debe mencionar
    // "disponible" ni el nombre de un producto como si lo hubiera verificado.
    assert.match(salida.respuesta, /no pude consultar/i);
    assert.doesNotMatch(salida.respuesta.toLowerCase(), /tenemos varios|disponible ahora|en stock/);
  });

  test('cuando la IA responde normalmente (sin error), no lleva la marca de error', async () => {
    const llamarInyectado = async () => ({ content: 'Hola, en que te puedo ayudar?', tool_calls: [] });

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Hola', undefined, { llamarInyectado });

    assert.equal(salida.ok, true);
    assert.equal(salida.error, undefined);
    assert.equal(salida.respuesta, 'Hola, en que te puedo ayudar?');
  });

  test('agente inexistente no rompe, responde con ok:false controlado', async () => {
    const salida = await generarRespuesta(999999999, TELEFONO, [], 'Hola', undefined, {});
    assert.equal(salida.ok, false);
  });
});

describe('generarRespuesta - la IA puede mostrar productos reales via tool_calls', () => {
  test('si la IA llama mostrar_productos, el sistema ejecuta la tool y arma el mensaje final', async () => {
    let vuelta = 0;
    const llamarInyectado = async () => {
      vuelta += 1;
      if (vuelta === 1) {
        return {
          content: '',
          tool_calls: [{ id: 'call_1', name: 'mostrar_productos', arguments: { idsProductos: [productoId] } }],
        };
      }
      return { content: 'Aca tenes la zapatilla que buscabas.', tool_calls: [] };
    };

    const historial = [{ rol: 'CLIENTE', contenido: 'Busco zapatillas' }];
    const salida = await generarRespuesta(agenteId, TELEFONO, historial, 'Que tienen en calzado?', undefined, { llamarInyectado });

    assert.equal(salida.ok, true);
    assert.equal(salida.error, undefined);
    assert.match(salida.respuesta, /zapatilla/i);
  });
});

describe('generarRespuesta - nunca dice "no hay stock" si la busqueda real SI encontro algo', () => {
  // Bug real reportado: el bot dijo "no tenemos zapatillas en stock" en el
  // mismo tramo de la conversacion en que si mostro tarjetas reales.
  test('si el modelo afirma falta de stock sin respaldo, el sistema lo corrige antes de mandarlo', async () => {
    let vuelta = 0;
    const llamarInyectado = async () => {
      vuelta += 1;
      if (vuelta === 1) {
        return { content: 'Actualmente no tenemos zapatillas disponibles en stock.', tool_calls: [] };
      }
      if (vuelta === 2) {
        return { content: '', tool_calls: [{ id: 'call_1', name: 'mostrar_productos', arguments: { idsProductos: [productoId] } }] };
      }
      return { content: 'Aca tenes lo que encontramos.', tool_calls: [] };
    };

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Que tienen en calzado?', undefined, { llamarInyectado });

    assert.equal(salida.ok, true);
    assert.doesNotMatch(salida.respuesta.toLowerCase(), /no (tenemos|hay|contamos con)[^.?!]{0,40}(stock|disponible)/, 'la afirmacion falsa nunca debio llegar al cliente');
  });
});

describe('generarRespuesta - nunca afirma "ya esta en tu carrito" si el carrito sigue vacio', () => {
  // Bug real con capturas: el cliente dijo "estoy viendo la Park St 2.0"
  // (solo mirando, sin talla/color) y el bot respondio "ya la tienes en tu
  // carrito" en el mismo mensaje en el que recien preguntaba la talla -
  // agregar_al_carrito nunca se habia llamado con exito. Este test simula un
  // modelo que insiste con la afirmacion falsa en TODAS las vueltas (peor
  // caso) y confirma que el sistema nunca la deja pasar tal cual.
  test('si el modelo insiste con la afirmacion falsa, el sistema la corrige antes de mandarla', async () => {
    const llamarInyectado = async () => ({
      content: 'Ya la tienes en tu carrito. ¿Te gustaría ver algo más?',
      tool_calls: [],
    });

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Estoy viendo la Zapatilla de test', undefined, { llamarInyectado });

    assert.equal(salida.ok, true);
    assert.doesNotMatch(salida.respuesta, /ya (la|lo|los|las) tien[e]?s? en tu carrito/i);

    const cliente = await prisma.clienteFinal.findFirst({ where: { empresaId, telefono: TELEFONO } });
    const carrito = (cliente.contexto && cliente.contexto.carrito && cliente.contexto.carrito.items) || [];
    assert.equal(carrito.length, 0, 'el carrito real nunca debio tener nada: la afirmacion era falsa');
  });
});
