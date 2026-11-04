// Conexion unica a la base de datos (patron singleton).
// Se importa desde cualquier parte con: const { prisma } = require('./lib/db');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');

// Bajo el runner de pruebas (node --test) se usa SIEMPRE una base aparte
// ("<base>_test", o DATABASE_URL_TEST): los tests crean y borran datos a
// montones y no deben tocar la base de desarrollo. Se crea con
// `npm run test:preparar`.
function urlDeTest() {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = `${u.pathname.replace(/_test$/, '')}_test`;
  return u.toString();
}
const enPruebas = Boolean(process.env.NODE_TEST_CONTEXT) && process.env.TEST_DB_AISLADA !== '0';

const adapter = new PrismaPg({ connectionString: enPruebas ? urlDeTest() : process.env.DATABASE_URL });

// Reutiliza la instancia en desarrollo para no abrir conexiones de mas
// cada vez que node --watch reinicia el servidor.
const globalForPrisma = globalThis;
const prisma = globalForPrisma.__prisma || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = { prisma, urlDeTest };
