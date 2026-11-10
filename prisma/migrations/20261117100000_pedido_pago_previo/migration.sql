-- Pedidos que ya vienen pagados (QR, tarjeta, transferencia): se registra cuanto y como se pago, para no cobrarlos de nuevo.
-- Todo aditivo. pagadoMonto = 0 significa "todavia no pago nada" (lo que tienen todos los pedidos de hoy).
ALTER TABLE "pedidos" ADD COLUMN "pagadoMonto" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "pedidos" ADD COLUMN "pagoMetodo" TEXT;
ALTER TABLE "pedidos" ADD COLUMN "pagadoAt" TIMESTAMP(3);
ALTER TABLE "pedidos" ADD CONSTRAINT "pedidos_pagado_check" CHECK ("pagadoMonto" >= 0);
