// Auditoría: se registra con cada acción importante, es atómica en transacciones, inmutable y por empresa.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const Aud = require('../lib/services/auditoria');
const Caja = require('../lib/services/caja');
const Ventas = require('../lib/services/ventas');

const SLUGS = ['test-aud-a', 'test-aud-b'];
let A; let B;

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug } });
  const cat = await prisma.categoria.create({ data: { empresaId: e.id, nombre: 'General' } });
  const dueno = await prisma.usuario.create({ data: { empresaId: e.id, email: `${slug}-dueno@test.local`, passwordHash: 'x', nombre: `Dueña ${slug}`, rol: 'OWNER' } });
  return { empresaId: e.id, categoriaId: cat.id, dueno: { id: dueno.id, rol: 'OWNER' } };
}
const acciones = (ctx, filtro = {}) => prisma.auditoria.findMany({ where: { empresaId: ctx.empresaId, ...filtro }, orderBy: { id: 'asc' } });

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: SLUGS.map((s) => `${s}-dueno@test.local`) } } });
  A = await empresa(SLUGS[0]);
  B = await empresa(SLUGS[1]);
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.usuario.deleteMany({ where: { email: { in: SLUGS.map((s) => `${s}-dueno@test.local`) } } });
});

describe('registro', () => {
  test('guarda quién, qué y el detalle, con el nombre del momento', async () => {
    await Aud.registrar(prisma, { empresaId: A.empresaId, actor: A.dueno, accion: 'STOCK_AJUSTADO', entidad: 'Producto', entidadId: 7, detalle: { producto: 'Camisa', antes: 5, despues: 9 } });
    const [f] = await acciones(A, { accion: 'STOCK_AJUSTADO' });
    assert.equal(f.usuarioNombre, `Dueña ${SLUGS[0]}`);
    assert.equal(f.usuarioRol, 'OWNER');
    assert.deepEqual(f.detalle, { producto: 'Camisa', antes: 5, despues: 9 });
    assert.match(Aud.resumenDe(f), /Camisa: 5 → 9/);
  });

  test('una acción desconocida se rechaza (no se llenan registros con typos)', async () => {
    await assert.rejects(Aud.registrar(prisma, { empresaId: A.empresaId, actor: A.dueno, accion: 'ALGO_RARO' }), /desconocida/);
  });

  test('una acción de Proshop queda con su nombre y sin usuario de la empresa', async () => {
    await Aud.registrar(prisma, { empresaId: A.empresaId, actor: { nombre: 'Proshop (administración)', rol: 'PROSHOP_ADMIN' }, accion: 'PLAN_ASIGNADO', detalle: { plan: 'Agente', hasta: '2027-01-01' } });
    const [f] = await acciones(A, { accion: 'PLAN_ASIGNADO' });
    assert.equal(f.usuarioId, null);
    assert.equal(f.usuarioNombre, 'Proshop (administración)');
  });

  test('en una transacción es atómica: si la transacción falla, el registro tampoco queda', async () => {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await Aud.registrar(tx, { empresaId: A.empresaId, actor: A.dueno, accion: 'PRODUCTO_ELIMINADO', detalle: { producto: 'Fantasma' } });
      throw new Error('falla después de registrar');
    }), /falla después/);
    assert.equal((await acciones(A, { accion: 'PRODUCTO_ELIMINADO' })).length, 0);
  });

  test('el detalle se recorta: nada de textos enormes', async () => {
    await Aud.registrar(prisma, { empresaId: A.empresaId, actor: A.dueno, accion: 'EQUIPO_INVITADO', detalle: { email: 'x'.repeat(5000) } });
    const [f] = await acciones(A, { accion: 'EQUIPO_INVITADO' });
    assert.equal(f.detalle.email.length, 300);
  });
});

describe('es inmutable', () => {
  test('la base rechaza editar un registro', async () => {
    const [f] = await acciones(A, { accion: 'STOCK_AJUSTADO' });
    await assert.rejects(prisma.auditoria.update({ where: { id: f.id }, data: { usuarioNombre: 'Otra persona' } }), /no se puede modificar/);
    await assert.rejects(prisma.$executeRaw`UPDATE auditoria SET accion = 'CAJA_ABIERTA' WHERE id = ${f.id}`, /no se puede modificar/);
  });
});

