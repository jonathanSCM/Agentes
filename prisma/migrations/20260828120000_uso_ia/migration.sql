-- Costo real de IA que paga Proshop (no el cliente) por cada llamada a
-- OpenAI/Anthropic. Dashboard interno /admin/costo-ia.
CREATE TABLE IF NOT EXISTS "usos_ia" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "conversacionId" INTEGER,
    "proveedor" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "proposito" TEXT NOT NULL DEFAULT 'respuesta',
    "vuelta" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usos_ia_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "usos_ia_empresaId_createdAt_idx" ON "usos_ia"("empresaId", "createdAt");

ALTER TABLE "usos_ia"
  ADD CONSTRAINT "usos_ia_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
