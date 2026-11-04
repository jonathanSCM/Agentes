'use strict';
// Crea (si no existe) la base de datos de pruebas "<tu base>_test" en el mismo
// servidor de Postgres, le aplica todas las migraciones y carga los planes.
// Los tests (npm test) usan SIEMPRE esa base (ver lib/db.js): nunca ensucian ni
// dependen de la base de desarrollo.
//
//   npm run test:preparar        (una vez, y de nuevo si agregas migraciones)
//
// Para usar otra base de pruebas: DATABASE_URL_TEST en el .env.
require('dotenv').config();

const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { urlDeTest } = require('../lib/db');

(async () => {
  const url = new URL(urlDeTest());
  const nombre = url.pathname.replace(/^\//, '');
  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  const existe = await c.query('select 1 from pg_database where datname = $1', [nombre]);
  if (!existe.rowCount) {
    await c.query(`CREATE DATABASE "${nombre.replace(/"/g, '')}"`);
    console.log(`Base de pruebas creada: ${nombre}`);
  } else {
    console.log(`Base de pruebas existente: ${nombre}`);
  }
  await c.end();

  const env = { ...process.env, DATABASE_URL: url.toString(), SEED_CLIENTE_EMAIL: '', SEED_CLIENTE_PASSWORD: '' };
  for (const [titulo, cmd, params] of [
    ['Migraciones', 'npx', ['prisma', 'migrate', 'deploy']],
    ['Planes y paquetes', 'node', ['prisma/seed.js']],
  ]) {
    console.log(`\n== ${titulo} ==`);
    const r = spawnSync(cmd, params, { env, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) { console.error(`Falló: ${titulo}`); process.exit(r.status || 1); }
  }
  console.log('\nListo. Ahora `npm test` corre contra la base de pruebas.');
})().catch((e) => { console.error(e.message); process.exit(1); });