describe('listar', () => {
  test('filtra por grupo y no mezcla empresas', async () => {
    await Aud.registrar(prisma, { empresaId: B.empresaId, actor: B.dueno, accion: 'CAJA_ABIERTA', detalle: { efectivoInicial: 10 } });
    const a = await Aud.listar(A.empresaId, {});
    assert.ok(a.filas.length >= 3);
    assert.ok(a.filas.every((f) => f.empresaId === A.empresaId));
    const inv = await Aud.listar(A.empresaId, { grupo: 'Inventario' });
    assert.ok(inv.filas.length >= 1 && inv.filas.every((f) => f.accion === 'STOCK_AJUSTADO'));
    assert.equal((await Aud.listar(A.empresaId, { grupo: 'Caja' })).filas.length, 0);
  });

  test('lo más nuevo primero y paginado', async () => {
    const r = await Aud.listar(A.empresaId, { pagina: 1 });
    const fechas = r.filas.map((f) => f.createdAt.getTime());
    assert.deepEqual(fechas, [...fechas].sort((x, y) => y - x));
    assert.equal(r.pagina, 1);
    assert.equal((await Aud.listar(A.empresaId, { pagina: 'abc' })).pagina, 1);
  });
});

describe('se registra solo al operar', () => {
  let cajero; let producto;
  before(async () => {
    cajero = { id: A.dueno.id, rol: 'OWNER' };
    producto = await prisma.producto.create({ data: { empresaId: A.empresaId, categoriaId: A.categoriaId, nombre: 'Medias', precio: 20, stock: 10 } });
  });

  test('abrir, mover y cerrar la caja dejan su rastro, con la diferencia', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 100);
    await Caja.registrarMovimiento(A.empresaId, cajero.id, { tipo: 'SALIDA', monto: 30, nota: 'pago a proveedor' });
    await Caja.cerrar(A.empresaId, cajero.id, { efectivoContado: 65 });
    const lista = await acciones(A, { accion: { in: ['CAJA_ABIERTA', 'CAJA_MOVIMIENTO', 'CAJA_CERRADA'] } });
    assert.deepEqual(lista.map((f) => f.accion), ['CAJA_ABIERTA', 'CAJA_MOVIMIENTO', 'CAJA_CERRADA']);
    const cierre = lista[2];
    assert.deepEqual([cierre.detalle.esperado, cierre.detalle.contado, cierre.detalle.diferencia], [70, 65, -5]);
    assert.match(Aud.resumenDe(cierre, 'Bs'), /diferencia Bs -5.00/);
  });

  test('anular una venta se registra con el motivo, y una anulación rechazada no deja nada', async () => {
    await Caja.abrir(A.empresaId, cajero.id, 0);
    const { venta } = await Ventas.crear(A.empresaId, cajero, { lineas: [{ productoId: producto.id, cantidad: 1 }], pagos: [{ metodo: 'QR', monto: 20 }], claveIdempotencia: `aud-${Date.now()}` });
    await assert.rejects(Ventas.anular(A.empresaId, cajero, venta.id, 'x'), /motivo/);
    assert.equal((await acciones(A, { accion: 'VENTA_ANULADA' })).length, 0);
    await Ventas.anular(A.empresaId, cajero, venta.id, 'se equivocó el cajero');
    const [f] = await acciones(A, { accion: 'VENTA_ANULADA' });
    assert.equal(f.entidadId, venta.id);
    assert.equal(f.detalle.motivo, 'se equivocó el cajero');
    assert.equal(f.detalle.total, 20);
    await assert.rejects(Ventas.anular(A.empresaId, cajero, venta.id, 'otra vez anulada'), /ya fue anulada/);
    assert.equal((await acciones(A, { accion: 'VENTA_ANULADA' })).length, 1, 'la segunda anulación no duplica el registro');
    await prisma.sesionCaja.updateMany({ where: { empresaId: A.empresaId, estado: 'ABIERTA' }, data: { estado: 'CERRADA', cerradaAt: new Date() } });
  });
});
