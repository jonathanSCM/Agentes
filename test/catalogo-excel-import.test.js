// importarCatalogo toca la base real (categorias/productos/variantes), asi
// que se prueba contra Postgres local con datos propios, aislados y
// limpiados al final - mismo patron que test/regresion-agente.test.js.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { importarCatalogo } = require('../lib/services/catalogoExcel');

const SLUG = 'test-import-excel';

let empresaId;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  const empresa = await prisma.empresa.create({ data: { nombre: 'Empresa Import Excel', slug: SLUG } });
  empresaId = empresa.id;
});

after(async () => {
  await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
});

beforeEach(async () => {
  // Cada test arranca con el catalogo de esta empresa vacio, para que los
  // conteos (limite de plan, "ya existe") no se pisen entre tests.
  await prisma.producto.deleteMany({ where: { empresaId } });
  await prisma.categoria.deleteMany({ where: { empresaId } });
});

const filaProducto = (o = {}) => ({
  fila: 2, categoria: null, subcategoria: null, nombre: 'Producto', descripcion: null,
  precio: 100, stock: 0, sku: null, atributos: {}, caracteristicas: [], fotos: [],
  ...o,
});
const filaVariante = (o = {}) => ({ fila: 2, producto: 'Producto', atributos: {}, stock: 0, precio: null, sku: null, ...o });

describe('importarCatalogo - categorias', () => {
  test('categoria nueva (rubro) se crea si no existe', async () => {
    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ categoria: 'Calzado', nombre: 'Zapatilla A' })],
      variantes: [],
    }, {});
    assert.equal(reporte.categoriasCreadas, 1);
    const categoria = await prisma.categoria.findFirst({ where: { empresaId, nombre: 'Calzado' } });
    assert.ok(categoria);
    assert.equal(categoria.padreId, null);
  });

  test('rubro + subcategoria: la subcategoria queda colgada del rubro correcto', async () => {
    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ categoria: 'Calzado', subcategoria: 'Zapatillas urbanas', nombre: 'Zapatilla B' })],
      variantes: [],
    }, {});
    assert.equal(reporte.categoriasCreadas, 2);
    const rubro = await prisma.categoria.findFirst({ where: { empresaId, nombre: 'Calzado' } });
    const sub = await prisma.categoria.findFirst({ where: { empresaId, nombre: 'Zapatillas urbanas' } });
    assert.equal(sub.padreId, rubro.id);
  });

  test('categoria existente se reusa, nunca se duplica', async () => {
    await prisma.categoria.create({ data: { empresaId, nombre: 'Ropa' } });
    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ categoria: 'Ropa', nombre: 'Polera' })],
      variantes: [],
    }, {});
    assert.equal(reporte.categoriasCreadas, 0);
    const categorias = await prisma.categoria.findMany({ where: { empresaId, nombre: 'Ropa' } });
    assert.equal(categorias.length, 1);
  });

  test('nombre de subcategoria que ya existe bajo OTRO rubro: se reporta, no revienta el import', async () => {
    const otroRubro = await prisma.categoria.create({ data: { empresaId, nombre: 'Accesorios' } });
    await prisma.categoria.create({ data: { empresaId, nombre: 'Gorras', padreId: otroRubro.id } });

    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ categoria: 'Calzado', subcategoria: 'Gorras', nombre: 'Producto Choque' })],
      variantes: [],
    }, {});
    assert.equal(reporte.productosCreados, 0);
    assert.equal(reporte.saltados.length, 1);
    assert.match(reporte.saltados[0].motivo, /Gorras/);
  });
});

