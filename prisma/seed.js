// Proshop - carga inicial de datos (planes y paquetes segun el PDF comercial).
// Ejecutar con:  npm run seed
require('dotenv').config();

const { prisma } = require('../lib/db');
const { registrarCliente } = require('../lib/services/auth');

const SEED_CLIENTE_EMAIL = process.env.SEED_CLIENTE_EMAIL;
const SEED_CLIENTE_PASSWORD = process.env.SEED_CLIENTE_PASSWORD;
const SEED_CLIENTE_EMPRESA = process.env.SEED_CLIENTE_EMPRESA || 'Mi empresa';
const SEED_CLIENTE_NOMBRE = process.env.SEED_CLIENTE_NOMBRE || 'Administrador';
const SEED_CLIENTE_PLAN = process.env.SEED_CLIENTE_PLAN || 'ACCESO_TOTAL';

// ---- Planes por MODULOS (precios en bolivianos; todo editable desde /admin/planes) ----
// Un plan es una plantilla: al asignarlo a un cliente se copian sus valores (docs/11 §11).
// Los precios de esta siembra son una propuesta inicial: el superadmin los ajusta.
const PLANES = [
  {
    codigo: 'PRUEBA', nombre: 'Prueba gratis', oculto: true, orden: 0,
    mensualidadBs: 0, implementacionBs: 0, primerPagoBs: 0,
    convIncluidas: 100, maxProductos: 10, maxUsuarios: 1, maxServicios: 3, maxCitasMes: 30, maxMensajesPropios: 30,
    modulos: ['AGENTE'], modeloIa: 'gpt-4o-mini', categoria: 'PERSONAL',
    features: ['Solo el Agente de ventas', 'Prueba sin costo'],
  },
  {
    codigo: 'AGENTE', nombre: 'Agente', orden: 1,
    mensualidadBs: 490, implementacionBs: 0, primerPagoBs: 490,
    convIncluidas: 300, maxProductos: 100, maxUsuarios: 1, maxServicios: 10, maxCitasMes: 200, maxMensajesPropios: 30,
    modulos: ['AGENTE'], modeloIa: 'gpt-4.1-mini', categoria: 'PERSONAL',
    features: [
      'Agente de ventas con IA por WhatsApp', 'Catálogo digital y carrito conversacional',
      'Registro automático de pedidos', 'Reserva de citas por WhatsApp', 'Mensajes del agente editables',
      'Conversaciones tipo CRM', 'Gestión de clientes', 'Derivación a atención humana',
    ],
  },
  {
    codigo: 'AGENTE_POS', nombre: 'Agente + Punto de venta', orden: 2, recomendado: true,
    mensualidadBs: 990, implementacionBs: 0, primerPagoBs: 990,
    convIncluidas: 500, maxProductos: 500, maxUsuarios: 3, maxServicios: 30, maxCitasMes: 1000, maxMensajesPropios: 30,
    modulos: ['AGENTE', 'POS'], modeloIa: 'gpt-4o', categoria: 'PERSONAL',
    features: [
      'Todo lo del plan Agente, más:', 'Punto de venta con caja y recibos', 'Impresora térmica y lector de códigos de barras',
      'Control de stock compartido con el agente', 'Ventas, anulaciones y devoluciones', 'Usuario cajero',
    ],
  },
  {
    codigo: 'AGENTE_POS_PANEL', nombre: 'Agente + Punto de venta + Panel comercial', orden: 3,
    mensualidadBs: 1990, implementacionBs: 0, primerPagoBs: 1990,
    convIncluidas: 1500, maxProductos: 2000, maxUsuarios: 10, maxServicios: 100, maxCitasMes: 5000, maxMensajesPropios: 30,
    modulos: ['AGENTE', 'POS', 'PANEL'], modeloIa: 'gpt-4o', marcaBlanca: true, categoria: 'PERSONAL',
    features: [
      'Todo lo del plan Agente + Punto de venta, más:', 'Panel comercial: ventas, utilidad y margen',
      'Comparativa WhatsApp vs mostrador', 'Reportes con Excel', 'Inteligencia comercial', 'Auditoría', 'Marca blanca',
    ],
  },
  {
    // Plan oculto: solo un superadmin lo asigna. Todo ilimitado, para pruebas.
    codigo: 'ACCESO_TOTAL', nombre: 'Acceso total', oculto: true, ilimitado: true, orden: 99,
    mensualidadBs: 0, implementacionBs: 0, primerPagoBs: 0,
    convIncluidas: 0, maxProductos: 0, maxUsuarios: 0, maxServicios: 0, maxCitasMes: 0, maxMensajesPropios: 0,
    modulos: ['AGENTE', 'POS', 'PANEL'], modeloIa: 'gpt-4o', marcaBlanca: true, categoria: 'PERSONAL',
    features: ['Todos los módulos, sin límites (solo pruebas)'],
  },
];

