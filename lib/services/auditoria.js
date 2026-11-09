'use strict';
// lib/services/auditoria.js
//
// AUDITORÍA (docs/11, F7): quién hizo qué. Solo se agrega, nunca se edita (un trigger de la base lo impide).
// Reglas:
//   - Dentro de una transacción (`cliente` = tx) el registro es ATÓMICO con la acción: si no se pudo
//     registrar, la acción tampoco ocurre.
//   - Fuera de una transacción es "de mejor esfuerzo": si falla, se anota en el log del servidor pero no se
//     le niega al usuario lo que ya hizo (por ejemplo cerrar la caja).
//   - Se guarda el NOMBRE y el rol del usuario al momento: el historial sigue legible aunque la persona se
//     elimine del equipo.
//   - El detalle son datos simples (montos, motivos, nombres); nunca contraseñas ni tokens.

const { prisma } = require('../db');

// Catálogo: etiqueta legible + grupo para el filtro. Una acción desconocida no se registra (evita typos).
const ACCIONES = {
  VENTA_ANULADA: { etiqueta: 'Venta anulada', grupo: 'Ventas', grave: true },
  DEVOLUCION_REGISTRADA: { etiqueta: 'Devolución', grupo: 'Ventas', grave: true },
  CAJA_ABIERTA: { etiqueta: 'Caja abierta', grupo: 'Caja' },
  CAJA_CERRADA: { etiqueta: 'Caja cerrada', grupo: 'Caja' },
  CAJA_MOVIMIENTO: { etiqueta: 'Entrada o salida de caja', grupo: 'Caja' },
  STOCK_AJUSTADO: { etiqueta: 'Stock ajustado a mano', grupo: 'Inventario' },
  PRODUCTO_ELIMINADO: { etiqueta: 'Producto eliminado', grupo: 'Inventario', grave: true },
  PEDIDO_CANCELADO: { etiqueta: 'Pedido cancelado', grupo: 'Pedidos' },
  EQUIPO_INVITADO: { etiqueta: 'Invitación al equipo', grupo: 'Equipo' },
  EQUIPO_INVITACION_REVOCADA: { etiqueta: 'Invitación revocada', grupo: 'Equipo' },
  EQUIPO_ELIMINADO: { etiqueta: 'Persona quitada del equipo', grupo: 'Equipo', grave: true },
  PLAN_ASIGNADO: { etiqueta: 'Plan asignado', grupo: 'Plan' },
  PLAN_RENOVADO: { etiqueta: 'Plan renovado', grupo: 'Plan' },
  PLAN_EDITADO: { etiqueta: 'Plan editado', grupo: 'Plan' },
};

const POR_PAGINA = 50;

const limpiar = (v, max) => (v == null ? null : String(v).slice(0, max));

/** Recorta el detalle a datos simples y de tamaño razonable. */
function detalleSeguro(detalle) {
  if (!detalle || typeof detalle !== 'object') return null;
  const salida = {};
  for (const [k, v] of Object.entries(detalle)) {
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') salida[k] = v;
    else if (Array.isArray(v)) salida[k] = v.slice(0, 20).map((x) => (typeof x === 'object' ? JSON.stringify(x).slice(0, 120) : String(x).slice(0, 120)));
    else if (typeof v === 'object') salida[k] = JSON.stringify(v).slice(0, 300);
    else salida[k] = String(v).slice(0, 300);
  }
  return Object.keys(salida).length ? salida : null;
}

/**
 * Registra una acción. `cliente` es `prisma` o la `tx` de una transacción (en ese caso un error se propaga).
 * `actor`: { id, rol } de un usuario de la empresa, o { nombre } para una acción de Proshop (superadmin).
 */
async function registrar(cliente, { empresaId, actor, accion, entidad = null, entidadId = null, detalle = null }) {
  if (!ACCIONES[accion]) throw new Error(`Acción de auditoría desconocida: ${accion}`);
  const db = cliente || prisma;
  let nombre = actor && actor.nombre;
  let rol = actor && actor.rol;
  if (actor && actor.id != null && !nombre) {
    const u = await db.usuario.findFirst({ where: { id: actor.id }, select: { nombre: true, rol: true } });
    nombre = u ? u.nombre : `Usuario ${actor.id}`;
    rol = rol || (u && u.rol);
  }
  return db.auditoria.create({
    data: {
      empresaId,
      usuarioId: actor && actor.id != null ? actor.id : null,
      usuarioNombre: limpiar(nombre || 'Sistema', 120),
      usuarioRol: limpiar(rol, 30),
      accion,
      entidad: limpiar(entidad, 40),
      entidadId: entidadId == null ? null : Number(entidadId),
      detalle: detalleSeguro(detalle) || undefined,
    },
  });
}

