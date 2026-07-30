// Simulador de conversaciones entrantes.
// Genera consumo real usando la MISMA logica que usara el webhook de WhatsApp,
// para poder verificar saldos, cobros y bloqueos.
//
// Uso:
//   npm run simular                          -> lista las empresas disponibles
//   npm run simular -- "Tienda Dona Rosa" 5  -> simula 5 conversaciones nuevas
//   npm run simular -- 6 5                   -> tambien acepta el id de la empresa
require('dotenv').config();

const { prisma } = require('../lib/db');
const { procesarMensajeEntrante } = require('../lib/services/conversaciones');
const { obtenerResumenEmpresa } = require('../lib/services/suscripciones');

const PREGUNTAS = [
  'Hola, tienen zapatillas?',
  'Cuanto cuesta el envio?',
  'Hacen delivery a mi zona?',
  'Tienen talla 42 disponible?',
  'Aceptan pago con QR?',
  'Cual es su horario de atencion?',
  'Tienen descuento por mayor?',
  'Me pueden mandar el catalogo?',
];

function fmt(n) {
  return Number(n).toLocaleString('es-BO');
}

async function listarEmpresas() {
  const empresas = await prisma.empresa.findMany({
    include: { suscripcion: { include: { plan: true } }, agentes: true },
    orderBy: { id: 'asc' },
  });

  if (empresas.length === 0) {
    console.log('\n  No hay empresas registradas todavia.');
    console.log('  Crea una desde  http://localhost:3000/registro  o desde el panel admin.\n');
    return;
  }

  console.log('\n  EMPRESAS DISPONIBLES\n');
  for (const e of empresas) {
    const r = e.suscripcion ? await obtenerResumenEmpresa(e.id) : null;
    const saldo = r ? `${fmt(r.consumo.totalDisponible)} disponibles` : 'sin suscripcion';
    const agente = e.agentes[0] ? e.agentes[0].estado : 'SIN AGENTE';
    console.log(`  #${e.id}  ${e.nombre}`);
    console.log(`        plan: ${e.suscripcion ? e.suscripcion.plan.nombre : '-'} | ${saldo} | agente: ${agente}`);
  }
  console.log('\n  Para simular:  npm run simular -- "<nombre o id>" <cantidad>\n');
}

async function simular(refEmpresa, cantidad) {
  // Buscar por id o por nombre
  const porId = Number(refEmpresa);
  const empresa = await prisma.empresa.findFirst({
    where: Number.isInteger(porId) && porId > 0
      ? { id: porId }
      : { nombre: { contains: String(refEmpresa), mode: 'insensitive' } },
    include: { agentes: true, suscripcion: true },
  });

  if (!empresa) {
    console.log(`\n  No encontre ninguna empresa que coincida con "${refEmpresa}".\n`);
    return listarEmpresas();
  }
  if (!empresa.suscripcion) {
    console.log(`\n  "${empresa.nombre}" no tiene suscripcion. Asignale un plan desde el panel.\n`);
    return;
  }

  let agente = empresa.agentes[0];
  if (!agente) {
    agente = await prisma.agente.create({
      data: { empresaId: empresa.id, nombre: `Agente de ${empresa.nombre}`, estado: 'ACTIVO' },
    });
    console.log('  (se creo un agente para esta empresa)');
  }
  // El agente debe estar ACTIVO para atender
  if (agente.estado !== 'ACTIVO') {
    agente = await prisma.agente.update({ where: { id: agente.id }, data: { estado: 'ACTIVO' } });
    console.log('  (el agente estaba inactivo, se activo para la simulacion)');
  }

  const antes = await obtenerResumenEmpresa(empresa.id);
  console.log(`\n  EMPRESA: ${empresa.nombre}  (plan ${antes.plan.nombre})`);
  console.log('  ------------------------------------------------------------');
  console.log(`  ANTES ->  del plan: ${fmt(antes.consumo.incluidasDisponibles)}` +
    ` | de paquetes: ${fmt(antes.consumo.extraDisponible)}` +
    ` | TOTAL: ${fmt(antes.consumo.totalDisponible)}`);
  console.log('  ------------------------------------------------------------\n');

  const marca = Date.now().toString().slice(-6);
  let cobradasPlan = 0, cobradasExtra = 0, bloqueadas = 0;

  for (let i = 1; i <= cantidad; i++) {
    // Telefono distinto por conversacion -> cada una se cobra
    const telefono = `5917${marca}${String(i).padStart(3, '0')}`;
    const texto = PREGUNTAS[i % PREGUNTAS.length];

    const r = await procesarMensajeEntrante({
      agenteId: agente.id, telefonoCliente: telefono, contenido: texto,
    });

    if (!r.ok) {
      bloqueadas++;
      console.log(`  ${String(i).padStart(3)}. ${telefono}  BLOQUEADA (${r.motivo})`);
      continue;
    }
    if (r.origen === 'EXTRA') cobradasExtra++; else cobradasPlan++;
    console.log(`  ${String(i).padStart(3)}. ${telefono}  cobrada de: ${r.origen}`);

    // Un segundo mensaje del MISMO cliente: no debe cobrar
    if (i === 1) {
      const r2 = await procesarMensajeEntrante({
        agenteId: agente.id, telefonoCliente: telefono, contenido: 'Y tienen otro color?',
      });
      console.log(`       (2do mensaje del mismo cliente -> ${r2.cobrada ? 'COBRO (mal)' : 'no cobro, misma conversacion'})`);
    }
  }

  const despues = await obtenerResumenEmpresa(empresa.id);
  console.log('\n  ------------------------------------------------------------');
  console.log(`  DESPUES-> del plan: ${fmt(despues.consumo.incluidasDisponibles)}` +
    ` | de paquetes: ${fmt(despues.consumo.extraDisponible)}` +
    ` | TOTAL: ${fmt(despues.consumo.totalDisponible)}`);
  console.log('  ------------------------------------------------------------');
  console.log(`  Cobradas del plan: ${cobradasPlan} | de paquetes: ${cobradasExtra} | bloqueadas: ${bloqueadas}`);
  console.log(`  Consumido en total: ${fmt(antes.consumo.totalDisponible - despues.consumo.totalDisponible)}\n`);

  if (bloqueadas > 0) {
    console.log('  Se quedo sin saldo: compra un paquete en  http://localhost:3000/panel/paquetes\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) return listarEmpresas();

  const cantidad = parseInt(args[1], 10) || 5;
  await simular(args[0], cantidad);
}

main()
  .catch((e) => { console.error('\nError:', e.message, '\n'); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
