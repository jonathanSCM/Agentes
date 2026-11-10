// Cuentas (cita + extras): se arma, se cobra de una vez, no duplica, stock exacto, caja, aislamiento por empresa.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const Q = require('../lib/services/cuentas');
const caja = require('../lib/services/caja');
const ventas = require('../lib/services/ventas');

const SLUGS = ['test-cuentas-a', 'test-cuentas-b'];
let A; let B; let dueno; let corte; let tinte; let sinPrecio; let champu; let jean; let jeanV; let ana; let cli; let ajeno; let tazaB;
const U = () => ({ id: dueno.id, rol: 'OWNER' });
const rechaza = (p, patron) => assert.rejects(p, (e) => { assert.match(e.codigo, /CUENTA|VENTA/); assert.match(e.message, patron); return true; });
const stockDe = async (id) => (await prisma.producto.findUnique({ where: { id } })).stock;
const efectivo = async () => (await caja.resumen((await caja.sesionAbierta(A.id)).id)).efectivoEsperadoCentavos;
const manana = () => new Date(Date.now() + 86400000);
const nuevaCita = (extra = {}) => { const i = manana(); return prisma.cita.create({ data: { empresaId: A.id, clienteId: cli.id, servicioId: corte.id, recursoId: ana.id, inicio: i, fin: new Date(i.getTime() + 1800000), estado: 'CONFIRMADA', ...extra } }); };
const pagoEfectivo = (m) => [{ metodo: 'EFECTIVO', monto: m, recibido: m }];

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: 'cuentas@test.local' } });
  A = await prisma.empresa.create({ data: { nombre: 'Cuentas A', slug: SLUGS[0], modeloNegocio: 'CITAS', zonaHoraria: 'America/La_Paz' } });
  B = await prisma.empresa.create({ data: { nombre: 'Cuentas B', slug: SLUGS[1], modeloNegocio: 'CITAS' } });
  dueno = await prisma.usuario.create({ data: { empresaId: A.id, email: 'cuentas@test.local', nombre: 'Dueña', passwordHash: 'x', rol: 'OWNER' } });
  corte = await prisma.servicio.create({ data: { empresaId: A.id, nombre: 'Corte', precio: 60 } });
  tinte = await prisma.servicio.create({ data: { empresaId: A.id, nombre: 'Tinte', precio: 200 } });
  sinPrecio = await prisma.servicio.create({ data: { empresaId: A.id, nombre: 'Peinado a medida' } });
  ana = await prisma.recurso.create({ data: { empresaId: A.id, nombre: 'Ana' } });
  champu = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Shampoo', precio: 45, costo: 20, stock: 3 } });
  jean = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Peine', precio: 10, stock: 0 } });
  jeanV = await prisma.variante.create({ data: { productoId: jean.id, atributos: { Color: 'Negro' }, stock: 4 } });
  cli = await prisma.clienteFinal.create({ data: { empresaId: A.id, telefono: '59170005555', nombre: 'Lucía Pérez' } });
  ajeno = await prisma.clienteFinal.create({ data: { empresaId: B.id, telefono: '59170006666', nombre: 'Ajeno' } });
  tazaB = await prisma.producto.create({ data: { empresaId: B.id, nombre: 'Taza ajena', precio: 5, stock: 9 } });
  await caja.abrir(A.id, dueno.id, 100);
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: 'cuentas@test.local' } });
});

