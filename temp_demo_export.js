const { PrismaClient } = require('./lib/generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = 'postgresql://postgres:987654321@localhost:5432/proshop?schema=public';
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

(async () => {
  try {
    const empresa = await client.empresa.findUnique({
      where: { id: 2 },
      include: {
        usuarios: true,
        agentes: {
          include: {
            config: true,
            conexion: true,
            conversaciones: {
              include: { mensajes: true },
            },
          },
        },
        productos: true,
        pedidos: {
          include: { cliente: true, items: true },
        },
        pagos: true,
        comprasPaquete: true,
        notificaciones: true,
        suscripcion: true,
        clientes: true,
      },
    });
    console.log(JSON.stringify(empresa, null, 2));
  } catch (e) {
    console.error('ERROR', e);
    process.exit(1);
  } finally {
    await client.$disconnect();
  }
})();
