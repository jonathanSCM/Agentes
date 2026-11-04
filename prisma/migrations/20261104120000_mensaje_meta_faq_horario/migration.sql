-- Base para las mejoras de robustez del agente:
--  * mensajes.meta: marcas sobre cada mensaje (hasta que mensaje del cliente
--    leyo una respuesta, si una respuesta fue un fallo de la IA, etc.) para
--    poder re-contestar lo que quedo pendiente.
--  * agente_config.faq / horarioAtencion / conocimiento: lo que el negocio
--    carga para que el bot conteste sin IA (preguntas frecuentes y horario).
ALTER TABLE "mensajes" ADD COLUMN IF NOT EXISTS "meta" JSONB;
ALTER TABLE "agente_config"
  ADD COLUMN IF NOT EXISTS "faq" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "horarioAtencion" JSONB,
  ADD COLUMN IF NOT EXISTS "conocimiento" TEXT;
