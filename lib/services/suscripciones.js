// Servicio de suscripciones y consumo de conversaciones.
//
// El consumo se lleva como LIBRO CONTABLE (tabla registros_uso): cada consumo o
// compra es un evento inmutable. Los saldos se calculan sumando esos eventos,
// lo que deja un historial auditable ante cualquier reclamo del cliente.
//
// Reglas (segun el PDF comercial de Proshop):
//   1. Cada plan incluye N conversaciones por periodo, que se reinician cada mes.
//   2. Al agotarlas se consume del saldo de paquetes adicionales comprados.
//   3. El saldo de paquetes NO caduca: se usa solo tras agotar lo incluido.
//   4. Sin cupo incluido ni saldo extra, el agente deja de atender.

const { prisma } = require('../db');

const ESTADOS_CON_SERVICIO = ['ACTIVA', 'PRUEBA'];

/**
 * Calcula el estado de consumo de una suscripcion.
 * @returns {{
 *   incluidasTotal:number, incluidasUsadas:number, incluidasDisponibles:number,
 *   extraComprado:number, extraUsado:number, extraDisponible:number,
 *   totalDisponible:number, puedeAtender:boolean, porcentajeUsado:number
 * }}
 */
async function obtenerEstadoConsumo(suscripcionId) {
  const suscripcion = await prisma.suscripcion.findUniqueOrThrow({
    where: { id: suscripcionId },
    include: { plan: true },
  });

  const { periodoInicio, periodoFin } = suscripcion;

  // --- Conversaciones incluidas: solo cuentan las del periodo vigente ---
  const usadasIncluidas = await prisma.registroUso.aggregate({
    where: {
      suscripcionId,
      tipo: 'CONSUMIDA',
      origen: 'INCLUIDA',
      createdAt: { gte: periodoInicio, lt: periodoFin },
    },
    _sum: { cantidad: true },
  });

  // --- Saldo extra: suma de los paquetes comprados que siguen vigentes ---
  const compras = await prisma.compraPaquete.findMany({
    where: { empresaId: suscripcion.empresaId, estado: 'ACTIVA' },
    orderBy: { fechaCompra: 'asc' },
  });
  const vigentes = compras.filter((c) => c.fechaRenovacion > new Date());

  const incluidasTotal = suscripcion.plan.convIncluidas;
  const incluidasUsadas = usadasIncluidas._sum.cantidad || 0;
  const incluidasDisponibles = Math.max(0, incluidasTotal - incluidasUsadas);

  const extraComprado = vigentes.reduce((s, c) => s + c.cantidad, 0);
  const extraUsado = vigentes.reduce((s, c) => s + c.consumidas, 0);
  const extraDisponible = Math.max(0, extraComprado - extraUsado);

  const totalDisponible = incluidasDisponibles + extraDisponible;
  const vigente = ESTADOS_CON_SERVICIO.includes(suscripcion.estado) && suscripcion.periodoFin > new Date();

  return {
    incluidasTotal,
    incluidasUsadas,
    incluidasDisponibles,
    extraComprado,
    extraUsado,
    extraDisponible,
    paquetesVigentes: vigentes.length,
    totalDisponible,
    puedeAtender: vigente && totalDisponible > 0,
    porcentajeUsado: incluidasTotal > 0 ? Math.min(100, Math.round((incluidasUsadas / incluidasTotal) * 100)) : 0,
  };
}

/**
 * Resumen completo para mostrar en el panel del cliente.
 */
async function obtenerResumenEmpresa(empresaId) {
  const suscripcion = await prisma.suscripcion.findUnique({
    where: { empresaId },
    include: { plan: true },
  });
  if (!suscripcion) return null;

  const consumo = await obtenerEstadoConsumo(suscripcion.id);
  return { suscripcion, plan: suscripcion.plan, consumo };
}

/**
 * Descuenta UNA conversacion, eligiendo automaticamente de donde cobrarla.
 * Usa una transaccion para que nunca se pierda ni se duplique el consumo.
 *
 * @returns {{ok:boolean, origen?:'INCLUIDA'|'EXTRA', motivo?:string}}
 */
