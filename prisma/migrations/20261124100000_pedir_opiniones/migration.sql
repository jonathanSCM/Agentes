-- Pedir comentarios a los clientes despues de un servicio. Todo aditivo.
-- El negocio decide si lo activa (por defecto apagado: son mensajes salientes a sus clientes).
ALTER TABLE "empresas" ADD COLUMN "pedirOpiniones" BOOLEAN NOT NULL DEFAULT false;

-- Cada pedido de comentario: una sola vez por pedido entregado o cita completada (unico por tipo + referencia).
CREATE TABLE "solicitudes_opinion" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "clienteId" INTEGER NOT NULL REFERENCES "clientes_finales"("id") ON DELETE CASCADE,
  -- PEDIDO | CITA
  "tipo" TEXT NOT NULL,
  "refId" INTEGER NOT NULL,
  -- Cuantos servicios completos lleva el cliente con este (1, 2, 3...)
  "numeroServicio" INTEGER NOT NULL DEFAULT 1,
  -- PROGRAMADA | ENVIANDO | ENVIADA | OMITIDA | FALLO
  "estado" TEXT NOT NULL DEFAULT 'PROGRAMADA',
  "motivo" TEXT,
  "programadaPara" TIMESTAMP(3) NOT NULL,
  "enviadaAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "solicitudes_opinion_tipo_refId_key" UNIQUE ("tipo", "refId")
);
CREATE INDEX "solicitudes_opinion_empresaId_estado_idx" ON "solicitudes_opinion"("empresaId", "estado");
CREATE INDEX "solicitudes_opinion_estado_programadaPara_idx" ON "solicitudes_opinion"("estado", "programadaPara");
CREATE INDEX "solicitudes_opinion_clienteId_idx" ON "solicitudes_opinion"("clienteId");
