// POS pulido: cambio de producto (todo o nada, con diferencia) y ventas en espera.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const Caja = require('../lib/services/caja');
const Ventas = require('../lib/services/ventas');
const Espera = require('../lib/services/ventasEspera');
const Resumen = require('../lib/services/resumenComercial');

const SLUGS = ['test-cambio-a', 'test-cambio-b'];
let A; let B; let seq = 0;
const clave = () => `cx-${Date.now()}-${seq += 1}`;
const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.match(e.message, patron); return true; });
const stockDe = async (id) => (await prisma.producto.findUnique({ where: { id } })).stock;
const efectivo = (monto) => [{ metodo: 'EFECTIVO', monto }];

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug } });
  const cat = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'General' } });
  const dueno = await prisma.usuario.create({ data: { empresaId: e.id, email: `${slug}-dueno@test.local`, passwordHash: 'x', nombre: 'Dueña', rol: 'OWNER' } });
  const caj = await prisma.usuario.create({ data: { empresaId: e.id, email: `${slug}-caja@test.local`, passwordHash: 'x', nombre: 'Cajero', rol: 'CAJERO' } });
  return { empresaId: e.id, categoriaId: cat.id, dueno: { id: dueno.id, rol: 'OWNER' }, cajero: { id: caj.id, rol: 'CAJERO' } };
}
const producto = (ctx, nombre, precio, stock, extra = {}) => prisma.producto.create({ data: { empresaId: ctx.empresaId, categoriaId: ctx.categoriaId, nombre, precio, stock, ...extra } });
const abrirCaja = async (ctx, inicial = 0) => { await prisma.sesionCaja.updateMany({ where: { empresaId: ctx.empresaId, estado: 'ABIERTA' }, data: { estado: 'CERRADA', cerradaAt: new Date() } }); return Caja.abrir(ctx.empresaId, ctx.dueno.id, inicial); };
const vender = (ctx, lineas, pagos) => Ventas.crear(ctx.empresaId, ctx.dueno, { lineas, pagos, claveIdempotencia: clave() });
const esperado = async (ctx) => (await Caja.resumen((await Caja.sesionAbierta(ctx.empresaId)).id)).efectivoEsperadoCentavos;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: SLUGS.flatMap((s) => [`${s}-dueno@test.local`, `${s}-caja@test.local`]) } } });
  A = await empresa(SLUGS[0]);
  B = await empresa(SLUGS[1]);
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: SLUGS.flatMap((s) => [`${s}-dueno@test.local`, `${s}-caja@test.local`]) } } });
});

