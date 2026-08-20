-- Embedding para busqueda semantica (ver lib/services/embeddings.js). Array
-- simple de Postgres, sin extension: el catalogo de una tienda es chico
-- (100-300 productos), asi que calcular similitud coseno en JS al buscar es
-- instantaneo, sin depender de pgvector.
ALTER TABLE "productos" ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT '{}';
