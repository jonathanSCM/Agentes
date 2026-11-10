-- Cuentas: lo que consume un cliente (servicio de su cita + extras) se junta en UNA cuenta y se cobra de una vez.
-- Todo aditivo. Una cuenta no toca stock ni caja hasta que se cobra (ahi se crea la venta).

CREATE TABLE "cuentas" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "citaId" INTEGER REFERENCES "citas"("id") ON DELETE SET NULL,
  "clienteId" INTEGER,
  "clienteNombre" TEXT,
  "estado" TEXT NOT NULL DEFAULT 'ABIERTA',
  "ventaId" INTEGER,
  "usuarioId" INTEGER,
  "motivoCancelacion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cobradaAt" TIMESTAMP(3),
  CONSTRAINT "cuentas_estado_valido" CHECK ("estado" IN ('ABIERTA', 'COBRADA', 'CANCELADA'))
);
CREATE INDEX "cuentas_empresaId_estado_idx" ON "cuentas"("empresaId", "estado");
-- Una cita tiene como mucho UNA cuenta viva (abierta o cobrada): dos cajeros que la abran a la vez no la duplican.
CREATE UNIQUE INDEX "cuentas_una_por_cita" ON "cuentas"("citaId") WHERE "citaId" IS NOT NULL AND "estado" <> 'CANCELADA';

CREATE TABLE "cuenta_items" (
  "id" SERIAL PRIMARY KEY,
  "cuentaId" INTEGER NOT NULL REFERENCES "cuentas"("id") ON DELETE CASCADE,
  "tipo" TEXT NOT NULL,
  "servicioId" INTEGER,
  "productoId" INTEGER,
  "varianteId" INTEGER,
  "recursoId" INTEGER,
  "nombre" TEXT NOT NULL,
  "cantidad" INTEGER NOT NULL,
  "precioUnitario" DECIMAL(10,2) NOT NULL,
  -- El servicio no tenia precio cargado: se puede escribir a mano en la cuenta.
  "precioLibre" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "cuenta_items_tipo_valido" CHECK ("tipo" IN ('SERVICIO', 'PRODUCTO')),
  CONSTRAINT "cuenta_items_cantidad_check" CHECK ("cantidad" > 0),
  CONSTRAINT "cuenta_items_precio_check" CHECK ("precioUnitario" >= 0)
);
CREATE INDEX "cuenta_items_cuentaId_idx" ON "cuenta_items"("cuentaId");

-- Las ventas guardan que servicio se cobro (para reportes); null en ventas de productos.
ALTER TABLE "venta_items" ADD COLUMN "servicioId" INTEGER;
