-- Proveedores y compras de mercaderia (POS P3). Todo aditivo: tablas nuevas.

CREATE TABLE "proveedores" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "nombre" TEXT NOT NULL,
  "contacto" TEXT,
  "telefono" TEXT,
  "email" TEXT,
  "notas" TEXT,
  "activo" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "proveedores_empresaId_idx" ON "proveedores"("empresaId");

CREATE TABLE "compras" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "numero" INTEGER NOT NULL,
  "proveedorId" INTEGER REFERENCES "proveedores"("id") ON DELETE SET NULL,
  "proveedorNombre" TEXT,
  "referencia" TEXT,
  "estado" TEXT NOT NULL DEFAULT 'RECIBIDA',
  "total" DECIMAL(12,2) NOT NULL,
  "pagoEstado" TEXT NOT NULL DEFAULT 'PENDIENTE',
  "pagoMetodo" TEXT,
  "pagadaAt" TIMESTAMP(3),
  "notas" TEXT,
  "claveIdempotencia" TEXT,
  "usuarioId" INTEGER REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anuladaAt" TIMESTAMP(3),
  "anuladaPorId" INTEGER,
  "motivoAnulacion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "compras_estado_valido" CHECK ("estado" IN ('RECIBIDA', 'ANULADA')),
  CONSTRAINT "compras_pago_estado_valido" CHECK ("pagoEstado" IN ('PENDIENTE', 'PAGADA')),
  CONSTRAINT "compras_total_check" CHECK ("total" >= 0)
);
CREATE UNIQUE INDEX "compras_empresaId_numero_key" ON "compras"("empresaId", "numero");
CREATE UNIQUE INDEX "compras_empresaId_claveIdempotencia_key" ON "compras"("empresaId", "claveIdempotencia");
CREATE INDEX "compras_empresaId_createdAt_idx" ON "compras"("empresaId", "createdAt");
CREATE INDEX "compras_proveedorId_idx" ON "compras"("proveedorId");

CREATE TABLE "compra_items" (
  "id" SERIAL PRIMARY KEY,
  "compraId" INTEGER NOT NULL REFERENCES "compras"("id") ON DELETE CASCADE,
  "productoId" INTEGER,
  "varianteId" INTEGER,
  "nombre" TEXT NOT NULL,
  "cantidad" INTEGER NOT NULL,
  "costoUnitario" DECIMAL(10,2) NOT NULL,
  "total" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "compra_items_cantidad_check" CHECK ("cantidad" > 0),
  CONSTRAINT "compra_items_costo_check" CHECK ("costoUnitario" >= 0)
);
CREATE INDEX "compra_items_compraId_idx" ON "compra_items"("compraId");
