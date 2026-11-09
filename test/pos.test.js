// Punto de venta: caja, ventas, idempotencia, stock, anulación y recibo. Contra Postgres real.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const Caja = require('../lib/services/caja');
const Ventas = require('../lib/services/ventas');
const { aCentavos } = require('../lib/services/ventaCalculo');

const SLUGS = ['test-pos-a', 'test-pos-b'];
let A; let B; let cajero; let admin;

const rechaza = (promesa, codigo, patron) => assert.rejects(promesa, (e) => { assert.equal(e.codigo, codigo); assert.match(e.message, patron); return true; });
const producto = (ctx, nombre, precio, stock, extra = {}) => prisma.producto.create({ data: { empresaId: ctx.empresaId, categoriaId: ctx.categoriaId, nombre, precio, stock, ...extra }, include: { variantes: true } });
const stockDe = async (id) => (await prisma.producto.findUnique({ where: { id } })).stock;
const efectivo = (monto, recibido) => ({ metodo: 'EFECTIVO', monto, ...(recibido ? { recibido } : {}) });
const vender = (ctx, usuario, lineas, pagos, extra = {}) => Ventas.crear(ctx.empresaId, usuario, { lineas, pagos, ...extra });
let seq = 0;
const clave = () => `k-${Date.now()}-${seq += 1}`;

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug } });
  const cat = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'General' } });
  const dueno = await prisma.usuario.create({ data: { empresaId: e.id, email: `${slug}-dueno@test.local`, passwordHash: 'x', nombre: 'Dueña', rol: 'OWNER' } });
  const caj = await prisma.usuario.create({ data: { empresaId: e.id, email: `${slug}-caja@test.local`, passwordHash: 'x', nombre: 'Cajero', rol: 'CAJERO' } });
  return { empresaId: e.id, categoriaId: cat.id, dueno: { id: dueno.id, rol: 'OWNER' }, cajero: { id: caj.id, rol: 'CAJERO' } };
}

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  A = await empresa(SLUGS[0]);
  B = await empresa(SLUGS[1]);
  cajero = A.cajero; admin = A.dueno;
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: SLUGS.flatMap((s) => [`${s}-dueno@test.local`, `${s}-caja@test.local`]) } } });
});
beforeEach(async () => {
  // Cada prueba arranca sin caja abierta.
  await prisma.sesionCaja.updateMany({ where: { empresaId: { in: [A.empresaId, B.empresaId] }, estado: 'ABIERTA' }, data: { estado: 'CERRADA', cerradaAt: new Date() } });
});

describe('caja', () => {
  test('se abre con un efectivo inicial y no se puede abrir otra', async () => {
    const s = await Caja.abrir(A.empresaId, cajero.id, 100);
    assert.equal(Number(s.efectivoInicial), 100);
    assert.equal(s.estado, 'ABIERTA');
    await rechaza(Caja.abrir(A.empresaId, cajero.id, 0), 'CAJA', /Ya hay una caja abierta/);
  });

  test('cinco aperturas simultáneas: abre exactamente una', async () => {
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => Caja.abrir(A.empresaId, cajero.id, 50)));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await prisma.sesionCaja.count({ where: { empresaId: A.empresaId, estado: 'ABIERTA' } }), 1);
  });

  test('cada empresa tiene su propia caja', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 10);
    const s = await Caja.abrir(B.empresaId, B.cajero.id, 10);
    assert.equal(s.empresaId, B.empresaId);
  });

  test('valida el efectivo inicial', async () => {
    await rechaza(Caja.abrir(A.empresaId, cajero.id, -5), 'CAJA', /no es válido/);
    await rechaza(Caja.abrir(A.empresaId, cajero.id, 'abc'), 'CAJA', /no es válido/);
  });

  test('cierra con el conteo: esperado = inicial + cobros en efectivo (sin vuelto) + entradas - salidas', async () => {
    const p = await producto(A, 'Gaseosa', 25, 20);
    await Caja.abrir(A.empresaId, cajero.id, 100);
    await vender(A, cajero, [{ productoId: p.id, cantidad: 2 }], [efectivo(50, 100)]); // cobra 50, da 50 de vuelto
    await vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [{ metodo: 'QR', monto: 25 }]); // no es efectivo
    await Caja.registrarMovimiento(A.empresaId, cajero.id, { tipo: 'ENTRADA', monto: 20, nota: 'cambio extra' });
    await Caja.registrarMovimiento(A.empresaId, cajero.id, { tipo: 'SALIDA', monto: 10, nota: 'pago a proveedor' });
    const sesion = await Caja.sesionAbierta(A.empresaId);
    const r = await Caja.resumen(sesion.id);
    assert.equal(r.efectivoEsperadoCentavos, aCentavos(100 + 50 + 20 - 10));
    assert.equal(r.vendidoCentavos, aCentavos(75));
    assert.equal(r.porMetodoCentavos.QR, 2500);
    const c = await Caja.cerrar(A.empresaId, cajero.id, { efectivoContado: 150 });
    assert.equal(c.diferenciaCentavos, -1000, 'faltan 10');
    assert.equal(c.sesion.estado, 'CERRADA');
    assert.equal(Number(c.sesion.diferencia), -10);
    await rechaza(Caja.cerrar(A.empresaId, cajero.id, { efectivoContado: 150 }), 'CAJA', /No hay una caja abierta/);
  });

  test('una salida de efectivo no puede dejar la caja en negativo', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 20);
    await rechaza(Caja.registrarMovimiento(A.empresaId, cajero.id, { tipo: 'SALIDA', monto: 50, nota: 'demasiado' }), 'CAJA', /No hay tanto efectivo/);
    await rechaza(Caja.registrarMovimiento(A.empresaId, cajero.id, { tipo: 'ENTRADA', monto: 0, nota: 'cero' }), 'CAJA', /mayor a 0/);
    await rechaza(Caja.registrarMovimiento(A.empresaId, cajero.id, { tipo: 'ENTRADA', monto: 5, nota: '' }), 'CAJA', /motivo/);
  });
});

