// Núcleo de créditos: tarifario con vigencia, lotes, cobro atómico e idempotente, orden de consumo, devoluciones, vencimiento y cuadre del libro.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const C = require('../lib/services/creditos');

const SLUG = 'test-creditos';
let empresa;
const dia = 24 * 60 * 60 * 1000;

async function nueva() {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  empresa = await prisma.empresa.create({ data: { nombre: 'Tienda Créditos', slug: SLUG } });
}
const limpiar = async () => {
  await prisma.creditoMovimiento.deleteMany({ where: { empresaId: empresa.id } });
  await prisma.creditoLote.deleteMany({ where: { empresaId: empresa.id } });
};
const saldo = async () => (await C.saldo(empresa.id)).total;

before(nueva);
after(async () => { await prisma.empresa.delete({ where: { id: empresa.id } }).catch(() => {}); });

describe('tarifario', () => {
  test('viene con los precios iniciales y cambiar un precio no altera el pasado', async () => {
    assert.equal(await C.precio('CONVERSACION_NUEVA'), 5);
    assert.equal(await C.precio('TURNO_IA'), 1);
    assert.equal(await C.precio('PLANTILLA_SALIENTE'), 2);
    const antes = new Date(Date.now() - dia);
    const desde = new Date(Date.now() - 1000);
    await C.cambiarPrecio({ accion: 'PLANTILLA_SALIENTE', creditos: 3, desde, nota: 'test' });
    try {
      assert.equal(await C.precio('PLANTILLA_SALIENTE'), 3, 'hoy rige el nuevo');
      assert.equal(await C.precio('PLANTILLA_SALIENTE', antes), 2, 'el pasado conserva su precio');
    } finally {
      await prisma.accionCredito.deleteMany({ where: { accion: 'PLANTILLA_SALIENTE', nota: 'test' } });
      await prisma.accionCredito.updateMany({ where: { accion: 'PLANTILLA_SALIENTE' }, data: { vigenteHasta: null } });
    }
    assert.equal(await C.precio('PLANTILLA_SALIENTE'), 2);
  });
  test('rechaza precios inválidos y acciones que no existen', async () => {
    await assert.rejects(() => C.cambiarPrecio({ accion: 'TURNO_IA', creditos: -1 }), /entero/);
    await assert.rejects(() => C.cambiarPrecio({ accion: 'INVENTADA', creditos: 1 }), /no existe/);
  });
});

describe('otorgar', () => {
  test('crea un lote y su movimiento, y es idempotente por clave', async () => {
    await limpiar();
    const a = await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 100, clave: 'plan:1', vence: new Date(Date.now() + 30 * dia) });
    const b = await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 100, clave: 'plan:1' });
    assert.equal(a.repetido, false); assert.equal(b.repetido, true);
    assert.equal(await saldo(), 100);
    assert.equal(await prisma.creditoLote.count({ where: { empresaId: empresa.id } }), 1);
  });
  test('rechaza cantidades inválidas y orígenes desconocidos', async () => {
    await assert.rejects(() => C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 0, clave: 'x' }), /entero positivo/);
    await assert.rejects(() => C.otorgar({ empresaId: empresa.id, origen: 'REGALO', cantidad: 5, clave: 'x' }), /Origen/);
  });
});

describe('consumir', () => {
  test('descuenta con el precio del tarifario, guarda precio aplicado y saldo después', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 20, clave: 'p', vence: new Date(Date.now() + 30 * dia) });
    const r = await C.consumir({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: 'c1', referencia: 'conv:1' });
    assert.deepEqual([r.ok, r.cantidad, r.saldo], [true, 5, 15]);
    const m = await prisma.creditoMovimiento.findFirst({ where: { claveIdempotencia: 'c1' } });
    assert.equal(m.cantidad, -5); assert.equal(m.precioAplicado, 5); assert.equal(m.saldoDespues, 15); assert.equal(m.accion, 'CONVERSACION_NUEVA');
  });
  test('repetir la misma clave no vuelve a cobrar', async () => {
    const antes = await saldo();
    const r = await C.consumir({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: 'c1' });
    assert.equal(r.repetido, true);
    assert.equal(await saldo(), antes);
  });
  test('sin saldo suficiente no descuenta nada (ni parcial)', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 3, clave: 'p', vence: new Date(Date.now() + dia) });
    const r = await C.consumir({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: 'c2' });
    assert.deepEqual([r.ok, r.motivo], [false, 'SIN_SALDO']);
    assert.equal(await saldo(), 3);
    assert.equal(await prisma.creditoMovimiento.count({ where: { claveIdempotencia: 'c2' } }), 0);
  });
  test('consume primero el lote que vence antes y puede repartir un cobro entre dos lotes', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'COMPRA', cantidad: 50, clave: 'compra', vence: new Date(Date.now() + 300 * dia) });
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 3, clave: 'plan', vence: new Date(Date.now() + 10 * dia) });
    const r = await C.consumir({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: 'mix' });
    assert.equal(r.ok, true);
    const movs = await prisma.creditoMovimiento.findMany({ where: { claveIdempotencia: 'mix' }, include: { lote: true }, orderBy: { id: 'asc' } });
    assert.deepEqual(movs.map((m) => [m.lote.origen, m.cantidad]), [['PLAN', -3], ['COMPRA', -2]]);
    assert.equal(await saldo(), 48);
    assert.equal((await C.verificarCuadre(empresa.id)).ok, true);
  });
  test('cobros simultáneos nunca superan el saldo', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 12, clave: 'p', vence: new Date(Date.now() + dia) });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => C.consumir({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: `par${i}` })));
    assert.equal(rs.filter((r) => r.ok).length, 2, '12 créditos alcanzan para 2 cobros de 5');
    assert.equal(await saldo(), 2);
    assert.equal((await C.verificarCuadre(empresa.id)).ok, true);
  });
  test('la misma clave en paralelo cobra una sola vez', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 50, clave: 'p', vence: new Date(Date.now() + dia) });
    await Promise.all(Array.from({ length: 5 }, () => C.consumir({ empresaId: empresa.id, accion: 'TURNO_IA', clave: 'misma' })));
    assert.equal(await saldo(), 49);
  });
  test('un lote vencido no cuenta como saldo ni se consume', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 10, clave: 'viejo', vence: new Date(Date.now() - 1000) });
    assert.equal(await saldo(), 0);
    assert.equal((await C.consumir({ empresaId: empresa.id, accion: 'TURNO_IA', clave: 'v' })).motivo, 'SIN_SALDO');
  });
});

