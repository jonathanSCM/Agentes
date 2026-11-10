// Proveedores y compras: stock, costo, caja, deuda, anulación, idempotencia, concurrencia y aislamiento por empresa.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const C = require('../lib/services/compras');
const caja = require('../lib/services/caja');
const stockSrv = require('../lib/services/stock');

const SLUGS = ['test-compras-a', 'test-compras-b'];
let A; let B; let dueno; let cajero; let remera; let talle; let tazaB; let prov;
const U = () => ({ id: dueno.id, rol: 'OWNER' });
const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.equal(e.codigo, 'COMPRA'); assert.match(e.message, patron); return true; });
const stockDe = async (id) => (await prisma.producto.findUnique({ where: { id } })).stock;
const efectivo = async () => (await caja.resumen((await caja.sesionAbierta(A.id)).id)).efectivoEsperadoCentavos;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: ['compras-a@test.local', 'compras-c@test.local'] } } });
  A = await prisma.empresa.create({ data: { nombre: 'Compras A', slug: SLUGS[0] } });
  B = await prisma.empresa.create({ data: { nombre: 'Compras B', slug: SLUGS[1] } });
  dueno = await prisma.usuario.create({ data: { empresaId: A.id, email: 'compras-a@test.local', nombre: 'Dueña', passwordHash: 'x', rol: 'OWNER' } });
  cajero = await prisma.usuario.create({ data: { empresaId: A.id, email: 'compras-c@test.local', nombre: 'Caja', passwordHash: 'x', rol: 'CAJERO' } });
  remera = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Remera', precio: 100, stock: 2 } });
  talle = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Jean', precio: 200, stock: 0 } });
  await prisma.variante.create({ data: { productoId: talle.id, atributos: { Talla: '42' }, stock: 0 } });
  tazaB = await prisma.producto.create({ data: { empresaId: B.id, nombre: 'Taza de otra empresa', precio: 10, stock: 5 } });
  prov = await C.crearProveedor(A.id, U(), { nombre: 'Textil Sur', telefono: '70000000' });
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: ['compras-a@test.local', 'compras-c@test.local'] } } });
});

describe('proveedores', () => {
  test('no se repite el nombre (sin importar mayúsculas) y se valida el correo', async () => {
    await rechaza(C.crearProveedor(A.id, U(), { nombre: 'textil sur' }), /Ya tenés/);
    await rechaza(C.crearProveedor(A.id, U(), { nombre: 'X' }), /nombre/);
    await rechaza(C.crearProveedor(A.id, U(), { nombre: 'Otro', email: 'mal' }), /correo/);
  });
  test('solo dueño o administrador', async () => {
    await rechaza(C.crearProveedor(A.id, { id: cajero.id, rol: 'CAJERO' }, { nombre: 'Nuevo' }), /dueño o un administrador/);
  });
  test('otra empresa no ve ni toca mis proveedores', async () => {
    assert.equal((await C.listarProveedores(B.id)).length, 0);
    await rechaza(C.actualizarProveedor(B.id, { id: 1, rol: 'OWNER' }, prov.id, { nombre: 'Robado' }), /no existe/);
  });
});