describe('cobrar una venta', () => {
  test('sin caja abierta no se vende', async () => {
    const p = await producto(A, 'Sin caja', 10, 5);
    await rechaza(vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(10)]), 'VENTA', /Abrí la caja/);
    assert.equal(await stockDe(p.id), 5);
  });

  test('el servidor usa los precios de la base: lo que mande el navegador se ignora', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Polera cara', 100, 10, { costo: 60 });
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 2, precioUnitario: 1, total: 2 }], [efectivo(200)]);
    assert.equal(Number(venta.total), 200);
    assert.equal(Number(venta.items[0].precioUnitario), 100);
    assert.equal(Number(venta.items[0].costoUnitario), 60, 'guarda el costo del momento');
    assert.equal(venta.cajeroId, cajero.id);
  });

  test('descuenta el stock con historial VENTA y la venta queda numerada y con recibo', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Medias', 10, 8);
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 3 }], [efectivo(30, 50)]);
    assert.equal(await stockDe(p.id), 5);
    const [m] = await prisma.movimientoStock.findMany({ where: { referenciaTipo: 'Venta', referenciaId: venta.id } });
    assert.equal(m.tipo, 'VENTA');
    assert.equal(m.cantidad, -3);
    assert.ok(venta.numero >= 1);
    assert.ok(venta.tokenRecibo.length >= 16);
    assert.equal(Number(venta.pagos[0].vuelto), 20);
  });

  test('con variantes: hay que elegir la opción, y el stock sale de esa opción', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Camisa', 50, 0, { variantes: { create: [{ atributos: { Talla: 'M' }, stock: 4, precio: 55 }, { atributos: { Talla: 'L' }, stock: 4 }] } });
    await rechaza(vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(50)]), 'VENTA', /Elegí la opción/);
    const m = p.variantes.find((v) => v.atributos.Talla === 'M');
    const { venta } = await vender(A, cajero, [{ productoId: p.id, varianteId: m.id, cantidad: 2 }], [efectivo(110)]);
    assert.equal(Number(venta.total), 110, 'usa el precio de la opción');
    assert.equal((await prisma.variante.findUnique({ where: { id: m.id } })).stock, 2);
  });

  test('descuentos y pagos mixtos', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Mixto', 40, 10);
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 2, descuento: 10 }], [efectivo(20, 50), { metodo: 'TARJETA', monto: 40 }], { descuento: 10 });
    assert.equal(Number(venta.subtotal), 80);
    assert.equal(Number(venta.descuento), 20);
    assert.equal(Number(venta.total), 60);
    assert.equal(venta.pagos.length, 2);
  });

  test('pagos que no suman el total, producto de otra empresa o inactivo: se rechaza y no cambia nada', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Control', 10, 5);
    const ajeno = await producto(B, 'De B', 10, 5);
    const inactivo = await producto(A, 'Inactivo', 10, 5, { activo: false });
    const antes = await prisma.venta.count({ where: { empresaId: A.empresaId } });
    await rechaza(vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(9)]), 'VENTA', /Falta cobrar/);
    await rechaza(vender(A, cajero, [{ productoId: ajeno.id, cantidad: 1 }], [efectivo(10)]), 'VENTA', /ya no está disponible/);
    await rechaza(vender(A, cajero, [{ productoId: inactivo.id, cantidad: 1 }], [efectivo(10)]), 'VENTA', /ya no está disponible/);
    assert.equal(await prisma.venta.count({ where: { empresaId: A.empresaId } }), antes);
    assert.equal(await stockDe(p.id), 5);
    assert.equal(await stockDe(ajeno.id), 5);
  });

  test('sin stock suficiente: no se crea la venta (se deshace todo)', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Escaso', 10, 2);
    const otro = await producto(A, 'Otro', 10, 9);
    const antes = await prisma.venta.count({ where: { empresaId: A.empresaId } });
    await assert.rejects(vender(A, cajero, [{ productoId: otro.id, cantidad: 1 }, { productoId: p.id, cantidad: 3 }], [efectivo(40)]), (e) => { assert.equal(e.codigo, 'STOCK'); return true; });
    assert.equal(await prisma.venta.count({ where: { empresaId: A.empresaId } }), antes);
    assert.equal(await stockDe(otro.id), 9, 'la línea anterior también se deshizo');
  });

  test('el stock no se vende dos veces: 12 cobros simultáneos por 5 unidades', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Ultimas cinco', 10, 5);
    const r = await Promise.allSettled(Array.from({ length: 12 }, () => vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(10)], { claveIdempotencia: clave() })));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 5);
    assert.equal(await stockDe(p.id), 0);
    assert.equal(await prisma.movimientoStock.count({ where: { productoId: p.id, tipo: 'VENTA' } }), 5);
  });

  test('numeración correlativa sin repetidos ni saltos aunque se cobre en paralelo', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Numerada', 1, 100);
    const antes = await prisma.venta.aggregate({ where: { empresaId: A.empresaId }, _max: { numero: true } });
    const base = antes._max.numero || 0;
    const r = await Promise.all(Array.from({ length: 10 }, () => vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(1)])));
    const numeros = r.map((x) => x.venta.numero).sort((a, b) => a - b);
    assert.deepEqual(numeros, Array.from({ length: 10 }, (_, i) => base + i + 1));
  });
});

