-- AlterTable
ALTER TABLE "clientes_finales" ADD COLUMN     "ubicacionLat" DOUBLE PRECISION,
ADD COLUMN     "ubicacionLng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "pedidos" ADD COLUMN     "entregaLat" DOUBLE PRECISION,
ADD COLUMN     "entregaLng" DOUBLE PRECISION;
