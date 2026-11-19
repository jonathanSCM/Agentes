'use strict';
// lib/services/creditosConsumo.js
//
// Conecta los CREDITOS (creditos.js) con el resto del sistema (fase 5 y parte de la 7):
//   - cobro de cada accion real: conversacion nueva, respuesta con IA, plantilla saliente;
//   - sin saldo el agente NO se corta: sigue con el flujo sin IA (menus, catalogo, carrito, cierre del pedido);
//   - avisos al 80, 95 y 100 % del saldo y cuando el agente pasa al modo sin IA;
//   - acreditacion de los creditos del plan (cada periodo) y de los paquetes comprados.
// Todo respeta CREDITOS_MODO (APAGADO / SOMBRA / ACTIVO, ver creditos.js). Nada de esto rompe nunca la atencion al cliente.

const { prisma } = require('../db');
const vig = require('./vigenciaPlan');
const { valoresDeSuscripcion } = require('./planesCliente');
const notif = require('./notificaciones');
const trazaIA = require('./trazaIA');
const cr = require('./creditos');

const ESTADOS_CON_SERVICIO = ['ACTIVA', 'PRUEBA'];

// ----------------------------- Avisos -----------------------------

async function marcarAvisos(suscripcion, claves) {
  const avisos = { ...(suscripcion.avisosEnviados || {}) };
  for (const [k, v] of Object.entries(claves)) avisos[k] = v;
  await prisma.suscripcion.update({ where: { id: suscripcion.id }, data: { avisosEnviados: avisos } });
}

/** Al entrar creditos nuevos se vuelven a permitir los avisos de uso. */
async function reiniciarAvisos(empresaId) {
  const s = await prisma.suscripcion.findUnique({ where: { empresaId } });
  if (!s) return;
  await marcarAvisos(s, { creditos80: false, creditos95: false, creditos100: false, creditosSinIA: false });
}

const nf = (n) => Number(n).toLocaleString('es-BO');

/**
 * Avisos de uso de creditos (80, 95, 100 %). Cada uno se manda UNA vez hasta que entren creditos nuevos.
 * El porcentaje se calcula sobre los creditos de los lotes vigentes.
 */
async function revisarAvisos(empresaId) {
  try {
    if (cr.modo() !== 'ACTIVO') return [];
    const s = await prisma.suscripcion.findUnique({ where: { empresaId } });
    if (!s || s.ilimitado) return [];
    const ahora = new Date();
    const { total } = await cr.saldo(empresaId);
    // La base incluye los lotes ya agotados (si no, al llegar a 0 no habria base) pero no los vencidos.
    const baseAgg = await prisma.creditoLote.aggregate({ where: { empresaId, OR: [{ vence: null }, { vence: { gt: ahora } }] }, _sum: { cantidadInicial: true } });
    const base = baseAgg._sum.cantidadInicial || 0;
    if (base <= 0) return [];
    const usado = Math.round(((base - total) / base) * 100);
    const enviados = s.avisosEnviados || {};
    const hecho = [];
    const avisar = async (clave, titulo, mensaje) => {
      if (enviados[clave]) return;
      await notif.crear(empresaId, { titulo, mensaje, tipo: 'USO_CREDITOS', conBotones: true });
      await marcarAvisos(s, { [clave]: true });
      enviados[clave] = true; hecho.push(clave);
    };
    if (total <= 0) {
      await avisar('creditos100', 'Se acabaron tus créditos', 'Tu agente sigue atendiendo con los menús, el catálogo y el carrito, pero ya no usa la IA ni envía plantillas. Pedí más créditos para volver a la atención completa.');
    } else if (usado >= 95) {
      await avisar('creditos95', 'Te quedan muy pocos créditos', `Usaste el ${usado} % de tus créditos (quedan ${nf(total)}). Pedí más para que tu agente no pase al modo sin IA.`);
    } else if (usado >= 80) {
      await avisar('creditos80', 'Ya usaste el 80 % de tus créditos', `Quedan ${nf(total)} créditos. Pedí más a tiempo para que no se interrumpa la atención con IA.`);
    }
    return hecho;
  } catch (err) { console.error('[creditos] avisos:', err.message); return []; }
}

/** Una sola vez por recarga: avisa que el agente paso al modo sin IA por falta de creditos. */
async function avisarSinCreditos(empresaId) {
  try {
    const s = await prisma.suscripcion.findUnique({ where: { empresaId } });
    if (!s || (s.avisosEnviados || {}).creditosSinIA) return false;
    await notif.crear(empresaId, { titulo: 'Tu agente pasó al modo sin IA', mensaje: 'No tenés créditos: tus clientes se siguen atendiendo con menús, catálogo y carrito, sin respuestas de IA. Pedí créditos para volver a la atención completa.', tipo: 'USO_CREDITOS', conBotones: true });
    await marcarAvisos(s, { creditosSinIA: true });
    return true;
  } catch (err) { console.error('[creditos] aviso sin creditos:', err.message); return false; }
}

