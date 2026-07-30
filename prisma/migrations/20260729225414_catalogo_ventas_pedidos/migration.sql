/*
  Warnings:

  - Added the required column `updatedAt` to the `clientes_finales` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "NivelInteres" AS ENUM ('FRIO', 'TIBIO', 'CALIENTE');

-- CreateEnum
CREATE TYPE "EstadoLead" AS ENUM ('NUEVO', 'EN_CONVERSACION', 'CALIFICADO', 'PEDIDO_CREADO', 'DERIVADO_A_ASESOR', 'CERRADO', 'NO_INTERESADO');

-- AlterTable
ALTER TABLE "clientes_finales" ADD COLUMN     "cantidad" TEXT,
ADD COLUMN     "categoriaInteres" TEXT,
ADD COLUMN     "contexto" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "direccionEntrega" TEXT,
ADD COLUMN     "estadoLead" "EstadoLead" NOT NULL DEFAULT 'NUEVO',
ADD COLUMN     "nivelInteres" "NivelInteres" NOT NULL DEFAULT 'FRIO',
ADD COLUMN     "observaciones" TEXT,
ADD COLUMN     "presupuesto" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "pedidos" ADD COLUMN     "direccionEntrega" TEXT,
ADD COLUMN     "notas" TEXT;

-- AlterTable
ALTER TABLE "productos" ADD COLUMN     "caracteristicas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "categoria" TEXT,
ADD COLUMN     "fotos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "pedido_items" (
    "id" SERIAL NOT NULL,
    "pedidoId" INTEGER NOT NULL,
    "productoId" INTEGER,
    "nombre" TEXT NOT NULL,
    "precio" DECIMAL(10,2) NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pedido_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pedido_items_pedidoId_idx" ON "pedido_items"("pedidoId");

-- AddForeignKey
ALTER TABLE "pedido_items" ADD CONSTRAINT "pedido_items_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido_items" ADD CONSTRAINT "pedido_items_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
