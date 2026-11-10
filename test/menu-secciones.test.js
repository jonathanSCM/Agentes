// El menú lateral se organiza en secciones (una por módulo) y la pantalla recuerda el desplazamiento del menú.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { construirMenu, ICONOS_GRUPO } = require('../lib/services/menuPanel');
const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('cada sección del menú tiene clave única, título e ícono', () => {
  const casos = [
    construirMenu({ rol: 'OWNER', modulos: ['AGENTE', 'POS', 'PANEL'] }),
    construirMenu({ rol: 'OWNER', esCitas: true }),
    construirMenu({ rol: 'ADMIN', modulos: ['AGENTE'] }),
    construirMenu({ rol: 'STAFF' }),
    construirMenu({ rol: 'CAJERO', modulos: ['AGENTE', 'POS'] }),
  ];
  for (const menu of casos) {
    const secciones = menu.filter((g) => g.titulo);
    const claves = secciones.map((g) => g.clave);
    assert.equal(new Set(claves).size, claves.length, 'claves repetidas');
    for (const g of secciones) {
      assert.ok(g.clave, `la sección "${g.titulo}" necesita clave`);
      assert.ok(g.icono && g.icono.length > 10, `la sección "${g.titulo}" necesita ícono`);
    }
  }
  assert.ok(Object.keys(ICONOS_GRUPO).length >= 6);
});

test('el dueño de una tienda ve sus módulos como secciones separadas y ninguna es larguísima', () => {
  const menu = construirMenu({ rol: 'OWNER', modulos: ['AGENTE', 'POS', 'PANEL'] });
  assert.deepEqual(menu.filter((g) => g.titulo).map((g) => g.clave), ['agente', 'pos', 'catalogo', 'panel', 'cuenta']);
  for (const g of menu) assert.ok(g.items.length <= 8, `la sección ${g.clave} tiene ${g.items.length} opciones`);
  assert.deepEqual(menu[0].items.map((i) => i.clave), ['inicio'], 'Inicio queda suelto arriba');
});

test('un negocio de citas tiene su sección "Mi negocio" en vez de Catálogo y Panel comercial', () => {
  const menu = construirMenu({ esCitas: true });
  assert.deepEqual(menu.filter((g) => g.titulo).map((g) => g.clave), ['agente', 'negocio', 'cobros', 'catalogo', 'cuenta']);
});

test('en un negocio de citas, cobros trae las cuentas, la caja y las ventas (módulo POS); el cajero y el profesional ven lo suyo', () => {
  const claves = (m) => m.flatMap((g) => g.items.map((i) => i.clave));
  const cobros = construirMenu({ esCitas: true, modulos: ['AGENTE', 'POS'] }).find((g) => g.clave === 'cobros');
  assert.deepEqual(cobros.items.map((i) => i.clave), ['cuentas', 'caja', 'ventas']);
  assert.ok(cobros.items.every((i) => !i.bloqueado && i.modulo === 'POS'));
  assert.ok(construirMenu({ esCitas: true, modulos: ['AGENTE'] }).find((g) => g.clave === 'cobros').items.every((i) => i.bloqueado), 'sin POS en el plan: con candado');
  assert.deepEqual(claves(construirMenu({ esCitas: true, rol: 'CAJERO', modulos: ['AGENTE', 'POS'] })), ['cuentas', 'caja', 'ventas']);
  assert.deepEqual(claves(construirMenu({ esCitas: true, rol: 'PROFESIONAL' })), ['mi-agenda']);
});

test('la pantalla arma las secciones desplegables y abre solo la del módulo actual', () => {
  const vista = leer('views', 'cliente', 'partials', 'inicio.ejs');
  assert.match(vista, /nav-grupo-cab/);
  assert.match(vista, /aria-expanded/);
  assert.match(vista, /tieneActivo/, 'se abre la sección que contiene la pantalla actual');
  assert.match(vista, /primeraSeccion/, 'en Inicio se abre la primera (Agente)');
});

test('al cambiar de pantalla el menú recuerda su desplazamiento (cliente y superadmin)', () => {
  for (const [vista, clave] of [[['cliente', 'partials', 'fin.ejs'], 'panel-nav-scroll'], [['admin', 'partials', 'fin.ejs'], 'admin-nav-scroll']]) {
    const js = leer('views', ...vista);
    assert.ok(js.includes(clave), `${vista.join('/')} guarda el scroll en ${clave}`);
    assert.match(js, /scrollIntoView/, 'deja a la vista la opción actual');
  }
  assert.match(leer('views', 'admin', 'partials', 'inicio.ejs'), /id="sidebarNav"/);
});

test('plegado a solo iconos se ven todas las opciones aunque la sección esté cerrada', () => {
  const css = leer('public', 'css', 'panel-shell.css');
  assert.match(css, /\.sidebar\.is-collapsed \.nav-grupo-items \{ display: flex;/);
  assert.match(css, /\.sidebar\.is-collapsed \.nav-grupo-cab \{ display: none;/);
});
