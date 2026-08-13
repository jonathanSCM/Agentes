-- AlterTable
ALTER TABLE "productos"
  ADD COLUMN "atributos" JSONB NOT NULL DEFAULT '{}';
