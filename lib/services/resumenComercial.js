'use strict';
// lib/services/resumenComercial.js
//
// RESUMEN COMERCIAL (docs/11, F7 · módulo PANEL). Todo son consultas a la base: cero IA.
// Reglas:
//   - Los periodos se miden en la zona horaria del negocio (empresa.zonaHoraria), no en la del servidor.
//   - Se suman dos canales: MOSTRADOR (ventas COMPLETADAS) y WHATSAPP (pedidos no cancelados). Un pedido
//     que ya se cobró en el mostrador (ventas.pedidoId) cuenta una sola vez, como venta del mostrador.
//   - Utilidad = ingresos − costo, SOLO de las líneas que tienen costo. Si falta el costo de una línea no
//     se inventa utilidad: se informa cuánto de lo vendido quedó "sin costo".
//   - Los montos se calculan en centavos enteros y se devuelven como números con 2 decimales.

const { DateTime } = require('luxon');
const { prisma } = require('../db');

const PERIODOS = {
  hoy: 'Hoy',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
  mes: 'Este mes',
};
const PERIODO_POR_DEFECTO = '7d';
const UMBRAL_STOCK_BAJO = 5;

const aCent = (v) => Math.round(Number(v || 0) * 100);
const deCent = (c) => Math.round(c) / 100;

/**
 * Rango [desde, hasta) del periodo y el periodo anterior de igual duración (para la comparación).
 * `ahora` se inyecta para poder probarlo.
 */
function rangoDe(periodo, zona = 'America/La_Paz', ahora = new Date()) {
  const clave = PERIODOS[periodo] ? periodo : PERIODO_POR_DEFECTO;
  const fin = DateTime.fromJSDate(ahora, { zone: zona });
  const hoyInicio = fin.startOf('day');
  let desde;
  if (clave === 'hoy') desde = hoyInicio;
  else if (clave === '7d') desde = hoyInicio.minus({ days: 6 });
  else if (clave === '30d') desde = hoyInicio.minus({ days: 29 });
  else desde = fin.startOf('month');
  const hasta = hoyInicio.plus({ days: 1 });
  const dias = Math.max(1, Math.round(hasta.diff(desde, 'days').days));
  return {
    periodo: clave,
    etiqueta: PERIODOS[clave],
    zona,
    dias,
    desde: desde.toJSDate(),
    hasta: hasta.toJSDate(),
    anteriorDesde: desde.minus({ days: dias }).toJSDate(),
    anteriorHasta: desde.toJSDate(),
  };
}

const diaDe = (fecha, zona) => DateTime.fromJSDate(fecha, { zone: zona }).toFormat('yyyy-MM-dd');

/** Variación porcentual contra el periodo anterior; null si no hay con qué comparar. */
function variacion(actual, anterior) {
  if (!anterior) return actual ? null : 0;
  return Math.round(((actual - anterior) / anterior) * 1000) / 10;
}

/** Trae ventas del mostrador y pedidos de WhatsApp de un rango, ya normalizados a "movimientos". */
async function movimientosDe(empresaId, desde, hasta) {
  const [ventas, pedidos] = await Promise.all([
    prisma.venta.findMany({
      where: { empresaId, estado: 'COMPLETADA', createdAt: { gte: desde, lt: hasta } },
      include: { items: true, pagos: true },
    }),
    prisma.pedido.findMany({
      where: { empresaId, estado: { not: 'CANCELADO' }, createdAt: { gte: desde, lt: hasta } },
      include: {
        items: { include: { producto: { select: { costo: true } }, variante: { select: { costo: true } } } },
      },
    }),
  ]);
  // Un pedido cobrado en el mostrador ya está dentro de una venta: no se cuenta dos veces.
  const cobrados = new Set(ventas.map((v) => v.pedidoId).filter(Boolean));
  const pedidosSueltos = pedidos.filter((p) => !cobrados.has(p.id));

  const movimientos = [];
  for (const v of ventas) {
    const lineas = v.items.map((i) => ({
      productoId: i.productoId, nombre: i.nombre, cantidad: i.cantidad,
      ingreso: aCent(i.total),
      costo: i.costoUnitario == null ? null : aCent(i.costoUnitario) * i.cantidad,
    }));
    movimientos.push({ canal: 'MOSTRADOR', fecha: v.createdAt, total: aCent(v.total), lineas, venta: v });
  }
  for (const p of pedidosSueltos) {
    const lineas = p.items.map((i) => {
      const costoU = (i.variante && i.variante.costo != null) ? i.variante.costo : (i.producto ? i.producto.costo : null);
      return {
        productoId: i.productoId, nombre: i.nombre, cantidad: i.cantidad,
        ingreso: aCent(i.precio) * i.cantidad,
        costo: costoU == null ? null : aCent(costoU) * i.cantidad,
      };
    });
    movimientos.push({ canal: 'WHATSAPP', fecha: p.createdAt, total: aCent(p.total), lineas, pedido: p });
  }
  return movimientos;
}

