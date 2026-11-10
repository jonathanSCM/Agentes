-- Un usuario PROFESIONAL se vincula al "recurso" (profesional de la agenda) cuyas citas ve. La invitacion lo lleva y se copia al aceptar.
ALTER TABLE "usuarios" ADD COLUMN "recursoId" INTEGER REFERENCES "recursos"("id") ON DELETE SET NULL;
ALTER TABLE "invitaciones" ADD COLUMN "recursoId" INTEGER REFERENCES "recursos"("id") ON DELETE SET NULL;
CREATE INDEX "usuarios_recursoId_idx" ON "usuarios"("recursoId");
