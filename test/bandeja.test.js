// Bandeja de conversaciones: una fila por cliente, no leídas, filtros, búsqueda y aislamiento por empresa.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const B = require('../lib/services/bandeja');

const SLUGS = ['test-bandeja-a', 'test-bandeja-b'];
let A; let Bx; // { empresaId, agenteId, agenteIds }

async function empresa(slug) {
  const e = await prisma.empresa.create({ data: { nombre: slug, slug, agentes: { create: { nombre: 'Agente' } } }, include: { agentes: true } });
  return { empresaId: e.id, agenteId: e.agentes[0].id, agenteIds: [e.agentes[0].id] };
}
async function charla(ctx, telefono, { nombre = null, modo = 'IA', mensajes = [], leidoAt = null, estadoLead = null, minutosAtras = 5 } = {}) {
  if (nombre || estadoLead) await prisma.clienteFinal.create({ data: { empresaId: ctx.empresaId, telefono, nombre, ...(estadoLead ? { estadoLead } : {}) } });
  const conv = await prisma.conversacion.create({
    data: { agenteId: ctx.agenteId, telefonoCliente: telefono, modo, leidoAt, ultimoMensajeAt: new Date(Date.now() - minutosAtras * 60000) },
  });
  let t = Date.now() - (minutosAtras + 1) * 60000;
  for (const [rol, contenido, extra] of mensajes) {
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol, contenido, createdAt: new Date(t += 1000), ...(extra || {}) } });
  }
  return conv;
}

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
  A = await empresa(SLUGS[0]);
  Bx = await empresa(SLUGS[1]);
});
after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: SLUGS } } });
});