/** Totales de una lista de movimientos (para el periodo actual y el anterior). */
function totalesDe(movimientos) {
  const t = {
    ventas: movimientos.length, ingresos: 0, utilidad: 0, ingresosConCosto: 0, ingresosSinCosto: 0,
    canal: {
      MOSTRADOR: { ventas: 0, ingresos: 0 },
      WHATSAPP: { ventas: 0, ingresos: 0 },
    },
  };
  for (const m of movimientos) {
    t.ingresos += m.total;
    t.canal[m.canal].ventas += 1;
    t.canal[m.canal].ingresos += m.total;
    for (const l of m.lineas) {
      if (l.costo == null) t.ingresosSinCosto += l.ingreso;
      else { t.ingresosConCosto += l.ingreso; t.utilidad += l.ingreso - l.costo; }
    }
  }
  return t;
}

/**
 * Resumen completo. `opciones.ahora` solo se usa en pruebas.
 */
async function resumen(empresaId, periodo, opciones = {}) {
  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId }, select: { zonaHoraria: true, moneda: true } });
  const zona = (empresa && empresa.zonaHoraria) || 'America/La_Paz';
  const rango = rangoDe(periodo, zona, opciones.ahora || new Date());

  const agentes = await prisma.agente.findMany({ where: { empresaId }, select: { id: true } });
  const agenteIds = agentes.map((a) => a.id);

  const [actuales, anteriores, conversaciones, pedidosPorCobrar, productosActivos, ventasAnuladas] = await Promise.all([
    movimientosDe(empresaId, rango.desde, rango.hasta),
    movimientosDe(empresaId, rango.anteriorDesde, rango.anteriorHasta),
    prisma.conversacion.count({ where: { agenteId: { in: agenteIds }, createdAt: { gte: rango.desde, lt: rango.hasta } } }),
    prisma.pedido.findMany({ where: { empresaId, estado: { in: ['NUEVO', 'CONFIRMADO'] } }, select: { total: true } }),
    prisma.producto.findMany({
      where: { empresaId, activo: true },
      select: { id: true, nombre: true, stock: true, variantes: { where: { activa: true }, select: { stock: true } } },
    }),
    prisma.venta.count({ where: { empresaId, estado: 'ANULADA', createdAt: { gte: rango.desde, lt: rango.hasta } } }),
  ]);

  const t = totalesDe(actuales);
  const ta = totalesDe(anteriores);

  // Serie diaria por canal.
  const porDia = new Map();
  for (let i = 0; i < rango.dias; i++) {
    const dia = DateTime.fromJSDate(rango.desde, { zone: zona }).plus({ days: i }).toFormat('yyyy-MM-dd');
    porDia.set(dia, { dia, mostrador: 0, whatsapp: 0 });
  }
  for (const m of actuales) {
    const fila = porDia.get(diaDe(m.fecha, zona));
    if (!fila) continue;
    fila[m.canal === 'MOSTRADOR' ? 'mostrador' : 'whatsapp'] += m.total;
  }
  const serie = [...porDia.values()].map((f) => ({ dia: f.dia, mostrador: deCent(f.mostrador), whatsapp: deCent(f.whatsapp), total: deCent(f.mostrador + f.whatsapp) }));

  // Productos más vendidos (ambos canales).
  const productos = new Map();
  for (const m of actuales) {
    for (const l of m.lineas) {
      const clave = l.productoId != null ? `p${l.productoId}` : `n${l.nombre}`;
      if (!productos.has(clave)) productos.set(clave, { nombre: l.nombre, unidades: 0, ingresos: 0, utilidad: 0, sinCosto: false });
      const f = productos.get(clave);
      f.unidades += l.cantidad;
      f.ingresos += l.ingreso;
      if (l.costo == null) f.sinCosto = true; else f.utilidad += l.ingreso - l.costo;
    }
  }
  const masVendidos = [...productos.values()]
    .sort((a, b) => b.unidades - a.unidades || b.ingresos - a.ingresos)
    .slice(0, 8)
    .map((f) => ({ nombre: f.nombre, unidades: f.unidades, ingresos: deCent(f.ingresos), utilidad: f.sinCosto ? null : deCent(f.utilidad) }));

  // Cobros por método (solo el mostrador registra pagos).
  const metodos = {};
  for (const m of actuales) {
    if (!m.venta) continue;
    for (const p of m.venta.pagos) metodos[p.metodo] = (metodos[p.metodo] || 0) + aCent(p.monto);
  }
  const porMetodo = Object.entries(metodos).map(([metodo, c]) => ({ metodo, monto: deCent(c) })).sort((a, b) => b.monto - a.monto);

  // Stock bajo (el de un producto con opciones vive en las opciones).
  const stockBajo = productosActivos
    .map((p) => ({ id: p.id, nombre: p.nombre, stock: p.variantes.length ? p.variantes.reduce((s, v) => s + v.stock, 0) : p.stock }))
    .filter((p) => p.stock <= UMBRAL_STOCK_BAJO)
    .sort((a, b) => a.stock - b.stock);

  const margen = t.ingresosConCosto > 0 ? Math.round((t.utilidad / t.ingresosConCosto) * 1000) / 10 : null;
  const ticket = t.ventas ? deCent(t.ingresos / t.ventas) : 0;
  const ticketAnterior = ta.ventas ? ta.ingresos / ta.ventas : 0;

  return {
    rango: { periodo: rango.periodo, etiqueta: rango.etiqueta, dias: rango.dias, desde: rango.desde, hasta: rango.hasta },
    moneda: (empresa && empresa.moneda) || 'BOB',
    ingresos: deCent(t.ingresos),
    ventas: t.ventas,
    ticketPromedio: ticket,
    utilidad: t.ingresosConCosto > 0 ? deCent(t.utilidad) : null,
    margen,
    sinCosto: deCent(t.ingresosSinCosto),
    vsAnterior: {
      ingresos: variacion(t.ingresos, ta.ingresos),
      ventas: variacion(t.ventas, ta.ventas),
      ticket: variacion(t.ventas ? t.ingresos / t.ventas : 0, ticketAnterior),
    },
    canal: {
      mostrador: { ventas: t.canal.MOSTRADOR.ventas, ingresos: deCent(t.canal.MOSTRADOR.ingresos) },
      whatsapp: { ventas: t.canal.WHATSAPP.ventas, ingresos: deCent(t.canal.WHATSAPP.ingresos) },
    },
    serie,
    masVendidos,
    porMetodo,
    embudo: { conversaciones, pedidosWhatsapp: t.canal.WHATSAPP.ventas, ventasMostrador: t.canal.MOSTRADOR.ventas },
    porCobrar: { pedidos: pedidosPorCobrar.length, monto: deCent(pedidosPorCobrar.reduce((s, p) => s + aCent(p.total), 0)) },
    stockBajo: stockBajo.slice(0, 8),
    stockBajoTotal: stockBajo.length,
    ventasAnuladas,
  };
}

