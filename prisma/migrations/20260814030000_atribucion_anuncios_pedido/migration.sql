ALTER TABLE "conversaciones" ADD COLUMN "anuncioId" TEXT;
ALTER TABLE "conversaciones" ADD COLUMN "anuncioTitulo" TEXT;
ALTER TABLE "conversaciones" ADD COLUMN "anuncioImagenUrl" TEXT;

ALTER TABLE "pedidos" ADD COLUMN "conversacionId" INTEGER;
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "conversaciones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
