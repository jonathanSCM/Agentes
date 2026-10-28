// Flujo determinista (lib/services/flujoDeterminista.js): menus con listas,
// "¿algo mas?", edicion de carrito y cierre por plantillas y botones, SIN
// llamar a la IA. Se prueba contra la base real con una IA inyectada que
// CUENTA sus llamadas: si el flujo funciona, el contador queda en 0.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');
const { nombrePlausible } = require('../lib/services/flujoDeterminista');

const SLUG = 'test-flujo-determinista';
const TELEFONO = '000-test-flujo-det';

let empresaId;
let agenteId;
let conv;
let zapatillas = []; // con variantes
let rubroCalzado;
let subBotas;

function iaContada() {
  let llamadas = 0;
  const llamar = async () => { llamadas += 1; return { content: 'respuesta de la IA', tool_calls: [] }; };
  return { llamar, llamadas: () => llamadas };
}

async function turno(texto) {
  await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: texto } });
}
async function toque(id, titulo, ia) {
  await turno(titulo);
  return generarRespuesta(agenteId, TELEFONO, [], titulo, conv.id, { llamarInyectado: ia.llamar, idBoton: id });
}
async function escribe(texto, ia) {
  await turno(texto);
  return generarRespuesta(agenteId, TELEFONO, [], texto, conv.id, { llamarInyectado: ia.llamar });
}

const itemDe = (p, cantidad = 1) => ({
  productoId: p.id, varianteId: p.variantes[0].id, nombre: p.nombre, precio: Number(p.precio), cantidad, agregadoEn: new Date().toISOString(),
});

async function lead(datos = {}, items = []) {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  const { contexto = {}, ...resto } = datos;
  // Un cliente con algo en el carrito ya esta "en compra" (agregar_al_carrito
  // deja el estado y el favorito): sin eso el motor lo trataria como recien
  // llegado y le mandaria el menu de bienvenida por su cuenta.
  const enCompra = items.length ? { estadoConversacion: 'INTENCION_DE_COMPRA', productoFavoritoId: items[0].productoId } : {};
  return prisma.clienteFinal.create({
    data: {
      empresaId, telefono: TELEFONO, ...enCompra, ...resto,
      contexto: { ...contexto, ...(items.length ? { carrito: { conversacionId: null, items, actualizadoEn: new Date().toISOString() } } : {}) },
    },
  });
}
const leadActual = () => prisma.clienteFinal.findFirst({ where: { telefono: TELEFONO } });
const pasoDe = async () => ((await leadActual()).contexto || {}).flujo?.paso || null;

const CIERRE_COMPLETO = {
  nombre: 'Ana Pérez', tipoEntrega: 'DOMICILIO', direccionEntrega: 'Av 123', ubicacionLat: -17.767619, ubicacionLng: -63.181035,
};

before(async () => {
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Flujo Det', slug: SLUG, moneda: 'BOB',
      agentes: { create: [{ nombre: 'Vendedor', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, aceptaQr: true, flujoDeterminista: true, preguntasIniciales: [] } } }] },
    },
    include: { agentes: true },
  });
  empresaId = empresa.id;
  agenteId = empresa.agentes[0].id;
  conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TELEFONO, ultimoMensajeAt: new Date() } });

  const catZapas = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
  for (let n = 1; n <= 2; n += 1) {
    zapatillas.push(await prisma.producto.create({
      data: {
        empresaId, categoriaId: catZapas.id, nombre: `Zapatilla ${n}`, precio: 300 + n, stock: 0, atributos: {}, fotos: ['z.jpg'],
        variantes: { create: [{ atributos: { Talla: '42' }, stock: 5, fotos: [] }] },
      },
      include: { variantes: true },
    }));
  }
  rubroCalzado = await prisma.categoria.create({ data: { empresaId, nombre: 'Calzado', orden: 1 } });
  subBotas = await prisma.categoria.create({ data: { empresaId, nombre: 'Botas', padreId: rubroCalzado.id, orden: 1 } });
  const subSandalias = await prisma.categoria.create({ data: { empresaId, nombre: 'Sandalias', padreId: rubroCalzado.id, orden: 2 } });
  for (const [nombre, categoriaId] of [['Bota alta', subBotas.id], ['Sandalia playa', subSandalias.id]]) {
    await prisma.producto.create({ data: { empresaId, categoriaId, nombre, precio: 200, stock: 4, atributos: {}, fotos: ['f.jpg'] } });
  }
});

