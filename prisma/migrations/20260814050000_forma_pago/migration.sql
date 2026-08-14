CREATE TYPE "FormaPago" AS ENUM ('QR', 'EFECTIVO', 'TARJETA');

ALTER TABLE "agente_config" ADD COLUMN "aceptaQr" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agente_config" ADD COLUMN "qrCobroUrl" TEXT;
ALTER TABLE "agente_config" ADD COLUMN "aceptaEfectivo" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "agente_config" ADD COLUMN "aceptaTarjeta" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "clientes_finales" ADD COLUMN "formaPago" "FormaPago";

ALTER TABLE "pedidos" ADD COLUMN "formaPago" "FormaPago";
