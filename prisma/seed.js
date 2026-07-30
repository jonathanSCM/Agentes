// Proshop - carga inicial de datos (planes y paquetes segun el PDF comercial).
// Ejecutar con:  npm run seed
require('dotenv').config();

const { prisma } = require('../lib/db');

// ---- Planes (precios en bolivianos) ----
const PLANES = [
  {
    codigo: 'GRATIS',
    nombre: 'Gratis',
    mensualidadBs: 0,
    implementacionBs: 0,
    primerPagoBs: 0,
    convIncluidas: 100,
    maxProductos: 10,
    maxUsuarios: 1,
    recomendado: false,
    modeloIa: 'gpt-4o-mini',
    orden: 1,
    features: [
      'Hasta 10 productos',
      'Respuestas basicas por WhatsApp',
      'Consulta de productos y precios',
      'Captura del nombre y telefono del cliente',
      'Derivacion a un vendedor humano',
      'Acceso para un usuario',
      'Marca ProShop visible',
    ],
  },
  {
    codigo: 'STANDARD',
    nombre: 'Standard',
    mensualidadBs: 490,
    implementacionBs: 900,
    primerPagoBs: 1390,
    convIncluidas: 300,
    maxProductos: 100,
    maxUsuarios: 1,
    recomendado: false,
    modeloIa: 'gpt-4.1-mini',
    orden: 2,
    features: [
      'Hasta 100 productos',
      'Agente de ventas con IA por WhatsApp',
      'Catalogo digital de productos',
      'Respuestas automaticas sobre productos y precios',
      'Recomendaciones basicas',
      'Carrito conversacional',
      'Registro automatico de pedidos',
      'Pago contra entrega',
      'Panel administrativo basico',
      'Gestion de clientes',
      'Control manual de stock',
      'Derivacion a atencion humana',
    ],
  },
  {
    codigo: 'PRO',
    nombre: 'Pro',
    mensualidadBs: 990,
    implementacionBs: 1900,
    primerPagoBs: 2890,
    convIncluidas: 500,
    maxProductos: 500,
    maxUsuarios: 3,
    recomendado: true,
    modeloIa: 'gpt-4o',
    orden: 3,
    features: [
      'Todo lo del plan Standard, mas:',
      'Hasta 500 productos',
      'Acceso para hasta tres usuarios',
      'Gestion avanzada de pedidos',
      'Creacion de combos y promociones',
      'Identificacion de clientes frecuentes',
      'Alertas de stock bajo',
      'Historial de compras por cliente',
      'CRM comercial basico',
      'Recordatorios de seguimiento',
      'Reportes de ventas',
      'Identificacion de productos mas vendidos',
      'Calculo del ticket promedio',
      'Seguimiento de oportunidades comerciales',
      'Soporte prioritario',
    ],
  },
  {
    codigo: 'PREMIUM',
    nombre: 'Premium Business Intelligence',
    mensualidadBs: 1990,
    implementacionBs: 3900,
    primerPagoBs: 5890,
    convIncluidas: 1500,
    maxProductos: 2000,
    maxUsuarios: 10,
    recomendado: false,
    modeloIa: 'gpt-5.2-chat-latest',
    marcaBlanca: true,
    orden: 4,
    features: [
      'Todo lo del plan Pro, mas:',
      'Hasta 2.000 productos',
      'Acceso para hasta diez usuarios',
      'Plataforma con marca blanca',
      'Dashboard gerencial',
      'Comparacion de ventas por periodos',
      'Identificacion de clientes nuevos y recurrentes',
      'Deteccion de clientes inactivos',
      'Identificacion de clientes con riesgo de abandono',
      'Analisis de devoluciones y pedidos cancelados',
      'Analisis de resenas y comentarios',
      'Identificacion de productos con mejor y peor rendimiento',
      'Resumen ejecutivo generado por inteligencia artificial',
      'Identificacion de riesgos comerciales',
      'Acciones recomendadas para mejorar las ventas',
    ],
  },
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
  console.log('Cargando planes...');
  for (const plan of PLANES) {
    await prisma.plan.upsert({
      where: { codigo: plan.codigo },
      update: plan,
      create: plan,
    });
    console.log(`  - ${plan.nombre} (Bs ${plan.mensualidadBs}/mes, ${plan.convIncluidas} conv.)`);
  }

  console.log('Cargando paquetes de conversaciones...');
  // Los paquetes no tienen clave unica natural: se recargan desde cero.
  await prisma.paquete.deleteMany({});
  for (const p of PAQUETES) {
    await prisma.paquete.create({ data: p });
    console.log(`  - ${p.cantidad.toLocaleString('es')} conv. -> US$ ${p.precioUsd}`);
  }

  const totalPlanes = await prisma.plan.count();
  const totalPaquetes = await prisma.paquete.count();
  console.log(`\nListo: ${totalPlanes} planes y ${totalPaquetes} paquetes en la base de datos.`);
}

main()
  .catch((e) => {
    console.error('Error en el seed:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
