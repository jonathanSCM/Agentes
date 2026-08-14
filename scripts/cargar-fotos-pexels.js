// Completa el campo `fotos` de los productos que no tienen ninguna foto
// propia, usando fotos de stock reales de la API de Pexels.
//
// No pisa fotos subidas manualmente: solo actualiza productos con fotos: [].
// Se puede volver a correr mas adelante para productos nuevos sin fotos.
//
// Uso: node scripts/cargar-fotos-pexels.js

const { prisma } = require('../lib/db');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// Traduce categoria -> termino de busqueda en ingles (Pexels busca mejor en ingles).
const TERMINO_POR_CATEGORIA = {
  Shorts: 'shorts',
  Jeans: 'jeans',
  Camisas: 'shirt',
  'Zapatillas urbanas': 'urban sneakers',
  'Vestidos y Enterizos': 'dress',
  'Botas y botines': 'boots',
  Faldas: 'skirt',
  Pantalones: 'pants',
  'Chompas y chalecos': 'sweater vest',
  'Casacas y abrigos': 'jacket coat',
  Chompas: 'sweater',
  'Zapatillas deportivas': 'sport sneakers',
  'Ropa de baño': 'swimwear',
  'Ropa Deportiva': 'activewear',
  Blusas: 'blouse',
  'Zapatos hombre': 'men dress shoes',
  Poleras: 't-shirt',
  Casacas: 'jacket',
};

const GENERO_EN = { Hombre: 'man', Mujer: 'woman' };

async function buscarEnPexels(query) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=portrait`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
  if (!res.ok) {
    throw new Error(`Pexels respondio ${res.status} para "${query}": ${await res.text()}`);
  }
  const data = await res.json();
  return (data.photos || []).map((p) => p.src.large);
}

async function main() {
  if (!PEXELS_API_KEY) {
    throw new Error('Falta PEXELS_API_KEY en el .env');
  }

  const productos = await prisma.producto.findMany({
    where: { fotos: { equals: [] } },
    select: { id: true, nombre: true, categoria: true, atributos: true },
    orderBy: { id: 'asc' },
  });

  console.log(`Productos sin fotos: ${productos.length}`);

  // Agrupa por (categoria + genero) para no repetir busquedas.
  const grupos = new Map();
  for (const p of productos) {
    const genero = (p.atributos && p.atributos.Genero) || '';
    const clave = `${p.categoria}||${genero}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(p);
  }

  let actualizados = 0;
  for (const [clave, items] of grupos) {
    const [categoria, genero] = clave.split('||');
    const terminoBase = TERMINO_POR_CATEGORIA[categoria] || categoria.toLowerCase();
    const terminoGenero = GENERO_EN[genero] || '';
    const query = `${terminoGenero} ${terminoBase} fashion`.trim();

    let fotos = [];
    try {
      fotos = await buscarEnPexels(query);
    } catch (err) {
      console.error(`  ! Error buscando "${query}":`, err.message);
      continue;
    }

    if (!fotos.length) {
      console.warn(`  ! Sin resultados en Pexels para "${query}" (${items.length} productos afectados)`);
      continue;
    }

    console.log(`"${query}" -> ${fotos.length} fotos encontradas, aplicando a ${items.length} productos`);

    for (let i = 0; i < items.length; i++) {
      const foto = fotos[i % fotos.length];
      await prisma.producto.update({
        where: { id: items[i].id },
        data: { fotos: [foto] },
      });
      actualizados++;
    }
  }

  console.log(`Listo. ${actualizados} productos actualizados con fotos de Pexels.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