// Planes de antes de los modulos: se retiran. Si algun cliente de prueba todavia los usa, se ocultan
// (su copia sigue funcionando); si nadie los usa, se borran.
const PLANES_VIEJOS = ['GRATIS', 'STANDARD', 'PRO', 'PREMIUM'];

// ---- Catalogo de caracteristicas comparables (filas de la tabla publica /planes/:categoria) ----
const TODOS = ['AGENTE', 'AGENTE_POS', 'AGENTE_POS_PANEL'];
const CON_POS = ['AGENTE_POS', 'AGENTE_POS_PANEL'];
const CARACTERISTICAS = [
  { nombre: 'Agente de ventas con IA por WhatsApp', orden: 1, planes: TODOS },
  { nombre: 'Catálogo digital y carrito conversacional', orden: 2, planes: TODOS },
  { nombre: 'Registro automático de pedidos', orden: 3, planes: TODOS },
  { nombre: 'Reserva de citas por WhatsApp', orden: 4, planes: TODOS },
  { nombre: 'Mensajes del agente editables', orden: 5, planes: TODOS },
  { nombre: 'Conversaciones tipo CRM', orden: 6, planes: TODOS },
  { nombre: 'Gestión de clientes', orden: 7, planes: TODOS },
  { nombre: 'Derivación a un asesor humano', orden: 8, planes: TODOS },
  { nombre: 'Punto de venta con caja y recibos', orden: 9, planes: CON_POS },
  { nombre: 'Impresora térmica y lector de códigos de barras', orden: 10, planes: CON_POS },
  { nombre: 'Stock compartido entre el agente y el mostrador', orden: 11, planes: CON_POS },
  { nombre: 'Panel comercial (ventas, utilidad, margen)', orden: 12, planes: ['AGENTE_POS_PANEL'] },
  { nombre: 'Reportes con Excel', orden: 13, planes: ['AGENTE_POS_PANEL'] },
  { nombre: 'Inteligencia comercial y auditoría', orden: 14, planes: ['AGENTE_POS_PANEL'] },
  { nombre: 'Marca blanca (plataforma con tu marca)', orden: 15, planes: ['AGENTE_POS_PANEL'] },
];

// ---- Paquetes de conversaciones adicionales (precios en dolares) ----
const PAQUETES = [
  { cantidad: 1000, precioUsd: 66, costoUnitarioUsd: 0.066 },
  { cantidad: 2500, precioUsd: 160, costoUnitarioUsd: 0.064 },
  { cantidad: 3500, precioUsd: 220.5, costoUnitarioUsd: 0.063 },
  { cantidad: 5000, precioUsd: 310, costoUnitarioUsd: 0.062 },
  { cantidad: 8000, precioUsd: 488, costoUnitarioUsd: 0.061 },
  { cantidad: 10000, precioUsd: 600, costoUnitarioUsd: 0.06 },
  { cantidad: 15000, precioUsd: 885, costoUnitarioUsd: 0.059 },
];

