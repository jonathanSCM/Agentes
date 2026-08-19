-- Personalizacion visual del catalogo web publico (/catalogo/:slug): sin
-- esto, todas las tiendas comparten el mismo tema oscuro fijo. Vacio = se
-- usan los colores por defecto y se muestra el nombre de la tienda como
-- texto en vez de logo.
ALTER TABLE "agente_config"
  ADD COLUMN IF NOT EXISTS "logoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "colorPrimario" TEXT,
  ADD COLUMN IF NOT EXISTS "colorSecundario" TEXT;
