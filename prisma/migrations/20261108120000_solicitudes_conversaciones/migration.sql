-- Pedidos de mas conversaciones: el cliente pide una cantidad con una nota ("voy a pagar...") y le llega
-- al buzon del superadmin, que aprueba y carga el paquete a mano (hasta tener pasarela de pago).
DO $$ BEGIN
  CREATE TYPE "EstadoSolicitud" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "solicitudes_conversaciones" (
  "id"               SERIAL PRIMARY KEY,
  "empresaId"        INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "cantidad"         INTEGER NOT NULL,
  "nota"             TEXT,
  "estado"           "EstadoSolicitud" NOT NULL DEFAULT 'PENDIENTE',
  "cantidadAprobada" INTEGER,
  "respuesta"        TEXT,
  "compraPaqueteId"  INTEGER REFERENCES "compras_paquete"("id") ON DELETE SET NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resueltaAt"       TIMESTAMP(3),
  CONSTRAINT "solicitudes_conversaciones_cantidad_check" CHECK ("cantidad" > 0)
);
CREATE INDEX IF NOT EXISTS "solicitudes_conversaciones_estado_createdAt_idx" ON "solicitudes_conversaciones"("estado", "createdAt");
CREATE INDEX IF NOT EXISTS "solicitudes_conversaciones_empresaId_idx" ON "solicitudes_conversaciones"("empresaId");
