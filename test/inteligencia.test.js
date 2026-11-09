// Inteligencia de negocio con datos reales: riesgo de clientes, panorama (reglas) y buscador de mensajes.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const I = require('../lib/services/inteligencia');

const DIA = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-11-10T15:00:00Z');
const hace = (dias) => new Date(AHORA.getTime() - dias * DIA);

describe('clasificarCliente (puro)', () => {
  test('compra cada ~10 días y lleva 35 sin comprar: riesgo alto', () => {
    const r = I.clasificarCliente([hace(75), hace(65), hace(55), hace(45), hace(35)], AHORA);
    assert.equal(r.riesgo, 'HIGH');
    assert.equal(r.cadaDias, 10);
    assert.equal(r.diasSinComprar, 35);
    assert.match(r.motivo, /cada 10 días y ya pasaron 35/);
  });

  test('escala según cuántas veces su ritmo habitual lleva sin comprar', () => {
    const base = (dias) => I.clasificarCliente([hace(dias + 60), hace(dias + 30), hace(dias)], AHORA); // cada 30 días
    assert.equal(base(20), null, 'va dentro de su ritmo');
    assert.equal(base(45).riesgo, 'LOW');
    assert.equal(base(65).riesgo, 'MEDIUM');
    assert.equal(base(95).riesgo, 'HIGH');
  });

  test('un cliente que compró una sola vez: solo alerta pasado un tiempo largo', () => {
    assert.equal(I.clasificarCliente([hace(20)], AHORA), null);
    assert.equal(I.clasificarCliente([hace(60)], AHORA).riesgo, 'MEDIUM');
    assert.equal(I.clasificarCliente([hace(150)], AHORA).riesgo, 'HIGH');
    assert.match(I.clasificarCliente([hace(150)], AHORA).motivo, /una sola vez hace 150 días/);
  });

  test('una devolución reciente sube la alerta a medio como mínimo y cambia la acción', () => {
    const r = I.clasificarCliente([hace(5), hace(15)], AHORA, { devolucionReciente: true });
    assert.equal(r.riesgo, 'MEDIUM');
    assert.match(r.motivo, /devolución reciente/);
    assert.match(r.accion, /conforme/);
    const alto = I.clasificarCliente([hace(200)], AHORA, { devolucionReciente: true });
    assert.equal(alto.riesgo, 'HIGH', 'si ya estaba en alto, la devolución no lo baja');
    assert.match(alto.motivo, /devolución reciente.*una sola vez/);
  });

  test('sin compras no hay nada que evaluar', () => {
    assert.equal(I.clasificarCliente([], AHORA), null);
  });

  test('mensaje sugerido: usa el nombre de pila y se adapta al motivo', () => {
    assert.match(I.mensajeSugerido({ nombre: 'Ana Rojas', motivo: 'Tuvo una devolución reciente', compras: 2 }, 'Tienda X'), /^Hola Ana, .*conforme/);
    assert.match(I.mensajeSugerido({ nombre: 'Cliente sin nombre', motivo: '', compras: 1 }, ''), /^Hola, ¿cómo te fue con tu compra/);
  });

  test('palabras de la búsqueda: sin tildes, sin palabras vacías, con raíz', () => {
    const p = I.palabrasDe('La talla CHICA y el envío, con descuentos');
    assert.deepEqual(p.map((x) => x.palabra), ['talla', 'chica', 'envio', 'descuentos']);
    assert.equal(p.find((x) => x.palabra === 'descuentos').raiz, 'descuent');
    assert.deepEqual(I.palabrasDe('a el de'), []);
  });
});

const SLUGS = ['test-intel-a', 'test-intel-b'];
let A; let B;

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug, agentes: { create: { nombre: 'Agente' } } }, include: { agentes: true } });
  const cat = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'Calzado' } });
  const cat2 = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'Ropa' } });
  return { empresaId: e.id, agenteId: e.agentes[0].id, categoriaId: cat.id, categoria2Id: cat2.id, numero: 0 };
}
const cliente = (ctx, nombre, telefono) => prisma.clienteFinal.create({ data: { empresaId: ctx.empresaId, nombre, telefono } });
const producto = (ctx, nombre, precio, categoriaId, stock = 20) => prisma.producto.create({ data: { empresaId: ctx.empresaId, categoriaId, nombre, precio, stock } });
const pedido = (ctx, { fecha, clienteId = null, estado = 'ENTREGADO', items }) => prisma.pedido.create({
  data: {
    empresaId: ctx.empresaId, clienteId, estado, createdAt: fecha, total: items.reduce((s, i) => s + i.precio * i.cantidad, 0),
    items: { create: items.map((i) => ({ productoId: i.productoId, nombre: i.nombre, precio: i.precio, cantidad: i.cantidad })) },
  },
});
let tokenSeq = 0;
async function venta(ctx, { fecha, clienteId = null, items }) {
  const total = items.reduce((s, i) => s + i.precio * i.cantidad, 0);
  ctx.numero += 1;
  return prisma.venta.create({
    data: {
      empresaId: ctx.empresaId, numero: ctx.numero, clienteId, subtotal: total, total, estado: 'COMPLETADA', tokenRecibo: `tok-intel-${Date.now()}-${tokenSeq += 1}`, createdAt: fecha,
      items: { create: items.map((i) => ({ productoId: i.productoId, nombre: i.nombre, cantidad: i.cantidad, precioUnitario: i.precio, total: i.precio * i.cantidad })) },
    },
    include: { items: true },
  });
}

