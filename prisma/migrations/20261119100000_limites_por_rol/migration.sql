-- Limites de usuarios POR ROL en los planes (administradores, colaboradores, cajeros, profesionales). Todo aditivo.
-- NULL = sin limite por rol (solo cuenta el tope total de usuarios): los planes que ya existen no cambian.
ALTER TABLE "planes" ADD COLUMN "maxAdmins" INTEGER;
ALTER TABLE "planes" ADD COLUMN "maxStaff" INTEGER;
ALTER TABLE "planes" ADD COLUMN "maxCajeros" INTEGER;
ALTER TABLE "planes" ADD COLUMN "maxProfesionales" INTEGER;
ALTER TABLE "planes" ADD CONSTRAINT "planes_limites_rol_check" CHECK (("maxAdmins" IS NULL OR "maxAdmins" >= 0) AND ("maxStaff" IS NULL OR "maxStaff" >= 0) AND ("maxCajeros" IS NULL OR "maxCajeros" >= 0) AND ("maxProfesionales" IS NULL OR "maxProfesionales" >= 0));

-- La copia de cada cliente (suscripcion): igual, NULL = sin limite.
ALTER TABLE "suscripciones" ADD COLUMN "maxAdmins" INTEGER;
ALTER TABLE "suscripciones" ADD COLUMN "maxStaff" INTEGER;
ALTER TABLE "suscripciones" ADD COLUMN "maxCajeros" INTEGER;
ALTER TABLE "suscripciones" ADD COLUMN "maxProfesionales" INTEGER;