/** Igual que registrar, pero un fallo no interrumpe la operación ya hecha (solo se anota en el log). */
async function registrarSinRiesgo(datos) {
  try {
    return await registrar(prisma, datos);
  } catch (err) {
    console.error('[auditoria] no se pudo registrar', datos && datos.accion, err.message);
    return null;
  }
}

/** Lista paginada, solo de la empresa pedida. */
async function listar(empresaId, { accion = '', grupo = '', usuarioId = null, desde = null, hasta = null, pagina = 1 } = {}) {
  const where = { empresaId };
  if (accion && ACCIONES[accion]) where.accion = accion;
  else if (grupo) {
    const acciones = Object.keys(ACCIONES).filter((a) => ACCIONES[a].grupo === grupo);
    if (acciones.length) where.accion = { in: acciones };
  }
  if (usuarioId) where.usuarioId = Number(usuarioId);
  if (desde || hasta) where.createdAt = { ...(desde ? { gte: desde } : {}), ...(hasta ? { lt: hasta } : {}) };
  const p = Math.max(1, parseInt(pagina, 10) || 1);
  const [total, filas] = await Promise.all([
    prisma.auditoria.count({ where }),
    prisma.auditoria.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (p - 1) * POR_PAGINA, take: POR_PAGINA }),
  ]);
  return { total, pagina: p, paginas: Math.max(1, Math.ceil(total / POR_PAGINA)), filas };
}

/** Texto corto de lo que pasó, armado con el detalle (para la lista). */
function resumenDe(fila, simbolo = '') {
  const d = fila.detalle || {};
  const m = (n) => `${simbolo ? `${simbolo} ` : ''}${Number(n).toFixed(2)}`;
  switch (fila.accion) {
    case 'VENTA_ANULADA': return `Venta ${d.numero || ''} por ${m(d.total || 0)}. Motivo: ${d.motivo || '—'}`;
    case 'DEVOLUCION_REGISTRADA': return `Venta ${d.numero || ''}: devolvió ${m(d.monto || 0)} por ${String(d.metodo || '').toLowerCase()}${d.repone ? '' : ' (sin volver al stock)'}. Motivo: ${d.motivo || '—'}`;
    case 'CAJA_ABIERTA': return `Efectivo inicial ${m(d.efectivoInicial || 0)}`;
    case 'CAJA_CERRADA': return `Esperado ${m(d.esperado || 0)}, contado ${m(d.contado || 0)}, diferencia ${m(d.diferencia || 0)}`;
    case 'CAJA_MOVIMIENTO': return `${d.tipo === 'ENTRADA' ? 'Entró' : 'Salió'} ${m(d.monto || 0)}. ${d.nota || ''}`;
    case 'STOCK_AJUSTADO': return `${d.producto || 'Producto'}: ${d.antes} → ${d.despues}`;
    case 'PRODUCTO_ELIMINADO': return d.producto || 'Producto';
    case 'PEDIDO_CANCELADO': return `Pedido #${fila.entidadId} por ${m(d.total || 0)}`;
    case 'EQUIPO_INVITADO': return `${d.email || ''} como ${d.rol || ''}`;
    case 'EQUIPO_INVITACION_REVOCADA': return d.email || 'Invitación';
    case 'EQUIPO_ELIMINADO': return `${d.nombre || ''} (${d.rol || ''})`;
    case 'PLAN_ASIGNADO': case 'PLAN_RENOVADO': case 'PLAN_EDITADO': return d.plan ? `Plan ${d.plan}${d.hasta ? ` hasta ${d.hasta}` : ''}` : '';
    default: return '';
  }
}

module.exports = { ACCIONES, POR_PAGINA, registrar, registrarSinRiesgo, listar, resumenDe };
