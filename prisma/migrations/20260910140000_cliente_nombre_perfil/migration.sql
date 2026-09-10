-- Nombre de perfil de WhatsApp del cliente, capturado del webhook (Meta
-- manda contacts[0].profile.name en cada mensaje entrante). Se usa para
-- mostrar en el panel de conversaciones aunque el cliente todavia no haya
-- dado su nombre real para el pedido.
ALTER TABLE "clientes_finales"
  ADD COLUMN IF NOT EXISTS "nombrePerfil" TEXT;
