-- Historial de actividad del agente (fase 3 del planning). Todo aditivo.
-- Detalle con retencion de 120 dias (turnos y eventos); lo contable (usos_ia, resumenes diarios, auditoria) se conserva siempre.

-- Un registro por cada mensaje de un cliente que se atiende.
CREATE TABLE "ia_turnos" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "agenteId" INTEGER,
  "conversacionId" INTEGER,
  -- Telefono enmascarado (5917***555): el historial no guarda el numero completo.
  "telefonoMasc" TEXT,
  -- TEXTO | BOTON | PRUEBA (chat de prueba del panel)
  "entrada" TEXT NOT NULL DEFAULT 'TEXTO',
  -- FLUJO (sin IA) | IA | SIN_IA (modo sin IA por caida o tope) | CITAS (bot de citas) | GUARDIA (bloqueado por la guardia)
  "ruta" TEXT NOT NULL DEFAULT 'FLUJO',
  "modelo" TEXT,
  "llamadasIA" INTEGER NOT NULL DEFAULT 0,
  "fallidasIA" INTEGER NOT NULL DEFAULT 0,
  "tokensEntrada" INTEGER NOT NULL DEFAULT 0,
  "tokensSalida" INTEGER NOT NULL DEFAULT 0,
  "costoUsd" DECIMAL(12,6),
  "latenciaMs" INTEGER,
  -- EN_CURSO | OK | DERIVADO | SIN_RESPUESTA | ERROR
  "resultado" TEXT NOT NULL DEFAULT 'EN_CURSO',
  "error" TEXT,
  "prueba" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ia_turnos_resultado_valido" CHECK ("resultado" IN ('EN_CURSO', 'OK', 'DERIVADO', 'SIN_RESPUESTA', 'ERROR')),
  CONSTRAINT "ia_turnos_ruta_valida" CHECK ("ruta" IN ('FLUJO', 'IA', 'SIN_IA', 'CITAS', 'GUARDIA'))
);
CREATE INDEX "ia_turnos_empresaId_createdAt_idx" ON "ia_turnos"("empresaId", "createdAt");
CREATE INDEX "ia_turnos_resultado_createdAt_idx" ON "ia_turnos"("resultado", "createdAt");
CREATE INDEX "ia_turnos_ruta_createdAt_idx" ON "ia_turnos"("ruta", "createdAt");
CREATE INDEX "ia_turnos_createdAt_idx" ON "ia_turnos"("createdAt");

-- Hechos dentro de un turno (o sueltos): herramientas, bloqueos, reintentos, fallas, derivaciones, audios/imagenes no soportados.
CREATE TABLE "ia_eventos" (
  "id" SERIAL PRIMARY KEY,
  "turnoId" INTEGER REFERENCES "ia_turnos"("id") ON DELETE CASCADE,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "agenteId" INTEGER,
  "tipo" TEXT NOT NULL,
  -- INFO | AVISO | ERROR
  "gravedad" TEXT NOT NULL DEFAULT 'INFO',
  "detalle" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ia_eventos_gravedad_valida" CHECK ("gravedad" IN ('INFO', 'AVISO', 'ERROR'))
);
CREATE INDEX "ia_eventos_turnoId_idx" ON "ia_eventos"("turnoId");
CREATE INDEX "ia_eventos_tipo_createdAt_idx" ON "ia_eventos"("tipo", "createdAt");
CREATE INDEX "ia_eventos_empresaId_createdAt_idx" ON "ia_eventos"("empresaId", "createdAt");

-- Resumen por dia y empresa: se genera ANTES de borrar el detalle y se conserva siempre.
CREATE TABLE "ia_resumen_diario" (
  "id" SERIAL PRIMARY KEY,
  "fecha" DATE NOT NULL,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "turnos" INTEGER NOT NULL DEFAULT 0,
  "porRuta" JSONB NOT NULL DEFAULT '{}',
  "errores" INTEGER NOT NULL DEFAULT 0,
  "derivados" INTEGER NOT NULL DEFAULT 0,
  "llamadasIA" INTEGER NOT NULL DEFAULT 0,
  "fallidasIA" INTEGER NOT NULL DEFAULT 0,
  "tokens" INTEGER NOT NULL DEFAULT 0,
  "costoUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "latenciaMediaMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ia_resumen_diario_fecha_empresaId_key" ON "ia_resumen_diario"("fecha", "empresaId");

-- Cada solicitud a la IA queda ligada al turno que la causo.
ALTER TABLE "usos_ia" ADD COLUMN "turnoId" INTEGER;
CREATE INDEX "usos_ia_turnoId_idx" ON "usos_ia"("turnoId");