describe('abrir la cuenta de una cita', () => {
  test('trae el servicio de la cita con su precio y el nombre del cliente', async () => {
    const cita = await nuevaCita();
    const c = await Q.abrirDeCita(A.id, U(), cita.id);
    const d = await Q.detalle(A.id, c.id);
    assert.equal(d.clienteNombre, 'Lucía Pérez');
    assert.equal(d.items.length, 1);
    assert.deepEqual([d.items[0].nombre, Number(d.items[0].precioUnitario), d.items[0].tipo, d.items[0].recursoId], ['Corte', 60, 'SERVICIO', ana.id]);
    assert.equal(d.totalCentavos, 6000);
  });
  test('abrirla dos veces (o a la vez) devuelve la misma cuenta, sin duplicar', async () => {
    const cita = await nuevaCita();
    const rs = await Promise.all([1, 2, 3].map(() => Q.abrirDeCita(A.id, U(), cita.id)));
    assert.equal(new Set(rs.map((r) => r.id)).size, 1);
    assert.equal(await prisma.cuenta.count({ where: { citaId: cita.id } }), 1);
  });
  test('no se abre para citas canceladas, de otra empresa o inexistentes', async () => {
    const cancelada = await nuevaCita({ estado: 'CANCELADA' });
    await rechaza(Q.abrirDeCita(A.id, U(), cancelada.id), /cancelada/);
    await rechaza(Q.abrirDeCita(B.id, U(), (await nuevaCita()).id), /no existe/);
    await rechaza(Q.abrirDeCita(A.id, U(), 99999999), /no existe/);
  });
  test('una cuenta suelta pide el nombre; el cliente tiene que ser de la empresa', async () => {
    await rechaza(Q.abrirLibre(A.id, U(), { clienteNombre: '  ' }), /nombre/);
    await rechaza(Q.abrirLibre(A.id, U(), { clienteId: ajeno.id }), /no existe/);
    assert.equal((await Q.abrirLibre(A.id, U(), { clienteNombre: 'Pedro' })).clienteNombre, 'Pedro');
  });
  test('un servicio sin precio entra con precio libre (0) y se completa a mano', async () => {
    const cita = await nuevaCita({ servicioId: sinPrecio.id });
    const c = await Q.abrirDeCita(A.id, U(), cita.id);
    const it = (await Q.detalle(A.id, c.id)).items[0];
    assert.equal(it.precioLibre, true);
    await rechaza(Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(0) }), /total de la cuenta es 0/);
    await Q.ponerPrecio(A.id, U(), c.id, it.id, '85.50');
    assert.equal((await Q.detalle(A.id, c.id)).totalCentavos, 8550);
    await rechaza(Q.ponerPrecio(A.id, U(), c.id, it.id, -1), /número de 0 o más/);
  });
});

describe('armar la cuenta', () => {
  test('suma servicios y productos; el precio de catálogo que cambia después no mueve la cuenta', async () => {
    const c = await Q.abrirLibre(A.id, U(), { clienteNombre: 'Marta' });
    await Q.agregarServicio(A.id, U(), c.id, { servicioId: tinte.id, recursoId: ana.id });
    await Q.agregarServicio(A.id, U(), c.id, { servicioId: tinte.id, recursoId: ana.id });
    await Q.agregarProducto(A.id, U(), c.id, { productoId: champu.id, cantidad: 2 });
    await prisma.servicio.update({ where: { id: tinte.id }, data: { precio: 999 } });
    const d = await Q.detalle(A.id, c.id);
    assert.equal(d.items.length, 2, 'el mismo servicio se junta en una línea');
    assert.equal(d.totalCentavos, 2 * 20000 + 2 * 4500);
    await prisma.servicio.update({ where: { id: tinte.id }, data: { precio: 200 } });
  });
  test('productos: valida stock, opción obligatoria y empresa', async () => {
    const c = await Q.abrirLibre(A.id, U(), { clienteNombre: 'Rosa' });
    await rechaza(Q.agregarProducto(A.id, U(), c.id, { productoId: champu.id, cantidad: 4 }), /No hay stock/);
    await rechaza(Q.agregarProducto(A.id, U(), c.id, { productoId: jean.id }), /Elegí la opción/);
    await Q.agregarProducto(A.id, U(), c.id, { productoId: jean.id, varianteId: jeanV.id, cantidad: 2 });
    await rechaza(Q.agregarProducto(A.id, U(), c.id, { productoId: jean.id, varianteId: jeanV.id, cantidad: 3 }), /No hay stock/);
    await rechaza(Q.agregarProducto(A.id, U(), c.id, { productoId: tazaB.id }), /ya no está disponible/);
    await rechaza(Q.agregarServicio(A.id, U(), c.id, { servicioId: 999999 }), /no existe/);
    await rechaza(Q.agregarServicio(A.id, U(), c.id, { servicioId: corte.id, cantidad: 0 }), /entero/);
    await rechaza(Q.agregarServicio(A.id, U(), c.id, { servicioId: corte.id, cantidad: 1.5 }), /entero/);
    assert.equal(await stockDe(champu.id), 3, 'agregar a la cuenta no toca el stock');
  });
  test('cambiar cantidad, quitar y no poder tocar cuentas de otra empresa', async () => {
    const c = await Q.abrirLibre(A.id, U(), { clienteNombre: 'Leo' });
    const it = await Q.agregarServicio(A.id, U(), c.id, { servicioId: corte.id, cantidad: 2 });
    await Q.cambiarCantidad(A.id, U(), c.id, it.id, 3);
    assert.equal((await Q.detalle(A.id, c.id)).totalCentavos, 18000);
    await rechaza(Q.cambiarCantidad(B.id, { id: 1, rol: 'OWNER' }, c.id, it.id, 1), /no existe/);
    await Q.cambiarCantidad(A.id, U(), c.id, it.id, 0);
    assert.equal((await Q.detalle(A.id, c.id)).items.length, 0);
  });
});

