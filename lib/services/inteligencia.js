'use strict';
// lib/services/inteligencia.js
//
// INTELIGENCIA DE NEGOCIO (docs/11, F7 · módulo PANEL). Todo sale de los datos reales del negocio y se
// calcula con REGLAS (código y consultas a la base): cero IA, cero costo por consulta.
//   - Los textos de riesgos y acciones solo se generan cuando hay un dato que los respalda; si no hay
//     datos suficientes se dice, no se inventa.
//   - Clientes en riesgo: se compara cuánto hace que no compra con CADA cuánto suele comprar.
//   - Buscador de comentarios: busca por palabras en los mensajes reales que escribieron los clientes
//     por WhatsApp (sin tildes, singular o plural). No es búsqueda semántica y no calcula "% de
//     coincidencia" inventados.

const { DateTime } = require('luxon');
const { prisma } = require('../db');
const R = require('./resumenComercial');

const DIA_MS = 24 * 60 * 60 * 1000;
const NIVELES = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const MAX_CLIENTES = 40;

const aCent = (v) => Math.round(Number(v || 0) * 100);
const deCent = (c) => Math.round(c) / 100;
const mediana = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Riesgo de que un cliente deje de comprar, a partir de sus fechas de compra.
 * @param {Date[]} fechas fechas de compra del cliente
 * @param {Date} ahora
 * @param {{ devolucionReciente?: boolean }} [extra]
 * @returns {null | { riesgo, motivo, accion, diasSinComprar, compras, cadaDias }}
 */
function clasificarCliente(fechas, ahora, { devolucionReciente = false } = {}) {
  if (!fechas.length) return null;
  const orden = [...fechas].sort((a, b) => a - b);
  const compras = orden.length;
  const dias = Math.max(0, Math.floor((ahora - orden[compras - 1]) / DIA_MS));
  let riesgo = null;
  let motivo = null;
  let accion = null;
  let cadaDias = null;

  if (compras >= 2) {
    const intervalos = [];
    for (let i = 1; i < orden.length; i++) intervalos.push(Math.max(1, (orden[i] - orden[i - 1]) / DIA_MS));
    cadaDias = Math.max(1, Math.round(mediana(intervalos)));
    const razon = dias / cadaDias;
    if (razon >= 3 && dias >= 30) riesgo = 'HIGH';
    else if (razon >= 2 && dias >= 21) riesgo = 'MEDIUM';
    else if (razon >= 1.5 && dias >= 14) riesgo = 'LOW';
    if (riesgo) {
      motivo = `Suele comprar cada ${cadaDias} día${cadaDias === 1 ? '' : 's'} y ya pasaron ${dias}`;
      accion = riesgo === 'HIGH'
        ? 'Escribirle personalmente con una oferta basada en lo que ya compró.'
        : 'Mandarle un recordatorio amable con las novedades.';
    }
  } else if (dias >= 120) {
    riesgo = 'HIGH';
    motivo = `Compró una sola vez hace ${dias} días y no volvió`;
    accion = 'Preguntarle cómo le fue con su compra y ofrecerle algo para que vuelva.';
  } else if (dias >= 45) {
    riesgo = 'MEDIUM';
    motivo = `Compró una sola vez hace ${dias} días y no volvió`;
    accion = 'Preguntarle cómo le fue con su compra y mostrarle productos nuevos.';
  }

  if (devolucionReciente) {
    // Una devolución reciente sube la alerta (como mínimo a "medio") y cambia la acción.
    if (!riesgo || NIVELES[riesgo] > NIVELES.MEDIUM) riesgo = 'MEDIUM';
    motivo = motivo ? `Tuvo una devolución reciente. ${motivo}` : 'Tuvo una devolución reciente';
    accion = 'Preguntarle si quedó conforme y ofrecerle ayuda antes de que se enfríe.';
  }
  if (!riesgo) return null;
  return { riesgo, motivo, accion, diasSinComprar: dias, compras, cadaDias };
}

