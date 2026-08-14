-- Convierte productos.categoria (texto libre, columna vieja que se borra en
-- la migracion siguiente) a la nueva relacion Categoria: crea una Categoria
-- por cada texto distinto que ya exista, por empresa, y liga cada producto a
-- la que le corresponde. Idempotente (ON CONFLICT DO NOTHING / solo actualiza
-- lo que todavia esta null) para poder correr sin romper en una base que ya
-- este migrada. No agrega atributos a las categorias creadas: cada negocio
-- los configura despues desde /panel/categorias segun le sirva a su rubro.
INSERT INTO "categorias" ("empresaId", "nombre")
SELECT DISTINCT "empresaId", "categoria" FROM "productos"
WHERE "categoria" IS NOT NULL
ON CONFLICT ("empresaId", "nombre") DO NOTHING;

UPDATE "productos" p
SET "categoriaId" = c.id
FROM "categorias" c
WHERE p."categoria" = c."nombre" AND p."empresaId" = c."empresaId" AND p."categoriaId" IS NULL;
