-- Reorganiza el catalogo existente en 7 rubros con subcategorias.
--
-- Antes: 18 categorias sueltas, con dos pares que eran la MISMA prenda partida
-- por genero ("Casacas" solo mujer vs "Casacas y abrigos" solo hombre, y lo
-- mismo con las chompas). Eso obligaba al bot a listar 18 opciones, dos de
-- ellas aparentemente repetidas.
--
-- Ahora: 7 rubros. El genero deja de estar en el nombre de la categoria porque
-- ya es un atributo de cada producto (los 150 lo tienen cargado) y el buscador
-- filtra por el: una clienta sigue viendo solo lo de mujer.
--
-- ALCANCE: solo se toca una empresa si tiene al menos 8 de estos 18 nombres,
-- o sea si su catalogo es de verdad el que se esta reorganizando. Un negocio
-- distinto que casualmente tenga una categoria "Poleras" no se ve afectado.
--
-- Idempotente: solo mueve categorias que siguen siendo de primer nivel, asi no
-- pisa una reorganizacion posterior hecha a mano desde el panel.

DO $$
DECLARE
  emp RECORD;
  par RECORD;
  rel RECORD;
  destino INTEGER;
  origen INTEGER;
  rubro INTEGER;
  coincidencias INTEGER;
  nombres TEXT[] := ARRAY[
    'Zapatillas urbanas','Zapatillas deportivas','Botas y botines','Zapatos hombre',
    'Jeans','Pantalones','Shorts','Faldas','Poleras','Camisas','Blusas',
    'Casacas','Casacas y abrigos','Chompas','Chompas y chalecos',
    'Vestidos y Enterizos','Ropa Deportiva','Ropa de baño'
  ];
BEGIN
  FOR emp IN SELECT id FROM "empresas" LOOP
    SELECT count(*) INTO coincidencias
      FROM "categorias" WHERE "empresaId" = emp.id AND nombre = ANY(nombres);
    CONTINUE WHEN coincidencias < 8;

    -- 1) Fusionar los pares que eran la misma prenda separada por genero.
    --    Los productos se mudan; el genero los sigue separando para el cliente.
    FOR par IN
      SELECT d.id AS dest, o.id AS orig
        FROM (VALUES ('Casacas y abrigos','Casacas'), ('Chompas y chalecos','Chompas')) AS p(dest, orig)
        JOIN "categorias" d ON d."empresaId" = emp.id AND d.nombre = p.dest
        JOIN "categorias" o ON o."empresaId" = emp.id AND o.nombre = p.orig
    LOOP
      destino := par.dest;
      origen := par.orig;
      UPDATE "productos" SET "categoriaId" = destino WHERE "categoriaId" = origen;
      -- Un lead que apuntaba a la categoria que desaparece quedaria colgado
      -- (ese campo no tiene FK): se lo reapunta a la que absorbe.
      UPDATE "clientes_finales" SET "categoriaId" = destino WHERE "categoriaId" = origen;
      DELETE FROM "categorias" WHERE id = origen;
    END LOOP;

    -- 2) El genero no va en el nombre: lo filtra el atributo del producto.
    UPDATE "categorias" SET nombre = 'Zapatos de vestir'
      WHERE "empresaId" = emp.id AND nombre = 'Zapatos hombre'
        AND NOT EXISTS (SELECT 1 FROM "categorias" c2 WHERE c2."empresaId" = emp.id AND c2.nombre = 'Zapatos de vestir');

    -- 3) Crear los rubros nuevos (los que agrupan varias subcategorias).
    FOR rel IN
      SELECT * FROM (VALUES
        ('Calzado', 1), ('Prendas de abajo', 2), ('Prendas de arriba', 3), ('Abrigos', 4)
      ) AS r(nombre, orden)
    LOOP
      INSERT INTO "categorias" ("empresaId", nombre, "padreId", orden)
        VALUES (emp.id, rel.nombre, NULL, rel.orden)
        ON CONFLICT ("empresaId", nombre) DO NOTHING;
    END LOOP;

    -- 4) Colgar cada subcategoria de su rubro.
    FOR rel IN
      SELECT * FROM (VALUES
        ('Calzado','Zapatillas urbanas',1), ('Calzado','Zapatillas deportivas',2),
        ('Calzado','Botas y botines',3), ('Calzado','Zapatos de vestir',4),
        ('Prendas de abajo','Jeans',1), ('Prendas de abajo','Pantalones',2),
        ('Prendas de abajo','Shorts',3), ('Prendas de abajo','Faldas',4),
        ('Prendas de arriba','Poleras',1), ('Prendas de arriba','Camisas',2),
        ('Prendas de arriba','Blusas',3),
        ('Abrigos','Casacas y abrigos',1), ('Abrigos','Chompas y chalecos',2)
      ) AS r(rubro, sub, orden)
    LOOP
      SELECT id INTO rubro FROM "categorias" WHERE "empresaId" = emp.id AND nombre = rel.rubro;
      CONTINUE WHEN rubro IS NULL;
      -- Solo lo que sigue siendo de primer nivel: no se pisa lo reorganizado a mano.
      UPDATE "categorias" SET "padreId" = rubro, orden = rel.orden
        WHERE "empresaId" = emp.id AND nombre = rel.sub AND "padreId" IS NULL AND id <> rubro;
    END LOOP;

    -- 5) Los tres rubros que no se dividen quedan de primer nivel, con orden
    --    para que el menu salga siempre igual.
    UPDATE "categorias" SET orden = 5 WHERE "empresaId" = emp.id AND nombre = 'Vestidos y Enterizos' AND "padreId" IS NULL;
    UPDATE "categorias" SET orden = 6 WHERE "empresaId" = emp.id AND nombre = 'Ropa Deportiva' AND "padreId" IS NULL;
    UPDATE "categorias" SET orden = 7 WHERE "empresaId" = emp.id AND nombre = 'Ropa de baño' AND "padreId" IS NULL;
  END LOOP;
END $$;