describe('panorama y clientes en riesgo contra la base', () => {
  let zapato; let polera; let fiel; let unaVez; let reciente; let devolvio;
  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
    A = await empresa(SLUGS[0]);
    B = await empresa(SLUGS[1]);
    zapato = await producto(A, 'Zapatilla', 200, A.categoriaId, 3);
    polera = await producto(A, 'Polera', 50, A.categoria2Id);
    fiel = await cliente(A, 'Marcelo Rojas', '59170000001');
    unaVez = await cliente(A, 'Daniela Vargas', '59170000002');
    reciente = await cliente(A, 'Ivan Salazar', '59170000003');
    devolvio = await cliente(A, 'Fabiola Ríos', '59170000004');

    // Marcelo compraba cada 10 días y lleva 40 sin comprar → alto.
    for (const d of [80, 70, 60, 50, 40]) await pedido(A, { fecha: hace(d), clienteId: fiel.id, items: [{ productoId: polera.id, nombre: 'Polera', precio: 50, cantidad: 1 }] });
    // Daniela compró una sola vez hace 150 días → alto.
    await pedido(A, { fecha: hace(150), clienteId: unaVez.id, items: [{ productoId: polera.id, nombre: 'Polera', precio: 50, cantidad: 1 }] });
    // Ivan compró hace 3 días → no está en riesgo.
    await pedido(A, { fecha: hace(3), clienteId: reciente.id, items: [{ productoId: zapato.id, nombre: 'Zapatilla', precio: 200, cantidad: 1 }] });
    // Fabiola compró hace 12 días en el mostrador y devolvió → medio.
    const v = await venta(A, { fecha: hace(12), clienteId: devolvio.id, items: [{ productoId: zapato.id, nombre: 'Zapatilla', precio: 200, cantidad: 1 }] });
    await prisma.devolucion.create({ data: { empresaId: A.empresaId, ventaId: v.id, metodo: 'QR', monto: 200, motivo: 'no le quedó', createdAt: hace(10), items: { create: [{ ventaItemId: v.items[0].id, cantidad: 1, monto: 200 }] } } });
    // Pedidos cancelados y uno parado hace 5 días.
    await pedido(A, { fecha: hace(4), estado: 'CANCELADO', items: [{ productoId: polera.id, nombre: 'Polera', precio: 50, cantidad: 1 }] });
    await pedido(A, { fecha: hace(5), estado: 'NUEVO', items: [{ productoId: polera.id, nombre: 'Polera', precio: 50, cantidad: 1 }] });
    // Del periodo anterior (35-60 días atrás) para comparar el ticket.
    await pedido(A, { fecha: hace(40), items: [{ productoId: polera.id, nombre: 'Polera', precio: 50, cantidad: 1 }] });
    await pedido(A, { fecha: hace(45), items: [{ productoId: polera.id, nombre: 'Polera', precio: 50, cantidad: 1 }] });
    // Otra empresa: nada de esto debe verse.
    const ajeno = await cliente(B, 'Ajeno Perdido', '59170009999');
    const pb = await producto(B, 'Ajeno', 10, B.categoriaId);
    await pedido(B, { fecha: hace(300), clienteId: ajeno.id, items: [{ productoId: pb.id, nombre: 'Ajeno', precio: 10, cantidad: 1 }] });
  });
  test('lista solo a quienes están en riesgo, con su motivo real, ordenados por urgencia', async () => {
    const r = await I.clientesEnRiesgo(A.empresaId, { ahora: AHORA });
    const nombres = r.clientes.map((c) => c.nombre);
    assert.ok(nombres.includes('Marcelo Rojas') && nombres.includes('Daniela Vargas') && nombres.includes('Fabiola Ríos'));
    assert.ok(!nombres.includes('Ivan Salazar'), 'compró hace 3 días');
    assert.ok(!nombres.includes('Ajeno Perdido'), 'de otra empresa');
    assert.ok(r.clientes[0].riesgo === 'HIGH');
    const marcelo = r.clientes.find((c) => c.nombre === 'Marcelo Rojas');
    assert.equal(marcelo.compras, 5);
    assert.equal(marcelo.diasSinComprar, 40);
    assert.match(r.clientes.find((c) => c.nombre === 'Fabiola Ríos').motivo, /devolución reciente/);
    assert.equal(r.cuenta.HIGH, 2);
  });

  test('un pedido cobrado en el mostrador cuenta como una sola compra', async () => {
    const c = await cliente(A, 'Una Compra', '59170000010');
    const p = await pedido(A, { fecha: hace(100), clienteId: c.id, items: [{ productoId: polera.id, nombre: 'Polera', precio: 50, cantidad: 1 }] });
    await prisma.venta.create({ data: { empresaId: A.empresaId, numero: 900, clienteId: c.id, pedidoId: p.id, subtotal: 50, total: 50, estado: 'COMPLETADA', tokenRecibo: `tok-intel-unico-${Date.now()}`, createdAt: hace(100) } });
    const r = await I.clientesEnRiesgo(A.empresaId, { ahora: AHORA });
    assert.equal(r.clientes.find((x) => x.nombre === 'Una Compra').compras, 1);
  });

  test('el panorama sale de los datos: devoluciones, cancelados, categoría líder, ticket y riesgos', async () => {
    const d = await I.panorama(A.empresaId, { ahora: AHORA });
    assert.equal(d.hayDatos, true);
    assert.equal(d.kpis.tasaDevolucion.devuelto, 200);
    assert.equal(d.kpis.cancelados.cantidad, 1);
    assert.equal(d.kpis.cancelados.total, 3, 'pedidos de los últimos 30 días: el de Ivan, el cancelado y el parado');
    assert.equal(d.kpis.categoriaTop.nombre, 'Calzado');
    assert.equal(d.serieTicket.length, 6);
    assert.ok(d.riesgos.some((r) => /Zapatilla/.test(r) && /acabando/.test(r)), 'stock bajo en un producto de los más vendidos');
    assert.ok(d.riesgos.some((r) => /pedido.*más de 3 días/.test(r)), 'el pedido parado');
    assert.ok(d.riesgos.some((r) => /riesgo alto/.test(r)));
    assert.equal(d.acciones.length, d.riesgos.length, 'cada riesgo trae su acción');
  });

  test('una empresa sin ventas recientes recibe un estado vacío, no números inventados', async () => {
    const d = await I.panorama(B.empresaId, { ahora: AHORA });
    assert.equal(d.hayDatos, false, 'su único pedido es de hace 300 días');
    assert.equal(d.riesgos.length, 1, 'solo el cliente que lleva 300 días sin comprar; nada más se inventa');
    assert.match(d.riesgos[0], /riesgo alto/);
    assert.equal(d.kpis.tasaDevolucion.valor, null);
    assert.equal(d.kpis.categoriaTop, null);
    assert.ok(d.serieTicket.every((x) => x.ticket === null));
  });
});