describe('cambio de producto', () => {
  test('mismo valor: no se cobra ni se devuelve nada; el stock se mueve y la venta nueva guarda su crédito', async () => {
    await abrirCaja(A, 100);
    const viejo = await producto(A, 'Camisa M', 100, 10); const nuevo = await producto(A, 'Camisa L', 100, 10);
    const { venta } = await vender(A, [{ productoId: viejo.id, cantidad: 1 }], efectivo(100));
    const antes = await esperado(A);
    const r = await Ventas.cambiar(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'talla equivocada', lineas: [{ productoId: nuevo.id, cantidad: 1 }], claveIdempotencia: clave() });
    assert.equal(Number(r.venta.total), 100);
    assert.equal(Number(r.venta.creditoCambio), 100);
    assert.equal(r.venta.cambioDeVentaId, venta.id);
    assert.equal(r.venta.pagos.length, 0, 'no hay nada que cobrar');
    assert.equal(r.devolucion.metodo, 'CAMBIO');
    assert.equal(await stockDe(viejo.id), 10, 'lo devuelto volvió al stock');
    assert.equal(await stockDe(nuevo.id), 9, 'lo nuevo salió');
    assert.equal(await esperado(A), antes, 'la caja no se movió');
  });

  test('lo nuevo vale más: el cliente paga la diferencia y la caja la suma', async () => {
    await abrirCaja(A, 0);
    const viejo = await producto(A, 'Gorra', 100, 5); const caro = await producto(A, 'Gorra premium', 150, 5);
    const { venta } = await vender(A, [{ productoId: viejo.id, cantidad: 1 }], [{ metodo: 'QR', monto: 100 }]);
    const antes = await esperado(A);
    await rechaza(Ventas.cambiar(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'prefiere la otra', lineas: [{ productoId: caro.id, cantidad: 1 }], pagos: efectivo(40) }), /Falta cobrar/);
    assert.equal(await stockDe(viejo.id), 4, 'un pago que no suma no cambia nada');
    const r = await Ventas.cambiar(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'prefiere la otra', lineas: [{ productoId: caro.id, cantidad: 1 }], pagos: efectivo(50), claveIdempotencia: clave() });
    assert.equal(Number(r.venta.total), 150);
    assert.equal(Number(r.venta.creditoCambio), 100);
    assert.equal(Number(r.venta.pagos[0].monto), 50);
    assert.equal(await esperado(A), antes + 5000, 'entran 50 en efectivo');
  });

  test('lo nuevo vale menos: la diferencia sale de la caja en efectivo (que no puede quedar en negativo)', async () => {
    await abrirCaja(A, 0);
    const viejo = await producto(A, 'Buzo', 100, 5); const barato = await producto(A, 'Medias', 60, 5);
    const { venta } = await vender(A, [{ productoId: viejo.id, cantidad: 1 }], efectivo(100));
    const antes = await esperado(A);
    const r = await Ventas.cambiar(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'mejor algo más barato', lineas: [{ productoId: barato.id, cantidad: 1 }], claveIdempotencia: clave() });
    assert.equal(r.aDevolver, 40);
    assert.equal(await esperado(A), antes - 4000, 'salen 40 de la caja');
    const mov = await prisma.movimientoCaja.findFirst({ where: { tipo: 'SALIDA', nota: { contains: 'Cambio de V-' } }, orderBy: { id: 'desc' } });
    assert.equal(Number(mov.monto), 40);
  });

  test('si la caja no tiene el efectivo para devolver la diferencia, no pasa nada (todo o nada)', async () => {
    await abrirCaja(A, 0);
    const viejo = await producto(A, 'Saco', 100, 5); const barato = await producto(A, 'Pañuelo', 10, 5);
    const { venta } = await vender(A, [{ productoId: viejo.id, cantidad: 1 }], [{ metodo: 'QR', monto: 100 }]); // pagó por QR: la caja no tiene efectivo
    await rechaza(Ventas.cambiar(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'mejor otro más barato', lineas: [{ productoId: barato.id, cantidad: 1 }] }), /en efectivo y en la caja hay/);
    assert.equal(await stockDe(viejo.id), 4, 'el producto devuelto no volvió al stock');
    assert.equal(await stockDe(barato.id), 5);
    assert.equal(await prisma.devolucion.count({ where: { ventaId: venta.id } }), 0);
  });

  test('si lo nuevo no tiene stock, se deshace TODO (no queda ni devolución ni stock repuesto)', async () => {
    await abrirCaja(A, 100);
    const viejo = await producto(A, 'Pantalón', 100, 5); const agotado = await producto(A, 'Pantalón raro', 100, 0);
    const { venta } = await vender(A, [{ productoId: viejo.id, cantidad: 1 }], efectivo(100));
    await rechaza(Ventas.cambiar(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'cambio de modelo', lineas: [{ productoId: agotado.id, cantidad: 1 }] }), /stock|no alcanza|disponible/i);
    assert.equal(await stockDe(viejo.id), 4);
    assert.equal(await prisma.devolucion.count({ where: { ventaId: venta.id } }), 0);
  });

  test('reglas: solo dueño/admin, motivo, nada que cobrar con pagos de más, un cambio no se anula y no se devuelve más de lo que pagó', async () => {
    await abrirCaja(A, 200);
    const a = await producto(A, 'Zapato', 100, 9); const b = await producto(A, 'Zapato B', 100, 9);
    const { venta } = await vender(A, [{ productoId: a.id, cantidad: 2 }], efectivo(200));
    const base = { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'cambio de numero', lineas: [{ productoId: b.id, cantidad: 1 }] };
    await rechaza(Ventas.cambiar(A.empresaId, A.cajero, venta.id, base), /Solo el dueño/);
    await rechaza(Ventas.cambiar(A.empresaId, A.dueno, venta.id, { ...base, motivo: 'x' }), /motivo/);
    await rechaza(Ventas.cambiar(A.empresaId, A.dueno, venta.id, { ...base, pagos: efectivo(10) }), /cubierto/);
    await rechaza(Ventas.cambiar(A.empresaId, A.dueno, venta.id, { ...base, lineas: [] }), /al menos un producto/i);
    const ok = await Ventas.cambiar(A.empresaId, A.dueno, venta.id, { ...base, claveIdempotencia: clave() });
    await rechaza(Ventas.anular(A.empresaId, A.dueno, ok.venta.id, 'quiero anular el cambio'), /es un cambio de producto/);
    // La venta del cambio se pagó con crédito: solo se le puede devolver lo que NO fue crédito (aquí, nada).
    await rechaza(Ventas.devolver(A.empresaId, A.dueno, ok.venta.id, { items: [{ ventaItemId: ok.venta.items[0].id, cantidad: 1 }], metodo: 'EFECTIVO', motivo: 'quiere la plata' }), /no tiene un monto|más de lo que pagó/);
  });

  test('tocar dos veces el cambio (misma clave) o dos a la vez: se hace una sola vez', async () => {
    await abrirCaja(A, 0);
    const a = await producto(A, 'Remera', 100, 9); const b = await producto(A, 'Remera B', 100, 9);
    const { venta } = await vender(A, [{ productoId: a.id, cantidad: 1 }], efectivo(100));
    const datos = (k) => ({ items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'doble toque', lineas: [{ productoId: b.id, cantidad: 1 }], claveIdempotencia: k });
    const k = clave();
    const rs = await Promise.allSettled([Ventas.cambiar(A.empresaId, A.dueno, venta.id, datos(k)), Ventas.cambiar(A.empresaId, A.dueno, venta.id, datos(k)), Ventas.cambiar(A.empresaId, A.dueno, venta.id, datos(clave()))]);
    assert.ok(rs.filter((x) => x.status === 'fulfilled').length >= 1);
    assert.equal(await prisma.devolucion.count({ where: { ventaId: venta.id } }), 1, 'la unidad se devuelve una sola vez');
    assert.equal(await stockDe(b.id), 8, 'solo salió una unidad nueva');
  });

  test('en el Resumen comercial el cambio cuenta por su diferencia, no el doble', async () => {
    await abrirCaja(A, 0);
    const a = await producto(A, 'Chaleco', 100, 9, { costo: 60 }); const b = await producto(A, 'Chaleco B', 130, 9, { costo: 70 });
    const antes = await Resumen.resumen(A.empresaId, 'hoy');
    const { venta } = await vender(A, [{ productoId: a.id, cantidad: 1 }], efectivo(100));
    await Ventas.cambiar(A.empresaId, A.dueno, venta.id, { items: [{ ventaItemId: venta.items[0].id, cantidad: 1 }], motivo: 'prefiere el otro', lineas: [{ productoId: b.id, cantidad: 1 }], pagos: efectivo(30), claveIdempotencia: clave() });
    const despues = await Resumen.resumen(A.empresaId, 'hoy');
    assert.equal(Math.round((despues.ingresos - antes.ingresos) * 100), 13000, 'a lo vendido se suma 130 (lo nuevo) y se resta 100 (lo devuelto) y +100 de la venta original = 130 neto');
    assert.equal(Math.round((despues.utilidad - antes.utilidad) * 100), 6000, 'utilidad del producto que se quedó: 130 − 70');
  });
});

