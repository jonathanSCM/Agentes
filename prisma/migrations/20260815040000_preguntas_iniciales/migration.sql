-- Datos que el bot pregunta ANTES de mostrar nada (ni el menu de rubros).
-- Son filtros que aplican a todo el catalogo: el caso tipico es el genero en
-- una tienda de ropa, donde mostrar vestidos a un hombre es perder el tiempo.
--
-- Default "Genero" porque es el unico que sirve igual en cualquier rubro. La
-- talla NO va por defecto: en el mismo catalogo conviven tallas 42 (calzado) y
-- M (ropa), asi que preguntarla antes de saber que busca confunde al cliente.
-- Cada negocio puede sumarla desde /panel/configuracion si le sirve.
ALTER TABLE "agente_config"
  ADD COLUMN IF NOT EXISTS "preguntasIniciales" TEXT[] NOT NULL DEFAULT ARRAY['Genero']::TEXT[];
