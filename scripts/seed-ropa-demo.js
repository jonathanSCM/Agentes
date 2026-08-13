// Reemplaza el catalogo de "Tienda Demo" (mezcla de electrodomesticos,
// calzado y accesorios) por un catalogo de UN SOLO rubro: ropa real, con
// variantes de talla y color con su propio stock. Pensado para dejar la
// demo alineada con la regla de negocio de "una tienda = un rubro".
//
// Ejecutar con:  node scripts/seed-ropa-demo.js
// (o:            npm run seed:ropa   si se agrega el script a package.json)
require('dotenv').config();

const { prisma } = require('../lib/db');

const SLUG_EMPRESA = process.env.SEED_ROPA_SLUG || 'tienda-demo';

// Cada producto: nombre, descripcion, precio base (usado si una variante no
// tiene precio propio), categoria (SIEMPRE "Ropa", un solo rubro),
// caracteristicas, y las variantes (talla + color) con su propio stock. El
// stock del producto en si queda en 0 porque, al tener variantes, el stock
// real vive en cada variante (asi lo espera el motor de busqueda).
const PRODUCTOS_ROPA = [
  {
    nombre: 'Camiseta básica de algodón',
    descripcion: 'Camiseta de algodón 100%, corte clásico, ideal para uso diario.',
    precio: 80,
    caracteristicas: ['Algodón 100%', 'Corte clásico', 'Cuello redondo'],
    variantes: combinar(['S', 'M', 'L', 'XL'], ['Blanco', 'Negro', 'Gris'], { stockBase: 8 }),
  },
  {
    nombre: 'Polera oversize unisex',
    descripcion: 'Polera de algodón con corte oversize, cómoda y versátil.',
    precio: 110,
    caracteristicas: ['Corte oversize', 'Algodón peinado', 'Unisex'],
    variantes: combinar(['S', 'M', 'L', 'XL'], ['Negro', 'Beige'], { stockBase: 6 }),
  },
  {
    nombre: 'Pantalón jogger deportivo',
    descripcion: 'Jogger cómodo con puños ajustables, ideal para entrenar o salir casual.',
    precio: 150,
    caracteristicas: ['Puños ajustables', 'Bolsillos con cierre', 'Tela elástica'],
    variantes: combinar(['S', 'M', 'L', 'XL'], ['Negro', 'Gris plomo'], { stockBase: 5 }),
  },
  {
    nombre: 'Chompa con capucha',
    descripcion: 'Chompa canguro con capucha y bolsillo frontal, abrigada para el invierno.',
    precio: 190,
    caracteristicas: ['Capucha ajustable', 'Bolsillo canguro', 'Interior afelpado'],
    variantes: combinar(['S', 'M', 'L', 'XL'], ['Negro', 'Azul marino', 'Vino'], { stockBase: 4, precioOverride: { Vino: 210 } }),
  },
  {
    nombre: 'Vestido casual de verano',
    descripcion: 'Vestido liviano de tela fresca, corte suelto, ideal para el calor.',
    precio: 160,
    caracteristicas: ['Tela liviana', 'Corte suelto', 'Manga corta'],
    variantes: combinar(['XS', 'S', 'M', 'L'], ['Floral', 'Negro'], { stockBase: 5 }),
  },
  {
    nombre: 'Chaqueta de mezclilla',
    descripcion: 'Chaqueta de mezclilla clásica, resistente y combinable con todo.',
    precio: 220,
    caracteristicas: ['Mezclilla resistente', 'Botones metálicos', 'Corte clásico'],
    variantes: combinar(['S', 'M', 'L', 'XL'], ['Azul clásico', 'Negro'], { stockBase: 3, precioOverride: { 'Azul clásico': 240 } }),
  },
];

// Genera todas las combinaciones talla x color con stock (y precio opcional
// distinto por color, para probar el caso de "precio propio de variante").
function combinar(tallas, colores, { stockBase = 5, precioOverride = {} } = {}) {
  const variantes = [];
  for (const talla of tallas) {
    for (const color of colores) {
      variantes.push({
        atributos: { Talla: talla, Color: color },
        stock: stockBase + Math.floor(Math.random() * 4), // algo de variedad realista
        precio: precioOverride[color] || null,
      });
    }
  }
  return variantes;
}

async function main() {
  const empresa = await prisma.empresa.findUnique({ where: { slug: SLUG_EMPRESA } });
  if (!empresa) {
    console.error(`No existe una empresa con slug "${SLUG_EMPRESA}". Nada que hacer.`);
    process.exit(1);
  }

  console.log(`Empresa encontrada: ${empresa.nombre} (id ${empresa.id})`);

  const anteriores = await prisma.producto.findMany({ where: { empresaId: empresa.id }, select: { id: true, nombre: true } });
  console.log(`Eliminando ${anteriores.length} productos existentes...`);
  // onDelete: Cascade en Variante se encarga de borrar sus variantes.
  // pedido_items.productoId tiene onDelete: SetNull, asi que los pedidos
  // viejos no se rompen (guardan el nombre del producto por separado).
  await prisma.producto.deleteMany({ where: { empresaId: empresa.id } });

  console.log(`Creando ${PRODUCTOS_ROPA.length} productos de ropa con variantes...`);
  for (const p of PRODUCTOS_ROPA) {
    const creado = await prisma.producto.create({
      data: {
        empresaId: empresa.id,
        nombre: p.nombre,
        descripcion: p.descripcion,
        precio: p.precio,
        stock: 0, // el stock real vive en las variantes
        activo: true,
        categoria: 'Ropa',
        caracteristicas: p.caracteristicas,
        fotos: [],
        variantes: {
          create: p.variantes.map((v) => ({
            atributos: v.atributos,
            stock: v.stock,
            precio: v.precio,
            activa: true,
          })),
        },
      },
      include: { variantes: true },
    });
    console.log(`  ✓ ${creado.nombre} — ${creado.variantes.length} variantes`);
  }

  console.log('Listo. Catálogo de ropa cargado.');
}

main()
  .catch((err) => {
    console.error('Error en el seeder de ropa:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
