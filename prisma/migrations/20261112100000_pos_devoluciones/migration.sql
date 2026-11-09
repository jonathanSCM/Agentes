-- POS fase 2: devoluciones y cobro de pedidos de WhatsApp en el mostrador. Todo aditivo.

CREATE TABLE "devoluciones" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "ventaId" INTEGER NOT NULL REFERENCES "ventas"("id") ON DELETE CASCADE,
  -- La caja que estaba abierta cuando salió el dinero (una devolución en efectivo resta de ESA caja).
  "sesionCajaId" INTEGER REFERENCES "sesiones_caja"("id") ON DELETE SET NULL,
  "usuarioId" INTEGER,
  -- EFECTIVO | QR | TARJETA | TRANSFERENCIA: cómo se le devolvió el dinero al cliente.
  "metodo" TEXT NOT NULL,
  "monto" DECIMAL(12,2) NOT NULL,
  -- true = los productos vuelven al stock; false = no (por ejemplo, vinieron dañados).
  "repone" BOOLEAN NOT NULL DEFAULT true,
  "motivo" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "devoluciones_monto_positivo" CHECK ("monto" > 0),
  CONSTRAINT "devoluciones_metodo_valido" CHECK ("metodo" IN ('EFECTIVO', 'QR', 'TARJETA', 'TRANSFERENCIA'))
);
CREATE INDEX "devoluciones_empresaId_createdAt_idx" ON "devoluciones"("empresaId", "createdAt");
CREATE INDEX "devoluciones_ventaId_idx" ON "devoluciones"("ventaId");
CREATE INDEX "devoluciones_sesionCajaId_idx" ON "devoluciones"("sesionCajaId");

CREATE TABLE "devolucion_items" (
  "id" SERIAL PRIMARY KEY,
  "devolucionId" INTEGER NOT NULL REFERENCES "devoluciones"("id") ON DELETE CASCADE,
  "ventaItemId" INTEGER NOT NULL REFERENCES "venta_items"("id") ON DELETE CASCADE,
  "cantidad" INTEGER NOT NULL,
  "monto" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "devolucion_items_cantidad_positiva" CHECK ("cantidad" > 0),
  CONSTRAINT "devolucion_items_monto_no_negativo" CHECK ("monto" >= 0)
);
CREATE INDEX "devolucion_items_devolucionId_idx" ON "devolucion_items"("devolucionId");
CREATE INDEX "devolucion_items_ventaItemId_idx" ON "devolucion_items"("ventaItemId");

-- Un pedido de WhatsApp se cobra en el mostrador una sola vez (aunque se cobre desde dos pantallas a la vez).
CREATE UNIQUE INDEX "ventas_pedidoId_unico" ON "ventas"("pedidoId") WHERE "pedidoId" IS NOT NULL;
