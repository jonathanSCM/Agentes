// Motor de mensajes prefabricados (lib/services/mensajes.js + mensajesBase.js).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const M = require('../lib/services/mensajes');
const { CATALOGO } = require('../lib/services/mensajesBase');

const vos = M.crearContexto({ registro: 'vos', negocio: { nombre: 'Tienda Demo' } });
const tu = M.crearContexto({ registro: 'tu', negocio: { nombre: 'Tienda Demo' } });

describe('catálogo de fábrica: galería (cada mensaje se arma bien)', () => {
  const ejemploDe = (m) => {
    const vars = { ...m.ejemplo };
    for (const [nombre, tipoCrudo] of Object.entries(m.variables)) {
      if (vars[nombre] === undefined && !String(tipoCrudo).endsWith('?')) vars[nombre] = tipoCrudo === 'numero' ? 1 : 'x';
    }
    return vars;
  };

  test('hay un catálogo razonable y todos tienen descripción (la lee la IA para elegir)', () => {
    assert.ok(CATALOGO.length >= 55, `solo ${CATALOGO.length} mensajes`);
    for (const m of CATALOGO) {
      assert.match(m.clave, /^[a-z0-9_]{3,40}$/, m.clave);
      assert.ok(m.descripcion && m.descripcion.length >= 15, `${m.clave}: falta la descripción`);
      assert.ok(m.categoria, `${m.clave}: falta la categoría`);
    }
  });

  for (const registro of ['vos', 'tu']) {
    test(`todos se renderizan en "${registro}" sin sintaxis suelta ni textos desmedidos`, () => {
      const ctx = M.crearContexto({ registro, negocio: { nombre: 'Tienda Demo' } });
      for (const m of CATALOGO) {
        const { texto } = ctx.render(m.clave, ejemploDe(m));
        assert.ok(texto.length > 0 && texto.length <= 1000, `${m.clave}: largo ${texto.length}`);
        assert.doesNotMatch(texto, /\{\{|\}\}|\{r:|undefined|null|\[object/, `${m.clave}: ${texto}`);
      }
    });
  }

  test('las variables que usa cada texto están declaradas', () => {
    for (const m of CATALOGO) {
      for (const nombre of M.variablesDeTexto(m.texto)) {
        if (nombre === 'negocio' || nombre.startsWith('dato.') || nombre.startsWith('vocab.')) continue;
        assert.ok(m.variables[nombre] !== undefined, `${m.clave} usa {{${nombre}}} sin declararla`);
      }
    }
  });

  test('el registro "tu" no deja voseo en ningún mensaje', () => {
    const voseo = /\b(querés|podés|preferís|llevás|buscás|elegí|decime|abrilo|tocá|compartila|pegame|pegá|mandame|escribí|probá|respondé|compartí|necesitás|escribime)\b/i;
    for (const m of CATALOGO) {
      // Los fragmentos que otro mensaje inserta (el ofrecimiento de asesor, el QR) los arma el backend en el MISMO registro.
      const ejemplo = ejemploDe(m);
      if (ejemplo.asesor !== undefined) ejemplo.asesor = tu.t('ofrecer_asesor');
      if (ejemplo.qr !== undefined) ejemplo.qr = tu.t('qr_pendiente');
      const { texto } = tu.render(m.clave, ejemplo);
      assert.doesNotMatch(texto, voseo, `${m.clave} (tú): ${texto}`);
    }
  });
});

describe('textos de fábrica en "vos" = los que antes estaban en el código', () => {
  const igual = (clave, vars, esperado) => assert.equal(vos.t(clave, vars), esperado);
  test('menú, carrito y cierre', () => {
    igual('menu_rubros', {}, 'Esto es lo que tenemos, ¿cuál te interesa?');
    igual('menu_rubros', { saludo: 'Dale 🛍️' }, 'Dale 🛍️ Esto es lo que tenemos, ¿cuál te interesa?');
    igual('subcategorias', { categoria: 'Calzado' }, 'Dentro de Calzado, ¿qué tipo buscás?');
    igual('tarjeta_categoria', { categoria: 'zapatillas' }, 'Échale un vistazo a zapatillas 👆 Cuando algo te guste, decime el nombre del modelo o abrilo en el catálogo.');
    igual('carrito_resumen', { carrito: '- 1x A' }, 'Esto llevás:\n- 1x A');
    igual('cantidad_ya_lleva', { cantidad: 2, carrito: '- 2x A' }, 'Ya llevás 2:\n- 2x A');
    igual('producto_quitado', {}, 'Listo, lo saqué de tu carrito. ¿Querés ver otra cosa?');
    igual('pedir_ubicacion', {}, 'Para la entrega necesito tu ubicación. Tocá el botón y compartila, o pegame el link de Google Maps.');
    igual('pedir_pago', {}, '¿Cómo preferís pagar?');
    igual('resumen_pedido', { resumen: 'X' }, 'Este es el resumen de tu pedido:\nX\n\n¿Está todo bien?');
  });
  test('pedido creado: con y sin número de pedido y con y sin QR', () => {
    igual('pedido_creado', { coordina: 'la entrega' }, '¡Listo! Tu pedido quedó registrado ✅ Un asesor va a coordinar la entrega con vos.');
    igual('pedido_creado', { numero: 15, coordina: 'el retiro', qr: vos.t('qr_enviado') },
      '¡Listo! Tu pedido #15 quedó registrado ✅ Te envié el QR 👆 Cuando pagues, mandame el comprobante por acá. Un asesor va a coordinar el retiro con vos.');
  });
  test('sistema y reglas', () => {
    igual('alcance_manipulacion', { negocio: 'Tienda Demo' }, 'Solo puedo ayudarte con lo que ofrece Tienda Demo 😊 ¿Seguimos con tu compra?');
    igual('error_tecnico', {}, 'Tuve un problema técnico y no pude procesar tu mensaje. Probá de nuevo en un momento o escribí "asesor" y una persona te atiende.');
    igual('pago_formas', { formas: 'QR y efectivo' }, 'En Tienda Demo podés pagar con QR y efectivo. ¿Seguimos con tu pedido?');
  });
  test('registro "tu": mismo mensaje, sin voseo', () => {
    assert.equal(tu.t('pedir_pago'), '¿Cómo prefieres pagar?');
    assert.equal(tu.t('pedido_creado', { coordina: 'la entrega' }), '¡Listo! Tu pedido quedó registrado ✅ Un asesor va a coordinar la entrega contigo.');
  });
});

describe('variables y validación', () => {
  test('un monto se escribe con la moneda del negocio, no como lo mande quien llama', () => {
    const ctx = M.crearContexto({ moneda: 'USD' });
    const { texto } = ctx.render('aviso_carrito_web', { carrito: 'x', cierre: 'y' });
    assert.match(texto, /Agregado a tu carrito/);
    const conMonto = M.renderizarTexto('Total {{total}}', { total: 'monto' }, { total: 12.5 }, { moneda: 'USD', registro: 'vos', datos: new Map() }, 't');
    assert.equal(conMonto, 'Total US$ 12.50');
  });
  test('falta una variable obligatoria: error claro', () => {
    assert.throws(() => vos.t('cantidad_ya_lleva', { carrito: 'x' }), /falta el valor de "cantidad"/);
  });
  test('una variable que el mensaje no declara no se acepta en el texto', () => {
    assert.throws(() => M.renderizarTexto('Hola {{inventada}}', {}, {}, { registro: 'vos', datos: new Map() }, 'x'), /no existe en este mensaje/);
  });
  test('un número inválido se rechaza', () => assert.throws(() => vos.t('sin_mas_stock', { stock: 'mucho' }), /debe ser un número/));
  test('el valor que viene de afuera no puede traer sintaxis del motor', () => {
    const t = vos.t('carrito_resumen', { carrito: 'Zapatilla {{dato.secreto}} {r:a|b} \u0001fin' });
    assert.doesNotMatch(t, /\{\{|\{r:|\u0001/);
  });
  test('una clave que no existe falla fuerte (programación, no negocio)', () => assert.throws(() => vos.t('no_existe'), /No existe el mensaje/));
  test('bloque sin cerrar', () => assert.throws(() => M.renderizarTexto('{{#a}}hola', { a: 'texto?' }, { a: 'x' }, { registro: 'vos', datos: new Map() }, 'x'), /sin cerrar/));

  test('validarTextoDelNegocio: lo que el panel verifica antes de guardar', () => {
    assert.deepEqual(M.validarTextoDelNegocio('Total: {{carrito}} en {{negocio}}', ['carrito']), []);
    assert.match(M.validarTextoDelNegocio('Hola {{nombre_raro}}', ['carrito'])[0], /no se puede usar/);
    assert.match(M.validarTextoDelNegocio('Garantía: {{dato.garantia}}', [], { datosExistentes: [] })[0], /no existe en "Datos de mi negocio"/);
    assert.deepEqual(M.validarTextoDelNegocio('Garantía: {{dato.garantia}}', [], { datosExistentes: ['garantia'] }), []);
    assert.match(M.validarTextoDelNegocio('{{#a}}sin cierre', ['a'])[0], /sin cerrar/);
    assert.ok(M.validarTextoDelNegocio('   ').length);
    assert.ok(M.validarTextoDelNegocio('x'.repeat(1200)).length);
  });
});

describe('lo que personaliza el negocio', () => {
  const fila = (extra) => ({ clave: 'pedir_nombre', texto: '¿Cómo te llamás? Es para el pedido.', variantes: [], variables: [], origen: 'PERSONALIZADO', activo: true, ...extra });

  test('el texto del negocio manda sobre el de fábrica', () => {
    const ctx = M.crearContexto({ overrides: [fila()] });
    assert.deepEqual(ctx.render('pedir_nombre'), { texto: '¿Cómo te llamás? Es para el pedido.', clave: 'pedir_nombre', origen: 'negocio' });
  });
  test('un mensaje desactivado vuelve al de fábrica', () => {
    assert.equal(M.crearContexto({ overrides: [fila({ activo: false })] }).render('pedir_nombre').origen, 'fabrica');
  });
  test('si el texto del negocio está roto, el cliente igual recibe el de fábrica', () => {
    const original = console.error; const logs = [];
    console.error = (m) => logs.push(m);
    try {
      const ctx = M.crearContexto({ overrides: [fila({ texto: 'Hola {{variable_que_no_existe}}' })] });
      const r = ctx.render('pedir_nombre');
      assert.equal(r.origen, 'fabrica');
      assert.equal(r.texto, '¿A nombre de quién hago el pedido?');
      assert.ok(logs.some((l) => /no sirve/.test(l)));
    } finally { console.error = original; }
  });
  test('varias redacciones se alternan (sin repetir cuando la semilla avanza)', () => {
    const f = fila({ variantes: ['Decime tu nombre 🙂', 'Tu nombre para el pedido, por favor'] });
    const textos = [0, 1, 2, 3].map((semilla) => M.crearContexto({ overrides: [f], semilla }).t('pedir_nombre'));
    assert.equal(textos[0], '¿Cómo te llamás? Es para el pedido.');
    assert.equal(textos[1], 'Decime tu nombre 🙂');
    assert.equal(textos[2], 'Tu nombre para el pedido, por favor');
    assert.equal(textos[3], textos[0]);
  });
  test('datos añadibles del negocio: {{dato.garantia}}', () => {
    const ctx = M.crearContexto({
      overrides: [fila({ clave: 'garantia_info', origen: 'PROPIO', texto: 'Garantía: {{dato.garantia}} ✅', variables: [] })],
      datos: [{ clave: 'garantia', etiqueta: 'Garantía', valor: '30 días por falla de fábrica', visible: true }],
    });
    assert.equal(ctx.t('garantia_info'), 'Garantía: 30 días por falla de fábrica ✅');
    assert.ok(ctx.existe('garantia_info'));
  });
  test('un dato oculto no se usa: el mensaje que lo necesita no se puede armar (no queda a medias)', () => {
    const ctx = M.crearContexto({ overrides: [fila({ clave: 'garantia_info', origen: 'PROPIO', texto: 'Garantía: {{dato.garantia}}' })], datos: [{ clave: 'garantia', valor: 'x', visible: false }] });
    assert.throws(() => ctx.t('garantia_info'), /falta el valor de "dato.garantia"/);
  });
  test('un mensaje PROPIO con variables que él declara', () => {
    const ctx = M.crearContexto({ overrides: [fila({ clave: 'promo_semana', origen: 'PROPIO', texto: 'Esta semana {{producto}} a {{precio}}', variables: [{ nombre: 'producto', tipo: 'texto' }, { nombre: 'precio', tipo: 'monto' }] })] });
    assert.equal(ctx.t('promo_semana', { producto: 'Zapatilla Runner', precio: 250 }), 'Esta semana Zapatilla Runner a Bs 250.00');
  });
  test('el vocabulario del negocio: {{vocab.cita}}', () => {
    const ctx = M.crearContexto({ vocab: { cita: 'turno' }, overrides: [fila({ clave: 'x_vocab', origen: 'PROPIO', texto: 'Tu {{vocab.cita}} quedó confirmado' })] });
    assert.equal(ctx.t('x_vocab'), 'Tu turno quedó confirmado');
  });
});

describe('cargarContexto (base de datos)', () => {
  let empresaId;
  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: 'test-mensajes' } });
    const e = await prisma.empresa.create({ data: { nombre: 'Tienda Mensajes', slug: 'test-mensajes', moneda: 'BOB' } });
    empresaId = e.id;
    await prisma.mensajeAgente.create({ data: { empresaId, clave: 'pedir_nombre', texto: '¿Tu nombre, por favor?' } });
    await prisma.mensajeAgente.create({ data: { empresaId, clave: 'pedir_pago', texto: 'No se usa', activo: false } });
    await prisma.datoNegocio.create({ data: { empresaId, clave: 'garantia', etiqueta: 'Garantía', valor: '30 días' } });
    M.invalidar();
  });
  after(async () => {
    M.invalidar();
    await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  });

  test('lee lo que el negocio personalizó y respeta el registro del agente', async () => {
    const ctx = await M.cargarContexto({ empresa: { id: empresaId, nombre: 'Tienda Mensajes', moneda: 'BOB' }, config: { registro: 'tu' } });
    assert.equal(ctx.t('pedir_nombre'), '¿Tu nombre, por favor?');
    assert.equal(ctx.t('pedir_pago'), '¿Cómo prefieres pagar?', 'el desactivado vuelve al de fábrica y en el registro del agente');
    assert.match(ctx.t('alcance_manipulacion'), /Tienda Mensajes/, 'el nombre del negocio lo pone el sistema');
  });
  test('sin empresa o con la base caída devuelve los de fábrica, nunca lanza', async () => {
    const ctx = await M.cargarContexto({ empresa: null, config: null });
    assert.equal(ctx.t('pedir_nombre'), '¿A nombre de quién hago el pedido?');
  });
  test('el cache se renueva con invalidar()', async () => {
    const empresa = { id: empresaId, nombre: 'Tienda Mensajes' };
    await M.cargarContexto({ empresa, config: {} });
    await prisma.mensajeAgente.update({ where: { empresaId_clave: { empresaId, clave: 'pedir_nombre' } }, data: { texto: 'Otro texto' } });
    assert.equal((await M.cargarContexto({ empresa, config: {} })).t('pedir_nombre'), '¿Tu nombre, por favor?', 'sigue el cache');
    M.invalidar(empresaId);
    assert.equal((await M.cargarContexto({ empresa, config: {} })).t('pedir_nombre'), 'Otro texto');
  });
});
