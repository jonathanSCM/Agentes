CREATE TABLE "categorias" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "nombre" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "categorias_empresaId_nombre_key" ON "categorias"("empresaId", "nombre");

CREATE TABLE "categoria_atributos" (
  "id" SERIAL PRIMARY KEY,
  "categoriaId" INTEGER NOT NULL REFERENCES "categorias"("id") ON DELETE CASCADE,
  "nombre" TEXT NOT NULL,
  "obligatorio" BOOLEAN NOT NULL DEFAULT false,
  "esDeVariante" BOOLEAN NOT NULL DEFAULT false,
  "orden" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "categoria_atributos_categoriaId_nombre_key" ON "categoria_atributos"("categoriaId", "nombre");

ALTER TABLE "productos" ADD COLUMN "categoriaId" INTEGER;
ALTER TABLE "productos" ADD CONSTRAINT "productos_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "categorias"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "productos_categoriaId_idx" ON "productos"("categoriaId");

ALTER TABLE "clientes_finales" ADD COLUMN "categoriaId" INTEGER;
ALTER TABLE "clientes_finales" ADD COLUMN "atributosLead" JSONB NOT NULL DEFAULT '{}';
