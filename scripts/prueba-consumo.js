// Prueba end-to-end de la logica de consumo de conversaciones.
// Crea datos de prueba, simula mensajes de WhatsApp y verifica las reglas del PDF.
// Al final borra todo lo que creo.  Ejecutar con:  npm run prueba
require('dotenv').config();

const { prisma } = require('../lib/db');
const { procesarMensajeEntrante } = require('../lib/services/conversaciones');
const {
  obtenerEstadoConsumo,
  registrarCompraPaquete,
} = require('../lib/services/suscripciones');

const SLUG = 'empresa-de-prueba-tmp';
let fallos = 0;

function check(descripcion, condicion, detalle = '') {
  const icono = condicion ? 'OK  ' : 'FALLA';
  if (!condicion) fallos++;
  console.log(`  [${icono}] ${descripcion}${detalle ? ' -> ' + detalle : ''}`);
}

async function limpiar() {
  await prisma.empresa.deleteMany({ where: { slug: SLUG } });
  await prisma.plan.deleteMany({ where: { codigo: 'TEST_TMP' } });
}

async function main() {
  await limpiar();
  console.log('\n=== PREPARANDO ESCENARIO DE PRUEBA ===');

  // Plan pequeno (2 conversaciones) para poder agotarlo rapido
  const plan = await prisma.plan.create({
    data: {
      codigo: 'TEST_TMP',
      nombre: 'Plan de prueba',
      mensualidadBs: 0,
      implementacionBs: 0,
      primerPagoBs: 0,
      convIncluidas: 2,
      maxProductos: 10,
      maxUsuarios: 1,
      activo: false,
      features: [],
    },
  });

  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Empresa de prueba',
      slug: SLUG,
      suscripcion: {
        create: {
          planId: plan.id,
          estado: 'ACTIVA',
          periodoFin: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      },
      agentes: { create: { nombre: 'Agente de prueba', estado: 'ACTIVO' } },
    },
    include: { suscripcion: true, agentes: true },
  });

  const agenteId = empresa.agentes[0].id;
  const subId = empresa.suscripcion.id;
  console.log(`  Plan con ${plan.convIncluidas} conversaciones incluidas. Agente ACTIVO.`);

  // ---------------------------------------------------------------
  console.log('\n=== 1) Primer mensaje de un cliente: debe COBRAR ===');
  const r1 = await procesarMensajeEntrante({
    agenteId, telefonoCliente: '59171111111', contenido: 'Hola, tienen zapatos?',
  });
  check('Se atiende', r1.ok);
  check('Se cobra 1 conversacion', r1.cobrada === true);
  check('Se descuenta del cupo INCLUIDO', r1.origen === 'INCLUIDA', r1.origen);

  // ---------------------------------------------------------------
  console.log('\n=== 2) Mismo cliente escribe de nuevo: NO debe cobrar ===');
  const r2 = await procesarMensajeEntrante({
    agenteId, telefonoCliente: '59171111111', contenido: 'De que talla?',
  });
  check('Se atiende', r2.ok);
  check('NO se vuelve a cobrar', r2.cobrada === false);
  check('Es la MISMA conversacion', r2.conversacionId === r1.conversacionId,
    `#${r1.conversacionId} vs #${r2.conversacionId}`);

  const est1 = await obtenerEstadoConsumo(subId);
  check('Solo 1 conversacion consumida (no 2 mensajes)', est1.incluidasUsadas === 1,
    `usadas=${est1.incluidasUsadas}`);

  // ---------------------------------------------------------------
  console.log('\n=== 3) Otro cliente distinto: debe COBRAR ===');
  const r3 = await procesarMensajeEntrante({
    agenteId, telefonoCliente: '59172222222', contenido: 'Precio del producto X?',
  });
  check('Se cobra', r3.cobrada === true);
  check('Es una conversacion NUEVA', r3.conversacionId !== r1.conversacionId);

  const est2 = await obtenerEstadoConsumo(subId);
  check('Cupo incluido agotado (2 de 2)', est2.incluidasDisponibles === 0,
    `disponibles=${est2.incluidasDisponibles}`);

  // ---------------------------------------------------------------
  console.log('\n=== 4) Tercer cliente sin saldo: debe BLOQUEAR ===');
  const r4 = await procesarMensajeEntrante({
    agenteId, telefonoCliente: '59173333333', contenido: 'Hola',
  });
  check('NO se atiende', r4.ok === false);
  check('El motivo es falta de saldo', r4.motivo === 'SIN_SALDO', r4.motivo);

  // ---------------------------------------------------------------
  console.log('\n=== 5) Compra un paquete adicional de 5 ===');
  await registrarCompraPaquete({
    empresaId: empresa.id, cantidad: 5, precioUsd: 66, nota: 'Paquete de prueba',
  });
  const est3 = await obtenerEstadoConsumo(subId);
  check('Saldo extra disponible = 5', est3.extraDisponible === 5, `extra=${est3.extraDisponible}`);
  check('Ya puede atender', est3.puedeAtender === true);

  // ---------------------------------------------------------------
  console.log('\n=== 6) Ese cliente reintenta: cobra del saldo EXTRA ===');
  const r5 = await procesarMensajeEntrante({
    agenteId, telefonoCliente: '59173333333', contenido: 'Hola de nuevo',
  });
  check('Ahora si se atiende', r5.ok === true);
  check('Se cobra del saldo EXTRA', r5.origen === 'EXTRA', r5.origen);

  const est4 = await obtenerEstadoConsumo(subId);
  check('Saldo extra bajo a 4', est4.extraDisponible === 4, `extra=${est4.extraDisponible}`);
  check('Las incluidas siguen en 2 usadas', est4.incluidasUsadas === 2);

  // ---------------------------------------------------------------
  console.log('\n=== 7) Libro contable (auditoria) ===');
  const registros = await prisma.registroUso.findMany({
    where: { suscripcionId: subId }, orderBy: { id: 'asc' },
  });
  registros.forEach((r) =>
    console.log(`  #${r.id} ${r.tipo}${r.origen ? '/' + r.origen : ''} x${r.cantidad}  ${r.nota || ''}`)
  );
  check('Quedaron 4 eventos registrados', registros.length === 4, `${registros.length} eventos`);

  console.log('\n=== 8) Saldo por paquete comprado ===');
  const compras = await prisma.compraPaquete.findMany({ where: { empresaId: empresa.id } });
  compras.forEach((c) =>
    console.log(`  Paquete de ${c.cantidad}: consumidas ${c.consumidas}, saldo ${c.cantidad - c.consumidas}, renueva ${c.fechaRenovacion.toLocaleDateString('es-BO')}, estado ${c.estado}`)
  );
  check('El paquete registra 1 consumida', compras[0] && compras[0].consumidas === 1);
  check('Saldo del paquete = 4', compras[0] && compras[0].cantidad - compras[0].consumidas === 4);

  console.log('\n=== RESUMEN FINAL ===');
  console.log(`  Incluidas: ${est4.incluidasUsadas}/${est4.incluidasTotal}` +
    ` | Extra disponible: ${est4.extraDisponible} | Total disponible: ${est4.totalDisponible}`);

  await limpiar();
  console.log('\n  (datos de prueba eliminados)');

  if (fallos > 0) {
    console.log(`\nRESULTADO: ${fallos} verificacion(es) FALLARON\n`);
    process.exit(1);
  }
  console.log('\nRESULTADO: todas las verificaciones pasaron correctamente\n');
}

main()
  .catch(async (e) => {
    console.error('\nError en la prueba:', e);
    await limpiar().catch(() => {});
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