/** Clientes con riesgo de dejar de comprar (los más urgentes primero). */
async function clientesEnRiesgo(empresaId, { ahora = new Date() } = {}) {
  const desde = new Date(ahora.getTime() - 365 * DIA_MS);
  const desdeDev = new Date(ahora.getTime() - 60 * DIA_MS);
  const [pedidos, ventas, devoluciones] = await Promise.all([
    prisma.pedido.findMany({ where: { empresaId, estado: { not: 'CANCELADO' }, clienteId: { not: null }, createdAt: { gte: desde } }, select: { clienteId: true, createdAt: true, id: true } }),
    prisma.venta.findMany({ where: { empresaId, estado: 'COMPLETADA', clienteId: { not: null }, createdAt: { gte: desde } }, select: { clienteId: true, createdAt: true, pedidoId: true } }),
    prisma.devolucion.findMany({ where: { empresaId, createdAt: { gte: desdeDev } }, select: { venta: { select: { clienteId: true } } } }),
  ]);
  // Un pedido cobrado en el mostrador ya está en su venta: una sola compra.
  const cobrados = new Set(ventas.map((v) => v.pedidoId).filter(Boolean));
  const porCliente = new Map();
  const agregar = (id, fecha) => { if (!porCliente.has(id)) porCliente.set(id, []); porCliente.get(id).push(fecha); };
  pedidos.filter((p) => !cobrados.has(p.id)).forEach((p) => agregar(p.clienteId, p.createdAt));
  ventas.forEach((v) => agregar(v.clienteId, v.createdAt));
  const conDevolucion = new Set(devoluciones.map((d) => d.venta && d.venta.clienteId).filter(Boolean));

  const evaluados = [];
  for (const [clienteId, fechas] of porCliente) {
    const r = clasificarCliente(fechas, ahora, { devolucionReciente: conDevolucion.has(clienteId) });
    if (r) evaluados.push({ clienteId, ...r });
  }
  evaluados.sort((a, b) => NIVELES[a.riesgo] - NIVELES[b.riesgo] || b.diasSinComprar - a.diasSinComprar);
  const elegidos = evaluados.slice(0, MAX_CLIENTES);
  const clientes = await prisma.clienteFinal.findMany({
    where: { empresaId, id: { in: elegidos.map((e) => e.clienteId) } },
    select: { id: true, nombre: true, nombrePerfil: true, telefono: true },
  });
  const porId = new Map(clientes.map((c) => [c.id, c]));
  return {
    total: evaluados.length,
    cuenta: { HIGH: evaluados.filter((e) => e.riesgo === 'HIGH').length, MEDIUM: evaluados.filter((e) => e.riesgo === 'MEDIUM').length, LOW: evaluados.filter((e) => e.riesgo === 'LOW').length },
    clientes: elegidos.filter((e) => porId.has(e.clienteId)).map((e) => {
      const c = porId.get(e.clienteId);
      return { ...e, nombre: c.nombre || c.nombrePerfil || 'Cliente sin nombre', telefono: c.telefono };
    }),
  };
}

/** Texto sugerido para escribirle a un cliente (se edita antes de enviar). */
function mensajeSugerido(cliente, nombreNegocio) {
  const nombre = String(cliente.nombre || '').split(' ')[0];
  const saludo = nombre && nombre !== 'Cliente' ? `Hola ${nombre}` : 'Hola';
  const negocio = nombreNegocio ? ` de ${nombreNegocio}` : '';
  if (/devoluci/i.test(cliente.motivo || '')) return `${saludo}, te escribimos${negocio}. ¿Quedaste conforme con lo último? Si hay algo que podamos mejorar, contanos y lo resolvemos.`;
  if (cliente.compras <= 1) return `${saludo}, ¿cómo te fue con tu compra${negocio ? negocio : ''}? Tenemos novedades que te pueden gustar. ¿Querés que te mostremos?`;
  return `${saludo}, hace un tiempo que no sabemos de vos${negocio ? ` en ${nombreNegocio}` : ''}. Tenemos novedades y queremos mostrártelas. ¿Te las mandamos?`;
}

