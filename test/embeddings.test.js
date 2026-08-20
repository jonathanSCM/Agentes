// Busqueda semantica del catalogo (Opcion B de docs/05-propuesta-...).
// similitudCoseno es pura (sin red/DB). generarEmbedding/buscarPorSimilitud
// se testean contra la base local real, siguiendo el patron ya establecido
// en el proyecto (datos aislados, se limpian despues).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { similitudCoseno, generarEmbedding, guardarEmbeddingDeProducto, buscarPorSimilitud } = require('../lib/services/embeddings');

describe('similitudCoseno - pura, sin red ni DB', () => {
  test('vectores identicos dan similitud 1', () => {
    assert.equal(similitudCoseno([1, 0, 0], [1, 0, 0]), 1);
  });

  test('vectores opuestos dan similitud -1', () => {
    assert.equal(similitudCoseno([1, 0], [-1, 0]), -1);
  });

  test('vectores perpendiculares dan similitud 0', () => {
    assert.equal(similitudCoseno([1, 0], [0, 1]), 0);
  });

  test('nunca revienta con vectores vacios, nulos o de largo distinto', () => {
    assert.equal(similitudCoseno(null, [1, 2]), 0);
    assert.equal(similitudCoseno([], []), 0);
    assert.equal(similitudCoseno([1, 2], [1, 2, 3]), 0);
    assert.equal(similitudCoseno(undefined, undefined), 0);
  });
});

describe('generarEmbedding/buscarPorSimilitud - nunca rompen sin API key', () => {
  test('generarEmbedding sin OPENAI_API_KEY devuelve null, no revienta', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const r = await generarEmbedding('zapatillas rojas');
      assert.equal(r, null);
    } finally {
      if (original) process.env.OPENAI_API_KEY = original;
    }
  });

  test('buscarPorSimilitud sin ids permitidos devuelve vacio sin tocar la red', async () => {
    const r = await buscarPorSimilitud(1, 'algo', [], 3);
    assert.deepEqual(r, []);
  });
});

describe('embeddings reales contra la API (solo si hay OPENAI_API_KEY)', { skip: !process.env.OPENAI_API_KEY }, () => {
  const SLUG = 'test-embeddings';
  let empresaId, poleraId, pantalonId;

  before(async () => {
    await prisma.empresa.deleteMany({ where: { slug: SLUG } });
    const empresa = await prisma.empresa.create({ data: { nombre: 'Empresa Embeddings', slug: SLUG } });
    empresaId = empresa.id;
    const categoria = await prisma.categoria.create({ data: { empresaId, nombre: 'Ropa' } });
    const polera = await prisma.producto.create({
      data: { empresaId, nombre: 'Polera basica de algodon', categoriaId: categoria.id, precio: 80, stock: 10 },
    });
    poleraId = polera.id;
    const pantalon = await prisma.producto.create({
      data: { empresaId, nombre: 'Pantalon jean recto', categoriaId: categoria.id, precio: 200, stock: 10 },
    });
    pantalonId = pantalon.id;

    await guardarEmbeddingDeProducto(poleraId, 'Polera basica de algodon');
    await guardarEmbeddingDeProducto(pantalonId, 'Pantalon jean recto');
  });

  after(async () => {
    await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  });

  test('un sinonimo ("remera") encuentra la polera, no el pantalon', async () => {
    const ids = await buscarPorSimilitud(empresaId, 'remera de algodon', [poleraId, pantalonId], 3);
    assert.ok(ids.includes(poleraId), 'deberia encontrar la polera por significado');
    assert.equal(ids[0], poleraId, 'la polera deberia ser el resultado mas cercano');
  });

  test('nunca cruza productos de otra empresa (idsPermitidos siempre filtra)', async () => {
    const ids = await buscarPorSimilitud(empresaId, 'remera', [], 3);
    assert.deepEqual(ids, []);
  });
});
