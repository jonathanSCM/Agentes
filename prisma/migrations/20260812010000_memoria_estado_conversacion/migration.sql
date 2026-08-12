-- CreateEnum
CREATE TYPE "EstadoConversacion" AS ENUM ('EXPLORANDO', 'BUSCANDO_PRODUCTO', 'COMPARANDO', 'INTERESADO', 'INTENCION_DE_COMPRA', 'LISTO_PARA_COMPRAR');

-- AlterTable
ALTER TABLE "clientes_finales"
  ADD COLUMN "marca" TEXT,
  ADD COLUMN "talla" TEXT,
  ADD COLUMN "color" TEXT,
  ADD COLUMN "estadoConversacion" "EstadoConversacion" NOT NULL DEFAULT 'EXPLORANDO',
  ADD COLUMN "productosMostrados" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "productosDescartados" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "productoFavoritoId" INTEGER;
