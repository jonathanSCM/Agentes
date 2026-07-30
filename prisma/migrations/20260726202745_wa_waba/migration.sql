-- AlterTable
ALTER TABLE "conexiones_whatsapp" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "wabaId" TEXT;