describe('idempotencia (doble clic y reintentos)', () => {
  test('la misma clave devuelve la misma venta y no vuelve a descontar', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Idem', 10, 10);
    const k = clave();
    const uno = await vender(A, cajero, [{ productoId: p.id, cantidad: 2 }], [efectivo(20)], { claveIdempotencia: k });
    const dos = await vender(A, cajero, [{ productoId: p.id, cantidad: 2 }], [efectivo(20)], { claveIdempotencia: k });
    assert.equal(uno.repetida, false);
    assert.equal(dos.repetida, true);
    assert.equal(uno.venta.id, dos.venta.id);
    assert.equal(await stockDe(p.id), 8);
  });

  test('cinco envíos simultáneos con la misma clave: una sola venta y el stock baja una vez', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Idem paralelo', 10, 10);
    const k = clave();
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(10)], { claveIdempotencia: k })));
    assert.ok(r.every((x) => x.status === 'fulfilled'), 'ninguno falla: los repetidos devuelven la misma venta');
    assert.equal(new Set(r.map((x) => x.value.venta.id)).size, 1);
    assert.equal(await stockDe(p.id), 9);
    assert.equal(await prisma.venta.count({ where: { empresaId: A.empresaId, claveIdempotencia: k } }), 1);
  });

  test('la misma clave en OTRA empresa no choca', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    await Caja.abrir(B.empresaId, B.cajero.id, 0);
    const pa = await producto(A, 'Pa', 10, 5);
    const pb = await producto(B, 'Pb', 10, 5);
    const k = clave();
    const a = await vender(A, cajero, [{ productoId: pa.id, cantidad: 1 }], [efectivo(10)], { claveIdempotencia: k });
    const b = await vender(B, B.cajero, [{ productoId: pb.id, cantidad: 1 }], [efectivo(10)], { claveIdempotencia: k });
    assert.notEqual(a.venta.id, b.venta.id);
  });
});

