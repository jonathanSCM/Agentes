-- Stock unificado (docs/11 F4): un solo stock para el bot, el mostrador y el panel.
--   - historial de movimientos (kardex): todo cambio de stock queda registrado con antes/despues
--   - restricciones: el stock nunca baja de 0, aunque falle un camino de codigo
--   - costo (margen en el panel comercial) y codigo de barras (lector del punto de venta)
-- Aditiva: nada se borra.

ALTER TABLE "productos"
  ADD COLUMN IF NOT EXISTS "costo"        DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "codigoBarras" TEXT;
ALTER TABLE "variantes"
  ADD COLUMN IF NOT EXISTS "costo"        DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "codigoBarras" TEXT;

CREATE INDEX IF NOT EXISTS "productos_empresaId_codigoBarras_idx" ON "productos"("empresaId", "codigoBarras");
CREATE INDEX IF NOT EXISTS "variantes_codigoBarras_idx" ON "variantes"("codigoBarras");

-- Red de seguridad en la base (hoy no hay filas negativas).
DO $$ BEGIN
  ALTER TABLE "productos" ADD CONSTRAINT "productos_stock_no_negativo" CHECK ("stock" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "variantes" ADD CONSTRAINT "variantes_stock_no_negativo" CHECK ("stock" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "movimientos_stock" (
  "id"             SERIAL PRIMARY KEY,
  "empresaId"      INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "productoId"     INTEGER REFERENCES "productos"("id") ON DELETE SET NULL,
  "varianteId"     INTEGER REFERENCES "variantes"("id") ON DELETE SET NULL,
  -- Se guarda el nombre: el historial se entiende aunque despues se borre el producto.
  "nombre"         TEXT NOT NULL,
  "tipo"           TEXT NOT NULL,
  -- Con signo: negativo = salio, positivo = entro.
  "cantidad"       INTEGER NOT NULL,
  "stockAntes"     INTEGER NOT NULL,
  "stockDespues"   INTEGER NOT NULL,
  "referenciaTipo" TEXT,
  "referenciaId"   INTEGER,
  "usuarioId"      INTEGER REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "nota"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "movimientos_stock_stock_check" CHECK ("stockAntes" >= 0 AND "stockDespues" >= 0),
  CONSTRAINT "movimientos_stock_tipo_check" CHECK ("tipo" IN ('INICIAL','PEDIDO','CANCELACION_PEDIDO','AJUSTE','IMPORTACION','VENTA','ANULACION_VENTA','DEVOLUCION_VENTA','COMPRA'))
);
CREATE INDEX IF NOT EXISTS "movimientos_stock_empresaId_createdAt_idx" ON "movimientos_stock"("empresaId", "createdAt");
CREATE INDEX IF NOT EXISTS "movimientos_stock_productoId_createdAt_idx" ON "movimientos_stock"("productoId", "createdAt");
