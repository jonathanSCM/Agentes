-- Costos de IA completos (fase 2 del planning de creditos y Centro de IA). Todo aditivo.

-- 1) Tarifas versionadas: el costo de cada solicitud usa la tarifa vigente EN SU FECHA (nunca valores fijos en el codigo).
CREATE TABLE "tarifas_ia" (
  "id" SERIAL PRIMARY KEY,
  "proveedor" TEXT NOT NULL,
  "modelo" TEXT NOT NULL,
  "servicio" TEXT NOT NULL DEFAULT 'chat',
  "entradaUsdPorM" DECIMAL(12,6) NOT NULL,
  "cacheUsdPorM" DECIMAL(12,6) NOT NULL,
  "salidaUsdPorM" DECIMAL(12,6) NOT NULL,
  "vigenteDesde" TIMESTAMP(3) NOT NULL,
  "vigenteHasta" TIMESTAMP(3),
  "nota" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tarifas_ia_valores_check" CHECK ("entradaUsdPorM" >= 0 AND "cacheUsdPorM" >= 0 AND "salidaUsdPorM" >= 0),
  CONSTRAINT "tarifas_ia_vigencia_check" CHECK ("vigenteHasta" IS NULL OR "vigenteHasta" > "vigenteDesde")
);
CREATE INDEX "tarifas_ia_busqueda_idx" ON "tarifas_ia"("proveedor", "modelo", "servicio", "vigenteDesde");

-- Tarifas iniciales (las que estaban escritas en el codigo, USD por millon de tokens).
INSERT INTO "tarifas_ia" ("proveedor", "modelo", "servicio", "entradaUsdPorM", "cacheUsdPorM", "salidaUsdPorM", "vigenteDesde", "nota") VALUES
  ('openai', 'gpt-4o', 'chat', 2.50, 1.25, 10.00, '2000-01-01', 'Inicial: precios publicos del proveedor'),
  ('openai', 'gpt-4o-mini', 'chat', 0.15, 0.075, 0.60, '2000-01-01', 'Inicial: precios publicos del proveedor'),
  ('openai', 'gpt-4.1-mini', 'chat', 0.40, 0.10, 1.60, '2000-01-01', 'Inicial: precios publicos del proveedor'),
  ('openai', 'gpt-6-luna', 'chat', 0.10, 0.10, 0.50, '2000-01-01', 'Inicial: precio dado por el dueño (nov-2026). La entrada cacheada se desconoce: se usa la normal, asi que el costo es un TECHO.'),
  ('anthropic', 'claude-haiku-4-5', 'chat', 1.00, 0.10, 5.00, '2000-01-01', 'Inicial: precios publicos del proveedor'),
  ('anthropic', 'claude-sonnet-5', 'chat', 3.00, 0.30, 15.00, '2000-01-01', 'Inicial: precios publicos del proveedor'),
  ('openai', 'text-embedding-3-small', 'embedding', 0.02, 0.02, 0, '2000-01-01', 'Inicial: busqueda semantica del catalogo (solo cuenta entrada)');

-- 2) Cada solicitud guarda mas: agente, servicio, estado, id del proveedor, latencia, costo y tarifa usada.
ALTER TABLE "usos_ia" ADD COLUMN "agenteId" INTEGER;
ALTER TABLE "usos_ia" ADD COLUMN "servicio" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "usos_ia" ADD COLUMN "estado" TEXT NOT NULL DEFAULT 'COMPLETADA';
ALTER TABLE "usos_ia" ADD COLUMN "error" TEXT;
ALTER TABLE "usos_ia" ADD COLUMN "solicitudId" TEXT;
ALTER TABLE "usos_ia" ADD COLUMN "latenciaMs" INTEGER;
ALTER TABLE "usos_ia" ADD COLUMN "costoUsd" DECIMAL(12,6);
ALTER TABLE "usos_ia" ADD COLUMN "tarifaId" INTEGER;
-- CALCULADO = costo estimado al momento de la llamada; RECALCULADO = filas anteriores a esta migracion, recalculadas con la tarifa de su epoca.
ALTER TABLE "usos_ia" ADD COLUMN "costoFuente" TEXT NOT NULL DEFAULT 'CALCULADO';
ALTER TABLE "usos_ia" ADD CONSTRAINT "usos_ia_estado_valido" CHECK ("estado" IN ('COMPLETADA', 'FALLIDA', 'CANCELADA'));
CREATE INDEX "usos_ia_estado_createdAt_idx" ON "usos_ia"("estado", "createdAt");
CREATE INDEX "usos_ia_servicio_createdAt_idx" ON "usos_ia"("servicio", "createdAt");

-- Las filas viejas: costo recalculado con la tarifa vigente en su fecha (los modelos sin tarifa quedan sin costo: no se inventa).
UPDATE "usos_ia" u SET
  "tarifaId" = t."id",
  "costoUsd" = ((GREATEST(u."promptTokens" - u."cachedTokens", 0) * t."entradaUsdPorM" + u."cachedTokens" * t."cacheUsdPorM" + u."completionTokens" * t."salidaUsdPorM") / 1000000.0),
  "costoFuente" = 'RECALCULADO'
FROM "tarifas_ia" t
WHERE t."proveedor" = u."proveedor" AND t."modelo" = u."modelo" AND t."servicio" = 'chat'
  AND t."vigenteDesde" <= u."createdAt" AND (t."vigenteHasta" IS NULL OR t."vigenteHasta" > u."createdAt");

-- 3) Tipo de cambio Bs por dolar, una fila por fecha y fuente (BCB = oficial, API = referencia, MANUAL = valor puesto a mano).
CREATE TABLE "tipos_cambio" (
  "id" SERIAL PRIMARY KEY,
  "fecha" DATE NOT NULL,
  "bobPorUsd" DECIMAL(10,4) NOT NULL,
  "fuente" TEXT NOT NULL,
  "nota" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tipos_cambio_valor_check" CHECK ("bobPorUsd" > 0),
  CONSTRAINT "tipos_cambio_fuente_valida" CHECK ("fuente" IN ('BCB', 'API', 'MANUAL'))
);
CREATE UNIQUE INDEX "tipos_cambio_fecha_fuente_key" ON "tipos_cambio"("fecha", "fuente");
