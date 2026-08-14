-- AlterTable
ALTER TABLE "planes"
  ADD COLUMN "mensualidadUsd" DECIMAL(10,2),
  ADD COLUMN "implementacionUsd" DECIMAL(10,2),
  ADD COLUMN "primerPagoUsd" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "plan_precios_pais" (
  "id" SERIAL PRIMARY KEY,
  "planId" INTEGER NOT NULL REFERENCES "planes"("id") ON DELETE CASCADE,
  "pais" TEXT NOT NULL,
  "moneda" TEXT NOT NULL,
  "mensualidad" DECIMAL(10,2) NOT NULL,
  "implementacion" DECIMAL(10,2) NOT NULL,
  "primerPago" DECIMAL(10,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "plan_precios_pais_planId_pais_key" ON "plan_precios_pais"("planId", "pais");

-- CreateTable
CREATE TABLE "paquete_precios_pais" (
  "id" SERIAL PRIMARY KEY,
  "paqueteId" INTEGER NOT NULL REFERENCES "paquetes"("id") ON DELETE CASCADE,
  "pais" TEXT NOT NULL,
  "moneda" TEXT NOT NULL,
  "precio" DECIMAL(10,2) NOT NULL,
  "costoUnitario" DECIMAL(10,4) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "paquete_precios_pais_paqueteId_pais_key" ON "paquete_precios_pais"("paqueteId", "pais");
