-- Nuevos estados de CompraPaquete: PENDIENTE (comprada pero sin saldo
-- usable hasta confirmar el pago) y RECHAZADA (el pago no se confirmo).
ALTER TYPE "EstadoCompra" ADD VALUE IF NOT EXISTS 'PENDIENTE';
ALTER TYPE "EstadoCompra" ADD VALUE IF NOT EXISTS 'RECHAZADA';

-- Vinculo exacto entre un Pago (tipo PAQUETE) y la CompraPaquete que paga.
ALTER TABLE "pagos" ADD COLUMN "compraPaqueteId" INTEGER;
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_compraPaqueteId_fkey"
  FOREIGN KEY ("compraPaqueteId") REFERENCES "compras_paquete"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