describe('registrar una compra', () => {
  test('suma el stock, deja el historial y actualiza el último costo', async () => {
    const { compra } = await C.crear(A.id, U(), { proveedorId: prov.id, referencia: 'F-100', pago: 'PENDIENTE', items: [{ productoId: remera.id, cantidad: 10, costo: '12.50' }] });
    assert.equal(compra.numero, 1);
    assert.equal(Number(compra.total), 125);
    assert.equal(compra.pagoEstado, 'PENDIENTE');
    assert.equal(await stockDe(remera.id), 12);
    assert.equal(Number((await prisma.producto.findUnique({ where: { id: remera.id } })).costo), 12.5);
    const mov = await prisma.movimientoStock.findFirst({ where: { empresaId: A.id, tipo: 'COMPRA', productoId: remera.id } });
    assert.equal(mov.cantidad, 10);
    assert.equal(mov.stockAntes, 2);
    assert.equal(mov.stockDespues, 12);
  });
  test('con opciones (talla) suma a la opción, no al producto', async () => {
    const v = await prisma.variante.findFirst({ where: { productoId: talle.id } });
    await C.crear(A.id, U(), { items: [{ productoId: talle.id, varianteId: v.id, cantidad: 4, costo: 80 }], pago: 'OTRO' });
    assert.equal((await prisma.variante.findUnique({ where: { id: v.id } })).stock, 4);
    assert.equal(Number((await prisma.variante.findUnique({ where: { id: v.id } })).costo), 80);
    assert.equal(await stockDe(talle.id), 0);
  });
  test('valida: cantidad, costo, líneas repetidas, vacío y producto de otra empresa', async () => {
    await rechaza(C.crear(A.id, U(), { items: [] }), /al menos un producto/);
    await rechaza(C.crear(A.id, U(), { items: [{ productoId: remera.id, cantidad: 0, costo: 1 }] }), /cantidad/);
    await rechaza(C.crear(A.id, U(), { items: [{ productoId: remera.id, cantidad: 1.5, costo: 1 }] }), /cantidad/);
    await rechaza(C.crear(A.id, U(), { items: [{ productoId: remera.id, cantidad: 1, costo: -3 }] }), /costo/);
    await rechaza(C.crear(A.id, U(), { items: [{ productoId: remera.id, cantidad: 1, costo: 'abc' }] }), /costo/);
    await rechaza(C.crear(A.id, U(), { items: [{ productoId: remera.id, cantidad: 1, costo: 1 }, { productoId: remera.id, cantidad: 2, costo: 1 }] }), /repetido/);
    await rechaza(C.crear(A.id, U(), { items: [{ productoId: tazaB.id, cantidad: 1, costo: 1 }] }), /ya no existe/);
    await rechaza(C.crear(A.id, U(), { proveedorId: 999999, items: [{ productoId: remera.id, cantidad: 1, costo: 1 }] }), /proveedor/);
    assert.equal(await stockDe(tazaB.id), 5, 'no tocó el stock de otra empresa');
  });
  test('si una línea falla no queda nada a medias', async () => {
    const antes = await stockDe(remera.id);
    await rechaza(C.crear(A.id, U(), { items: [{ productoId: remera.id, cantidad: 5, costo: 1 }, { productoId: tazaB.id, cantidad: 1, costo: 1 }] }), /ya no existe/);
    assert.equal(await stockDe(remera.id), antes);
  });
  test('un cajero no puede registrar compras', async () => {
    await rechaza(C.crear(A.id, { id: cajero.id, rol: 'CAJERO' }, { items: [{ productoId: remera.id, cantidad: 1, costo: 1 }] }), /dueño o un administrador/);
  });
  test('la misma clave no crea dos compras, ni con dos pedidos a la vez', async () => {
    const antes = await stockDe(remera.id);
    const datos = { claveIdempotencia: 'clave-1', pago: 'OTRO', items: [{ productoId: remera.id, cantidad: 3, costo: 5 }] };
    const rs = await Promise.all([C.crear(A.id, U(), datos), C.crear(A.id, U(), datos), C.crear(A.id, U(), datos)]);
    assert.equal(new Set(rs.map((r) => r.compra.id)).size, 1);
    assert.equal(rs.filter((r) => !r.repetida).length, 1);
    assert.equal(await stockDe(remera.id), antes + 3);
  });
  test('compras a la vez: números distintos y correlativos', async () => {
    const rs = await Promise.all([1, 2, 3, 4].map(() => C.crear(A.id, U(), { pago: 'OTRO', items: [{ productoId: remera.id, cantidad: 1, costo: 5 }] })));
    const nums = rs.map((r) => r.compra.numero).sort((a, b) => a - b);
    assert.equal(new Set(nums).size, 4);
    assert.equal(nums[3] - nums[0], 3);
  });
});

describe('pago y caja', () => {
  test('pagar de la caja exige caja abierta y efectivo suficiente', async () => {
    await rechaza(C.crear(A.id, U(), { pago: 'EFECTIVO_CAJA', items: [{ productoId: remera.id, cantidad: 1, costo: 5 }] }), /abrila/);
    await caja.abrir(A.id, dueno.id, 100);
    const antes = await stockDe(remera.id);
    await rechaza(C.crear(A.id, U(), { pago: 'EFECTIVO_CAJA', items: [{ productoId: remera.id, cantidad: 1, costo: 500 }] }), /No hay tanto efectivo/);
    assert.equal(await stockDe(remera.id), antes, 'sin efectivo no entra la mercadería');
  });
  test('pagar de la caja saca el efectivo; anular lo devuelve y baja el stock', async () => {
    const stock0 = await stockDe(remera.id); const e0 = await efectivo();
    const { compra } = await C.crear(A.id, U(), { pago: 'EFECTIVO_CAJA', items: [{ productoId: remera.id, cantidad: 4, costo: 10 }] });
    assert.equal(compra.pagoEstado, 'PAGADA');
    assert.equal(await efectivo(), e0 - 4000);
    assert.equal(await stockDe(remera.id), stock0 + 4);
    await C.anular(A.id, U(), compra.id, 'Se equivocó la cantidad');
    assert.equal(await efectivo(), e0);
    assert.equal(await stockDe(remera.id), stock0);
    assert.equal((await C.detalle(A.id, compra.id)).estado, 'ANULADA');
    await rechaza(C.anular(A.id, U(), compra.id, 'otra vez'), /ya estaba anulada/);
  });
  test('una compra por pagar se paga una sola vez (aunque se toque dos veces a la vez)', async () => {
    const { compra } = await C.crear(A.id, U(), { pago: 'PENDIENTE', items: [{ productoId: remera.id, cantidad: 1, costo: 20 }] });
    const e0 = await efectivo();
    const rs = await Promise.allSettled([C.pagar(A.id, U(), compra.id, 'EFECTIVO_CAJA'), C.pagar(A.id, U(), compra.id, 'EFECTIVO_CAJA')]);
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await efectivo(), e0 - 2000, 'salió una sola vez');
    await rechaza(C.pagar(A.id, U(), compra.id, 'OTRO'), /ya está pagada/);
    await rechaza(C.pagar(A.id, U(), compra.id, 'cualquiera'), /Elegí/);
  });
  test('anular una compra pagada de la caja con la caja cerrada se rechaza y no deja nada a medias', async () => {
    const { compra } = await C.crear(A.id, U(), { pago: 'EFECTIVO_CAJA', items: [{ productoId: remera.id, cantidad: 1, costo: 1 }] });
    const stock = await stockDe(remera.id);
    const sesion = await caja.sesionAbierta(A.id);
    await caja.cerrar(A.id, dueno.id, { efectivoContado: 0 });
    await rechaza(C.anular(A.id, U(), compra.id, 'prueba'), /Abrí la caja/);
    assert.equal((await C.detalle(A.id, compra.id)).estado, 'RECIBIDA', 'sigue recibida');
    assert.equal(await stockDe(remera.id), stock);
    await caja.abrir(A.id, dueno.id, 50);
    assert.ok(sesion);
  });
});

