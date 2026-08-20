// Busqueda semantica para el catalogo (Opcion B de
// docs/05-propuesta-personalizacion-ia.md): que el bot encuentre un producto
// aunque el cliente no use las palabras exactas del catalogo ("polera" vs
// "remera", errores de tipeo). NO reemplaza el matching literal, que sigue
// siendo el camino principal (gratis, determinista, instantaneo) - esto es
// una red de seguridad para cuando el literal no encuentra nada.
//
// Sin pgvector (no disponible en este entorno): el embedding se guarda como
// un array simple (Producto.embedding, Float[]) y la similitud coseno se
// calcula en JS. Para un catalogo de 100-300 productos por tienda esto es
// instantaneo - no hace falta una extension de base de datos.
//
// Nunca bloquea nada: sin OPENAI_API_KEY, o si la red falla, todo esto
// devuelve null/[] y el catalogo sigue funcionando solo con matching literal.
const { prisma } = require('../db');

const MODELO_EMBEDDING = 'text-embedding-3-small';
// Umbral minimo de similitud coseno para aceptar un match semantico: por
// debajo de esto, es mejor decir la verdad ("no lo tenemos") que forzar un
// producto que en realidad no tiene nada que ver.
const UMBRAL_SIMILITUD = 0.3;

let openaiClient = null;
function getOpenAI() {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAI = require('openai');
  openaiClient = new OpenAI();
  return openaiClient;
}

async function generarEmbedding(texto) {
  const openai = getOpenAI();
  if (!openai || !texto || !texto.trim()) return null;
  try {
    const resp = await openai.embeddings.create({ model: MODELO_EMBEDDING, input: texto.slice(0, 8000) });
    return resp.data[0].embedding;
  } catch (err) {
    console.error('Error generando embedding:', err.message);
    return null;
  }
}

async function guardarEmbeddingDeProducto(productoId, texto) {
  const embedding = await generarEmbedding(texto);
  if (!embedding) return false;
  try {
    await prisma.producto.update({ where: { id: productoId }, data: { embedding } });
    return true;
  } catch (err) {
    console.error('Error guardando embedding de producto:', err.message);
    return false;
  }
}

// Producto punto normalizado por las normas: 1 = identicos, 0 = sin relacion,
// negativo = opuestos. Pura y determinista, sin red ni DB.
function similitudCoseno(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  let punto = 0, normaA = 0, normaB = 0;
  for (let i = 0; i < a.length; i++) {
    punto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  if (!normaA || !normaB) return 0;
  return punto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

async function buscarPorSimilitud(empresaId, textoConsulta, idsPermitidos, limite = 5) {
  if (!idsPermitidos || !idsPermitidos.length) return [];
  const embeddingConsulta = await generarEmbedding(textoConsulta);
  if (!embeddingConsulta) return [];

  const productos = await prisma.producto.findMany({
    where: { id: { in: idsPermitidos }, empresaId },
    select: { id: true, embedding: true },
  });

  return productos
    .map((p) => ({ id: p.id, similitud: similitudCoseno(embeddingConsulta, p.embedding) }))
    .filter((p) => p.similitud >= UMBRAL_SIMILITUD)
    .sort((a, b) => b.similitud - a.similitud)
    .slice(0, limite)
    .map((p) => p.id);
}

module.exports = { generarEmbedding, guardarEmbeddingDeProducto, similitudCoseno, buscarPorSimilitud, UMBRAL_SIMILITUD };
