'use strict';
// Negocio de prueba para los evals: una empresa propia ("eval-...") con dos
// agentes (uno con el flujo de botones y otro sin él), un catálogo chico pero
// con todo lo que importa (rubros con tipos, variantes de talla, producto sin
// variantes) y un cliente "otro" para las pruebas de privacidad.
//
// Todo lo que crea se borra al terminar (y al empezar, si quedó algo de una
// corrida cortada): nunca toca los datos reales de ninguna empresa.

const { prisma } = require('../../lib/db');

const SLUG = 'eval-tienda';
const TELEFONO_OTRO_CLIENTE = '59170000099';

async function limpiar() {
  const viejas = await prisma.empresa.findMany({ where: { slug: { startsWith: 'eval-' } }, select: { id: true } });
  for (const { id } of viejas) {
    await prisma.pedido.deleteMany({ where: { empresaId: id } });
    await prisma.clienteFinal.deleteMany({ where: { empresaId: id } });
    await prisma.empresa.delete({ where: { id } }).catch(() => {});
  }
}

async function crear() {
  await limpiar();
  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'Tienda Eval', slug: SLUG, moneda: 'BOB',
      agentes: {
        create: [
          { nombre: 'Ana', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, aceptaQr: true, preguntasIniciales: [], flujoDeterminista: true, direccionTienda: 'Av. Siempre Viva 123' } } },
          { nombre: 'Beto', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, aceptaQr: true, preguntasIniciales: [], flujoDeterminista: false, direccionTienda: 'Av. Siempre Viva 123' } } },
        ],
      },
    },
    include: { agentes: true },
  });
  const empresaId = empresa.id;
  const agentes = { flujo: empresa.agentes.find((a) => a.nombre === 'Ana').id, ia: empresa.agentes.find((a) => a.nombre === 'Beto').id };

  const calzado = await prisma.categoria.create({ data: { empresaId, nombre: 'Calzado', orden: 1 } });
  const zapatillas = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas', padreId: calzado.id, orden: 1 } });
  const botas = await prisma.categoria.create({ data: { empresaId, nombre: 'Botas', padreId: calzado.id, orden: 2 } });
  const ropa = await prisma.categoria.create({ data: { empresaId, nombre: 'Ropa', orden: 2 } });
  const poleras = await prisma.categoria.create({ data: { empresaId, nombre: 'Poleras', padreId: ropa.id, orden: 1 } });
  const gorras = await prisma.categoria.create({ data: { empresaId, nombre: 'Gorras', orden: 3 } });

  const conVariantes = (categoriaId, nombre, precio, tallas) => prisma.producto.create({
    data: {
      empresaId, categoriaId, nombre, precio, stock: 0, atributos: {}, fotos: ['eval.jpg'],
      variantes: { create: tallas.map((t) => ({ atributos: { Talla: t }, stock: 5, fotos: [] })) },
    },
  });
  await conVariantes(zapatillas.id, 'Zapatilla Runner', 300, ['41', '42', '43']);
  await conVariantes(zapatillas.id, 'Zapatilla Urbana', 250, ['40', '42']);
  await conVariantes(poleras.id, 'Polera Básica', 80, ['M', 'L']);
  await prisma.producto.create({ data: { empresaId, categoriaId: botas.id, nombre: 'Bota Alta', precio: 200, stock: 4, atributos: {}, fotos: ['eval.jpg'] } });
  await prisma.producto.create({ data: { empresaId, categoriaId: gorras.id, nombre: 'Gorra Sol', precio: 60, stock: 9, atributos: {}, fotos: ['eval.jpg'] } });

  // Otro cliente de la misma tienda, con datos que NUNCA deben aparecer en otra conversación.
  await prisma.clienteFinal.create({ data: { empresaId, telefono: TELEFONO_OTRO_CLIENTE, nombre: 'Carlos Ajeno', direccionEntrega: 'Calle Secreta 999' } });

  return { empresaId, agentes };
}

/** Deja el stock y los pedidos como al principio (cada corrida parte limpia). */
async function reiniciar(empresaId) {
  await prisma.pedido.deleteMany({ where: { empresaId } });
  await prisma.clienteFinal.deleteMany({ where: { empresaId, telefono: { startsWith: 'eval-' } } });
  await prisma.variante.updateMany({ where: { producto: { empresaId } }, data: { stock: 5 } });
  await prisma.producto.updateMany({ where: { empresaId, nombre: 'Bota Alta' }, data: { stock: 4 } });
  await prisma.producto.updateMany({ where: { empresaId, nombre: 'Gorra Sol' }, data: { stock: 9 } });
}

/**
 * Deja al cliente en el estado que pide el escenario.
 *   cliente: { carrito: [{ producto, talla, cantidad }], datos: {...campos de ClienteFinal}, categoria, tarjetaMostrada }
 */
async function prepararCliente(empresaId, telefono, cliente = {}) {
  const items = [];
  for (const it of cliente.carrito || []) {
    const p = await prisma.producto.findFirst({ where: { empresaId, nombre: it.producto }, include: { variantes: true } });
    const v = it.talla ? p.variantes.find((x) => x.atributos.Talla === it.talla) : null;
    items.push({
      productoId: p.id, varianteId: v ? v.id : null, seleccion: null,
      nombre: v ? `${p.nombre} (Talla: ${it.talla})` : p.nombre, precio: Number(p.precio), cantidad: it.cantidad || 1, agregadoEn: new Date().toISOString(),
    });
  }
  const enCompra = items.length ? { estadoConversacion: 'INTENCION_DE_COMPRA', productoFavoritoId: items[0].productoId } : {};
  const cat = cliente.categoria ? await prisma.categoria.findFirst({ where: { empresaId, nombre: cliente.categoria } }) : null;
  const conCategoria = cat ? { categoriaId: cat.id, categoriaInteres: cat.nombre } : {};
  return prisma.clienteFinal.create({
    data: {
      empresaId, telefono, ...enCompra, ...conCategoria, ...(cliente.datos || {}),
      // Una categoria elegida ya tuvo su tarjeta (estado real de una conversacion en curso); sin eso el
      // motor la manda de nuevo por su cuenta y tapa lo que el cliente acaba de pedir.
      contexto: {
        ...(items.length ? { carrito: { conversacionId: null, items, actualizadoEn: new Date().toISOString() } } : {}),
        ...(cat && cliente.tarjetaMostrada !== false ? { tarjetasCategoriaMostradas: [cat.id] } : {}),
      },
    },
  });
}

module.exports = { crear, limpiar, reiniciar, prepararCliente, TELEFONO_OTRO_CLIENTE };