/** Ticket promedio por mes (últimos 6 meses, en la zona del negocio). */
function serieMensual(movimientos, zona, ahora) {
  const meses = [];
  for (let i = 5; i >= 0; i--) {
    const inicio = DateTime.fromJSDate(ahora, { zone: zona }).startOf('month').minus({ months: i });
    meses.push({ clave: inicio.toFormat('yyyy-MM'), etiqueta: inicio.setLocale('es').toFormat('LLL'), ventas: 0, ingresos: 0 });
  }
  for (const m of movimientos) {
    const fila = meses.find((x) => x.clave === DateTime.fromJSDate(m.fecha, { zone: zona }).toFormat('yyyy-MM'));
    if (!fila) continue;
    fila.ingresos += m.total;
    if (!m.devolucion) fila.ventas += 1;
  }
  return meses.map((x) => ({ etiqueta: x.etiqueta, ventas: x.ventas, ticket: x.ventas ? deCent(x.ingresos / x.ventas) : null }));
}

/** Panorama gerencial con datos reales de los últimos 30 días contra los 30 anteriores. */
async function panorama(empresaId, { ahora = new Date() } = {}) {
  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId }, select: { zonaHoraria: true, moneda: true } });
  const zona = (empresa && empresa.zonaHoraria) || 'America/La_Paz';
  const rango = R.rangoDe('30d', zona, ahora);
  const inicioSerie = DateTime.fromJSDate(ahora, { zone: zona }).startOf('month').minus({ months: 5 }).toJSDate();

  const [movSerie, categorias, pedidosCancelados, pedidosTotales, pedidosViejos, productos] = await Promise.all([
    R.movimientosDe(empresaId, inicioSerie, rango.hasta),
    prisma.categoria.findMany({ where: { empresaId }, select: { id: true, nombre: true, padreId: true } }),
    prisma.pedido.count({ where: { empresaId, estado: 'CANCELADO', createdAt: { gte: rango.desde, lt: rango.hasta } } }),
    prisma.pedido.count({ where: { empresaId, createdAt: { gte: rango.desde, lt: rango.hasta } } }),
    prisma.pedido.count({ where: { empresaId, estado: { in: ['NUEVO', 'CONFIRMADO'] }, createdAt: { lt: new Date(ahora.getTime() - 3 * DIA_MS) } } }),
    prisma.producto.findMany({ where: { empresaId, activo: true }, select: { id: true, nombre: true, categoriaId: true, stock: true, variantes: { where: { activa: true }, select: { stock: true } } } }),
  ]);
  const actual = movSerie.filter((m) => m.fecha >= rango.desde && m.fecha < rango.hasta);
  const anterior = movSerie.filter((m) => m.fecha >= rango.anteriorDesde && m.fecha < rango.anteriorHasta);
  const ta = R.totalesDe(actual);
  const tp = R.totalesDe(anterior);
  const hayDatos = movSerie.some((m) => !m.devolucion);

  // Devoluciones: dinero devuelto sobre lo vendido en el periodo.
  const vendidoBruto = actual.filter((m) => !m.devolucion).reduce((s, m) => s + m.total, 0);
  const devuelto = -actual.filter((m) => m.devolucion).reduce((s, m) => s + m.total, 0);
  const tasaDevolucion = vendidoBruto > 0 ? Math.round((devuelto / vendidoBruto) * 1000) / 10 : null;

  // Categoría (rubro) que más ingresos genera.
  const rubroDe = new Map();
  const nombreDe = new Map(categorias.map((c) => [c.id, c]));
  for (const c of categorias) { let r = c; let g = 0; while (r.padreId && nombreDe.get(r.padreId) && g++ < 5) r = nombreDe.get(r.padreId); rubroDe.set(c.id, r); }
  const categoriaDeProducto = new Map(productos.map((p) => [p.id, p.categoriaId]));
  const porRubro = new Map();
  let ingresosLineas = 0;
  for (const m of actual) {
    for (const l of m.lineas) {
      const cat = categoriaDeProducto.get(l.productoId);
      const rubro = cat ? rubroDe.get(cat) : null;
      const clave = rubro ? rubro.nombre : 'Sin categoría';
      porRubro.set(clave, (porRubro.get(clave) || 0) + l.ingreso);
      ingresosLineas += l.ingreso;
    }
  }
  const rubros = [...porRubro.entries()].map(([nombre, ing]) => ({ nombre, ingresos: deCent(ing), porcentaje: ingresosLineas > 0 ? Math.round((ing / ingresosLineas) * 100) : 0 })).sort((a, b) => b.ingresos - a.ingresos);
  const categoriaTop = rubros.length && rubros[0].ingresos > 0 ? rubros[0] : null;

  // Ticket promedio (30 días contra los 30 anteriores).
  const ticketActual = ta.ventas ? ta.ingresos / ta.ventas : 0;
  const ticketAnterior = tp.ventas ? tp.ingresos / tp.ventas : 0;
  const ticket = { actual: deCent(ticketActual), anterior: deCent(ticketAnterior), variacion: R.variacion(ticketActual, ticketAnterior) };

  const riesgosClientes = await clientesEnRiesgo(empresaId, { ahora });

  // Productos más vendidos con poco stock.
  const unidades = new Map();
  for (const m of actual) for (const l of m.lineas) if (l.productoId) unidades.set(l.productoId, (unidades.get(l.productoId) || 0) + l.cantidad);
  const topIds = [...unidades.entries()].filter(([, u]) => u > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
  const stockDe = (p) => (p.variantes.length ? p.variantes.reduce((s, v) => s + v.stock, 0) : p.stock);
  const topPocoStock = productos.filter((p) => topIds.includes(p.id) && stockDe(p) <= R.UMBRAL_STOCK_BAJO).map((p) => ({ nombre: p.nombre, stock: stockDe(p) }));

  const riesgos = [];
  const acciones = [];
  const ingVar = R.variacion(ta.ingresos, tp.ingresos);
  if (tp.ingresos > 0 && ingVar !== null && ingVar <= -10) {
    riesgos.push(`Las ventas de los últimos 30 días bajaron ${Math.abs(ingVar)}% contra los 30 anteriores.`);
    acciones.push('Revisar qué cambió (precios, stock, promociones) y reforzar la difusión de tus productos más vendidos.');
  }
  if (ticket.variacion !== null && ticket.variacion <= -5 && tp.ventas > 0) {
    riesgos.push(`El ticket promedio bajó ${Math.abs(ticket.variacion)}%: los clientes están comprando menos por pedido.`);
    acciones.push('Probar combos o descuentos por llevar más de un producto para subir el ticket.');
  }
  if (categoriaTop && rubros.length > 1 && categoriaTop.porcentaje >= 40) {
    riesgos.push(`"${categoriaTop.nombre}" concentra el ${categoriaTop.porcentaje}% de tus ingresos: un problema de stock o precio ahí pega fuerte en el total.`);
    acciones.push(`Cuidar el stock y los precios de "${categoriaTop.nombre}" y empujar otras categorías.`);
  }
  if (tasaDevolucion !== null && tasaDevolucion >= 8) {
    riesgos.push(`Las devoluciones son el ${tasaDevolucion}% de lo vendido en los últimos 30 días.`);
    acciones.push('Revisar el motivo de las devoluciones (talla, calidad, descripción) para corregir la causa.');
  }
  if (pedidosTotales >= 5 && pedidosCancelados / pedidosTotales >= 0.2) {
    riesgos.push(`${pedidosCancelados} de ${pedidosTotales} pedidos de los últimos 30 días se cancelaron.`);
    acciones.push('Revisar por qué se cancelan (stock, demoras, precio) y qué le responde el agente al cliente.');
  }
  if (pedidosViejos > 0) {
    riesgos.push(`Hay ${pedidosViejos} pedido${pedidosViejos === 1 ? '' : 's'} con más de 3 días sin entregar ni cancelar.`);
    acciones.push('Ir a Pedidos y confirmar, entregar o cancelar los que están parados.');
  }
  if (topPocoStock.length) {
    riesgos.push(`Se te está acabando el stock de ${topPocoStock.map((p) => `"${p.nombre}"`).join(', ')}, que están entre tus más vendidos.`);
    acciones.push('Reponer esos productos antes de que se agoten.');
  }
  if (riesgosClientes.cuenta.HIGH > 0) {
    riesgos.push(`${riesgosClientes.cuenta.HIGH} cliente${riesgosClientes.cuenta.HIGH === 1 ? '' : 's'} con riesgo alto de no volver a comprar.`);
    acciones.push('Escribirles personalmente (ver la lista de abajo).');
  }

  return {
    hayDatos, moneda: (empresa && empresa.moneda) || 'BOB', rango: { desde: rango.desde, hasta: rango.hasta },
    kpis: {
      tasaDevolucion: { valor: tasaDevolucion, detalle: tasaDevolucion === null ? 'Todavía no hay ventas en el periodo' : `${deCent(devuelto)} devueltos de ${deCent(vendidoBruto)} vendidos`, devuelto: deCent(devuelto), vendido: deCent(vendidoBruto) },
      cancelados: { cantidad: pedidosCancelados, total: pedidosTotales, porcentaje: pedidosTotales ? Math.round((pedidosCancelados / pedidosTotales) * 1000) / 10 : null },
      categoriaTop, ticket,
    },
    rubros: rubros.slice(0, 5), serieTicket: serieMensual(movSerie, zona, ahora), riesgos, acciones, clientes: riesgosClientes,
  };
}

