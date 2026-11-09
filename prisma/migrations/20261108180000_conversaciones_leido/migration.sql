-- Bandeja de conversaciones (CRM): hasta cuando leyo el equipo cada conversacion.
-- "No leidos" = mensajes del cliente posteriores a esta marca.
ALTER TABLE "conversaciones" ADD COLUMN IF NOT EXISTS "leidoAt" TIMESTAMP(3);

-- Lo que ya existia se considera leido (no aparecen cientos de "no leidos" de golpe).
UPDATE "conversaciones" SET "leidoAt" = "ultimoMensajeAt" WHERE "leidoAt" IS NULL;
