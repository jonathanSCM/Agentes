'use strict';
// lib/services/limitesCitas.js
//
// Topes del plan para el modelo de CITAS: cuantos servicios activos puede tener
// el negocio (Plan.maxServicios) y cuantas citas puede crear por periodo de
// suscripcion (Plan.maxCitasMes). Al acercarse al tope (80 %) y al llegar, el
// negocio recibe un aviso en la campanita (sin duplicar mientras no lo lea).

const { prisma } = require('../db');

const AVISO_DESDE = 0.8;
const DEFECTO = { maxServicios: 10, maxCitasMes: 200 };

async function planDe(empresaId) {
  const s = await prisma.suscripcion.findUnique({ where: { empresaId }, include: { plan: true } });
  return {
    suscripcion: s,
    maxServicios: (s && s.plan && s.plan.maxServicios) || DEFECTO.maxServicios,
    maxCitasMes: (s && s.plan && s.plan.maxCitasMes) || DEFECTO.maxCitasMes,
  };
}

/** Desde/hasta del periodo que se cuenta: el de la suscripcion, o el mes calendario si no hay. */
function periodoDe(suscripcion, ahora = new Date()) {
  if (suscripcion && suscripcion.periodoInicio && suscripcion.periodoFin) return { desde: suscripcion.periodoInicio, hasta: suscripcion.periodoFin };
  return { desde: new Date(ahora.getFullYear(), ahora.getMonth(), 1), hasta: new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1) };
}

/** { servicios: { usados, tope }, citas: { usados, tope, desde, hasta } } */
async function estadoDeLimites(empresaId, ahora = new Date()) {
  const plan = await planDe(empresaId);
  const { desde, hasta } = periodoDe(plan.suscripcion, ahora);
  const [servicios, citas] = await Promise.all([
    prisma.servicio.count({ where: { empresaId, activo: true } }),
    prisma.cita.count({ where: { empresaId, estado: { not: 'CANCELADA' }, createdAt: { gte: desde, lt: hasta } } }),
  ]);
  return { servicios: { usados: servicios, tope: plan.maxServicios }, citas: { usados: citas, tope: plan.maxCitasMes, desde, hasta } };
}

async function avisar(empresaId, tipo, titulo, mensaje) {
  const yaAvisado = await prisma.notificacion.findFirst({ where: { empresaId, tipo, leida: false } });
  if (!yaAvisado) await prisma.notificacion.create({ data: { empresaId, tipo, titulo, mensaje, conBotones: true } });
}

async function avisarSiCorresponde(empresaId, que, usados, tope) {
  const nombre = que === 'servicios' ? 'servicios' : 'citas de este mes';
  const tipo = que === 'servicios' ? 'TOPE_SERVICIOS' : 'TOPE_CITAS';
  if (usados >= tope) {
    await avisar(empresaId, tipo, `Llegaste al tope de ${nombre}`, `Tu plan permite ${tope} ${nombre} y ya usaste ${usados}. Mejora tu plan para seguir sumando sin interrupciones.`);
  } else if (usados >= Math.ceil(tope * AVISO_DESDE)) {
    await avisar(empresaId, tipo, `Estás cerca del tope de ${nombre}`, `Usaste ${usados} de ${tope} ${nombre} de tu plan. Mejora tu plan para no quedarte sin cupo.`);
  }
}

/** ¿Puede crear otro servicio activo? */
async function puedeCrearServicio(empresaId) {
  const { servicios } = await estadoDeLimites(empresaId);
  return { ok: servicios.usados < servicios.tope, usados: servicios.usados, tope: servicios.tope };
}

/** ¿Puede crear otra cita en este periodo? */
async function puedeCrearCita(empresaId) {
  const { citas } = await estadoDeLimites(empresaId);
  return { ok: citas.usados < citas.tope, usados: citas.usados, tope: citas.tope };
}

/** Despues de crear un servicio o una cita: avisa si se acerca o llega al tope. Nunca lanza. */
async function revisarAvisos(empresaId, que) {
  try {
    const e = await estadoDeLimites(empresaId);
    const dato = que === 'servicios' ? e.servicios : e.citas;
    await avisarSiCorresponde(empresaId, que, dato.usados, dato.tope);
  } catch (err) {
    console.error(`[limitesCitas] no se pudo revisar el aviso de ${que}: ${err.message}`);
  }
}

module.exports = { estadoDeLimites, puedeCrearServicio, puedeCrearCita, revisarAvisos, periodoDe, AVISO_DESDE };
