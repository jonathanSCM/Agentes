-- Foto real de categoria para la tarjeta que manda el bot por WhatsApp.
ALTER TABLE "categorias"
  ADD COLUMN IF NOT EXISTS "imagenUrl" TEXT;

-- Plantilla visual elegida para el catalogo web publico.
ALTER TABLE "agente_config"
  ADD COLUMN IF NOT EXISTS "plantillaCatalogo" TEXT NOT NULL DEFAULT 'clasica';
