// Menú lateral por rol/módulos y bloqueo de rutas por módulo del plan.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { construirMenu, iniciales, etiquetaRol, ICONOS } = require('../lib/services/menuPanel');
const { requireModulo } = require('../lib/services/modulos');
const P = require('../lib/services/planesCliente');

const items = (grupos) => grupos.flatMap((g) => g.items);
const claves = (grupos) => items(grupos).map((i) => i.clave);

describe('menú lateral', () => {
  test('el dueño de una tienda ve todo; Reportes e Inteligencia bloqueados si el plan no trae el Panel', () => {
    const g = construirMenu({ rol: 'OWNER', modulos: ['AGENTE'] });
    for (const c of ['inicio', 'conversaciones', 'pedidos', 'productos', 'agente', 'configuracion', 'consumo', 'paquetes', 'mensajes']) assert.ok(claves(g).includes(c), c);
    const panel = items(g).filter((i) => i.modulo === 'PANEL');
    assert.deepEqual(panel.map((i) => i.clave).sort(), ['auditoria', 'inteligencia', 'reportes', 'resumen']);
    assert.ok(panel.every((i) => i.bloqueado));
  });

  test('con el módulo Panel en el plan no hay candados', () => {
    const g = construirMenu({ rol: 'OWNER', modulos: ['AGENTE', 'POS', 'PANEL'] });
    assert.equal(items(g).filter((i) => i.bloqueado).length, 0);
  });

  test('un colaborador no ve Agente IA, Configuración ni Mi cuenta', () => {
    const c = claves(construirMenu({ rol: 'STAFF', modulos: ['AGENTE'] }));
    for (const x of ['agente', 'configuracion', 'equipo', 'consumo', 'paquetes', 'compras']) assert.ok(!c.includes(x), x);
    assert.ok(c.includes('conversaciones'));
  });

  test('un administrador ve Configuración pero no la facturación del dueño', () => {
    const c = claves(construirMenu({ rol: 'ADMIN', modulos: ['AGENTE'] }));
    assert.ok(c.includes('configuracion') && c.includes('agente'));
    assert.ok(!c.includes('consumo') && !c.includes('equipo'));
  });

  test('con citas desaparecen Pedidos y el catálogo, y aparece Mi negocio con el vocabulario', () => {
    const g = construirMenu({ esCitas: true, vocab: { profesionales: 'Barberos' } });
    const c = claves(g);
    for (const x of ['pedidos', 'productos', 'categorias', 'inventario', 'reportes']) assert.ok(!c.includes(x), x);
    for (const x of ['servicios', 'atencion-equipo', 'horarios']) assert.ok(c.includes(x), x);
    assert.equal(items(g).find((i) => i.clave === 'atencion-equipo').etiqueta, 'Barberos');
  });

  test('cada ítem trae su ícono y los contadores solo si son positivos', () => {
    const g = construirMenu({ badges: { pedidos: 3, conversaciones: 0 } });
    assert.ok(items(g).every((i) => i.icono && i.icono.length > 5), 'todos con ícono');
    assert.equal(items(g).find((i) => i.clave === 'pedidos').badge, 3);
    assert.equal(items(g).find((i) => i.clave === 'conversaciones').badge, 0);
    assert.ok(ICONOS.candado);
  });

  test('iniciales y rol legible', () => {
    assert.equal(iniciales('Ana Pérez'), 'AP');
    assert.equal(iniciales('Beto'), 'B');
    assert.equal(iniciales(''), '?');
    assert.equal(etiquetaRol('OWNER'), 'Dueño');
    assert.equal(etiquetaRol('STAFF'), 'Colaborador');
  });
});

