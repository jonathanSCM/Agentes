-- Planes por modulos (Agente / POS / Panel) y copia de los valores del plan en cada suscripcion.
-- Aditiva: nada se borra. docs/11-plan-planes-pos-panel-y-rediseno.md §11.

ALTER TABLE "planes"
  ADD COLUMN IF NOT EXISTS "modulos"   TEXT[]  NOT NULL DEFAULT ARRAY['AGENTE']::TEXT[],
  ADD COLUMN IF NOT EXISTS "oculto"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ilimitado" BOOLEAN NOT NULL DEFAULT false;

-- La suscripcion se rige por SU COPIA de los valores del plan (no consulta el plan en cada uso).
ALTER TABLE "suscripciones"
  ADD COLUMN IF NOT EXISTS "planNombre"         TEXT,
  ADD COLUMN IF NOT EXISTS "modulos"            TEXT[]  NOT NULL DEFAULT ARRAY['AGENTE']::TEXT[],
  ADD COLUMN IF NOT EXISTS "convIncluidas"      INTEGER,
  ADD COLUMN IF NOT EXISTS "maxProductos"       INTEGER,
  ADD COLUMN IF NOT EXISTS "maxUsuarios"        INTEGER,
  ADD COLUMN IF NOT EXISTS "maxMensajesPropios" INTEGER,
  ADD COLUMN IF NOT EXISTS "maxServicios"       INTEGER,
  ADD COLUMN IF NOT EXISTS "maxCitasMes"        INTEGER,
  ADD COLUMN IF NOT EXISTS "modeloIa"           TEXT,
  ADD COLUMN IF NOT EXISTS "marcaBlanca"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ilimitado"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "planInicio"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "planFin"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "avisosEnviados"     JSONB   NOT NULL DEFAULT '{}'::jsonb;

-- Suscripciones que ya existian: se les copia lo que hoy les da su plan.
UPDATE "suscripciones" s SET
  "planNombre" = p."nombre",
  "convIncluidas" = p."convIncluidas",
  "maxProductos" = p."maxProductos",
  "maxUsuarios" = p."maxUsuarios",
  "maxMensajesPropios" = p."maxMensajesPropios",
  "maxServicios" = p."maxServicios",
  "maxCitasMes" = p."maxCitasMes",
  "modeloIa" = p."modeloIa",
  "marcaBlanca" = p."marcaBlanca",
  "planInicio" = s."periodoInicio",
  "planFin" = s."periodoFin"
FROM "planes" p
WHERE p."id" = s."planId" AND s."planNombre" IS NULL;