// ----------------------------- Cobro de acciones -----------------------------

/**
 * Conversacion NUEVA de un cliente final.
 * - SOMBRA/APAGADO: no cobra (el sistema de conversaciones manda); `anotarSombra` la deja registrada despues de abrirla.
 * - ACTIVO: cobra creditos. Sin saldo NO corta: la conversacion se abre igual y se atiende sin IA (a menos que la suscripcion este cancelada o vencida).
 * @returns {{ usaCreditos: boolean, ok?: boolean, motivo?: string, origen?: string, clave?: string, cobrado?: number, sinCreditos?: boolean }}
 */
async function cobrarConversacionNueva({ suscripcion, empresaId, referencia }) {
  if (cr.modo() !== 'ACTIVO') return { usaCreditos: false };
  const valores = valoresDeSuscripcion(suscripcion);
  if (valores.ilimitado) return { usaCreditos: false };
  if (suscripcion.estado === 'CANCELADA') return { usaCreditos: true, ok: false, motivo: 'SUSCRIPCION_CANCELADA' };
  const vigente = ESTADOS_CON_SERVICIO.includes(suscripcion.estado) && valores.vigencia.puedeUsarAgente;
  const clave = `conv-nueva:${empresaId}:${referencia}:${Date.now()}`;
  const r = await cr.consumir({ empresaId, accion: cr.ACCIONES.CONVERSACION_NUEVA, clave, referencia });
  if (r.ok) return { usaCreditos: true, ok: true, origen: 'INCLUIDA', clave, cobrado: r.cantidad };
  if (r.motivo === 'SIN_SALDO' && vigente) return { usaCreditos: true, ok: true, origen: 'INCLUIDA', sinCreditos: true, cobrado: 0 };
  return { usaCreditos: true, ok: false, motivo: !ESTADOS_CON_SERVICIO.includes(suscripcion.estado) ? 'SUSCRIPCION_INACTIVA' : (vigente ? r.motivo : 'PERIODO_VENCIDO') };
}

/** Anota en sombra una conversacion nueva ya abierta (idempotente). */
function anotarSombraConversacion({ empresaId, conversacionId }) {
  if (cr.modo() !== 'SOMBRA') return null;
  return cr.registrarSombra({ empresaId, accion: cr.ACCIONES.CONVERSACION_NUEVA, clave: `conv:${conversacionId}`, referencia: `conv:${conversacionId}` });
}

/**
 * Respuesta con IA de un turno. Se llama DENTRO del turno (trazaIA): si el turno llamo a la IA con exito, se cobra 1 vez por turno.
 * El chat de prueba del panel y los turnos sin IA no cuestan.
 */
async function cobrarTurnoIA({ empresaId, modoPrueba = false }) {
  try {
    const m = cr.modo();
    if (m === 'APAGADO' || modoPrueba) return null;
    const ctx = trazaIA.actual();
    if (!ctx || ctx.acum.llamadas < 1) return null;
    const clave = `turno:${ctx.turnoId}`;
    if (m === 'SOMBRA') return await cr.registrarSombra({ empresaId, accion: cr.ACCIONES.TURNO_IA, clave, referencia: clave });
    const s = await prisma.suscripcion.findUnique({ where: { empresaId }, select: { ilimitado: true } });
    if (s && s.ilimitado) return null;
    const r = await cr.consumir({ empresaId, accion: cr.ACCIONES.TURNO_IA, clave, referencia: clave });
    if (!r.ok) trazaIA.desdeEtapa('error_aviso_sin_ia', { error: 'No se pudo cobrar el turno: ' + r.motivo });
    revisarAvisos(empresaId).catch(() => {});
    return r;
  } catch (err) { console.error('[creditos] cobro de turno:', err.message); return null; }
}

/** Plantilla saliente (recordatorios, avisos fuera de la ventana). En ACTIVO sin saldo no se envia. @returns {{ permitido: boolean }} */
async function cobrarPlantilla({ empresaId, referencia }) {
  try {
    const m = cr.modo();
    if (m === 'APAGADO') return { permitido: true };
    const clave = `plantilla:${empresaId}:${referencia}`;
    if (m === 'SOMBRA') { await cr.registrarSombra({ empresaId, accion: cr.ACCIONES.PLANTILLA_SALIENTE, clave, referencia }); return { permitido: true }; }
    const s = await prisma.suscripcion.findUnique({ where: { empresaId }, select: { ilimitado: true } });
    if (s && s.ilimitado) return { permitido: true };
    const r = await cr.consumir({ empresaId, accion: cr.ACCIONES.PLANTILLA_SALIENTE, clave, referencia });
    revisarAvisos(empresaId).catch(() => {});
    return { permitido: r.ok, motivo: r.motivo };
  } catch (err) { console.error('[creditos] cobro de plantilla:', err.message); return { permitido: true }; }
}