describe('ventas en espera', () => {
  const lineas = (p, n = 1) => [{ productoId: p.id, cantidad: n }];

  test('se guarda sin tocar stock ni caja, se lista y al retomar vuelve con el precio y el stock de HOY', async () => {
    const p = await producto(A, 'Polera E', 50, 10);
    const stockAntes = await stockDe(p.id);
    const guardada = await Espera.guardar(A.empresaId, A.cajero, { lineas: lineas(p, 3), descuento: 5, etiqueta: 'Señora de rojo', clienteNombre: 'Ana' });
    assert.equal(await stockDe(p.id), stockAntes, 'no reserva stock');
    const lista = await Espera.listar(A.empresaId);
    assert.ok(lista.some((x) => x.id === guardada.id && x.etiqueta === 'Señora de rojo' && x.productos === 3 && x.por === 'Cajero'));
    await prisma.producto.update({ where: { id: p.id }, data: { precio: 60, stock: 2 } });
    const r = await Espera.retomar(A.empresaId, guardada.id);
    assert.equal(r.lineas[0].precio, 60, 'precio de hoy');
    assert.equal(r.lineas[0].cantidad, 2, 'ajustada al stock que queda');
    assert.match(r.avisos.join(' '), /solo quedan 2 \(tenías 3\)/);
    assert.equal(r.descuento, 5);
    assert.equal(r.clienteNombre, 'Ana');
    await rechaza(Espera.retomar(A.empresaId, guardada.id), /ya no está/, 'retomarla la borra');
  });

  test('los productos que ya no existen o no tienen stock se avisan y se sacan', async () => {
    const ok = await producto(A, 'Sigue', 10, 5); const agotado = await producto(A, 'Se agotó', 10, 5); const oculto = await producto(A, 'Se desactivó', 10, 5);
    const g = await Espera.guardar(A.empresaId, A.dueno, { lineas: [...lineas(ok), ...lineas(agotado), ...lineas(oculto)] });
    await prisma.producto.update({ where: { id: agotado.id }, data: { stock: 0 } });
    await prisma.producto.update({ where: { id: oculto.id }, data: { activo: false } });
    const r = await Espera.retomar(A.empresaId, g.id);
    assert.deepEqual(r.lineas.map((l) => l.nombre), ['Sigue']);
    assert.equal(r.avisos.length, 2);
  });

  test('dos cajeros retomando a la vez: solo uno se la lleva', async () => {
    const p = await producto(A, 'Carrera', 10, 5);
    const g = await Espera.guardar(A.empresaId, A.cajero, { lineas: lineas(p) });
    const rs = await Promise.allSettled([Espera.retomar(A.empresaId, g.id), Espera.retomar(A.empresaId, g.id), Espera.retomar(A.empresaId, g.id)]);
    assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
  });

  test('validaciones: sin productos, productos de otro negocio, cantidades locas y tope de 10', async () => {
    const mio = await producto(A, 'Mío', 10, 5); const ajeno = await producto(B, 'Ajeno', 10, 5);
    await rechaza(Espera.guardar(A.empresaId, A.cajero, { lineas: [] }), /nada para dejar/);
    await rechaza(Espera.guardar(A.empresaId, A.cajero, { lineas: lineas(ajeno) }), /no existe/);
    for (const mal of [0, -1, 1.5, 'x', 99999]) await rechaza(Espera.guardar(A.empresaId, A.cajero, { lineas: [{ productoId: mio.id, cantidad: mal }] }), /cantidades/);
    await prisma.ventaEspera.deleteMany({ where: { empresaId: A.empresaId } });
    for (let i = 0; i < Espera.MAX_EN_ESPERA; i++) await Espera.guardar(A.empresaId, A.cajero, { lineas: lineas(mio) });
    await rechaza(Espera.guardar(A.empresaId, A.cajero, { lineas: lineas(mio) }), /Ya hay 10 ventas en espera/);
    await prisma.ventaEspera.deleteMany({ where: { empresaId: A.empresaId } });
  });

  test('cada negocio ve y toca solo las suyas; las vencidas se limpian', async () => {
    const mio = await producto(A, 'Aislada', 10, 5);
    const g = await Espera.guardar(A.empresaId, A.cajero, { lineas: lineas(mio) });
    assert.equal((await Espera.listar(B.empresaId)).length, 0);
    await rechaza(Espera.retomar(B.empresaId, g.id), /ya no está/);
    await rechaza(Espera.eliminar(B.empresaId, g.id), /ya no está/);
    await prisma.ventaEspera.update({ where: { id: g.id }, data: { createdAt: new Date(Date.now() - 4 * 86400000) } });
    assert.equal((await Espera.listar(A.empresaId)).some((x) => x.id === g.id), false, 'venció a los 3 días');
  });
});
