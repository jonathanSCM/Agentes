// Genera el embedding de busqueda semantica (Producto.embedding) para todos
// los productos activos que todavia no lo tienen. Correr una vez despues de
// cargar un catalogo nuevo, o si se cambia el modelo de embeddings:
//
//   node scripts/generar-embeddings.js
//
// Sin OPENAI_API_KEY no hace nada (cada producto queda con embedding vacio,
// el catalogo sigue funcionando solo con matching literal).
const { prisma } = require('../lib/db');
const { guardarEmbeddingDeProducto } = require('../lib/services/embeddings');

function textoParaEmbedding(p) {
  const atributos = Object.entries(p.atributos || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  return [p.nombre, p.descripcion, atributos, (p.caracteristicas || []).join(', ')].filter(Boolean).join('. ');
}

(async () => {
  const productos = await prisma.producto.findMany({
    where: { activo: true, embedding: { isEmpty: true } },
    select: { id: true, nombre: true, descripcion: true, atributos: true, caracteristicas: true },
  });

  console.log(`${productos.length} producto(s) sin embedding.`);
  if (!productos.length) {
    await prisma.$disconnect();
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.log('Sin OPENAI_API_KEY configurada: no se puede generar nada.');
    await prisma.$disconnect();
    return;
  }

  let ok = 0, fallidos = 0;
  for (const p of productos) {
    const exito = await guardarEmbeddingDeProducto(p.id, textoParaEmbedding(p));
    if (exito) ok++; else fallidos++;
    console.log(`[${ok + fallidos}/${productos.length}] ${p.nombre} -> ${exito ? 'ok' : 'fallo'}`);
    // Pausa chica para no saturar la API con catalogos grandes.
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`Listo: ${ok} generados, ${fallidos} fallidos.`);
  await prisma.$disconnect();
})();
