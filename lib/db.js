// Conexion unica a la base de datos (patron singleton).
// Se importa desde cualquier parte con: const { prisma } = require('./lib/db');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

// Reutiliza la instancia en desarrollo para no abrir conexiones de mas
// cada vez que node --watch reinicia el servidor.
const globalForPrisma = globalThis;
const prisma = globalForPrisma.__prisma || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = { prisma };
