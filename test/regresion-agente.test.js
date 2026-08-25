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

  // Se reusa el plan real "PRO" ya sembrado (prisma/seed.js) en vez de crear
  // uno nuevo: modeloParaPlan matchea por el codigo EXACTO "PRO" para elegir
  // gpt-4o (el modelo caro) en vez de caer directo en el economico - sin
  // esto no hay forma de probar el reintento por rate limit (el fallback y
  // el modelo original serian el mismo). El codigo es unico en la tabla, asi
  // que crear uno propio con el mismo codigo rompe el seed.
  const planPro = await prisma.plan.findUnique({ where: { codigo: 'PRO' } });

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Empresa de Test',
      slug: SLUG,
      suscripcion: planPro
        ? {
            create: {
              planId: planPro.id,
              estado: 'ACTIVA',
              periodoFin: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          }
        : undefined,
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

    // Nombra el producto puntual a proposito: sin nombre puntual y sin
    // categoria elegida, la regla de "el backend decide, no la IA" resuelve
    // el turno entero en codigo (nunca llega a invocar al proveedor), asi
    // que este test necesita el camino que SI la usa para poder simular la
    // falla del proveedor.
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Tienen la Zapatilla de test?', undefined, { llamarInyectado });

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

    // Nombra el producto puntual, mismo motivo que el test anterior: sin eso
    // el turno se resuelve entero en codigo (backend deterministico) y la
    // IA inyectada nunca se llega a invocar.
    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Tienen la Zapatilla de test?', undefined, { llamarInyectado });

    assert.equal(salida.ok, true);
    assert.equal(salida.error, undefined);
    assert.equal(salida.respuesta, 'Hola, en que te puedo ayudar?');
  });

  test('agente inexistente no rompe, responde con ok:false controlado', async () => {
    const salida = await generarRespuesta(999999999, TELEFONO, [], 'Hola', undefined, {});
    assert.equal(salida.ok, false);
  });

  test('si el proveedor devuelve 429 (rate limit), reintenta UNA vez con el modelo economico en vez de fallar el turno', async () => {
    let llamadas = 0;
    let modeloDelReintento = null;
    const llamarInyectado = async ({ modelo }) => {
      llamadas += 1;
      if (llamadas === 1) {
        // Simula exactamente el error real visto en produccion hoy: dos
        // conversaciones simultaneas saturaron el limite de tokens/minuto
        // de gpt-4o (429), y el cliente se quedaba sin respuesta.
        const err = new Error('Rate limit reached for gpt-4o on tokens per min (TPM)');
        err.status = 429;
        throw err;
      }
      if (llamadas === 2) modeloDelReintento = modelo;
      // Texto neutro a proposito: no debe disparar ninguno de los
      // detectores de "texto vago" (no nombra un producto, no lista nada,
      // no es una pregunta) para que el turno cierre en UNA sola vuelta y
      // el test pueda contar las llamadas con precision.
      return { content: 'Listo, avisame si necesitas algo mas.', tool_calls: [] };
    };

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Tienen la Zapatilla de test?', undefined, { llamarInyectado });

    assert.equal(llamadas, 2, 'debio reintentar exactamente una vez, sin gastar una vuelta extra del loop');
    // El reintento debe llegar con el modelo economico, no con el mismo que
    // acaba de fallar por saturacion.
    assert.equal(modeloDelReintento, 'gpt-4o-mini');
    assert.equal(salida.ok, true);
    assert.equal(salida.error, undefined, 'el turno no debe marcarse como error tecnico: el reintento salvo la respuesta');
    assert.equal(salida.respuesta, 'Listo, avisame si necesitas algo mas.');
  });

  test('si el proveedor devuelve un error que NO es 429, no reintenta y responde el error tecnico honesto', async () => {
    let llamadas = 0;
    const llamarInyectado = async () => {
      llamadas += 1;
      const err = new Error('Servicio no disponible');
      err.status = 500;
      throw err;
    };

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Tienen la Zapatilla de test?', undefined, { llamarInyectado });

    assert.equal(llamadas, 1, 'un error que no es de rate limit no debe reintentarse');
    assert.equal(salida.error, true);
    assert.match(salida.respuesta, /no pude consultar/i);
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

    // Nombra el producto puntual por su nombre a proposito: sin nombre
    // puntual, la regla de "solo tarjeta de categoria" (backend, no la IA)
    // resuelve el turno entero en codigo y nunca llega a invocar la IA -
    // este test verifica especificamente que el tool_calling con la IA
    // funciona de punta a punta, asi que necesita el camino que SI la usa.
    const historial = [{ rol: 'CLIENTE', contenido: 'Busco zapatillas' }];
    const salida = await generarRespuesta(agenteId, TELEFONO, historial, 'Tienen la Zapatilla de test?', undefined, { llamarInyectado });

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

describe('generarRespuesta - nunca manda el texto crudo de una tool call al cliente', () => {
  // Bug real reportado con capturas: en la ultima vuelta (sin tools
  // disponibles) el modelo escribio `mostrar_productos{"ids":[...]}` como
  // texto plano, con nombres de producto en vez de IDs reales, y eso le
  // llego tal cual al cliente por WhatsApp - ningun detector lo atajaba
  // porque todos exigen candidatosActuales.length, y en este caso no habia.
  test('si el modelo insiste con la sintaxis de tool call, el sistema no la deja pasar', async () => {
    const llamarInyectado = async () => ({
      content: '¡Perdón por eso! 🙈 Aquí te muestro algunas opciones de zapatillas que tenemos disponibles: mostrar_productos{"ids":["Zapatillas urbanas","Zapatillas para correr"]}',
      tool_calls: [],
    });

    const salida = await generarRespuesta(agenteId, TELEFONO, [], 'Hola', undefined, { llamarInyectado });

    assert.equal(salida.ok, true);
    assert.doesNotMatch(salida.respuesta, /mostrar_productos\s*[{(]/, 'el cliente nunca debe ver la sintaxis de la funcion');
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
