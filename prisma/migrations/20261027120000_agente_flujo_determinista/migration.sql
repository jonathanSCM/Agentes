-- Interruptor por agente del flujo determinista (menus con listas, carrito y
-- cierre por plantillas y botones de WhatsApp, sin llamar a la IA).
ALTER TABLE "agente_config"
  ADD COLUMN IF NOT EXISTS "flujoDeterminista" BOOLEAN NOT NULL DEFAULT false;
