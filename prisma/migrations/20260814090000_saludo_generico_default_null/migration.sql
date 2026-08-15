-- El default viejo ("Hola, en que puedo ayudarte?") hacia que el bot pensara
-- que la tienda habia elegido ese saludo generico a proposito, en vez de
-- presentarse (nombre, tienda, que vende). Se saca el default, se permite
-- null, y se limpian las filas que todavia tienen exactamente ese texto
-- (nunca lo personalizaron) para que vuelvan a usar la presentacion real.
ALTER TABLE "agente_config" ALTER COLUMN "mensajeBienvenida" DROP NOT NULL;
ALTER TABLE "agente_config" ALTER COLUMN "mensajeBienvenida" DROP DEFAULT;
UPDATE "agente_config" SET "mensajeBienvenida" = NULL WHERE "mensajeBienvenida" = 'Hola, en que puedo ayudarte?';
