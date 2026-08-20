// "Tambien te puede interesar" (co-compra, sin IA). Usa la base de datos
// local real (mismo patron que regresion-agente.test.js) con datos propios
// que se limpian al final.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { productosRelacionados } = require('../lib/services/recomendaciones');

const SLUG = 'test-recomendaciones';
const SLUG_OTRA = 'test-recomendaciones-otra';

let empresaId, otraEmpresaId;
let zapatilla, medias, gorra, sinCompras;

before(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: [SLUG, SLUG_OTRA] } } });

  const empresa = await prisma.empresa.create({ data: { nombre: 'Empresa Recom', slug: SLUG } });
  empresaId = empresa.id;
  const categoria = await prisma.categoria.create({ data: { empresaId, nombre: 'Calzado' } });

  zapatilla = await prisma.producto.create({ data: { empresaId, nombre: 'Zapatilla', categoriaId: categoria.id, precio: 300, stock: 10 } });
  medias = await prisma.producto.create({ data: { empresaId, nombre: 'Medias', categoriaId: categoria.id, precio: 20, stock: 10 } });
  gorra = await prisma.producto.create({ data: { empresaId, nombre: 'Gorra', categoriaId: categoria.id, precio: 50, stock: 10 } });
  sinCompras = await prisma.producto.create({ data: { empresaId, nombre: 'Sin compras', categoriaId: categoria.id, precio: 10, stock: 10 } });

  // 3 pedidos: zapatilla+medias x2, zapatilla+gorra x1 -> medias deberia
  // salir primero en las recomendaciones de zapatilla.
  for (const combo of [[zapatilla, medias], [zapatilla, medias], [zapatilla, gorra]]) {
    await prisma.pedido.create({
      data: {
        empresaId,
        items: { create: combo.map((p) => ({ productoId: p.id, nombre: p.nombre, precio: p.precio, cantidad: 1 })) },
      },
    });
  }

  // Una empresa distinta con el mismo patron de compra: nunca debe filtrar
  // recomendaciones hacia la primera empresa.
  const otraEmpresa = await prisma.empresa.create({ data: { nombre: 'Otra empresa', slug: SLUG_OTRA } });
  otraEmpresaId = otraEmpresa.id;
  const otraCategoria = await prisma.categoria.create({ data: { empresaId: otraEmpresaId, nombre: 'Ropa' } });
  const otroProducto = await prisma.producto.create({ data: { empresaId: otraEmpresaId, nombre: 'Campera', categoriaId: otraCategoria.id, precio: 400, stock: 5 } });
  await prisma.pedido.create({
    data: { empresaId: otraEmpresaId, items: { create: [{ productoId: otroProducto.id, nombre: otroProducto.nombre, precio: otroProducto.precio, cantidad: 1 }] } },
  });
});

after(async () => {
  await prisma.empresa.deleteMany({ where: { slug: { in: [SLUG, SLUG_OTRA] } } });
});

describe('productosRelacionados - co-compra sin IA', () => {
  test('ordena por frecuencia real de co-compra', async () => {
    const relacionados = await productosRelacionados(empresaId, zapatilla.id);
    assert.equal(relacionados.length, 2);
    assert.equal(relacionados[0].id, medias.id, 'medias se compro junto 2 veces, deberia ir primero');
    assert.equal(relacionados[1].id, gorra.id);
  });

  test('un producto sin ninguna co-compra devuelve vacio, nunca inventa nada', async () => {
    const relacionados = await productosRelacionados(empresaId, sinCompras.id);
    assert.deepEqual(relacionados, []);
  });

  test('nunca cruza datos entre empresas distintas', async () => {
    // La otra empresa tiene su propio patron de compra: pedirle
    // recomendaciones a un producto que no existe ahi no debe traer nada de
    // la empresa de test.
    const relacionados = await productosRelacionados(otraEmpresaId, zapatilla.id);
    assert.deepEqual(relacionados, []);
  });

  test('respeta el limite pedido', async () => {
    const relacionados = await productosRelacionados(empresaId, zapatilla.id, 1);
    assert.equal(relacionados.length, 1);
    assert.equal(relacionados[0].id, medias.id);
  });
});
