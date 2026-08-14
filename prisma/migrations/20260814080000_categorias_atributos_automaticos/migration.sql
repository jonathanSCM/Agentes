-- Precarga los atributos de cada categoria automaticamente, mirando los
-- productos/variantes que YA existen (sin asumir nada de rubro tipo "ropa" a
-- proposito, para que sirva igual para cualquier negocio):
--   - Nivel producto: cada clave que aparece en Producto.atributos dentro de
--     esa categoria se agrega como atributo opcional; si TODOS los productos
--     de la categoria ya la tienen cargada, se marca obligatoria (asume que
--     si ya la cargan siempre, es porque les importa).
--   - Nivel variante: mismo criterio pero mirando Variante.atributos (ej:
--     Talla/Color), marcado esDeVariante=true (guia, no bloquea guardar).
-- Idempotente (ON CONFLICT DO NOTHING): no pisa atributos que el negocio ya
-- haya configurado a mano desde /panel/categorias.

WITH conteo_productos AS (
  SELECT "categoriaId", count(*) AS total
  FROM productos
  WHERE "categoriaId" IS NOT NULL
  GROUP BY "categoriaId"
),
claves_producto AS (
  SELECT p."categoriaId", k AS clave, count(*) AS con_clave
  FROM productos p, jsonb_object_keys(p.atributos) AS k
  WHERE p."categoriaId" IS NOT NULL
  GROUP BY p."categoriaId", k
)
INSERT INTO "categoria_atributos" ("categoriaId", nombre, obligatorio, "esDeVariante", orden)
SELECT c."categoriaId", c.clave, (c.con_clave = t.total), false, 0
FROM claves_producto c
JOIN conteo_productos t ON t."categoriaId" = c."categoriaId"
ON CONFLICT ("categoriaId", nombre) DO NOTHING;

WITH conteo_productos AS (
  SELECT "categoriaId", count(*) AS total
  FROM productos
  WHERE "categoriaId" IS NOT NULL
  GROUP BY "categoriaId"
),
claves_variante AS (
  SELECT p."categoriaId", k AS clave, count(DISTINCT p.id) AS con_clave
  FROM productos p
  JOIN variantes v ON v."productoId" = p.id AND v.activa, jsonb_object_keys(v.atributos) AS k
  WHERE p."categoriaId" IS NOT NULL
  GROUP BY p."categoriaId", k
)
INSERT INTO "categoria_atributos" ("categoriaId", nombre, obligatorio, "esDeVariante", orden)
SELECT cv."categoriaId", cv.clave, (cv.con_clave = t.total), true, 1
FROM claves_variante cv
JOIN conteo_productos t ON t."categoriaId" = cv."categoriaId"
ON CONFLICT ("categoriaId", nombre) DO NOTHING;