describe('anular', () => {
  test('solo dueño/admin; devuelve el stock y deja el historial; la venta anulada no cuenta en la caja', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 100);
    const p = await producto(A, 'A anular', 10, 10);
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 4 }], [efectivo(40)]);
    await rechaza(Ventas.anular(A.empresaId, cajero, venta.id, 'error de cobro'), 'VENTA', /Solo el dueño o un administrador/);
    await rechaza(Ventas.anular(A.empresaId, admin, venta.id, 'x'), 'VENTA', /motivo/);
    const anulada = await Ventas.anular(A.empresaId, admin, venta.id, 'El cliente se arrepintió');
    assert.equal(anulada.estado, 'ANULADA');
    assert.equal(await stockDe(p.id), 10);
    const m = await prisma.movimientoStock.findFirst({ where: { referenciaTipo: 'Venta', referenciaId: venta.id, tipo: 'ANULACION_VENTA' } });
    assert.equal(m.cantidad, 4);
    const r = await Caja.resumen((await Caja.sesionAbierta(A.empresaId)).id);
    assert.equal(r.efectivoEsperadoCentavos, 10000, 'solo queda el efectivo inicial');
    assert.equal(r.cantidadVentas, 0);
  });

  test('dos anulaciones simultáneas devuelven el stock UNA sola vez', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Doble anular', 10, 10);
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 3 }], [efectivo(30)]);
    const r = await Promise.allSettled([Ventas.anular(A.empresaId, admin, venta.id, 'duplicado A'), Ventas.anular(A.empresaId, admin, venta.id, 'duplicado B')]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await stockDe(p.id), 10);
    assert.equal(await prisma.movimientoStock.count({ where: { productoId: p.id, tipo: 'ANULACION_VENTA' } }), 1);
  });

  test('con la caja de esa venta ya cerrada no se puede anular', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Caja cerrada', 10, 10);
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(10)]);
    await Caja.cerrar(A.empresaId, cajero.id, { efectivoContado: 10 });
    await rechaza(Ventas.anular(A.empresaId, admin, venta.id, 'tarde para anular'), 'VENTA', /ya está cerrada/);
    assert.equal(await stockDe(p.id), 9);
  });

  test('una empresa no puede anular ni ver ventas de otra', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Aislada', 10, 10);
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 1 }], [efectivo(10)]);
    await rechaza(Ventas.anular(B.empresaId, B.dueno, venta.id, 'intento ajeno'), 'VENTA', /no existe/);
    assert.equal(await Ventas.detalle(B.empresaId, venta.id), null);
    assert.ok(!(await Ventas.listar(B.empresaId)).some((v) => v.id === venta.id));
  });
});

describe('recibo público', () => {
  test('se abre solo con el token, trae los datos del negocio y rechaza tokens inválidos', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const p = await producto(A, 'Recibo', 12.5, 10);
    const { venta } = await vender(A, cajero, [{ productoId: p.id, cantidad: 2 }], [efectivo(25, 30)], { clienteNombre: 'Ana' });
    const r = await Ventas.reciboPorToken(venta.tokenRecibo);
    assert.equal(r.venta.id, venta.id);
    assert.equal(r.empresa.nombre, SLUGS[0]);
    assert.equal(r.venta.clienteNombre, 'Ana');
    assert.equal(await Ventas.reciboPorToken('x'), null);
    assert.equal(await Ventas.reciboPorToken('a'.repeat(22)), null);
    assert.equal(await Ventas.reciboPorToken(undefined), null);
  });
});

describe('red de seguridad de la base', () => {
  test('un descuento mayor al subtotal o un pago en 0 los rechaza la base aunque falle el código', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const s = await Caja.sesionAbierta(A.empresaId);
    await assert.rejects(prisma.$executeRaw`INSERT INTO "ventas" ("empresaId","numero","sesionCajaId","subtotal","descuento","total","tokenRecibo") VALUES (${A.empresaId}, 999990, ${s.id}, 10, 20, 0, 'tokenmalo0000000000000')`, /ventas_montos_check|check/i);
    const v = await prisma.venta.findFirst({ where: { empresaId: A.empresaId } });
    if (v) await assert.rejects(prisma.$executeRaw`INSERT INTO "venta_pagos" ("ventaId","metodo","monto") VALUES (${v.id}, 'QR', 0)`, /venta_pagos_monto_check|check/i);
  });
});
