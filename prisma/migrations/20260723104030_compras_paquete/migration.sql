-- CreateEnum
CREATE TYPE "EstadoCompra" AS ENUM ('ACTIVA', 'AGOTADA', 'VENCIDA');

-- CreateTable
CREATE TABLE "compras_paquete" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "paqueteId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "consumidas" INTEGER NOT NULL DEFAULT 0,
    "precioUsd" DECIMAL(10,2) NOT NULL,
    "fechaCompra" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaRenovacion" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoCompra" NOT NULL DEFAULT 'ACTIVA',
    "nota" TEXT,

    CONSTRAINT "compras_paquete_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compras_paquete_empresaId_estado_idx" ON "compras_paquete"("empresaId", "estado");

-- AddForeignKey
ALTER TABLE "compras_paquete" ADD CONSTRAINT "compras_paquete_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compras_paquete" ADD CONSTRAINT "compras_paquete_paqueteId_fkey" FOREIGN KEY ("paqueteId") REFERENCES "paquetes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
