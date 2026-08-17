-- Categorias en dos niveles: RUBRO (padreId null) -> SUBCATEGORIA.
-- El bot lista rubros cuando le piden "el catalogo", y las subcategorias del
-- rubro que el cliente elija. Los productos siempre cuelgan de la hoja.
--
-- Idempotente: se puede reaplicar sin romper nada.

ALTER TABLE "categorias" ADD COLUMN IF NOT EXISTS "padreId" INTEGER;
ALTER TABLE "categorias" ADD COLUMN IF NOT EXISTS "orden" INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE "categorias" ADD CONSTRAINT "categorias_padreId_fkey"
    FOREIGN KEY ("padreId") REFERENCES "categorias"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "categorias_empresaId_padreId_idx" ON "categorias"("empresaId", "padreId");
