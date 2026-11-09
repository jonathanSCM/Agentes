-- Auditoría (docs/11, F7): quién hizo qué. Solo se agrega; no se edita nunca.
CREATE TABLE "auditoria" (
  "id" SERIAL PRIMARY KEY,
  "empresaId" INTEGER NOT NULL REFERENCES "empresas"("id") ON DELETE CASCADE,
  "usuarioId" INTEGER,
  "usuarioNombre" TEXT NOT NULL,
  "usuarioRol" TEXT,
  "accion" TEXT NOT NULL,
  "entidad" TEXT,
  "entidadId" INTEGER,
  "detalle" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "auditoria_empresaId_createdAt_idx" ON "auditoria"("empresaId", "createdAt");
CREATE INDEX "auditoria_empresaId_accion_idx" ON "auditoria"("empresaId", "accion");

-- Un registro de auditoría no se modifica (borrar solo ocurre al eliminar toda la empresa, por cascada).
CREATE FUNCTION "auditoria_sin_cambios"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La auditoría no se puede modificar';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "auditoria_no_update" BEFORE UPDATE ON "auditoria" FOR EACH ROW EXECUTE FUNCTION "auditoria_sin_cambios"();
