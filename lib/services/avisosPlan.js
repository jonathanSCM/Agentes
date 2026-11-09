'use strict';
// lib/services/avisosPlan.js
//
// Avisos automaticos al dueño del negocio (la campanita del panel):
//   - del CORTE del plan: 7 dias antes, 2 dias antes y el mismo dia;
//   - de la GRACIA: cuando vence y empieza el periodo de 5 dias con todo funcionando;
//   - del VENCIMIENTO: pasada la gracia el agente se corta (la suscripcion pasa a MOROSA);
//   - del USO de conversaciones: al 80 % y al 95 % del cupo mensual.
// Cada aviso se manda UNA sola vez (queda marcado en suscripciones.avisosEnviados).
// Reglas de fechas en lib/services/vigenciaPlan.js (docs/11 §11.1).

const { prisma } = require('../db');
const vig = require('./vigenciaPlan');
const { valoresDeSuscripcion } = require('./planesCliente');
const { obtenerEstadoConsumo } = require('./suscripciones');
const notif = require('./notificaciones');

const fechaCorta = (d) => new Date(d).toLocaleDateString('es-BO', { day: '2-digit', month: '2-digit', year: 'numeric' });

function textoCorte({ diasAntes }, nombrePlan, planFin, esPrueba) {
  const que = esPrueba ? 'Tu prueba gratis' : `Tu plan ${nombrePlan}`;
  if (diasAntes === 0) return { titulo: esPrueba ? 'Tu prueba termina hoy' : 'Tu plan vence hoy', mensaje: `${que} vence hoy (${fechaCorta(planFin)}). Tenés 5 días de gracia con todo funcionando; pedí la renovación para no perder la atención de tu agente.` };
  return {
    titulo: esPrueba ? `Tu prueba termina en ${diasAntes} días` : `Tu plan vence en ${diasAntes} días`,
    mensaje: `${que} vence el ${fechaCorta(planFin)}. Pedí la renovación a tiempo para que tu agente no deje de atender.`,
  };
}

async function marcar(sub, claves, extra = {}) {
  const avisos = { ...(sub.avisosEnviados || {}), ...extra };
  for (const k of claves) avisos[k] = true;
  await prisma.suscripcion.update({ where: { id: sub.id }, data: { avisosEnviados: avisos } });
  sub.avisosEnviados = avisos;
}

/** Avisos de corte, gracia y vencimiento de UNA suscripcion. Devuelve lo que hizo. */
async function revisarVigencia(sub, ahora = new Date()) {
  const hecho = [];
  if (!['ACTIVA', 'PRUEBA', 'MOROSA'].includes(sub.estado)) return hecho;
  const valores = valoresDeSuscripcion(sub, ahora);
  if (!valores.planFin) return hecho; // sin vencimiento (acceso total)
  const esPrueba = sub.estado === 'PRUEBA';
  const enviados = Object.keys(sub.avisosEnviados || {}).filter((k) => sub.avisosEnviados[k]);

  for (const a of vig.avisosDeCorte({ planFin: valores.planFin, ahora, enviados })) {
    const t = textoCorte(a, valores.planNombre, valores.planFin, esPrueba);
    await notif.crear(sub.empresaId, { ...t, tipo: 'PLAN_CORTE', conBotones: true });
    await marcar(sub, a.marcar);
    hecho.push(a.clave);
  }

  if (valores.vigencia.estado === 'GRACIA' && !(sub.avisosEnviados || {}).gracia) {
    await notif.crear(sub.empresaId, {
      titulo: esPrueba ? 'Tu prueba terminó' : 'Tu plan venció',
      mensaje: `Venció el ${fechaCorta(valores.planFin)}. Tenés hasta el ${fechaCorta(valores.vigencia.graciaHasta)} con todo funcionando; después tu agente deja de atender hasta que se renueve.`,
      tipo: 'PLAN_GRACIA', conBotones: true,
    });
    await marcar(sub, ['gracia']);
    hecho.push('gracia');
  }

  if (valores.vigencia.estado === 'VENCIDO') {
    if (sub.estado === 'ACTIVA') {
      await prisma.suscripcion.update({ where: { id: sub.id }, data: { estado: 'MOROSA' } });
      sub.estado = 'MOROSA';
      await notif.crear(sub.empresaId, {
        titulo: 'Tu agente dejó de atender',
        mensaje: 'Pasaron los días de gracia y tu plan sigue vencido. Pedí la renovación para reactivar la atención por WhatsApp. Tu panel y tus datos siguen disponibles.',
        tipo: 'PERIODO_VENCIDO', conBotones: true,
      });
      hecho.push('morosa');
    } else if (esPrueba && !(sub.avisosEnviados || {}).pruebaVencida) {
      await notif.crear(sub.empresaId, {
        titulo: 'Tu período de prueba terminó',
        mensaje: 'Tu agente dejó de atender porque terminó la prueba gratis. Elegí un plan para seguir vendiendo por WhatsApp.',
        tipo: 'PRUEBA_VENCIDA', conBotones: true,
      });
      await marcar(sub, ['pruebaVencida']);
      hecho.push('pruebaVencida');
    }
  }
  return hecho;
}