describe('buscador de comentarios (mensajes reales)', () => {
  let conv;
  before(async () => {
    conv = await prisma.conversacion.create({ data: { agenteId: A.agenteId, telefonoCliente: '59170000001', ultimoMensajeAt: new Date() } });
    const convB = await prisma.conversacion.create({ data: { agenteId: B.agenteId, telefonoCliente: '59170009999', ultimoMensajeAt: new Date() } });
    const msg = (c, rol, contenido, dias = 2) => prisma.mensaje.create({ data: { conversacionId: c.id, rol, contenido, createdAt: new Date(Date.now() - dias * DIA) } });
    await msg(conv, 'CLIENTE', 'La talla me quedó chica, ¿tienen más grande?');
    await msg(conv, 'CLIENTE', 'Las TALLAS están mal marcadas y el envío demoró');
    await msg(conv, 'AGENTE', 'Sí, tenemos la talla más grande disponible.');
    await msg(conv, 'CLIENTE', 'Hola buenas tardes');
    await msg(conv, 'CLIENTE', 'Mensaje viejo sobre la talla', 400);
    await msg(convB, 'CLIENTE', 'La talla de otra empresa');
  });

  test('encuentra mensajes de clientes por palabra, sin tildes y con singular o plural', async () => {
    const { resultados } = await I.buscarComentarios(A.empresaId, 'talla');
    assert.equal(resultados.length, 2, 'dos mensajes del cliente (no el del agente, no el viejo, no el de otra empresa)');
    assert.ok(resultados.every((r) => /talla/i.test(r.contenido)));
    assert.equal(resultados[0].nombre, 'Marcelo Rojas');
  });

  test('con varias palabras, los que coinciden con más van primero', async () => {
    const { resultados } = await I.buscarComentarios(A.empresaId, 'talla envio demora');
    assert.match(resultados[0].contenido, /mal marcadas/);
    assert.equal(resultados[0].coincidencias, 3);
    assert.equal(resultados[1].coincidencias, 1);
  });

  test('tildes y mayúsculas no importan; una búsqueda vacía o de palabras vacías no devuelve nada', async () => {
    assert.equal((await I.buscarComentarios(A.empresaId, 'ENVÍO')).resultados.length, 1);
    assert.equal((await I.buscarComentarios(A.empresaId, 'a el de')).resultados.length, 0);
  });

  test('los caracteres especiales de la búsqueda no rompen la consulta ni actúan como comodines', async () => {
    for (const q of ["100%", "ta_lla", "talla'; DROP TABLE mensajes;--", '\\\\']) {
      await assert.doesNotReject(I.buscarComentarios(A.empresaId, q));
    }
    assert.equal((await I.buscarComentarios(A.empresaId, '%%%%')).resultados.length, 0);
    assert.equal(await prisma.mensaje.count({ where: { conversacionId: conv.id } }) > 0, true);
  });
});

after(async () => { await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } }); });