describe('devolver, ajustar y vencer', () => {
  test('devolver restituye lo cobrado, una sola vez', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 10, clave: 'p', vence: new Date(Date.now() + dia) });
    await C.consumir({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: 'x' });
    assert.equal(await saldo(), 5);
    const d1 = await C.devolver({ empresaId: empresa.id, clave: 'x' });
    const d2 = await C.devolver({ empresaId: empresa.id, clave: 'x' });
    assert.equal(d1.devuelto, 5); assert.equal(d2.repetido, true);
    assert.equal(await saldo(), 10);
    assert.equal((await C.devolver({ empresaId: empresa.id, clave: 'no-existe' })).motivo, 'NO_EXISTE');
    assert.equal((await C.verificarCuadre(empresa.id)).ok, true);
  });
  test('ajustar exige motivo, suma con un lote AJUSTE y no deja restar de más', async () => {
    await limpiar();
    await assert.rejects(() => C.ajustar({ empresaId: empresa.id, cantidad: 10, motivo: '' }), /motivo/);
    await C.ajustar({ empresaId: empresa.id, cantidad: 100, motivo: 'Regalo de bienvenida', quien: 'admin' });
    assert.equal(await saldo(), 100);
    await C.ajustar({ empresaId: empresa.id, cantidad: -30, motivo: 'Corrección' });
    assert.equal(await saldo(), 70);
    await assert.rejects(() => C.ajustar({ empresaId: empresa.id, cantidad: -500, motivo: 'Demasiado' }), /más créditos/);
    assert.equal(await saldo(), 70);
    const m = await prisma.creditoMovimiento.findFirst({ where: { empresaId: empresa.id, tipo: 'AJUSTE', cantidad: 100 } });
    assert.equal(m.quien, 'admin'); assert.equal(m.nota, 'Regalo de bienvenida');
    assert.equal((await C.verificarCuadre(empresa.id)).ok, true);
  });
  test('vencer deja el restante en 0 con su movimiento y es idempotente', async () => {
    await limpiar();
    const { loteId } = await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 10, clave: 'p', vence: new Date(Date.now() - 1000) });
    assert.ok(await C.vencer() >= 1);
    assert.equal((await prisma.creditoLote.findUnique({ where: { id: loteId } })).restante, 0);
    assert.equal(await prisma.creditoMovimiento.count({ where: { loteId, tipo: 'VENCIMIENTO' } }), 1);
    await C.vencer();
    assert.equal(await prisma.creditoMovimiento.count({ where: { loteId, tipo: 'VENCIMIENTO' } }), 1);
    assert.equal((await C.verificarCuadre(empresa.id)).ok, true);
  });
  test('la base impide un saldo negativo o mayor al inicial', async () => {
    await limpiar();
    const { loteId } = await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 5, clave: 'p' });
    await assert.rejects(() => prisma.creditoLote.update({ where: { id: loteId }, data: { restante: -1 } }));
    await assert.rejects(() => prisma.creditoLote.update({ where: { id: loteId }, data: { restante: 6 } }));
  });
});

describe('modo sombra', () => {
  test('anota consumos simulados sin mover el saldo, idempotentes, y los resume', async () => {
    await limpiar();
    await C.otorgar({ empresaId: empresa.id, origen: 'PLAN', cantidad: 10, clave: 'p', vence: new Date(Date.now() + dia) });
    await C.registrarSombra({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: 's1' });
    await C.registrarSombra({ empresaId: empresa.id, accion: 'CONVERSACION_NUEVA', clave: 's1' });
    await C.registrarSombra({ empresaId: empresa.id, accion: 'TURNO_IA', clave: 's2' });
    assert.equal(await saldo(), 10, 'la sombra no mueve el saldo');
    const inf = await C.informeSombra({ dias: 1 });
    const f = inf.filas.find((x) => x.empresaId === empresa.id);
    assert.deepEqual([f.conversaciones, f.turnosIA, f.creditos], [1, 1, 6]);
    assert.equal((await C.verificarCuadre(empresa.id)).ok, true, 'la sombra no cuenta en el cuadre');
  });
  test('el modo se lee de CREDITOS_MODO y por defecto está apagado', () => {
    assert.equal(C.modo({}), 'APAGADO'); assert.equal(C.modo({ CREDITOS_MODO: 'sombra' }), 'SOMBRA'); assert.equal(C.modo({ CREDITOS_MODO: 'ACTIVO' }), 'ACTIVO'); assert.equal(C.modo({ CREDITOS_MODO: 'x' }), 'APAGADO');
  });
});
