-- Punto de venta (docs/11 F5): caja, ventas y pagos del mostrador. Aditiva.
-- Reglas de dinero en la base: montos no negativos, una sola caja abierta por empresa, ventas con numero
-- unico por empresa y clave de idempotencia (un doble clic no cobra dos veces).

CREATE TABLE IF NOT EXISTS "sesiones_caja" (
  "id"               SERIAL PRIMARY KEY,
  "empresaId"        INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "abiertaPorId"     INTEGER REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "cerradaPorId"     INTEGER REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "estado"           TEXT NOT NULL DEFAULT 'ABIERTA',
  "efectivoInicial"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  "efectivoEsperado" DECIMAL(12,2),
  "efectivoContado"  DECIMAL(12,2),
  "diferencia"       DECIMAL(12,2),
  "notas"            TEXT,
  "abiertaAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cerradaAt"        TIMESTAMP(3),
  CONSTRAINT "sesiones_caja_estado_check" CHECK ("estado" IN ('ABIERTA','CERRADA')),
  CONSTRAINT "sesiones_caja_inicial_check" CHECK ("efectivoInicial" >= 0)
);
-- Una sola caja abierta por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS "sesiones_caja_una_abierta" ON "sesiones_caja"("empresaId") WHERE "estado" = 'ABIERTA';
CREATE INDEX IF NOT EXISTS "sesiones_caja_empresaId_abiertaAt_idx" ON "sesiones_caja"("empresaId", "abiertaAt");

CREATE TABLE IF NOT EXISTS "movimientos_caja" (
  "id"        SERIAL PRIMARY KEY,
  "sesionId"  INTEGER NOT NULL REFERENCES "sesiones_caja"("id") ON DELETE CASCADE,
  "tipo"      TEXT NOT NULL,
  "monto"     DECIMAL(12,2) NOT NULL,
  "nota"      TEXT,
  "usuarioId" INTEGER REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "movimientos_caja_tipo_check" CHECK ("tipo" IN ('ENTRADA','SALIDA')),
  CONSTRAINT "movimientos_caja_monto_check" CHECK ("monto" > 0)
);
CREATE INDEX IF NOT EXISTS "movimientos_caja_sesionId_idx" ON "movimientos_caja"("sesionId");

CREATE TABLE IF NOT EXISTS "ventas" (
  "id"                SERIAL PRIMARY KEY,
  "empresaId"         INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "numero"            INTEGER NOT NULL,
  "sesionCajaId"      INTEGER REFERENCES "sesiones_caja"("id") ON DELETE SET NULL,
  "cajeroId"          INTEGER REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "clienteId"         INTEGER REFERENCES "clientes_finales"("id") ON DELETE SET NULL,
  "clienteNombre"     TEXT,
  "subtotal"          DECIMAL(12,2) NOT NULL,
  "descuento"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total"             DECIMAL(12,2) NOT NULL,
  "estado"            TEXT NOT NULL DEFAULT 'COMPLETADA',
  "claveIdempotencia" TEXT,
  "tokenRecibo"       TEXT NOT NULL,
  "pedidoId"          INTEGER REFERENCES "pedidos"("id") ON DELETE SET NULL,
  "anuladaAt"         TIMESTAMP(3),
  "anuladaPorId"      INTEGER REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "motivoAnulacion"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ventas_estado_check" CHECK ("estado" IN ('COMPLETADA','ANULADA')),
  CONSTRAINT "ventas_montos_check" CHECK ("subtotal" >= 0 AND "descuento" >= 0 AND "total" >= 0 AND "descuento" <= "subtotal")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ventas_empresaId_numero_key" ON "ventas"("empresaId", "numero");
CREATE UNIQUE INDEX IF NOT EXISTS "ventas_empresaId_claveIdempotencia_key" ON "ventas"("empresaId", "claveIdempotencia") WHERE "claveIdempotencia" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ventas_tokenRecibo_key" ON "ventas"("tokenRecibo");
CREATE UNIQUE INDEX IF NOT EXISTS "ventas_pedidoId_key" ON "ventas"("pedidoId") WHERE "pedidoId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ventas_empresaId_createdAt_idx" ON "ventas"("empresaId", "createdAt");
CREATE INDEX IF NOT EXISTS "ventas_sesionCajaId_idx" ON "ventas"("sesionCajaId");

CREATE TABLE IF NOT EXISTS "venta_items" (
  "id"             SERIAL PRIMARY KEY,
  "ventaId"        INTEGER NOT NULL REFERENCES "ventas"("id") ON DELETE CASCADE,
  "productoId"     INTEGER REFERENCES "productos"("id") ON DELETE SET NULL,
  "varianteId"     INTEGER REFERENCES "variantes"("id") ON DELETE SET NULL,
  "nombre"         TEXT NOT NULL,
  "cantidad"       INTEGER NOT NULL,
  "precioUnitario" DECIMAL(12,2) NOT NULL,
  "descuento"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total"          DECIMAL(12,2) NOT NULL,
  "costoUnitario"  DECIMAL(12,2),
  CONSTRAINT "venta_items_montos_check" CHECK ("cantidad" > 0 AND "precioUnitario" >= 0 AND "descuento" >= 0 AND "total" >= 0)
);
CREATE INDEX IF NOT EXISTS "venta_items_ventaId_idx" ON "venta_items"("ventaId");
CREATE INDEX IF NOT EXISTS "venta_items_productoId_idx" ON "venta_items"("productoId");

CREATE TABLE IF NOT EXISTS "venta_pagos" (
  "id"         SERIAL PRIMARY KEY,
  "ventaId"    INTEGER NOT NULL REFERENCES "ventas"("id") ON DELETE CASCADE,
  "metodo"     TEXT NOT NULL,
  "monto"      DECIMAL(12,2) NOT NULL,
  "recibido"   DECIMAL(12,2),
  "vuelto"     DECIMAL(12,2),
  "referencia" TEXT,
  CONSTRAINT "venta_pagos_metodo_check" CHECK ("metodo" IN ('EFECTIVO','QR','TARJETA','TRANSFERENCIA')),
  CONSTRAINT "venta_pagos_monto_check" CHECK ("monto" > 0)
);
CREATE INDEX IF NOT EXISTS "venta_pagos_ventaId_idx" ON "venta_pagos"("ventaId");
