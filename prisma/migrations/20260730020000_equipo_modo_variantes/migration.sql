-- Equipo (invitaciones), modo de conversacion IA/humano, y variantes de producto.

-- ---------- Modo de conversacion ----------
CREATE TYPE "ModoConversacion" AS ENUM ('IA', 'HUMANO');

ALTER TABLE "conversaciones" ADD COLUMN "modo" "ModoConversacion" NOT NULL DEFAULT 'IA';
ALTER TABLE "conversaciones" ADD COLUMN "tomadaPorId" INTEGER;
ALTER TABLE "conversaciones" ADD CONSTRAINT "conversaciones_tomadaPorId_fkey"
  FOREIGN KEY ("tomadaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- Mensajes: quien lo mando (humano) y adjuntos ----------
ALTER TABLE "mensajes" ADD COLUMN "usuarioId" INTEGER;
ALTER TABLE "mensajes" ADD COLUMN "mediaUrl" TEXT;
ALTER TABLE "mensajes" ADD COLUMN "mediaTipo" TEXT;
ALTER TABLE "mensajes" ADD CONSTRAINT "mensajes_usuarioId_fkey"
  FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- Invitaciones de equipo ----------
CREATE TABLE "invitaciones" (
  "id" SERIAL NOT NULL,
  "empresaId" INTEGER NOT NULL,
  "email" TEXT NOT NULL,
  "rol" "Rol" NOT NULL DEFAULT 'STAFF',
  "token" TEXT NOT NULL,
  "aceptada" BOOLEAN NOT NULL DEFAULT false,
  "expiraEn" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invitaciones_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invitaciones_token_key" ON "invitaciones"("token");
CREATE INDEX "invitaciones_empresaId_idx" ON "invitaciones"("empresaId");
ALTER TABLE "invitaciones" ADD CONSTRAINT "invitaciones_empresaId_fkey"
  FOREIGN KEY ("empresaId") REFERENCES "empresas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- Variantes de producto ----------
CREATE TABLE "variantes" (
  "id" SERIAL NOT NULL,
  "productoId" INTEGER NOT NULL,
  "atributos" JSONB NOT NULL,
  "sku" TEXT,
  "precio" DECIMAL(10,2),
  "stock" INTEGER NOT NULL DEFAULT 0,
  "activa" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "variantes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "variantes_productoId_idx" ON "variantes"("productoId");
ALTER TABLE "variantes" ADD CONSTRAINT "variantes_productoId_fkey"
  FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pedido_items" ADD COLUMN "varianteId" INTEGER;
ALTER TABLE "pedido_items" ADD CONSTRAINT "pedido_items_varianteId_fkey"
  FOREIGN KEY ("varianteId") REFERENCES "variantes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
