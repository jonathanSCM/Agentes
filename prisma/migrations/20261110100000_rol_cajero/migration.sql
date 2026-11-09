-- Rol del mostrador (punto de venta). Va en su propia migracion: un valor nuevo de un enum no se puede
-- usar en la misma transaccion en la que se agrega.
ALTER TYPE "Rol" ADD VALUE IF NOT EXISTS 'CAJERO';