describe('piezas puras', () => {
  test('iniciales, color estable y vista previa por tipo de mensaje', () => {
    assert.equal(B.inicialesDe('Ana Pérez'), 'AP');
    assert.equal(B.inicialesDe('Beto'), 'B');
    assert.equal(B.inicialesDe(null), '#');
    assert.equal(B.colorDe('59170000100'), B.colorDe('59170000100'));
    assert.ok(/^#[0-9a-f]{6}$/i.test(B.colorDe('x')));
    assert.deepEqual(B.previewDe({ contenido: 'Hola\n  buenas', mediaTipo: null }), { texto: 'Hola buenas', tipo: null });
    assert.deepEqual(B.previewDe({ contenido: '', mediaTipo: 'imagen' }), { texto: 'Foto', tipo: 'imagen' });
    assert.deepEqual(B.previewDe({ contenido: '', mediaTipo: 'audio' }), { texto: 'Nota de voz', tipo: 'audio' });
    assert.deepEqual(B.previewDe(null), { texto: '', tipo: null });
  });
});

describe('la lista', () => {
  test('una fila por cliente aunque tenga varias sesiones; con nombre, último mensaje y orden por fecha', async () => {
    await charla(A, '59170001001', { nombre: 'Ana Pérez', minutosAtras: 60, mensajes: [['CLIENTE', 'Hola vieja sesión']] });
    await charla(A, '59170001001', { minutosAtras: 10, mensajes: [['CLIENTE', 'Hola de nuevo'], ['AGENTE', '¿Qué buscás?']] });
    await charla(A, '59170001002', { minutosAtras: 2, mensajes: [['CLIENTE', 'Quiero zapatillas']] });
    const lista = await B.listar(A.empresaId, A.agenteIds);
    assert.equal(lista.length, 2);
    assert.equal(lista[0].telefono, '59170001002', 'el más reciente primero');
    const ana = lista.find((f) => f.telefono === '59170001001');
    assert.equal(ana.titulo, 'Ana Pérez');
    assert.equal(ana.iniciales, 'AP');
    assert.equal(ana.sesiones, 2);
    assert.equal(ana.ultimoTexto, '¿Qué buscás?');
    assert.equal(ana.ultimoAutor, 'AGENTE');
  });

  test('no leídos: mensajes del cliente posteriores a la marca de lectura', async () => {
    const ctx = await empresa('test-bandeja-nl');
    SLUGS.push('test-bandeja-nl');
    await charla(ctx, '59170002001', { mensajes: [['CLIENTE', 'uno'], ['CLIENTE', 'dos'], ['AGENTE', 'resp']] });
    const [fila] = await B.listar(ctx.empresaId, ctx.agenteIds);
    assert.equal(fila.noLeidos, 2, 'solo cuentan los del cliente');
    assert.equal(await B.contarNoLeidos(ctx.agenteIds), 1);

    assert.equal(await B.marcarLeida(ctx.agenteIds, '59170002001'), 1);
    assert.equal((await B.listar(ctx.empresaId, ctx.agenteIds))[0].noLeidos, 0);
    assert.equal(await B.contarNoLeidos(ctx.agenteIds), 0);

    await prisma.mensaje.create({ data: { conversacionId: fila.conversacionIds[0], rol: 'CLIENTE', contenido: 'nuevo', createdAt: new Date(Date.now() + 5000) } });
    assert.equal((await B.listar(ctx.empresaId, ctx.agenteIds))[0].noLeidos, 1);
    await prisma.empresa.delete({ where: { id: ctx.empresaId } });
  });

  test('filtros: no leídas y con persona (la atiende un humano o pidió uno)', async () => {
    const ctx = await empresa('test-bandeja-f');
    SLUGS.push('test-bandeja-f');
    const leido = new Date();
    await charla(ctx, '59170003001', { leidoAt: leido, minutosAtras: 30, mensajes: [['CLIENTE', 'leída']] });
    await charla(ctx, '59170003002', { minutosAtras: 20, mensajes: [['CLIENTE', 'sin leer']] });
    await charla(ctx, '59170003003', { modo: 'HUMANO', leidoAt: leido, minutosAtras: 10, mensajes: [['AGENTE', 'te atiendo']] });
    await charla(ctx, '59170003004', { estadoLead: 'DERIVADO_A_ASESOR', leidoAt: leido, minutosAtras: 5, mensajes: [['CLIENTE', 'quiero un asesor']] });
    const tel = (l) => l.map((f) => f.telefono).sort();
    assert.equal((await B.listar(ctx.empresaId, ctx.agenteIds, { filtro: 'todas' })).length, 4);
    assert.deepEqual(tel(await B.listar(ctx.empresaId, ctx.agenteIds, { filtro: 'no_leidas' })), ['59170003002']);
    assert.deepEqual(tel(await B.listar(ctx.empresaId, ctx.agenteIds, { filtro: 'persona' })), ['59170003003', '59170003004']);
    await prisma.empresa.delete({ where: { id: ctx.empresaId } });
  });

  test('búsqueda por nombre, teléfono y texto del último mensaje', async () => {
    const ctx = await empresa('test-bandeja-q');
    SLUGS.push('test-bandeja-q');
    await charla(ctx, '59170004001', { nombre: 'Carla Méndez', mensajes: [['CLIENTE', 'precio de la polera']] });
    await charla(ctx, '59170004002', { nombre: 'Diego Soto', mensajes: [['CLIENTE', 'horario de atención']] });
    const q = async (t) => (await B.listar(ctx.empresaId, ctx.agenteIds, { q: t })).map((f) => f.telefono);
    assert.deepEqual(await q('carla'), ['59170004001']);
    assert.deepEqual(await q('4002'), ['59170004002']);
    assert.deepEqual(await q('polera'), ['59170004001']);
    assert.deepEqual(await q('nadie'), []);
    await prisma.empresa.delete({ where: { id: ctx.empresaId } });
  });

  test('aislamiento: una empresa nunca ve ni marca como leídas las conversaciones de otra', async () => {
    await charla(Bx, '59170005001', { nombre: 'Cliente de B', mensajes: [['CLIENTE', 'hola B']] });
    const deA = (await B.listar(A.empresaId, A.agenteIds)).map((f) => f.telefono);
    assert.ok(!deA.includes('59170005001'));
    assert.equal(await B.marcarLeida(A.agenteIds, '59170005001'), 0, 'no marca las de otra empresa');
    assert.equal((await B.listar(Bx.empresaId, Bx.agenteIds))[0].noLeidos, 1);
    assert.deepEqual(await B.listar(A.empresaId, []), []);
  });
});

describe('la ficha del contacto', () => {
  test('datos del cliente y sus pedidos (sin contar los cancelados en el total)', async () => {
    const ctx = await empresa('test-bandeja-ficha');
    SLUGS.push('test-bandeja-ficha');
    const cf = await prisma.clienteFinal.create({ data: { empresaId: ctx.empresaId, telefono: '59170006001', nombre: 'Elena', categoriaInteres: 'Calzado' } });
    await prisma.pedido.create({ data: { empresaId: ctx.empresaId, clienteId: cf.id, total: 300, estado: 'ENTREGADO' } });
    await prisma.pedido.create({ data: { empresaId: ctx.empresaId, clienteId: cf.id, total: 100, estado: 'CANCELADO' } });
    const f = await B.ficha(ctx.empresaId, '59170006001');
    assert.equal(f.cliente.nombre, 'Elena');
    assert.equal(f.pedidos.length, 2);
    assert.equal(f.totalComprado, 300);
    assert.equal((await B.ficha(ctx.empresaId, '000')).cliente, null);
    await prisma.empresa.delete({ where: { id: ctx.empresaId } });
  });
});
