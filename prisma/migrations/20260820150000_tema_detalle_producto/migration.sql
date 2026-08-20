-- Tema visual (oscuro/claro) de la pagina de detalle de producto del catalogo web.
ALTER TABLE "agente_config"
  ADD COLUMN IF NOT EXISTS "temaProducto" TEXT NOT NULL DEFAULT 'oscuro';