describe('anular', () => {
  test('si parte de la mercadería ya se vendió, no se puede anular', async () => {
    const p = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Gorra', precio: 30, stock: 0 } });
    const { compra } = await C.crear(A.id, U(), { pago: 'OTRO', items: [{ productoId: p.id, cantidad: 5, costo: 10 }] });
    await prisma.$transaction((tx) => stockSrv.descontar(tx, { empresaId: A.id, lineas: [{ productoId: p.id, cantidad: 3 }], tipo: 'VENTA' }));
    await rechaza(C.anular(A.id, U(), compra.id, 'prueba'), /ya salió parte/);
    assert.equal((await C.detalle(A.id, compra.id)).estado, 'RECIBIDA');
    assert.equal(await stockDe(p.id), 2);
  });
  test('exige motivo y solo dueño o administrador; otra empresa no puede', async () => {
    const { compra } = await C.crear(A.id, U(), { pago: 'OTRO', items: [{ productoId: remera.id, cantidad: 1, costo: 1 }] });
    await rechaza(C.anular(A.id, U(), compra.id, ''), /motivo/);
    await rechaza(C.anular(A.id, { id: cajero.id, rol: 'CAJERO' }, compra.id, 'xx yy'), /dueño o un administrador/);
    await rechaza(C.anular(B.id, { id: 1, rol: 'OWNER' }, compra.id, 'xx yy'), /no existe/);
  });
});

describe('consultas', () => {
  test('la deuda por proveedor y el total ignoran las anuladas y lo pagado', async () => {
    const antes = await C.totales(A.id);
    const { compra } = await C.crear(A.id, U(), { proveedorId: prov.id, pago: 'PENDIENTE', items: [{ productoId: remera.id, cantidad: 2, costo: 7.5 }] });
    let t = await C.totales(A.id);
    assert.equal(Math.round((t.deuda - antes.deuda) * 100), 1500);
    const lista = await C.listarProveedores(A.id);
    assert.ok(lista.find((x) => x.id === prov.id).deuda >= 15);
    await C.anular(A.id, U(), compra.id, 'prueba de deuda');
    t = await C.totales(A.id);
    assert.equal(Math.round((t.deuda - antes.deuda) * 100), 0);
  });
  test('la búsqueda incluye productos sin stock y no mezcla empresas', async () => {
    const r = await C.buscarMercaderia(A.id, 'jean');
    assert.equal(r.length, 1);
    assert.equal(r[0].stock, 4);
    assert.match(r[0].nombre, /Jean \(42\)/);
    assert.equal((await C.buscarMercaderia(A.id, 'Taza')).length, 0);
    assert.equal((await C.listar(B.id)).length, 0);
  });
});

describe('menú: proveedores y compras ya no están (el stock se maneja desde el catálogo)', () => {
  const { construirMenu } = require('../lib/services/menuPanel');
  const claves = (g) => g.flatMap((x) => x.items.map((i) => i.clave));
  test('ningún rol las ve en el menú, ni en negocios de productos ni de citas', () => {
    for (const rol of ['OWNER', 'ADMIN', 'STAFF', 'CAJERO']) {
      for (const esCitas of [false, true]) {
        const c = claves(construirMenu({ rol, esCitas, modulos: ['AGENTE', 'POS', 'PANEL'] }));
        assert.ok(!c.includes('proveedores') && !c.includes('compras-proveedor'), `${rol} ${esCitas}`);
      }
    }
  });
  test('el catálogo sí trae productos e inventario para manejar el stock', () => {
    const c = claves(construirMenu({ rol: 'OWNER', modulos: ['AGENTE', 'POS'] }));
    assert.ok(c.includes('productos') && c.includes('inventario'));
  });
});
