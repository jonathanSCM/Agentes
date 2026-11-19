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

// `contexto` ({ empresaId, agenteId? }) permite medir el consumo: cada embedding queda en usos_ia (servicio "embedding") con su costo.
async function generarEmbedding(texto, contexto = {}) {
  const openai = getOpenAI();
  if (!openai || !texto || !texto.trim()) return null;
  const t0 = Date.now();
  const medir = (extra) => (contexto.empresaId ? require('./usoIA').registrarSinRiesgo({
    empresaId: contexto.empresaId, agenteId: contexto.agenteId || null, proveedor: 'openai', modelo: MODELO_EMBEDDING, servicio: 'embedding',
    proposito: contexto.proposito || 'busqueda_semantica', latenciaMs: Date.now() - t0, ...extra,
  }) : null);
  try {
    const resp = await openai.embeddings.create({ model: MODELO_EMBEDDING, input: texto.slice(0, 8000) });
    await medir({ estado: 'COMPLETADA', promptTokens: (resp.usage && (resp.usage.prompt_tokens || resp.usage.total_tokens)) || 0, solicitudId: resp._request_id || null });
    return resp.data[0].embedding;
  } catch (err) {
    console.error('Error generando embedding:', err.message);
    await medir({ estado: 'FALLIDA', error: (err && (err.code || err.status)) || 'ERROR' });
    return null;
  }
}

async function guardarEmbeddingDeProducto(productoId, texto) {
  // Se mide a nombre de la empresa dueña del producto.
  const dueno = await prisma.producto.findUnique({ where: { id: productoId }, select: { empresaId: true } }).catch(() => null);
  const embedding = await generarEmbedding(texto, { empresaId: dueno && dueno.empresaId, proposito: 'embedding_producto' });
  if (!embedding) return false;
  try {
    await prisma.producto.update({ where: { id: productoId }, data: { embedding } });
    return true;
  } catch (err) {
    // P2025: el producto se borro mientras se generaba el vector (se corre sin
    // esperar tras guardar). No es un error: no hay nada que guardar.
    if (err && err.code === 'P2025') return false;
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
  const embeddingConsulta = await generarEmbedding(textoConsulta, { empresaId, proposito: 'busqueda_semantica' });
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
