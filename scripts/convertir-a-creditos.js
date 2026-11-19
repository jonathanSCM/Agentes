'use strict';
// Conversion de saldos de conversaciones a creditos (fase 7 del planning).
//
//   node scripts/convertir-a-creditos.js                 SIMULA (no escribe nada) y muestra el informe por empresa
//   node scripts/convertir-a-creditos.js --aplicar       escribe los lotes y verifica (diferencia tiene que ser 0)
//   node scripts/convertir-a-creditos.js --empresa=12    solo una empresa
//
// Recomendado: correrlo primero SIMULANDO, despues --aplicar sobre una COPIA de la base, revisar el informe y recien
// entonces correrlo en produccion. Es idempotente. No activa nada: los creditos mandan cuando CREDITOS_MODO=ACTIVO.

const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* sin dotenv */ }
const { prisma } = require('../lib/db');
const conv = require('../lib/services/conversionCreditos');

const args = process.argv.slice(2);
const aplicarCambios = args.includes('--aplicar');
const emp = args.find((a) => a.startsWith('--empresa='));
const empresaId = emp ? Number(emp.split('=')[1]) : null;

const fmt = (n) => Number(n).toLocaleString('es-BO');
const pad = (t, n) => String(t).padEnd(n).slice(0, n);

(async () => {
  console.log(aplicarCambios ? '== APLICANDO la conversión ==' : '== SIMULACIÓN (no se escribe nada) ==');
  const r = aplicarCambios ? await conv.aplicar({ empresaId }) : { ...(await conv.planificar({ empresaId })), verificacion: null };

  console.log(`\n${pad('Empresa', 32)}${pad('Estado', 10)}${pad('Conv.', 9)}${pad('Créditos', 11)}Detalle`);
  let totalConv = 0; let totalCred = 0;
  for (const f of r.filas) {
    totalConv += f.conversaciones; totalCred += f.creditosEsperados;
    const detalle = f.omitida ? `omitida (${f.omitida})` : (f.lotes.map((l) => `${l.origen === 'PLAN' ? 'plan' : 'paquete'} ${fmt(l.conversaciones)}`).join(' + ') || 'sin saldo');
    console.log(`${pad(f.nombre, 32)}${pad(f.estado, 10)}${pad(fmt(f.conversaciones), 9)}${pad(fmt(f.creditosEsperados), 11)}${detalle}`);
  }
  console.log(`\nTotal: ${fmt(totalConv)} conversaciones -> ${fmt(totalCred)} créditos (x${require('../lib/services/creditos').EQUIVALENCIA}).`);
  if (r.solicitudesPendientes) console.log(`ATENCIÓN: hay ${r.solicitudesPendientes} pedido(s) de conversaciones PENDIENTE(S). Resolvelos antes de activar: al aprobarse en modo ACTIVO se interpretan como créditos.`);

  let codigo = 0;
  if (r.verificacion) {
    console.log('\nVerificación (esperado vs creado):');
    for (const v of r.verificacion.filas) console.log(`${pad(v.nombre, 32)}esperado ${pad(fmt(v.esperado), 10)} creado ${pad(fmt(v.creado), 10)} diferencia ${v.diferencia}${v.cuadreLibro ? '' : '  ¡EL LIBRO NO CUADRA!'}`);
    console.log(r.verificacion.ok ? '\nINFORME DE DIFERENCIAS EN CERO: la conversión cuadra.' : '\nHAY DIFERENCIAS: no actives los créditos hasta revisarlas.');
    codigo = r.verificacion.ok ? 0 : 1;
  } else {
    console.log('\n(Simulación: para escribir usá --aplicar.)');
  }
  await prisma.$disconnect();
  process.exit(codigo);
})().catch(async (err) => { console.error('Error:', err.message); await prisma.$disconnect().catch(() => {}); process.exit(2); });