/** Devuelve un cobro (por ejemplo si no se pudo enviar la plantilla). */
function devolverPlantilla({ empresaId, referencia }) {
  if (cr.modo() !== 'ACTIVO') return null;
  return cr.devolver({ empresaId, clave: `plantilla:${empresaId}:${referencia}`, nota: 'La plantilla no se pudo enviar' }).catch(() => null);
}

// ----------------------------- Entradas de creditos -----------------------------

/**
 * Acredita un paquete comprado (idempotente por compra). Solo en modo ACTIVO: antes de eso el saldo vive en el sistema de conversaciones
 * y la conversion (fase 7) lo pasa a creditos.
 */
async function acreditarCompra(compraId, { forzar = false, creditos: creditosDados = null, vence = null } = {}) {
  try {
    if (!forzar && cr.modo() !== 'ACTIVO') return null;
    const compra = await prisma.compraPaquete.findUnique({ where: { id: compraId }, include: { paquete: true } });
    if (!compra || compra.estado !== 'ACTIVA') return null;
    const creditos = creditosDados || (compra.paquete && compra.paquete.creditos) || compra.cantidad * cr.EQUIVALENCIA;
    const r = await cr.otorgar({ empresaId: compra.empresaId, origen: 'COMPRA', cantidad: creditos, vence: vence || cr.sumaMes(new Date(), cr.MESES_VENCE_COMPRA), referencia: `compra:${compra.id}`, clave: `compra:${compra.id}`, nota: 'Paquete comprado' });
    if (!r.repetido) await reiniciarAvisos(compra.empresaId);
    return r;
  } catch (err) { console.error('[creditos] acreditar compra:', err.message); return null; }
}

/** Creditos mensuales de una suscripcion: su copia, si no el plan, si no las conversaciones x equivalencia. */
function creditosMesDe(sus) {
  if (sus.creditosMes !== null && sus.creditosMes !== undefined) return sus.creditosMes;
  if (sus.plan && sus.plan.creditosMes !== null && sus.plan.creditosMes !== undefined) return sus.plan.creditosMes;
  const v = valoresDeSuscripcion(sus);
  return v.limites.convIncluidas ? v.limites.convIncluidas * cr.EQUIVALENCIA : 0;
}

/** Entrega los creditos del periodo vigente a cada suscripcion (idempotente por periodo). Los del plan vencen al cerrar el periodo. */
async function otorgarPlanes(ahora = new Date(), { empresaId = null } = {}) {
  let n = 0;
  const subs = await prisma.suscripcion.findMany({ where: { estado: { in: ESTADOS_CON_SERVICIO }, ...(empresaId ? { empresaId } : {}) }, include: { plan: true } });
  for (const s of subs) {
    try {
      const valores = valoresDeSuscripcion(s, ahora);
      if (valores.ilimitado || !valores.vigencia.puedeUsarAgente) continue;
      const cantidad = creditosMesDe(s);
      if (!cantidad || cantidad <= 0) continue;
      const { desde, hasta } = vig.periodoMensual(valores.planInicio || s.periodoInicio, ahora);
      const r = await cr.otorgar({ empresaId: s.empresaId, origen: 'PLAN', cantidad, vence: hasta, referencia: `plan:${s.empresaId}:${desde.toISOString()}`, clave: `plan:${s.empresaId}:${desde.toISOString()}`, nota: 'Créditos del período' });
      if (!r.repetido) { n += 1; await reiniciarAvisos(s.empresaId); }
    } catch (err) { console.error('[creditos] otorgar plan', s.empresaId, err.message); }
  }
  return n;
}

/** Trabajo diario (solo en modo ACTIVO): vence lo vencido y entrega los creditos del periodo. */
function iniciarJob({ cadaMs = 6 * 60 * 60 * 1000 } = {}) {
  if (process.env.NODE_TEST_CONTEXT) return null;
  const ciclo = async () => {
    try {
      if (cr.modo() !== 'ACTIVO') return;
      const v = await cr.vencer();
      const o = await otorgarPlanes();
      if (v || o) console.log(`[creditos] ${v} lote(s) vencidos, ${o} entrega(s) de créditos del plan`);
    } catch (err) { console.error('[creditos] job:', err.message); }
  };
  const inicio = setTimeout(ciclo, 45 * 1000); if (inicio.unref) inicio.unref();
  const t = setInterval(ciclo, cadaMs); if (t.unref) t.unref();
  return t;
}

module.exports = { revisarAvisos, avisarSinCreditos, reiniciarAvisos, cobrarConversacionNueva, anotarSombraConversacion, cobrarTurnoIA, cobrarPlantilla, devolverPlantilla, acreditarCompra, creditosMesDe, otorgarPlanes, iniciarJob };
