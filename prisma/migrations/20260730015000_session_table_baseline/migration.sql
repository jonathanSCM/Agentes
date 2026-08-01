-- Tabla de sesiones creada por connect-pg-simple (express-session). Se
-- registra aca solo para que Prisma deje de reportarla como "drift"; esta
-- migracion se marca como ya aplicada (la tabla ya existe en la practica).
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
