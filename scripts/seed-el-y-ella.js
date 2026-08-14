// Reemplaza el catalogo de "Tienda Demo" por el catalogo real "El y Ella"
// (150 productos, ~2290 variantes talla+color, ropa y calzado para mujer y
// hombre). Los datos vienen de scripts/data/catalogo-el-y-ella.json, ya
// extraidos y limpiados desde el Excel original (ver comentario abajo).
//
// Ejecutar con:  npm run seed:el-y-ella
require('dotenv').config();

const { prisma } = require('../lib/db');
const catalogo = require('./data/catalogo-el-y-ella.json');

const SLUG_EMPRESA = process.env.SEED_EL_Y_ELLA_SLUG || 'tienda-demo';

async function main() {
  const empresa = await prisma.empresa.findUnique({ where: { slug: SLUG_EMPRESA } });
  if (!empresa) {
    console.error(`No existe una empresa con slug "${SLUG_EMPRESA}". Nada que hacer.`);
    process.exit(1);
  }

  console.log(`Empresa encontrada: ${empresa.nombre} (id ${empresa.id})`);

  const anteriores = await prisma.producto.count({ where: { empresaId: empresa.id } });
  console.log(`Eliminando ${anteriores} productos existentes...`);
  // onDelete: Cascade en Variante se encarga de borrar sus variantes.
  await prisma.producto.deleteMany({ where: { empresaId: empresa.id } });

  console.log(`Creando ${catalogo.length} productos del catalogo El y Ella...`);
  let contador = 0;
  for (const p of catalogo) {
    await prisma.producto.create({
      data: {
        empresaId: empresa.id,
        nombre: p.nombre,
        descripcion: p.descripcion,
        precio: p.precio,
        stock: 0, // el stock real vive en las variantes
        activo: p.activo,
        categoria: p.categoria,
        caracteristicas: p.caracteristicas,
        atributos: p.atributos,
        fotos: [],
        variantes: {
          create: p.variantes.map((v) => ({
            atributos: v.atributos,
            stock: v.stock,
            precio: v.precio,
            activa: v.activa,
          })),
        },
      },
    });
    contador += 1;
    if (contador % 25 === 0) console.log(`  ... ${contador}/${catalogo.length}`);
  }

  console.log(`Listo. ${contador} productos cargados con sus variantes.`);
}

main()
  .catch((err) => {
    console.error('Error en el seeder de El y Ella:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