/** Filas para el Excel: una por cada línea vendida, de ambos canales. */
async function filasParaExcel(empresaId, periodo, opciones = {}) {
  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId }, select: { zonaHoraria: true } });
  const zona = (empresa && empresa.zonaHoraria) || 'America/La_Paz';
  const rango = rangoDe(periodo, zona, opciones.ahora || new Date());
  const movimientos = await movimientosDe(empresaId, rango.desde, rango.hasta);
  movimientos.sort((a, b) => a.fecha - b.fecha);
  const filas = [];
  for (const m of movimientos) {
    const referencia = m.venta ? `V-${String(m.venta.numero).padStart(4, '0')}` : `Pedido #${m.pedido.id}`;
    const cuando = DateTime.fromJSDate(m.fecha, { zone: zona }).toFormat('yyyy-MM-dd HH:mm');
    for (const l of m.lineas) {
      filas.push({
        fecha: cuando,
        canal: m.canal === 'MOSTRADOR' ? 'Mostrador' : 'WhatsApp',
        referencia,
        producto: l.nombre,
        cantidad: l.cantidad,
        ingreso: deCent(l.ingreso),
        costo: l.costo == null ? null : deCent(l.costo),
        utilidad: l.costo == null ? null : deCent(l.ingreso - l.costo),
      });
    }
  }
  return { rango: { ...rango }, filas };
}

module.exports = { PERIODOS, PERIODO_POR_DEFECTO, UMBRAL_STOCK_BAJO, rangoDe, variacion, totalesDe, resumen, filasParaExcel };