after(async () => {
  await prisma.pedido.deleteMany({ where: { empresaId } });
  await prisma.clienteFinal.deleteMany({ where: { telefono: TELEFONO } });
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

describe('nombrePlausible - el flujo no guarda basura como nombre', () => {
  test('rechaza lo que el cliente suele escribir cuando se le pregunta otra cosa', () => {
    for (const t of ['Ok', 'ok', 'Nada mas', 'Terminar', 'hola buenas tardes', 'No deseo ver mas', 'quiero agregar otra zapatilla', 'si', '12345', 'a', 'Ana 😊']) {
      assert.equal(nombrePlausible(t), false, `"${t}" no es un nombre`);
    }
  });
  test('acepta nombres reales', () => {
    for (const t of ['Ana', 'Ana Pérez', 'José Luis', 'María de los', "D'Angelo", 'Juan-Carlos Gómez']) {
      assert.equal(nombrePlausible(t), true, `"${t}" si es un nombre`);
    }
  });
  test('mas de 3 palabras no es un nombre', () => {
    assert.equal(nombrePlausible('Juan Carlos Pérez Gómez'), false);
  });
});

describe('flujo determinista: menus (0 llamadas a la IA)', () => {
  beforeEach(async () => { await lead({}, [itemDe(zapatillas[0])]); });

  test('tocar un rubro con tipos responde una LISTA de tipos, con texto de respaldo para el historial', async () => {
    const ia = iaContada();
    const r = await toque(`rubro:${rubroCalzado.id}`, 'Calzado', ia);
    assert.equal(ia.llamadas(), 0);
    assert.ok(r.lista, 'responde una lista');
    const filas = r.lista.secciones[0].filas;
    assert.deepEqual(filas.map((f) => f.titulo).sort(), ['Botas', 'Sandalias']);
    assert.ok(filas.every((f) => f.id.startsWith('sub:')));
    assert.match(r.textoRegistro, /1\. /, 'el historial conserva las opciones');
  });

  test('tocar un tipo manda la tarjeta de la categoria', async () => {
    const ia = iaContada();
    const r = await toque(`sub:${subBotas.id}`, 'Botas', ia);
    assert.equal(ia.llamadas(), 0);
    assert.match(r.respuesta, /vistazo/i);
  });

  test('"Seguir comprando" abre el menu de categorias como lista', async () => {
    const ia = iaContada();
    const r = await toque('mas:si', 'Seguir comprando', ia);
    assert.equal(ia.llamadas(), 0);
    assert.ok(r.lista);
    assert.ok(r.lista.secciones[0].filas.some((f) => f.titulo === 'Calzado'));
  });

  test('"Ver carrito" muestra lo que lleva, con botones', async () => {
    const ia = iaContada();
    const r = await toque('mas:ver', 'Ver carrito', ia);
    assert.equal(ia.llamadas(), 0);
    assert.match(r.respuesta, /Zapatilla 1/);
    assert.ok(r.botones.length >= 2);
  });
});

describe('flujo determinista: carrito', () => {
  test('➕ 1 se detiene en el stock disponible (valida lo acumulado)', async () => {
    await lead({}, [itemDe(zapatillas[0], 5)]);
    const ia = iaContada();
    const r = await toque(`cant:mas:${zapatillas[0].id}:${zapatillas[0].variantes[0].id}`, '➕ 1', ia);
    assert.equal(ia.llamadas(), 0);
    assert.match(r.respuesta, /No hay más stock: quedan 5/);
  });

  test('➕ 1, ➖ 1 y Quitar actualizan el carrito', async () => {
    await lead({}, [itemDe(zapatillas[0], 2)]);
    const ia = iaContada();
    const p = zapatillas[0];
    const id = (op) => `cant:${op}:${p.id}:${p.variantes[0].id}`;
    let r = await toque(id('mas'), '➕ 1', ia);
    assert.match(r.respuesta, /3/);
    r = await toque(id('menos'), '➖ 1', ia);
    assert.match(r.respuesta, /2/);
    r = await toque(id('quitar'), 'Quitar', ia);
    assert.match(r.respuesta, /vacío/);
    assert.equal(ia.llamadas(), 0);
  });

  test('regreso desde el catalogo web ("Quiero X"): responde la plantilla, sin IA, y consume la marca', async () => {
    const p = zapatillas[0];
    await lead({ contexto: { carritoWebPendiente: { productoId: p.id, varianteId: p.variantes[0].id, agregadoEn: new Date().toISOString() } } }, [itemDe(p)]);
    const ia = iaContada();
    const r = await escribe('Quiero *Zapatilla 1* (Talla: 42)', ia);
    assert.equal(ia.llamadas(), 0);
    assert.match(r.respuesta, /Buena elección/);
    assert.match(r.respuesta, /algo más/);
    assert.equal(r.botones.length, 3);
    assert.equal(((await leadActual()).contexto || {}).carritoWebPendiente, null);
  });
});

describe('flujo determinista: cierre del pedido', () => {
  test('"Finalizar" sin nombre pregunta el nombre', async () => {
    await lead({}, [itemDe(zapatillas[0])]);
    const ia = iaContada();
    const r = await toque('mas:no', 'Finalizar', ia);
    assert.equal(ia.llamadas(), 0);
    assert.match(r.respuesta, /nombre/i);
    assert.equal(await pasoDe(), 'NOMBRE');
  });

  test('un "Ok" o "Nada mas" en el paso NOMBRE NO se guarda como nombre', async () => {
    await lead({ contexto: { flujo: { paso: 'NOMBRE', ts: Date.now(), intentos: 0 } } }, [itemDe(zapatillas[0])]);
    const ia = iaContada();
    for (const basura of ['Ok', 'Nada mas']) {
      const r = await escribe(basura, ia);
      assert.match(r.respuesta, /Solo necesito tu nombre/);
      assert.equal((await leadActual()).nombre, null);
    }
    assert.equal(ia.llamadas(), 0);
  });

  test('tres intentos invalidos ceden a la IA', async () => {
    await lead({ contexto: { flujo: { paso: 'NOMBRE', ts: Date.now(), intentos: 0 } } }, [itemDe(zapatillas[0])]);
    const ia = iaContada();
    await escribe('Ok', ia);
    await escribe('Ok', ia);
    await escribe('Ok', ia);
    assert.ok(ia.llamadas() >= 1, 'al tercer intento fallido la IA toma el turno');
  });

  test('un nombre valido avanza: con domicilio pide la ubicacion con el boton nativo', async () => {
    await lead({ contexto: { flujo: { paso: 'NOMBRE', ts: Date.now(), intentos: 0 } } }, [itemDe(zapatillas[0])]);
    const ia = iaContada();
    const r = await escribe('Ana Pérez', ia);
    assert.equal(ia.llamadas(), 0);
    assert.equal((await leadActual()).nombre, 'Ana Pérez');
    assert.equal(r.solicitarUbicacion, true);
  });

  test('pregunta en medio del cierre: la IA responde (no se la trata como nombre)', async () => {
    await lead({ contexto: { flujo: { paso: 'NOMBRE', ts: Date.now(), intentos: 0 } } }, [itemDe(zapatillas[0])]);
    const ia = iaContada();
    await escribe('¿hacen envíos a Montero?', ia);
    assert.ok(ia.llamadas() >= 1);
    assert.equal((await leadActual()).nombre, null);
  });

  test('cierre completo a domicilio: forma de pago -> resumen -> Confirmar crea el pedido, sin ninguna llamada a la IA', async () => {
    await lead(CIERRE_COMPLETO, [itemDe(zapatillas[0]), itemDe(zapatillas[1], 2)]);
    const ia = iaContada();

    const resumen = await toque('pago:EFECTIVO', 'Efectivo', ia);
    assert.match(resumen.respuesta, /resumen de tu pedido/i);
    assert.ok(resumen.botones.some((b) => b.id === 'cierre:confirmar'));
    assert.equal(await prisma.pedido.count({ where: { empresaId } }), 0, 'todavia no se creo nada');

    const listo = await toque('cierre:confirmar', 'Confirmar ✅', ia);
    assert.match(listo.respuesta, /quedó registrado/);
    assert.equal(ia.llamadas(), 0);

    const pedido = await prisma.pedido.findFirst({ where: { empresaId }, include: { items: true } });
    assert.equal(pedido.items.length, 2);
    assert.equal((await leadActual()).contexto.carrito, null, 'el carrito se vacia al comprar');
  });

  test('un boton "Confirmar" viejo con el carrito ya cambiado NO crea el pedido: muestra el resumen nuevo', async () => {
    await lead({ ...CIERRE_COMPLETO, formaPago: 'EFECTIVO' }, [itemDe(zapatillas[0])]);
    await prisma.pedido.deleteMany({ where: { empresaId } });
    const ia = iaContada();

    await toque('mas:no', 'Finalizar', ia); // muestra el resumen del carrito actual
    const l = await leadActual();
    const items = [...l.contexto.carrito.items, itemDe(zapatillas[1])]; // el cliente cambia el carrito
    await prisma.clienteFinal.update({ where: { id: l.id }, data: { contexto: { ...l.contexto, carrito: { ...l.contexto.carrito, items } } } });

    const r = await toque('cierre:confirmar', 'Confirmar ✅', ia); // toca el boton viejo
    assert.equal(await prisma.pedido.count({ where: { empresaId } }), 0, 'no se creo ningun pedido');
    assert.match(r.respuesta, /resumen de tu pedido/i);
    assert.match(r.respuesta, /Zapatilla 2/, 'el resumen refleja el carrito nuevo');
  });
});

describe('con el flag APAGADO el comportamiento es el de siempre', () => {
  before(async () => { await prisma.agenteConfig.update({ where: { agenteId }, data: { flujoDeterminista: false } }); });
  after(async () => { await prisma.agenteConfig.update({ where: { agenteId }, data: { flujoDeterminista: true } }); });

  test('el mismo toque ("Finalizar") ya no lo atiende el flujo: sigue el camino de la IA', async () => {
    await lead({}, [itemDe(zapatillas[0])]);
    const ia = iaContada();
    const r = await toque('mas:no', 'Finalizar', ia);
    assert.equal(r.lista, undefined);
    assert.equal(await pasoDe(), null, 'el flujo no guardo ningun paso');
  });
});

describe('cierre con retiro en tienda', () => {
  before(async () => { await prisma.agenteConfig.update({ where: { agenteId }, data: { direccionTienda: 'Av. Tienda 123' } }); });
  after(async () => { await prisma.agenteConfig.update({ where: { agenteId }, data: { direccionTienda: null } }); });

  test('si la tienda tiene local ofrece las dos opciones, y con retiro NUNCA pide ubicacion', async () => {
    await lead({ nombre: 'Ana Pérez' }, [itemDe(zapatillas[0])]);
    await prisma.pedido.deleteMany({ where: { empresaId } });
    const ia = iaContada();

    const entrega = await toque('mas:no', 'Finalizar', ia);
    assert.deepEqual(entrega.botones.map((b) => b.id), ['cierre:domicilio', 'cierre:recojo']);

    const pago = await toque('cierre:recojo', 'Retiro en tienda', ia);
    assert.equal(pago.solicitarUbicacion, undefined, 'con retiro no se pide ubicacion');
    assert.ok(pago.botones.some((b) => b.id === 'pago:EFECTIVO'), 'pasa directo a la forma de pago');

    const resumen = await toque('pago:EFECTIVO', 'Efectivo', ia);
    assert.match(resumen.respuesta, /Retira en la tienda: Av\. Tienda 123/);

    const listo = await toque('cierre:confirmar', 'Confirmar ✅', ia);
    assert.match(listo.respuesta, /el retiro/);
    assert.equal(ia.llamadas(), 0);
    const pedido = await prisma.pedido.findFirst({ where: { empresaId } });
    assert.equal(pedido.tipoEntrega, 'RECOJO');
    assert.equal(pedido.direccionEntrega, null);
  });
});

describe('cierre con pago QR', () => {
  const wa = require('../lib/services/whatsapp');
  const enviarImagenOriginal = wa.enviarImagen;
  let enviadas;

  before(async () => {
    await prisma.conexionWhatsApp.deleteMany({ where: { agenteId } });
    await prisma.conexionWhatsApp.create({ data: { agenteId, estado: 'CONECTADO', phoneNumberId: 'TEST_PN_FLUJO_QR', tokenCifrado: 'x' } });
    wa.enviarImagen = async (conexion, para, url) => { enviadas.push({ para, url }); return { ok: true, id: 'wamid.QR' }; };
  });
  after(async () => {
    wa.enviarImagen = enviarImagenOriginal;
    await prisma.conexionWhatsApp.deleteMany({ where: { agenteId } });
    await prisma.agenteConfig.update({ where: { agenteId }, data: { qrCobroUrl: null } });
  });
  beforeEach(() => { enviadas = []; });

  test('al confirmar un pedido con QR se manda la imagen del QR y se le avisa al cliente', async () => {
    await prisma.agenteConfig.update({ where: { agenteId }, data: { qrCobroUrl: 'https://tienda.test/qr.jpg' } });
    await lead(CIERRE_COMPLETO, [itemDe(zapatillas[0])]);
    await prisma.pedido.deleteMany({ where: { empresaId } });
    const ia = iaContada();

    await toque('pago:QR', 'QR', ia);
    const listo = await toque('cierre:confirmar', 'Confirmar ✅', ia);

    assert.equal(ia.llamadas(), 0);
    assert.equal(enviadas.length, 1, 'se mando exactamente una imagen');
    assert.equal(enviadas[0].url, 'https://tienda.test/qr.jpg');
    assert.match(listo.respuesta, /Te envié el QR/);
  });

  test('si la tienda no cargo la imagen del QR, no se afirma que se mando: avisa que un asesor lo envia', async () => {
    await prisma.agenteConfig.update({ where: { agenteId }, data: { qrCobroUrl: null } });
    await lead(CIERRE_COMPLETO, [itemDe(zapatillas[0])]);
    await prisma.pedido.deleteMany({ where: { empresaId } });
    const ia = iaContada();

    await toque('pago:QR', 'QR', ia);
    const listo = await toque('cierre:confirmar', 'Confirmar ✅', ia);

    assert.equal(enviadas.length, 0);
    assert.doesNotMatch(listo.respuesta, /Te envié el QR/);
    assert.match(listo.respuesta, /asesor te va a enviar el QR/);
  });
});

describe('paginacion de categorias ("Ver más") con mas de 10 rubros', () => {
  const idsCreados = { categorias: [], productos: [] };

  before(async () => {
    for (let n = 1; n <= 12; n += 1) {
      const categoria = await prisma.categoria.create({ data: { empresaId, nombre: `Cat ${String(n).padStart(2, '0')}` } });
      const producto = await prisma.producto.create({
        data: { empresaId, categoriaId: categoria.id, nombre: `Producto paginado ${n}`, precio: 10, stock: 3, atributos: {}, fotos: [] },
      });
      idsCreados.categorias.push(categoria.id);
      idsCreados.productos.push(producto.id);
    }
  });
  after(async () => {
    await prisma.producto.deleteMany({ where: { id: { in: idsCreados.productos } } });
    await prisma.categoria.deleteMany({ where: { id: { in: idsCreados.categorias } } });
  });

  test('la primera pagina muestra 9 categorias + "Ver más", y la segunda las restantes (maximo 10 filas por lista)', async () => {
    await lead({}, [itemDe(zapatillas[0])]);
    const ia = iaContada();

    const p0 = await toque('menu:rubros', 'Otra categoría', ia);
    const filas0 = p0.lista.secciones[0].filas;
    assert.equal(filas0.length, 10);
    assert.equal(filas0[9].titulo, 'Ver más ▸');
    assert.equal(filas0[9].id, 'menu:pag:rubros:1');

    const p1 = await toque('menu:pag:rubros:1', 'Ver más ▸', ia);
    const filas1 = p1.lista.secciones[0].filas;
    assert.ok(filas1.length >= 1 && filas1.length <= 10);
    assert.ok(filas1.every((f) => f.titulo !== 'Ver más ▸'), 'la ultima pagina no ofrece mas');
    const todos = [...filas0.slice(0, 9), ...filas1].map((f) => f.titulo);
    assert.equal(new Set(todos).size, todos.length, 'ninguna categoria se repite entre paginas');
    assert.ok(todos.includes('Calzado') && todos.includes('Zapatillas') && todos.includes('Cat 12'), 'no se pierde ninguna');
    assert.equal(ia.llamadas(), 0);
  });
});

describe('rescate de la ultima vuelta (la IA falla en pleno cierre y el cliente pide una categoria)', () => {
  async function conIaQueFalla() {
    // con la forma de pago ya elegida (si no, el motor manda primero los botones de pago)
    await lead({ ...CIERRE_COMPLETO, formaPago: 'EFECTIVO' }, [itemDe(zapatillas[0])]);
    const vago = { content: 'aqui tienes la info, dale un vistazo', tool_calls: [] }; // afirma mostrar algo sin tarjeta
    return escribe('calzado', { llamar: async () => vago });
  }

  test('con el flag activo los tipos salen como LISTA de WhatsApp, no como texto numerado', async () => {
    const r = await conIaQueFalla();
    assert.ok(r.lista, 'responde una lista');
    assert.deepEqual(r.lista.secciones[0].filas.map((f) => f.titulo).sort(), ['Botas', 'Sandalias']);
    assert.doesNotMatch(r.respuesta, /^Dentro de "Calzado" tenemos:\n1\./);
  });

  test('con el flag apagado sigue saliendo el texto numerado de siempre', async () => {
    await prisma.agenteConfig.update({ where: { agenteId }, data: { flujoDeterminista: false } });
    try {
      const r = await conIaQueFalla();
      assert.equal(r.lista, undefined);
      assert.match(r.respuesta, /Dentro de "Calzado" tenemos:\n1\. /);
    } finally {
      await prisma.agenteConfig.update({ where: { agenteId }, data: { flujoDeterminista: true } });
    }
  });
});