async function consumirConversacion(suscripcionId, nota) {
  return prisma.$transaction(async (tx) => {
    const suscripcion = await tx.suscripcion.findUniqueOrThrow({
      where: { id: suscripcionId },
      include: { plan: true },
    });

    // 1) La suscripcion debe estar vigente
    if (!ESTADOS_CON_SERVICIO.includes(suscripcion.estado)) {
      return { ok: false, motivo: 'SUSCRIPCION_INACTIVA' };
    }
    if (suscripcion.periodoFin <= new Date()) {
      return { ok: false, motivo: 'PERIODO_VENCIDO' };
    }

    // 2) Recalcular saldos dentro de la transaccion
    const incl = await tx.registroUso.aggregate({
      where: {
        suscripcionId,
        tipo: 'CONSUMIDA',
        origen: 'INCLUIDA',
        createdAt: { gte: suscripcion.periodoInicio, lt: suscripcion.periodoFin },
      },
      _sum: { cantidad: true },
    });
    const incluidasDisponibles = suscripcion.plan.convIncluidas - (incl._sum.cantidad || 0);

    // 3) Primero lo incluido...
    if (incluidasDisponibles > 0) {
      await tx.registroUso.create({
        data: { suscripcionId, tipo: 'CONSUMIDA', origen: 'INCLUIDA', cantidad: 1, nota },
      });
      return { ok: true, origen: 'INCLUIDA' };
    }

    // 4) ...luego el paquete comprado mas antiguo con saldo (FIFO)
    const compra = await tx.compraPaquete.findFirst({
      where: {
        empresaId: suscripcion.empresaId,
        estado: 'ACTIVA',
        fechaRenovacion: { gt: new Date() },
      },
      orderBy: { fechaCompra: 'asc' },
    });

    if (!compra || compra.consumidas >= compra.cantidad) {
      return { ok: false, motivo: 'SIN_SALDO' };
    }

    const consumidas = compra.consumidas + 1;
    await tx.compraPaquete.update({
      where: { id: compra.id },
      data: {
        consumidas,
        estado: consumidas >= compra.cantidad ? 'AGOTADA' : 'ACTIVA',
      },
    });
    await tx.registroUso.create({
      data: { suscripcionId, tipo: 'CONSUMIDA', origen: 'EXTRA', cantidad: 1, nota },
    });

    return { ok: true, origen: 'EXTRA', compraId: compra.id };
  });
}

/**
 * Registra la compra de un paquete adicional (tras confirmarse el pago).
 * Crea la compra con su propio saldo y fecha de renovacion, y deja el
 * evento correspondiente en el libro contable.
 *
 * @param {object} datos
 * @param {number} datos.empresaId
 * @param {number} [datos.paqueteId]  id del paquete del catalogo
 * @param {number} datos.cantidad     conversaciones compradas
 * @param {number} [datos.precioUsd]
 * @param {Date}   [datos.fechaRenovacion] por defecto 30 dias
 */
async function registrarCompraPaquete(datos) {
  const { empresaId, paqueteId, cantidad, precioUsd = 0, nota, estado = 'ACTIVA' } = datos;
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new Error('La cantidad del paquete debe ser un entero positivo.');
  }

  const fechaRenovacion =
    datos.fechaRenovacion || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    const compra = await tx.compraPaquete.create({
      data: { empresaId, paqueteId, cantidad, precioUsd, fechaRenovacion, nota, estado },
    });

    const suscripcion = await tx.suscripcion.findUnique({ where: { empresaId } });
    if (suscripcion) {
      await tx.registroUso.create({
        data: {
          suscripcionId: suscripcion.id,
          tipo: 'COMPRA_EXTRA',
          cantidad,
          nota: nota || `Paquete de ${cantidad} conversaciones`,
        },
      });
    }
    return compra;
  });
}

/**
 * Marca como VENCIDA toda compra cuya fecha de renovacion ya paso.
 * Pensado para una tarea programada diaria.
 */
async function vencerPaquetes() {
  const { count } = await prisma.compraPaquete.updateMany({
    where: { estado: 'ACTIVA', fechaRenovacion: { lte: new Date() } },
    data: { estado: 'VENCIDA' },
  });
  return count;
}

/**
 * Renueva el periodo: reinicia las conversaciones incluidas.
 * El saldo de paquetes adicionales NO se toca (no caduca).
 * Pensado para ejecutarse desde una tarea programada (cron).
 */
async function renovarPeriodo(suscripcionId, dias = 30) {
  const inicio = new Date();
  const fin = new Date(inicio.getTime() + dias * 24 * 60 * 60 * 1000);
  return prisma.suscripcion.update({
    where: { id: suscripcionId },
    data: { periodoInicio: inicio, periodoFin: fin, estado: 'ACTIVA' },
  });
}

module.exports = {
  obtenerEstadoConsumo,
  obtenerResumenEmpresa,
  consumirConversacion,
  registrarCompraPaquete,
  vencerPaquetes,
  renovarPeriodo,
};
