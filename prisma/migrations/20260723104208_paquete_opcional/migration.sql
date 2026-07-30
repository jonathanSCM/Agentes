-- DropForeignKey
ALTER TABLE "compras_paquete" DROP CONSTRAINT "compras_paquete_paqueteId_fkey";

-- AlterTable
ALTER TABLE "compras_paquete" ALTER COLUMN "paqueteId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "compras_paquete" ADD CONSTRAINT "compras_paquete_paqueteId_fkey" FOREIGN KEY ("paqueteId") REFERENCES "paquetes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
