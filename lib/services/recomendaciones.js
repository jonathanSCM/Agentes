// "Tambien te puede interesar" del catalogo web: co-compra simple, sin IA
// (Opcion C de docs/05-propuesta-personalizacion-ia.md). Mira que otros
// productos se compraron junto con este en pedidos reales de la MISMA
// empresa, ordenado por frecuencia. Si nunca se compro junto a nada, no
// inventa nada: devuelve vacio y la seccion simplemente no se muestra.
const { prisma } = require('../db');

async function productosRelacionados(empresaId, productoId, limite = 4) {
  const pedidosConEsteProducto = await prisma.pedidoItem.findMany({
    where: { productoId, pedido: { empresaId } },
    select: { pedidoId: true },
  });
  const pedidoIds = [...new Set(pedidosConEsteProducto.map((p) => p.pedidoId))];
  if (!pedidoIds.length) return [];

  const agrupado = await prisma.pedidoItem.groupBy({
    by: ['productoId'],
    where: { pedidoId: { in: pedidoIds }, productoId: { not: productoId } },
    _count: { productoId: true },
    orderBy: { _count: { productoId: 'desc' } },
    take: limite * 2, // margen: algunos ids pueden ya no estar activos
  });
  const idsOrdenados = agrupado.map((a) => a.productoId).filter((id) => id != null);
  if (!idsOrdenados.length) return [];

  // Nunca confia en el agrupado solo: vuelve a filtrar por empresa y activo
  // real, asi un producto borrado/desactivado o de otra tienda jamas aparece.
  const productos = await prisma.producto.findMany({
    where: { id: { in: idsOrdenados }, empresaId, activo: true },
    select: { id: true, nombre: true, precio: true, fotos: true, stock: true },
  });

  const orden = new Map(idsOrdenados.map((id, i) => [id, i]));
  return productos
    .sort((a, b) => orden.get(a.id) - orden.get(b.id))
    .slice(0, limite);
}

module.exports = { productosRelacionados };
