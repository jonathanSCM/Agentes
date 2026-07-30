// Servicio de notificaciones (la "campanita" del panel del cliente).
//
// Dos origenes:
//  1. Manual  -> Proshop envia un aviso desde el panel admin.
//  2. Auto    -> cuando al cliente le quedan pocas conversaciones del plan,
//                se crea sola una notificacion "plan a punto de acabar".
const { prisma } = require('../db');
const { obtenerEstadoConsumo } = require('./suscripciones');

// Umbral: avisar cuando queden estas conversaciones (o menos) del plan.
const UMBRAL_AVISO = Number(process.env.AVISO_CONVERSACIONES || 100);

async function crear(empresaId, { titulo, mensaje, tipo = 'MANUAL', conBotones = false }) {
  return prisma.notificacion.create({
    data: { empresaId, titulo, mensaje, tipo, conBotones },
  });
}

async function listar(empresaId, soloNoLeidas = false) {
  return prisma.notificacion.findMany({
    where: { empresaId, ...(soloNoLeidas ? { leida: false } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
}

async function contarNoLeidas(empresaId) {
  return prisma.notificacion.count({ where: { empresaId, leida: false } });
}

async function marcarLeida(empresaId, id) {
  return prisma.notificacion.updateMany({
    where: { id, empresaId },
    data: { leida: true },
  });
}

async function marcarTodasLeidas(empresaId) {
  return prisma.notificacion.updateMany({
    where: { empresaId, leida: false },
    data: { leida: true },
  });
}

async function eliminar(empresaId, id) {
  return prisma.notificacion.deleteMany({ where: { id, empresaId } });
}

/**
 * Revisa el consumo de una empresa y, si le quedan pocas conversaciones del
 * plan, crea la notificacion automatica (sin duplicarla).
 * Pensado para llamarse cada vez que el agente atiende un mensaje.
 */
async function verificarAvisos(empresaId) {
  const suscripcion = await prisma.suscripcion.findUnique({ where: { empresaId } });
  if (!suscripcion) return;

  const consumo = await obtenerEstadoConsumo(suscripcion.id);

  // Aviso: plan a punto de acabar (quedan <= umbral, pero todavia queda algo)
  if (consumo.incluidasDisponibles > 0 && consumo.incluidasDisponibles <= UMBRAL_AVISO) {
    // No duplicar: solo si no hay una PLAN_POR_ACABAR sin leer reciente
    const yaExiste = await prisma.notificacion.findFirst({
      where: {
        empresaId,
        tipo: 'PLAN_POR_ACABAR',
        leida: false,
        createdAt: { gte: suscripcion.periodoInicio },
      },
    });
    if (!yaExiste) {
      await crear(empresaId, {
        titulo: 'Tu plan está por acabar',
        mensaje: `Te quedan solo ${consumo.incluidasDisponibles} conversaciones de tu plan. Para que tu agente siga atendiendo sin interrupciones, compra un paquete o mejora tu plan.`,
        tipo: 'PLAN_POR_ACABAR',
        conBotones: true,
      });
    }
  }

  // Aviso: sin saldo (agotado del todo)
  if (consumo.totalDisponible === 0) {
    const yaExiste = await prisma.notificacion.findFirst({
      where: {
        empresaId,
        tipo: 'SIN_SALDO',
        leida: false,
        createdAt: { gte: suscripcion.periodoInicio },
      },
    });
    if (!yaExiste) {
      await crear(empresaId, {
        titulo: 'Te quedaste sin conversaciones',
        mensaje: 'Tu agente dejó de atender porque agotaste tu saldo. Compra un paquete o mejora tu plan para reactivarlo.',
        tipo: 'SIN_SALDO',
        conBotones: true,
      });
    }
  }
}

const MOTIVOS_LEGIBLES = {
  AGENTE_NO_EXISTE: 'tu agente no existe',
  AGENTE_INACTIVO: 'tu agente está pausado o en borrador',
  SIN_SUSCRIPCION: 'tu empresa no tiene una suscripción activa',
  SUSCRIPCION_INACTIVA: 'tu suscripción no está activa',
  PERIODO_VENCIDO: 'tu período venció',
  SIN_SALDO: 'te quedaste sin conversaciones disponibles',
};

/**
 * Un cliente real le escribio a tu agente por WhatsApp y NO recibio
 * respuesta (antes esto quedaba en silencio total: ni el dueño del negocio
 * se enteraba). Deja un aviso en la campanita, sin duplicar mientras el
 * mismo motivo siga sin leerse.
 */
async function avisarMensajeNoAtendido(empresaId, motivo) {
  const yaExiste = await prisma.notificacion.findFirst({
    where: { empresaId, tipo: 'MENSAJE_NO_ATENDIDO', leida: false },
  });
  if (yaExiste) return;

  await crear(empresaId, {
    titulo: 'Un cliente te escribió y tu agente no respondió',
    mensaje: `Un cliente envió un mensaje por WhatsApp pero tu agente no pudo atenderlo (${MOTIVOS_LEGIBLES[motivo] || motivo}). Revisa tu plan o la configuración de tu agente.`,
    tipo: 'MENSAJE_NO_ATENDIDO',
    conBotones: true,
  });
}

module.exports = {
  UMBRAL_AVISO,
  crear,
  listar,
  contarNoLeidas,
  marcarLeida,
  marcarTodasLeidas,
  eliminar,
  verificarAvisos,
  avisarMensajeNoAtendido,
};
