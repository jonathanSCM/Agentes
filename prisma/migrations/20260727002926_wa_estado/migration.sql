-- AlterTable
ALTER TABLE "conexiones_whatsapp" ADD COLUMN     "estado" TEXT NOT NULL DEFAULT 'EN_PROCESO',
ADD COLUMN     "ultimoMensajeAt" TIMESTAMP(3),
ALTER COLUMN "phoneNumberId" DROP NOT NULL,
ALTER COLUMN "tokenCifrado" DROP NOT NULL;