describe('requireModulo (bloqueo en el servidor)', () => {
  let empresaId;
  let plan;
  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: 'test-menu-modulos' } });
    await prisma.plan.deleteMany({ where: { codigo: 'TEST_MM' } });
    empresaId = (await prisma.empresa.create({ data: { nombre: 'Cliente Módulos', slug: 'test-menu-modulos' } })).id;
    plan = await prisma.plan.create({ data: { codigo: 'TEST_MM', nombre: 'Plan MM', mensualidadBs: 1, implementacionBs: 0, primerPagoBs: 1, convIncluidas: 1, maxProductos: 1, maxUsuarios: 1, modulos: ['AGENTE'] } });
  });
  after(async () => {
    await prisma.suscripcion.deleteMany({ where: { empresaId } });
    await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
    await prisma.plan.deleteMany({ where: { codigo: 'TEST_MM' } });
  });

  async function pasar(modulo, metodo = 'GET') {
    let respuesta = { siguio: false };
    const res = {
      status(c) { respuesta.status = c; return this; },
      type() { return this; },
      send(t) { respuesta.cuerpo = t; },
      render(vista, datos) { respuesta.vista = vista; respuesta.datos = datos; },
    };
    await requireModulo(modulo)({ session: { empresaId }, method: metodo }, res, (err) => { respuesta.siguio = !err; respuesta.error = err; });
    return respuesta;
  }

  test('sin plan (estado base) el Agente pasa y el POS y el Panel no', async () => {
    assert.equal((await pasar('AGENTE')).siguio, true);
    const r = await pasar('PANEL');
    assert.equal(r.siguio, false);
    assert.equal(r.status, 403);
    assert.equal(r.vista, 'cliente/modulo-bloqueado');
    assert.equal(r.datos.nombreModulo, 'Panel comercial');
  });

  test('un POST también se bloquea (no solo la pantalla)', async () => {
    const r = await pasar('POS', 'POST');
    assert.equal(r.siguio, false);
    assert.equal(r.status, 403);
    assert.match(r.cuerpo, /no incluye el módulo Punto de venta/);
  });

  test('al asignar un plan con el módulo, pasa; al cambiarlo por otro sin él, se corta', async () => {
    await prisma.plan.update({ where: { id: plan.id }, data: { modulos: ['AGENTE', 'PANEL'] } });
    await P.asignarPlan(empresaId, plan.id, { meses: 1 });
    assert.equal((await pasar('PANEL')).siguio, true);
    assert.equal((await pasar('POS')).siguio, false);
    await P.editarCopia(empresaId, { modulos: ['AGENTE'] });
    assert.equal((await pasar('PANEL')).siguio, false, 'el superadmin le quitó el módulo a este cliente');
  });

  test('el plan de acceso total abre todo', async () => {
    const full = await prisma.plan.findUnique({ where: { codigo: 'ACCESO_TOTAL' } });
    await P.asignarPlan(empresaId, full.id, {});
    for (const m of ['AGENTE', 'POS', 'PANEL']) assert.equal((await pasar(m)).siguio, true, m);
  });
});

describe('menú del punto de venta', () => {
  test('el dueño ve el grupo Punto de venta; bloqueado si el plan no trae POS', () => {
    const sin = items(construirMenu({ rol: 'OWNER', modulos: ['AGENTE'] })).filter((i) => i.modulo === 'POS');
    assert.deepEqual(sin.map((i) => i.clave), ['pos', 'pos-pedidos', 'caja', 'ventas', 'proveedores', 'compras-proveedor']);
    assert.ok(sin.every((i) => i.bloqueado));
    const con = items(construirMenu({ rol: 'OWNER', modulos: ['AGENTE', 'POS'] })).filter((i) => i.modulo === 'POS');
    assert.ok(con.every((i) => !i.bloqueado));
  });

  test('el cajero ve SOLO el mostrador (punto de venta, caja y ventas)', () => {
    const g = construirMenu({ rol: 'CAJERO', modulos: ['AGENTE', 'POS'] });
    assert.deepEqual(claves(g), ['pos', 'pos-pedidos', 'caja', 'ventas']);
    assert.equal(etiquetaRol('CAJERO'), 'Cajero');
  });

  test('un colaborador no ve el punto de venta; con citas tampoco aparece', () => {
    assert.ok(!claves(construirMenu({ rol: 'STAFF', modulos: ['AGENTE', 'POS'] })).includes('pos'));
    assert.ok(!claves(construirMenu({ esCitas: true, modulos: ['AGENTE', 'POS'] })).includes('pos'));
  });
});

describe('menú del resumen comercial', () => {
  test('dueño y administrador ven Resumen (con candado si el plan no trae Panel); el colaborador no', () => {
    for (const rol of ['OWNER', 'ADMIN']) {
      const sin = items(construirMenu({ rol, modulos: ['AGENTE'] })).find((i) => i.clave === 'resumen');
      assert.ok(sin && sin.bloqueado && sin.modulo === 'PANEL', rol);
      const con = items(construirMenu({ rol, modulos: ['AGENTE', 'PANEL'] })).find((i) => i.clave === 'resumen');
      assert.ok(con && !con.bloqueado, rol);
    }
    assert.ok(!claves(construirMenu({ rol: 'STAFF', modulos: ['AGENTE', 'PANEL'] })).includes('resumen'));
    assert.ok(!claves(construirMenu({ rol: 'CAJERO', modulos: ['AGENTE', 'POS', 'PANEL'] })).includes('resumen'));
  });
});
