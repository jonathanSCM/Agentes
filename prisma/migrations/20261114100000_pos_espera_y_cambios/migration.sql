-- POS pulido: ventas en espera y cambio de producto. Todo aditivo (solo se relaja un CHECK de devoluciones).

-- Ventas en espera: un carrito que se deja guardado (no toca el stock ni la caja) para retomarlo despues o en otro equipo.
CREATE TABLE "ventas_espera" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "usuarioId" INTEGER,
  "etiqueta" TEXT,
  -- [{ productoId, varianteId, cantidad, descuento }]: los precios NO se guardan, se leen de nuevo al retomar.
  "lineas" JSONB NOT NULL,
  "descuento" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "clienteId" INTEGER,
  "clienteNombre" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ventas_espera_descuento_check" CHECK ("descuento" >= 0)
);
CREATE INDEX "ventas_espera_empresaId_createdAt_idx" ON "ventas_espera"("empresaId", "createdAt");

-- Cambio de producto: la venta nueva guarda cuanto credito trajo del cambio y de que venta viene.
ALTER TABLE "ventas" ADD COLUMN "creditoCambio" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "ventas" ADD COLUMN "cambioDeVentaId" INTEGER;
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_credito_cambio_check" CHECK ("creditoCambio" >= 0 AND "creditoCambio" <= "total");

-- Una devolucion "por cambio" no mueve dinero: el valor devuelto se aplica a la venta nueva.
ALTER TABLE "devoluciones" DROP CONSTRAINT "devoluciones_metodo_valido";
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_metodo_valido" CHECK ("metodo" IN ('EFECTIVO', 'QR', 'TARJETA', 'TRANSFERENCIA', 'CAMBIO'));
