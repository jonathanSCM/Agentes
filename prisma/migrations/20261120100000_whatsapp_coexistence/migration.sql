-- Conexion de WhatsApp por COEXISTENCE (Embedded Signup): el mismo numero sigue en la app WhatsApp Business del celular y ademas en la API.
-- Todo aditivo. modo: MANUAL (credenciales cargadas a mano, lo de siempre) | COEXISTENCE.
ALTER TABLE "conexiones_whatsapp" ADD COLUMN "modo" TEXT NOT NULL DEFAULT 'MANUAL';
-- Estado de la sincronizacion de contactos e historial que se pide a Meta (ventana de 24 h desde la conexion): { contactos, historial, at, error }.
ALTER TABLE "conexiones_whatsapp" ADD COLUMN "estadoSync" JSONB;
ALTER TABLE "conexiones_whatsapp" ADD COLUMN "conectadoAt" TIMESTAMP(3);
