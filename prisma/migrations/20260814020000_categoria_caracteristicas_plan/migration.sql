-- CreateEnum
CREATE TYPE "PlanCategoria" AS ENUM ('PERSONAL', 'EMPRESARIAL');

-- AlterTable
ALTER TABLE "planes"
  ADD COLUMN "categoria" "PlanCategoria" NOT NULL DEFAULT 'PERSONAL';

-- CreateTable
CREATE TABLE "caracteristicas" (
  "id" SERIAL PRIMARY KEY,
  "nombre" TEXT NOT NULL,
  "orden" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "caracteristicas_nombre_key" ON "caracteristicas"("nombre");

-- CreateTable
CREATE TABLE "plan_caracteristicas" (
  "id" SERIAL PRIMARY KEY,
  "planId" INTEGER NOT NULL REFERENCES "planes"("id") ON DELETE CASCADE,
  "caracteristicaId" INTEGER NOT NULL REFERENCES "caracteristicas"("id") ON DELETE CASCADE,
  "incluida" BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "plan_caracteristicas_planId_caracteristicaId_key" ON "plan_caracteristicas"("planId", "caracteristicaId");