describe('cobrar', () => {
  test('una venta con todo junto: servicios y productos, stock de productos, efectivo a la caja y cita completada', async () => {
    const cita = await nuevaCita();
    const c = await Q.abrirDeCita(A.id, U(), cita.id);
    await Q.agregarProducto(A.id, U(), c.id, { productoId: champu.id, cantidad: 2 });
    const e0 = await efectivo(); const s0 = await stockDe(champu.id);
    const { venta, repetida } = await Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(150), claveIdempotencia: 'cu-1' });
    assert.equal(repetida, false);
    assert.equal(Number(venta.total), 150);
    assert.deepEqual(venta.items.map((i) => [i.nombre, i.cantidad, i.servicioId === null ? 'p' : 's']).sort(), [['Corte', 1, 's'], ['Shampoo', 2, 'p']]);
    assert.equal(Number(venta.items.find((i) => i.nombre === 'Shampoo').costoUnitario), 20);
    assert.equal(await stockDe(champu.id), s0 - 2);
    assert.equal(await efectivo(), e0 + 15000);
    assert.equal((await prisma.cita.findUnique({ where: { id: cita.id } })).estado, 'COMPLETADA');
    const cu = await prisma.cuenta.findUnique({ where: { id: c.id } });
    assert.deepEqual([cu.estado, cu.ventaId], ['COBRADA', venta.id]);
    await rechaza(Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(150) }), /ya está cobrada/);
    await rechaza(Q.abrirDeCita(A.id, U(), cita.id), /ya fue cobrada/);
  });
  test('doble cobro con la misma clave o a la vez: una sola venta', async () => {
    const c = await Q.abrirLibre(A.id, U(), { clienteNombre: 'Doble' });
    await Q.agregarServicio(A.id, U(), c.id, { servicioId: corte.id });
    const rs = await Promise.allSettled([1, 2, 3].map(() => Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(60), claveIdempotencia: 'cu-doble' })));
    const ok = rs.filter((r) => r.status === 'fulfilled');
    assert.equal(new Set(ok.map((r) => r.value.venta.id)).size, 1);
    assert.equal(await prisma.venta.count({ where: { empresaId: A.id, claveIdempotencia: 'cu-doble' } }), 1);
  });
  test('sin caja abierta, con pagos que no suman o sin líneas: no se cobra y la cuenta sigue abierta', async () => {
    const c = await Q.abrirLibre(A.id, U(), { clienteNombre: 'Nada' });
    await rechaza(Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(10) }), /no tiene nada/);
    await Q.agregarServicio(A.id, U(), c.id, { servicioId: corte.id });
    await rechaza(Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(10) }), /./);
    assert.equal((await prisma.cuenta.findUnique({ where: { id: c.id } })).estado, 'ABIERTA');
    const sesion = await caja.sesionAbierta(A.id);
    await caja.cerrar(A.id, dueno.id, { efectivoContado: 0 });
    await rechaza(Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(60) }), /Abrí la caja/);
    assert.equal((await prisma.cuenta.findUnique({ where: { id: c.id } })).estado, 'ABIERTA');
    await caja.abrir(A.id, dueno.id, 100);
    assert.ok(sesion);
  });
  test('si el stock ya no alcanza al cobrar, no se cobra nada y la cuenta sigue abierta', async () => {
    const p = await prisma.producto.create({ data: { empresaId: A.id, nombre: 'Ultimo', precio: 10, stock: 1 } });
    const c = await Q.abrirLibre(A.id, U(), { clienteNombre: 'Carrera' });
    await Q.agregarProducto(A.id, U(), c.id, { productoId: p.id });
    await prisma.producto.update({ where: { id: p.id }, data: { stock: 0 } }); // se vendió en el mostrador mientras tanto
    const e0 = await efectivo();
    await rechaza(Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(10) }), /No hay stock/);
    assert.equal((await prisma.cuenta.findUnique({ where: { id: c.id } })).estado, 'ABIERTA');
    assert.equal(await efectivo(), e0);
    assert.equal(await prisma.venta.count({ where: { empresaId: A.id, clienteNombre: 'Carrera' } }), 0);
  });
  test('la venta de una cuenta se puede anular y devuelve el stock solo de los productos', async () => {
    const c = await Q.abrirLibre(A.id, U(), { clienteNombre: 'Anula' });
    await Q.agregarServicio(A.id, U(), c.id, { servicioId: corte.id });
    await Q.agregarProducto(A.id, U(), c.id, { productoId: champu.id, cantidad: 1 });
    const s0 = await stockDe(champu.id);
    const { venta } = await Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(105) });
    assert.equal(await stockDe(champu.id), s0 - 1);
    await ventas.anular(A.id, U(), venta.id, 'prueba de anulación');
    assert.equal(await stockDe(champu.id), s0);
  });
});

