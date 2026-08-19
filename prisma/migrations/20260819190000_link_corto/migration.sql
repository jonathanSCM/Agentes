-- Acortador propio de links (ver LinkCorto en schema.prisma).
CREATE TABLE IF NOT EXISTS "links_cortos" (
  "id" SERIAL PRIMARY KEY,
  "destino" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
