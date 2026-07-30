const { PrismaClient } = require('./lib/generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = 'postgresql://postgres:987654321@localhost:5432/proshop?schema=public';
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

(async () => {
  try {
    const empresas = await client.empresa.findMany({
      include: {
        usuarios: true,
        agentes: true,
        productos: true,
        pedidos: true,
        pagos: true,
        suscripcion: true,
      },
    });
    console.log(JSON.stringify({ empresas }, null, 2));
  } catch (e) {
    console.error('ERROR', e);
    process.exit(1);
  } finally {
    await client.$disconnect();
  }
})();