describe('cancelar y consultas', () => {
  test('cancelar libera la cita para abrir otra cuenta', async () => {
    const cita = await nuevaCita();
    const c = await Q.abrirDeCita(A.id, U(), cita.id);
    await Q.cancelar(A.id, U(), c.id, 'se fue');
    await rechaza(Q.cobrar(A.id, U(), c.id, { pagos: pagoEfectivo(60) }), /cancelada/);
    const otra = await Q.abrirDeCita(A.id, U(), cita.id);
    assert.notEqual(otra.id, c.id);
    await rechaza(Q.cancelar(B.id, { id: 1, rol: 'OWNER' }, otra.id, 'x'), /ya no está abierta/);
  });
  test('citas de hoy sin cuenta: solo cobrables, de la empresa y sin cuenta viva', async () => {
    const ahora = new Date(Date.now() - 600000);
    const fin = (d) => new Date(d.getTime() + 1800000);
    const hoyA = await prisma.cita.create({ data: { empresaId: A.id, clienteId: cli.id, servicioId: corte.id, inicio: ahora, fin: fin(ahora), estado: 'CONFIRMADA' } });
    const noVino = await prisma.cita.create({ data: { empresaId: A.id, clienteId: cli.id, servicioId: corte.id, inicio: ahora, fin: fin(ahora), estado: 'NO_ASISTIO' } });
    await prisma.cita.create({ data: { empresaId: B.id, clienteId: ajeno.id, inicio: ahora, fin: fin(ahora), estado: 'CONFIRMADA' } });
    const empresa = await prisma.empresa.findUnique({ where: { id: A.id } });
    let ids = (await Q.citasDeHoySinCuenta(empresa)).map((x) => x.id);
    assert.ok(ids.includes(hoyA.id));
    assert.ok(!ids.includes(noVino.id));
    await Q.abrirDeCita(A.id, U(), hoyA.id);
    ids = (await Q.citasDeHoySinCuenta(empresa)).map((x) => x.id);
    assert.ok(!ids.includes(hoyA.id));
    assert.equal((await Q.citasDeHoySinCuenta(await prisma.empresa.findUnique({ where: { id: B.id } }))).every((x) => x.id !== hoyA.id), true);
  });
});
