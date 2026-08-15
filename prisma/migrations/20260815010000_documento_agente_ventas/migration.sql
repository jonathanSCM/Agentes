-- Cambios de estructura para aplicar el documento "Instrucciones definitivas
-- para el desarrollo del Agente de Ventas". Todo el archivo es idempotente
-- (IF NOT EXISTS / DO $$ ... $$) para poder reaplicarse sin romper un deploy.

-- ============ Nuevos enums ============
DO $$ BEGIN
  CREATE TYPE "NivelAtributo" AS ENUM ('OBLIGATORIO', 'RECOMENDADO', 'OPCIONAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TipoEntrega" AS ENUM ('DOMICILIO', 'RECOJO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Etapas de cierre que faltaban en el enum de estado de conversacion.
ALTER TYPE "EstadoConversacion" ADD VALUE IF NOT EXISTS 'DATOS_DE_PEDIDO';
ALTER TYPE "EstadoConversacion" ADD VALUE IF NOT EXISTS 'ENTREGA';
ALTER TYPE "EstadoConversacion" ADD VALUE IF NOT EXISTS 'PEDIDO_COMPLETADO';

-- ============ Moneda real del catalogo (la IA nunca la decide) ============
ALTER TABLE "empresas" ADD COLUMN IF NOT EXISTS "moneda" TEXT NOT NULL DEFAULT 'BOB';

-- ============ SKU a nivel producto ============
ALTER TABLE "productos" ADD COLUMN IF NOT EXISTS "sku" TEXT;

-- ============ Atributos de categoria: 3 niveles en vez de un booleano ============
ALTER TABLE "categoria_atributos" ADD COLUMN IF NOT EXISTS "nivel" "NivelAtributo" NOT NULL DEFAULT 'OPCIONAL';

-- Migracion de datos: obligatorio=true pasa a RECOMENDADO, NO a OBLIGATORIO.
--
-- Parece contraintuitivo, pero es la traduccion fiel de lo que ese flag hacia
-- hasta hoy: era solo una sugerencia en el prompt ("preguntale esto si podes"),
-- nunca bloqueo nada. RECOMENDADO es exactamente eso. OBLIGATORIO es un
-- comportamiento NUEVO (el bot no muestra ningun producto hasta saberlo), y
-- activarlo de prepo sobre los datos que ya existen seria un cambio de
-- comportamiento silencioso y muy malo:
--
--   los datos actuales tienen 8 atributos marcados obligatorio en CADA una de
--   las 18 categorias (Corte, Estilo, Genero, Material, Ocasion, Talla,
--   Temporada, Tipo), porque la migracion de auto-deteccion
--   (20260814080000) marcaba obligatorio a todo atributo presente en TODOS
--   los productos de la categoria. Con el gate nuevo, el bot exigiria las 8
--   respuestas antes de mostrar un solo producto: justo el interrogatorio que
--   el documento del negocio prohibe.
--
-- Cada negocio promueve a OBLIGATORIO los 1 o 2 que de verdad hacen falta
-- (tipicamente Genero y Talla) desde /panel/categorias/:id.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'categoria_atributos' AND column_name = 'obligatorio'
  ) THEN
    UPDATE "categoria_atributos" SET "nivel" = 'RECOMENDADO' WHERE "obligatorio" = true;
    ALTER TABLE "categoria_atributos" DROP COLUMN "obligatorio";
  END IF;
END $$;

-- ============ Ubicacion real de la tienda (para retiro en local) ============
ALTER TABLE "agente_config" ADD COLUMN IF NOT EXISTS "direccionTienda" TEXT;
ALTER TABLE "agente_config" ADD COLUMN IF NOT EXISTS "tiendaLat" DOUBLE PRECISION;
ALTER TABLE "agente_config" ADD COLUMN IF NOT EXISTS "tiendaLng" DOUBLE PRECISION;

-- ============ Memoria estructurada del lead ============
ALTER TABLE "clientes_finales" ADD COLUMN IF NOT EXISTS "presupuestoMin" DECIMAL(10,2);
ALTER TABLE "clientes_finales" ADD COLUMN IF NOT EXISTS "presupuestoMax" DECIMAL(10,2);
ALTER TABLE "clientes_finales" ADD COLUMN IF NOT EXISTS "varianteFavoritaId" INTEGER;
ALTER TABLE "clientes_finales" ADD COLUMN IF NOT EXISTS "tipoEntrega" "TipoEntrega";

-- ============ Tipo de entrega en el pedido ============
ALTER TABLE "pedidos" ADD COLUMN IF NOT EXISTS "tipoEntrega" "TipoEntrega";

-- Los pedidos que ya existen tienen direccion cargada: son todos a domicilio
-- (el retiro en tienda no existia hasta esta migracion).
UPDATE "pedidos" SET "tipoEntrega" = 'DOMICILIO'
WHERE "tipoEntrega" IS NULL AND "direccionEntrega" IS NOT NULL;
