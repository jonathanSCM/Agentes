-- Creditos (fases 4 a 7 del planning). Todo aditivo: no toca los saldos de conversaciones.

-- Tarifario: cuantos creditos cuesta cada accion, con vigencia (cambiar un precio no altera el pasado).
CREATE TABLE "acciones_credito" (
  "id" SERIAL PRIMARY KEY,
  "accion" TEXT NOT NULL,
  "creditos" INTEGER NOT NULL,
  "activa" BOOLEAN NOT NULL DEFAULT true,
  "vigenteDesde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "vigenteHasta" TIMESTAMP(3),
  "nota" TEXT,
  CONSTRAINT "acciones_credito_creditos_no_negativos" CHECK ("creditos" >= 0)
);
CREATE INDEX "acciones_credito_accion_vigenteDesde_idx" ON "acciones_credito"("accion", "vigenteDesde");

-- Lotes: grupos de creditos con origen, cantidad, saldo restante y vencimiento.
CREATE TABLE "creditos_lotes" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  -- PLAN | COMPRA | AJUSTE | MIGRACION
  "origen" TEXT NOT NULL,
  "cantidadInicial" INTEGER NOT NULL,
  "restante" INTEGER NOT NULL,
  "vence" TIMESTAMP(3),
  "referencia" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creditos_lotes_restante_no_negativo" CHECK ("restante" >= 0),
  CONSTRAINT "creditos_lotes_restante_no_supera_inicial" CHECK ("restante" <= "cantidadInicial"),
  CONSTRAINT "creditos_lotes_origen_valido" CHECK ("origen" IN ('PLAN', 'COMPRA', 'AJUSTE', 'MIGRACION'))
);
CREATE INDEX "creditos_lotes_empresaId_restante_vence_idx" ON "creditos_lotes"("empresaId", "restante", "vence");

-- Libro: cada movimiento, inmutable. Un error se corrige con un movimiento nuevo.
CREATE TABLE "creditos_movimientos" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "loteId" INTEGER REFERENCES "creditos_lotes"("id") ON DELETE CASCADE,
  -- ASIGNACION | COMPRA | MIGRACION | CONSUMO | DEVOLUCION | AJUSTE | VENCIMIENTO | SOMBRA (consumo simulado, no mueve saldo)
  "tipo" TEXT NOT NULL,
  -- Con signo: positivo suma, negativo resta.
  "cantidad" INTEGER NOT NULL,
  "saldoDespues" INTEGER,
  "accion" TEXT,
  "precioAplicado" INTEGER,
  "referencia" TEXT,
  "claveIdempotencia" TEXT,
  "nota" TEXT,
  "quien" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "creditos_movimientos_empresaId_createdAt_idx" ON "creditos_movimientos"("empresaId", "createdAt");
CREATE INDEX "creditos_movimientos_claveIdempotencia_idx" ON "creditos_movimientos"("claveIdempotencia");
CREATE INDEX "creditos_movimientos_loteId_idx" ON "creditos_movimientos"("loteId");
-- Un mismo cobro (misma clave) no puede dejar dos movimientos del mismo tipo en el mismo lote.
CREATE UNIQUE INDEX "creditos_movimientos_clave_tipo_lote_key" ON "creditos_movimientos"("claveIdempotencia", "tipo", "loteId");

-- Creditos por mes del plan y de la copia de cada cliente; creditos de un paquete (null = usar la equivalencia).
ALTER TABLE "planes" ADD COLUMN "creditosMes" INTEGER;
ALTER TABLE "suscripciones" ADD COLUMN "creditosMes" INTEGER;
ALTER TABLE "paquetes" ADD COLUMN "creditos" INTEGER;

-- Tarifario inicial (propuesta del planning; se ajusta con el costo real medido).
INSERT INTO "acciones_credito" ("accion", "creditos", "vigenteDesde", "nota") VALUES
  ('CONVERSACION_NUEVA', 5, '2000-01-01', 'Equivale a 1 conversacion actual'),
  ('TURNO_IA', 1, '2000-01-01', 'Una respuesta generada con IA'),
  ('PLANTILLA_SALIENTE', 2, '2000-01-01', 'Mensaje de plantilla fuera de la ventana de 24 h');