async function main() {
  console.log('Retirando planes anteriores...');
  for (const codigo of PLANES_VIEJOS) {
    const viejo = await prisma.plan.findUnique({ where: { codigo }, include: { _count: { select: { suscripciones: true } } } });
    if (!viejo) continue;
    if (viejo._count.suscripciones > 0) {
      await prisma.plan.update({ where: { id: viejo.id }, data: { activo: false, oculto: true } });
      console.log(`  - ${viejo.nombre}: oculto (todavia lo usa algun cliente de prueba)`);
    } else {
      await prisma.plan.delete({ where: { id: viejo.id } });
      console.log(`  - ${viejo.nombre}: borrado`);
    }
  }

  console.log('Cargando planes...');
  for (const plan of PLANES) {
    // update VACIO a proposito: este seed corre en CADA deploy (ver el CMD del
    // Dockerfile). Si actualizara los campos, cada despliegue pisaria los
    // precios y las conversaciones incluidas que Proshop haya editado desde
    // /admin/planes. El seed siembra lo que falta; la fuente de verdad de un
    // plan que ya existe es el panel.
    const existia = await prisma.plan.findUnique({ where: { codigo: plan.codigo } });
    await prisma.plan.upsert({
      where: { codigo: plan.codigo },
      update: {},
      create: plan,
    });
    console.log(`  - ${plan.nombre}${existia ? ' (ya existia, no se toco)' : ' (creado)'}`);
  }

  console.log('Cargando catalogo de caracteristicas comparables...');
  await prisma.caracteristica.deleteMany({ where: { nombre: { notIn: CARACTERISTICAS.map((c) => c.nombre) } } });
  for (const c of CARACTERISTICAS) {
    const caracteristica = await prisma.caracteristica.upsert({
      where: { nombre: c.nombre },
      update: { orden: c.orden },
      create: { nombre: c.nombre, orden: c.orden },
    });
    for (const codigoPlan of c.planes) {
      const plan = await prisma.plan.findUnique({ where: { codigo: codigoPlan } });
      if (!plan) continue;
      await prisma.planCaracteristica.upsert({
        where: { planId_caracteristicaId: { planId: plan.id, caracteristicaId: caracteristica.id } },
        update: { incluida: true },
        create: { planId: plan.id, caracteristicaId: caracteristica.id, incluida: true },
      });
    }
    console.log(`  - ${c.nombre} (${c.planes.join(', ')})`);
  }

  console.log('Cargando paquetes de conversaciones...');
  // NUNCA borrar y recrear los paquetes. Antes esto hacia deleteMany({}) + un
  // reset de la secuencia de ids, y como el seed corre en cada deploy eso
  // significaba, cada vez:
  //   - borrar en cascada los PaquetePrecioPais configurados desde /admin
  //     (la FK es ON DELETE CASCADE), y
  //   - dejar en NULL el paqueteId de todas las compras y pagos historicos
  //     (esas FKs son ON DELETE SET NULL), perdiendo que paquete se vendio.
  // Se siembra por cantidad, que es la clave natural del catalogo, y solo se
  // crea lo que falta: un paquete que ya existe queda intacto.
  for (const p of PAQUETES) {
    const existente = await prisma.paquete.findFirst({ where: { cantidad: p.cantidad } });
    if (existente) {
      console.log(`  - ${p.cantidad.toLocaleString('es')} conv. (ya existia, no se toco)`);
      continue;
    }
    await prisma.paquete.create({ data: p });
    console.log(`  - ${p.cantidad.toLocaleString('es')} conv. -> US$ ${p.precioUsd} (creado)`);
  }

  const totalPlanes = await prisma.plan.count();
  const totalPaquetes = await prisma.paquete.count();
  console.log(`\nListo: ${totalPlanes} planes y ${totalPaquetes} paquetes en la base de datos.`);

  if (SEED_CLIENTE_EMAIL && SEED_CLIENTE_PASSWORD) {
    try {
      const plan = await prisma.plan.findUnique({ where: { codigo: SEED_CLIENTE_PLAN } });
      if (!plan) {
        throw new Error(`No existe el plan con codigo ${SEED_CLIENTE_PLAN}.`);
      }
      const existingUser = await prisma.usuario.findUnique({ where: { email: SEED_CLIENTE_EMAIL.trim().toLowerCase() } });
      if (existingUser) {
        console.log(`La cuenta ${SEED_CLIENTE_EMAIL} ya existe, no se crea de nuevo.`);
      } else {
        console.log(`Creando cuenta inicial: ${SEED_CLIENTE_EMAIL}...`);
        await registrarCliente({
          empresa: SEED_CLIENTE_EMPRESA,
          nombre: SEED_CLIENTE_NOMBRE,
          email: SEED_CLIENTE_EMAIL,
          password: SEED_CLIENTE_PASSWORD,
          planId: plan.id,
        });
        console.log('Cuenta inicial creada correctamente.');
      }
    } catch (err) {
      console.error('No se pudo crear la cuenta inicial:', err.message);
      process.exit(1);
    }
  }
}

main()
  .catch((e) => {
    console.error('Error en el seed:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
