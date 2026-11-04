-- M0 del plan de mensajes prefabricados (docs/10): la IA no escribe, elige.
--  * mensajes_agente: lo que cada negocio cambia o crea sobre los mensajes de fabrica
--    (los de fabrica viven en el codigo, lib/services/mensajesBase.js).
--  * datos_negocio: datos añadibles que cualquier mensaje usa ({{dato.garantia}}).
--  * agente_config.registro: como habla el agente (vos | tu | usted).
--  * agente_config.mensajesPrefabricados: interruptor por agente de la fase M1 (la IA elige).
--  * planes.maxMensajesPropios: tope de mensajes propios por plan.
CREATE TABLE IF NOT EXISTS "mensajes_agente" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "clave" TEXT NOT NULL,
    "categoria" TEXT,
    "descripcion" TEXT,
    "texto" TEXT NOT NULL,
    "variantes" JSONB NOT NULL DEFAULT '[]',
    "variables" JSONB NOT NULL DEFAULT '[]',
    "origen" TEXT NOT NULL DEFAULT 'PERSONALIZADO',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensajes_agente_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mensajes_agente_empresaId_clave_key" ON "mensajes_agente"("empresaId", "clave");
ALTER TABLE "mensajes_agente"
  ADD CONSTRAINT "mensajes_agente_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "datos_negocio" (
    "id" SERIAL NOT NULL,
    "empresaId" INTEGER NOT NULL,
    "clave" TEXT NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "datos_negocio_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "datos_negocio_empresaId_clave_key" ON "datos_negocio"("empresaId", "clave");
ALTER TABLE "datos_negocio"
  ADD CONSTRAINT "datos_negocio_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agente_config"
  ADD COLUMN IF NOT EXISTS "registro" TEXT NOT NULL DEFAULT 'vos',
  ADD COLUMN IF NOT EXISTS "mensajesPrefabricados" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "planes" ADD COLUMN IF NOT EXISTS "maxMensajesPropios" INTEGER NOT NULL DEFAULT 30;