// ---------------------------------------------------------------------------------------------------
// Buscador de comentarios: mensajes reales de clientes por WhatsApp.

const PARADAS = new Set(['que', 'una', 'uno', 'los', 'las', 'con', 'por', 'para', 'del', 'muy', 'mas', 'como', 'pero', 'sin', 'son', 'fue', 'era']);
const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ');
/** Palabras de la búsqueda (sin tildes, sin palabras vacías) y su raíz, para que singular/plural coincidan. */
function palabrasDe(q) {
  const vistas = new Set();
  return normalizar(q).split(/\s+/).filter((w) => w.length > 2 && !PARADAS.has(w)).filter((w) => (vistas.has(w) ? false : vistas.add(w))).slice(0, 6)
    .map((w) => ({ palabra: w, raiz: w.length > 5 ? w.slice(0, w.length - 2) : w }));
}
const escaparLike = (s) => s.replace(/[\\%_]/g, '\\$&');

async function buscarComentarios(empresaId, q, { ahora = new Date(), dias = 120 } = {}) {
  const palabras = palabrasDe(q);
  if (!palabras.length) return { palabras, resultados: [] };
  const desde = new Date(ahora.getTime() - dias * DIA_MS);
  const patrones = palabras.map((p) => `%${escaparLike(p.raiz)}%`);
  const filas = await prisma.$queryRawUnsafe(
    `SELECT m.id, m."contenido", m."createdAt", c."telefonoCliente"
       FROM mensajes m
       JOIN conversaciones c ON c.id = m."conversacionId"
       JOIN agentes a ON a.id = c."agenteId"
      WHERE a."empresaId" = $1 AND m.rol = 'CLIENTE' AND m."createdAt" >= $2
        AND translate(lower(m."contenido"), 'áéíóúüñ', 'aeiouun') ILIKE ANY($3::text[])
      ORDER BY m."createdAt" DESC LIMIT 400`,
    empresaId, desde, patrones,
  );
  const evaluados = filas.map((f) => {
    const texto = normalizar(f.contenido);
    const coinciden = palabras.filter((p) => texto.includes(p.raiz));
    return { id: f.id, contenido: f.contenido, fecha: f.createdAt, telefono: f.telefonoCliente, coincidencias: coinciden.length };
  }).filter((f) => f.coincidencias > 0)
    .sort((a, b) => b.coincidencias - a.coincidencias || b.fecha - a.fecha).slice(0, 60);
  const telefonos = [...new Set(evaluados.map((e) => e.telefono))];
  const clientes = await prisma.clienteFinal.findMany({ where: { empresaId, telefono: { in: telefonos } }, select: { telefono: true, nombre: true, nombrePerfil: true } });
  const nombres = new Map(clientes.map((c) => [c.telefono, c.nombre || c.nombrePerfil]));
  return { palabras, resultados: evaluados.map((e) => ({ ...e, nombre: nombres.get(e.telefono) || null })) };
}

module.exports = { clasificarCliente, clientesEnRiesgo, mensajeSugerido, serieMensual, panorama, palabrasDe, buscarComentarios, NIVELES };