/** Avisos de uso de conversaciones (80 % / 95 %) de UNA suscripcion. */
async function revisarUsoDe(sub, ahora = new Date()) {
  const valores = valoresDeSuscripcion(sub, ahora);
  if (valores.ilimitado || !valores.limites.convIncluidas) return [];
  const consumo = await obtenerEstadoConsumo(sub.id);
  const periodo = vig.periodoMensual(valores.planInicio || sub.periodoInicio, ahora);
  const clavePeriodo = periodo.desde.toISOString();
  let avisos = { ...(sub.avisosEnviados || {}) };
  // Cada mes arranca un cupo nuevo: los avisos de uso se reinician.
  if (avisos.usoPeriodo !== clavePeriodo) {
    delete avisos.uso80; delete avisos.uso95;
    avisos.usoPeriodo = clavePeriodo;
    await prisma.suscripcion.update({ where: { id: sub.id }, data: { avisosEnviados: avisos } });
    sub.avisosEnviados = avisos;
  }
  const enviados = Object.keys(avisos).filter((k) => k.startsWith('uso') && k !== 'usoPeriodo' && avisos[k]);
  const hecho = [];
  for (const a of vig.avisosDeUso({ usadas: consumo.incluidasUsadas, total: consumo.incluidasTotal, enviados })) {
    await notif.crear(sub.empresaId, {
      titulo: a.porcentaje >= 95 ? 'Casi sin conversaciones este mes' : 'Ya usaste el 80 % de tus conversaciones',
      mensaje: `Llevás ${a.usadas.toLocaleString('es-BO')} de ${a.total.toLocaleString('es-BO')} conversaciones incluidas este mes. ${a.porcentaje >= 95 ? 'Cuando se acaben tu agente dejará de atender, salvo que tengas saldo extra.' : ''} Podés pedir más conversaciones en «Comprar paquete».`.replace(/\s+/g, ' ').trim(),
      tipo: 'PLAN_USO', conBotones: true,
    });
    await marcar(sub, a.marcar);
    hecho.push(a.clave);
  }
  return hecho;
}

/** Revisa el uso de una empresa (se llama despues de cada conversacion cobrada). Nunca lanza. */
async function revisarUso(empresaId) {
  try {
    const sub = await prisma.suscripcion.findUnique({ where: { empresaId }, include: { plan: true } });
    if (sub) await revisarUsoDe(sub);
  } catch (err) {
    console.error(`[avisosPlan] no se pudo revisar el uso: ${err.message}`);
  }
}

/** Revision completa (la corre el job cada hora): vigencia y uso de todas las suscripciones. */
async function revisarTodas(ahora = new Date()) {
  const subs = await prisma.suscripcion.findMany({ where: { estado: { in: ['ACTIVA', 'PRUEBA', 'MOROSA'] } }, include: { plan: true } });
  let avisos = 0;
  for (const sub of subs) {
    try {
      avisos += (await revisarVigencia(sub, ahora)).length;
      avisos += (await revisarUsoDe(sub, ahora)).length;
    } catch (err) {
      console.error(`[avisosPlan] suscripcion ${sub.id}: ${err.message}`);
    }
  }
  return { revisadas: subs.length, avisos };
}

module.exports = { revisarVigencia, revisarUsoDe, revisarUso, revisarTodas };
