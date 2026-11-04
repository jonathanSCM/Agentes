-- Fase 2 del plan (docs/09): modelo de negocio configurable (productos o citas) y base de Citas.
CREATE TYPE "ModeloNegocio" AS ENUM ('PRODUCTOS', 'CITAS');
CREATE TYPE "EstadoCita" AS ENUM ('PENDIENTE', 'CONFIRMADA', 'COMPLETADA', 'NO_ASISTIO', 'CANCELADA');

ALTER TABLE "empresas"
  ADD COLUMN IF NOT EXISTS "modeloNegocio" "ModeloNegocio" NOT NULL DEFAULT 'PRODUCTOS',
  ADD COLUMN IF NOT EXISTS "rubro" TEXT,
  ADD COLUMN IF NOT EXISTS "zonaHoraria" TEXT NOT NULL DEFAULT 'America/La_Paz',
  ADD COLUMN IF NOT EXISTS "pais" TEXT,
  ADD COLUMN IF NOT EXISTS "vocabulario" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "configAgenda" JSONB NOT NULL DEFAULT '{}';

-- Topes por plan para el modelo de citas.
ALTER TABLE "planes"
  ADD COLUMN IF NOT EXISTS "maxServicios" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "maxCitasMes" INTEGER NOT NULL DEFAULT 200;
UPDATE "planes" SET "maxServicios" = 3,   "maxCitasMes" = 30   WHERE "codigo" = 'GRATIS';
UPDATE "planes" SET "maxServicios" = 10,  "maxCitasMes" = 200  WHERE "codigo" = 'STANDARD';
UPDATE "planes" SET "maxServicios" = 30,  "maxCitasMes" = 1000 WHERE "codigo" = 'PRO';
UPDATE "planes" SET "maxServicios" = 100, "maxCitasMes" = 5000 WHERE "codigo" = 'PREMIUM';

-- Lo que se agenda: consulta, corte, reserva de mesa, visita...
CREATE TABLE "servicios" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "duracionMin" INTEGER NOT NULL DEFAULT 30,
    "bufferMin" INTEGER NOT NULL DEFAULT 0,
    "precio" DECIMAL(10,2),
    "usaPersonas" BOOLEAN NOT NULL DEFAULT false,
    "maxPersonas" INTEGER,
    "color" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "servicios_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "servicios_empresaId_activo_idx" ON "servicios"("empresaId", "activo");

-- Quien o que atiende: una persona o un recurso (salon, terraza, consultorio) con capacidad.
CREATE TABLE "recursos" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'persona',
    "especialidad" TEXT,
    "capacidad" INTEGER NOT NULL DEFAULT 1,
    "color" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recursos_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "recursos_empresaId_activo_idx" ON "recursos"("empresaId", "activo");

-- Sin filas para un recurso = atiende todos los servicios.
CREATE TABLE "recurso_servicios" (
    "recursoId" INTEGER NOT NULL,
    "servicioId" INTEGER NOT NULL,
    CONSTRAINT "recurso_servicios_pkey" PRIMARY KEY ("recursoId", "servicioId")
);

-- recursoId NULL = horario general del negocio. Varias filas por dia = turno partido.
CREATE TABLE "horarios_atencion" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "recursoId" INTEGER,
    "diaSemana" INTEGER NOT NULL,
    "horaInicio" TEXT NOT NULL,
    "horaFin" TEXT NOT NULL,
    CONSTRAINT "horarios_atencion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "horarios_atencion_diaSemana_check" CHECK ("diaSemana" BETWEEN 0 AND 6)
);
CREATE INDEX "horarios_atencion_empresaId_idx" ON "horarios_atencion"("empresaId");

-- Vacaciones, almuerzos puntuales, feriados propios. recursoId NULL = cierra todo el negocio.
CREATE TABLE "bloqueos_agenda" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "recursoId" INTEGER,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT,
    CONSTRAINT "bloqueos_agenda_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bloqueos_agenda_empresaId_inicio_idx" ON "bloqueos_agenda"("empresaId", "inicio");

CREATE TABLE "citas" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "clienteId" INTEGER NOT NULL,
    "servicioId" INTEGER,
    "recursoId" INTEGER,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "bufferMin" INTEGER NOT NULL DEFAULT 0,
    "personas" INTEGER NOT NULL DEFAULT 1,
    "carga" INTEGER NOT NULL DEFAULT 1,
    "estado" "EstadoCita" NOT NULL DEFAULT 'CONFIRMADA',
    "origen" TEXT NOT NULL DEFAULT 'whatsapp',
    "notas" TEXT,
    "recordatorios" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "citas_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "citas_empresaId_inicio_idx" ON "citas"("empresaId", "inicio");
CREATE INDEX "citas_clienteId_idx" ON "citas"("clienteId");
CREATE INDEX "citas_recursoId_inicio_idx" ON "citas"("recursoId", "inicio");

-- Feriados nacionales descargados de internet (Nager.Date), por pais y año.
CREATE TABLE "feriados_cache" (
    "pais" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "datos" JSONB NOT NULL DEFAULT '[]',
    "actualizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feriados_cache_pkey" PRIMARY KEY ("pais", "anio")
);

ALTER TABLE "servicios" ADD CONSTRAINT "servicios_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recursos" ADD CONSTRAINT "recursos_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurso_servicios" ADD CONSTRAINT "recurso_servicios_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "recursos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurso_servicios" ADD CONSTRAINT "recurso_servicios_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "servicios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "horarios_atencion" ADD CONSTRAINT "horarios_atencion_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "horarios_atencion" ADD CONSTRAINT "horarios_atencion_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "recursos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bloqueos_agenda" ADD CONSTRAINT "bloqueos_agenda_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bloqueos_agenda" ADD CONSTRAINT "bloqueos_agenda_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "recursos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "citas" ADD CONSTRAINT "citas_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "citas" ADD CONSTRAINT "citas_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes_finales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "citas" ADD CONSTRAINT "citas_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "servicios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "citas" ADD CONSTRAINT "citas_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "recursos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
