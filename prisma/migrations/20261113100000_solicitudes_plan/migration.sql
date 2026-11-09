-- Pedidos de CAMBIO DE PLAN: el cliente elige un plan y una duración; el superadmin lo aprueba (hasta que haya pasarela de pago).
-- Aditiva: no toca nada existente.
CREATE TABLE "solicitudes_plan" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "planId" INTEGER REFERENCES "planes"("id") ON DELETE SET NULL,
  -- Nombre del plan al pedirlo (queda legible aunque el plan cambie o se retire).
  "planNombre" TEXT NOT NULL,
  "meses" INTEGER NOT NULL,
  "nota" TEXT,
  "estado" "EstadoSolicitud" NOT NULL DEFAULT 'PENDIENTE',
  "respuesta" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resueltaAt" TIMESTAMP(3),
  CONSTRAINT "solicitudes_plan_meses_valido" CHECK ("meses" IN (1, 2, 3, 6, 12))
);
CREATE INDEX "solicitudes_plan_estado_createdAt_idx" ON "solicitudes_plan"("estado", "createdAt");
CREATE INDEX "solicitudes_plan_empresaId_idx" ON "solicitudes_plan"("empresaId");