describe('importarCatalogo - productos (crear vs actualizar)', () => {
  test('producto nuevo se crea con sus datos reales', async () => {
    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ nombre: 'Jean Slim', precio: 250, descripcion: 'Azul indigo', sku: 'JS-1' })],
      variantes: [],
    }, {});
    assert.equal(reporte.productosCreados, 1);
    const producto = await prisma.producto.findFirst({ where: { empresaId, nombre: 'Jean Slim' } });
    assert.equal(Number(producto.precio), 250);
    assert.equal(producto.descripcion, 'Azul indigo');
    assert.equal(producto.sku, 'JS-1');
  });

  test('volver a importar el mismo producto (mismo nombre) lo ACTUALIZA, no lo duplica', async () => {
    await importarCatalogo(prisma, empresaId, { productos: [filaProducto({ nombre: 'Camisa', precio: 100 })], variantes: [] }, {});
    const reporte2 = await importarCatalogo(prisma, empresaId, { productos: [filaProducto({ nombre: 'Camisa', precio: 150 })], variantes: [] }, {});

    assert.equal(reporte2.productosCreados, 0);
    assert.equal(reporte2.productosActualizados, 1);
    const productos = await prisma.producto.findMany({ where: { empresaId, nombre: 'Camisa' } });
    assert.equal(productos.length, 1, 'no se duplico');
    assert.equal(Number(productos[0].precio), 150, 'se actualizo el precio');
  });

  test('el limite del plan corta el import y reporta la fila saltada', async () => {
    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ nombre: 'Producto 1' }), filaProducto({ nombre: 'Producto 2', fila: 3 })],
      variantes: [],
    }, { maxProductos: 1 });
    assert.equal(reporte.productosCreados, 1);
    assert.equal(reporte.saltados.length, 1);
    assert.match(reporte.saltados[0].motivo, /límite/i);
  });

  test('una foto que no se pudo descargar se reporta, pero el producto igual se guarda', async () => {
    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ nombre: 'Con Foto Rota', fotos: ['https://no-existe.example/foto.jpg'] })],
      variantes: [],
    }, { descargarFoto: async () => null });
    assert.equal(reporte.productosCreados, 1);
    assert.equal(reporte.saltados.length, 1);
    assert.match(reporte.saltados[0].motivo, /foto/i);
    const producto = await prisma.producto.findFirst({ where: { empresaId, nombre: 'Con Foto Rota' } });
    assert.deepEqual(producto.fotos, []);
  });

  test('dispara onProductoGuardado por cada producto creado/actualizado', async () => {
    const guardados = [];
    await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ nombre: 'Con callback' })],
      variantes: [],
    }, { onProductoGuardado: (p) => guardados.push(p.nombre) });
    assert.deepEqual(guardados, ['Con callback']);
  });
});

describe('importarCatalogo - variantes', () => {
  test('un producto con filas en la hoja Variantes ignora el Stock de la hoja Productos (queda en 0)', async () => {
    await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ nombre: 'Zapatilla Variantes', stock: 999 })],
      variantes: [filaVariante({ producto: 'Zapatilla Variantes', atributos: { Talla: '42' }, stock: 5 })],
    }, {});
    const producto = await prisma.producto.findFirst({ where: { empresaId, nombre: 'Zapatilla Variantes' } });
    assert.equal(producto.stock, 0);
    const variante = await prisma.variante.findFirst({ where: { productoId: producto.id } });
    assert.equal(variante.stock, 5);
  });

  test('variante sin producto que matchee en la hoja Productos: se reporta y se salta', async () => {
    const reporte = await importarCatalogo(prisma, empresaId, {
      productos: [],
      variantes: [filaVariante({ producto: 'No Existe', atributos: { Talla: '40' } })],
    }, {});
    assert.equal(reporte.variantesCreadas, 0);
    assert.equal(reporte.saltados.length, 1);
    assert.match(reporte.saltados[0].motivo, /No Existe/);
  });

  test('volver a importar la misma variante (mismos atributos) la ACTUALIZA, no la duplica', async () => {
    const filas = {
      productos: [filaProducto({ nombre: 'Polera Variantes' })],
      variantes: [filaVariante({ producto: 'Polera Variantes', atributos: { Talla: 'M', Color: 'Negro' }, stock: 3 })],
    };
    await importarCatalogo(prisma, empresaId, filas, {});
    const reporte2 = await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ nombre: 'Polera Variantes' })],
      variantes: [filaVariante({ producto: 'Polera Variantes', atributos: { Talla: 'M', Color: 'Negro' }, stock: 10 })],
    }, {});

    assert.equal(reporte2.variantesCreadas, 0);
    assert.equal(reporte2.variantesActualizadas, 1);
    const producto = await prisma.producto.findFirst({ where: { empresaId, nombre: 'Polera Variantes' } });
    const variantes = await prisma.variante.findMany({ where: { productoId: producto.id } });
    assert.equal(variantes.length, 1, 'no se duplico la variante');
    assert.equal(variantes[0].stock, 10, 'se actualizo el stock');
  });

  test('dos tallas distintas del mismo producto crean dos variantes reales', async () => {
    await importarCatalogo(prisma, empresaId, {
      productos: [filaProducto({ nombre: 'Medias' })],
      variantes: [
        filaVariante({ producto: 'Medias', atributos: { Talla: 'S' }, stock: 2 }),
        filaVariante({ producto: 'Medias', atributos: { Talla: 'L' }, stock: 4, fila: 3 }),
      ],
    }, {});
    const producto = await prisma.producto.findFirst({ where: { empresaId, nombre: 'Medias' } });
    const variantes = await prisma.variante.findMany({ where: { productoId: producto.id } });
    assert.equal(variantes.length, 2);
  });
});
