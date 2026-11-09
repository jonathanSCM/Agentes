'use strict';
// lib/services/planesCliente.js
//
// El PLAN de un cliente (empresa): asignar, renovar, editar su copia y leer sus valores.
// docs/11-plan-planes-pos-panel-y-rediseno.md §11.
//
//   - Un plan es una PLANTILLA. Al asignarlo se COPIAN sus valores a la suscripcion del cliente y
//     el cliente se rige por esa copia (no consulta el plan en cada uso). El superadmin puede
//     ajustar la copia de un cliente puntual.
//   - Sin suscripcion, la empresa queda en el ESTADO BASE: solo el modulo AGENTE, sin
//     conversaciones incluidas.
//   - El plan "ilimitado" (oculto, solo superadmin) abre todos los modulos y quita los topes.
//
// Un tope `null` significa SIN LIMITE. Quien lo lea debe tratarlo asi.

const { prisma } = require('../db');
const vig = require('./vigenciaPlan');

const MODULOS = ['AGENTE', 'POS', 'PANEL'];
const NOMBRES_MODULO = { AGENTE: 'Agente', POS: 'Punto de venta', PANEL: 'Panel comercial' };
const CODIGO_PRUEBA = 'PRUEBA';
const DIAS_PRUEBA = 14;

// Estado base (sin suscripcion): el agente se puede configurar, pero no hay conversaciones incluidas.
const BASE = Object.freeze({
  planNombre: 'Base (sin suscripción)',
  modulos: ['AGENTE'],
  limites: Object.freeze({
    convIncluidas: 0, maxProductos: 10, maxUsuarios: 1, maxMensajesPropios: 30, maxServicios: 10, maxCitasMes: 200,
  }),
  modeloIa: null,
  marcaBlanca: false,
});

const CAMPOS_LIMITE = ['convIncluidas', 'maxProductos', 'maxUsuarios', 'maxMensajesPropios', 'maxServicios', 'maxCitasMes'];

/**
 * Valores EFECTIVOS de una suscripcion (con su plan incluido, si se lo trajo). Pura: no toca la base.
 * @returns {{ origen, planNombre, planCodigo, modulos, limites, modeloIa, marcaBlanca, ilimitado, planInicio, planFin, vigencia, estado }}
 */
function valoresDeSuscripcion(sub, ahora = new Date()) {
  if (!sub) {
    return {
      origen: 'BASE', planNombre: BASE.planNombre, planCodigo: null, modulos: [...BASE.modulos], limites: { ...BASE.limites },
      modeloIa: BASE.modeloIa, marcaBlanca: false, ilimitado: false, planInicio: null, planFin: null,
      vigencia: vig.estadoVigencia({ planFin: null, ahora }), estado: null,
    };
  }
  const plan = sub.plan || {};
  const ilimitado = Boolean(sub.ilimitado);
  const limites = {};
  // Con copia (planNombre guardado), `null` en un tope significa SIN LIMITE. Sin copia
  // (suscripciones anteriores), se usa lo que diga el plan.
  const tieneCopia = sub.planNombre != null;
  for (const k of CAMPOS_LIMITE) {
    if (ilimitado) limites[k] = null;
    else if (tieneCopia) limites[k] = sub[k] === undefined ? (plan[k] ?? BASE.limites[k]) : sub[k];
    else limites[k] = sub[k] ?? plan[k] ?? BASE.limites[k];
  }
  const modulos = ilimitado ? [...MODULOS] : (sub.modulos && sub.modulos.length ? sub.modulos : (plan.modulos && plan.modulos.length ? plan.modulos : [...BASE.modulos]));
  // periodoFin queda como respaldo de suscripciones anteriores a la copia del plan.
  const planFin = ilimitado ? null : (sub.planFin ?? sub.periodoFin ?? null);
  return {
    origen: 'PLAN',
    planNombre: sub.planNombre || plan.nombre || BASE.planNombre,
    planCodigo: plan.codigo || null,
    modulos, limites,
    modeloIa: sub.modeloIa ?? plan.modeloIa ?? null,
    marcaBlanca: Boolean(sub.marcaBlanca || plan.marcaBlanca),
    ilimitado,
    planInicio: sub.planInicio ?? sub.periodoInicio ?? null,
    planFin,
    vigencia: vig.estadoVigencia({ planFin, ahora }),
    estado: sub.estado,
  };
}

const SIN_TOPE = 1000000000;
/** Un tope `null` (ilimitado) como numero alto, para comparar con `<`/`>=` sin casos especiales. */
const topeNumerico = (v) => (v === null || v === undefined ? SIN_TOPE : v);
/** Texto para mostrar un tope en pantalla. */
const topeTexto = (v) => (v === null || v === undefined || v >= SIN_TOPE ? 'Ilimitado' : Number(v).toLocaleString('es-BO'));

/** Valores efectivos de una empresa (lee su suscripcion). */
async function valoresDe(empresaId, ahora = new Date()) {
  const sub = await prisma.suscripcion.findUnique({ where: { empresaId }, include: { plan: true } });
  return valoresDeSuscripcion(sub, ahora);
}

async function tieneModulo(empresaId, modulo) {
  return (await valoresDe(empresaId)).modulos.includes(modulo);
}

class ErrorPlan extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'PLAN'; }
}

function copiaDePlan(plan) {
  return {
    planId: plan.id,
    planNombre: plan.nombre,
    modulos: plan.ilimitado ? [...MODULOS] : (plan.modulos && plan.modulos.length ? [...plan.modulos] : ['AGENTE']),
    convIncluidas: plan.ilimitado ? null : plan.convIncluidas,
    maxProductos: plan.ilimitado ? null : plan.maxProductos,
    maxUsuarios: plan.ilimitado ? null : plan.maxUsuarios,
    maxMensajesPropios: plan.ilimitado ? null : plan.maxMensajesPropios,
    maxServicios: plan.ilimitado ? null : plan.maxServicios,
    maxCitasMes: plan.ilimitado ? null : plan.maxCitasMes,
    modeloIa: plan.modeloIa,
    marcaBlanca: Boolean(plan.marcaBlanca),
    ilimitado: Boolean(plan.ilimitado),
  };
}

/**
 * Asigna un plan a un cliente: copia los valores, empieza HOY y vence en `meses` (1, 2, 3, 6, 12)
 * o en `fechaFin`. Un plan "ilimitado" no vence salvo que se le ponga fecha.
 */
async function asignarPlan(empresaId, planId, { meses = null, fechaFin = null, ahora = new Date(), actor = null } = {}) {
  const plan = await prisma.plan.findUnique({ where: { id: Number(planId) } });
  if (!plan) throw new ErrorPlan('Ese plan no existe.');
  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId } });
  if (!empresa) throw new ErrorPlan('Ese cliente no existe.');

  let planFin = null;
  if (meses || fechaFin) {
    try { planFin = vig.calcularFin({ desde: ahora, meses, fechaPersonalizada: fechaFin }); } catch (err) { throw new ErrorPlan(err.message); }
  } else if (!plan.ilimitado) {
    throw new ErrorPlan('Elegí la duración: 1, 2, 3, 6 o 12 meses, o una fecha de fin.');
  }

  const copia = copiaDePlan(plan);
  const estado = plan.codigo === CODIGO_PRUEBA ? 'PRUEBA' : 'ACTIVA';
  const datos = {
    ...copia, estado, planInicio: ahora, planFin,
    // Compatibilidad: el resto del sistema todavia lee estas dos fechas.
    periodoInicio: ahora, periodoFin: planFin || vig.sumarMeses(ahora, 1200),
    avisosEnviados: {},
  };
  const sub = await prisma.suscripcion.upsert({
    where: { empresaId },
    create: { empresaId, ...datos },
    update: datos,
    include: { plan: true },
  });
  return { suscripcion: sub, valores: valoresDeSuscripcion(sub, ahora), actor };
}

/** Renovar: suma meses al fin vigente (si ya vencio, cuenta desde hoy) y reinicia los avisos de corte. */
async function renovar(empresaId, meses, { ahora = new Date() } = {}) {
  const sub = await prisma.suscripcion.findUnique({ where: { empresaId } });
  if (!sub) throw new ErrorPlan('Este cliente todavía no tiene un plan: asignale uno primero.');
  let planFin;
  try { planFin = vig.renovarFin({ planFin: sub.planFin, meses, ahora }); } catch (err) { throw new ErrorPlan(err.message); }
  const enviados = { ...(sub.avisosEnviados || {}) };
  for (const k of Object.keys(enviados)) if (k.startsWith('corte')) delete enviados[k];
  return prisma.suscripcion.update({
    where: { empresaId },
    data: { planFin, periodoFin: planFin, estado: sub.estado === 'PRUEBA' ? 'PRUEBA' : 'ACTIVA', avisosEnviados: enviados },
  });
}

const aEntero = (v, nombre) => {
  if (v === '' || v === null || v === undefined) return null; // vacio = sin limite
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ErrorPlan(`"${nombre}" tiene que ser un número entero (o vacío para sin límite).`);
  return n;
};

/** El superadmin ajusta la COPIA de un cliente (no toca el plan ni a otros clientes). */
async function editarCopia(empresaId, valores = {}) {
  const sub = await prisma.suscripcion.findUnique({ where: { empresaId } });
  if (!sub) throw new ErrorPlan('Este cliente todavía no tiene un plan.');
  const data = {};
  for (const k of CAMPOS_LIMITE) if (k in valores) data[k] = aEntero(valores[k], k);
  if ('modulos' in valores) {
    const m = [...new Set((valores.modulos || []).map(String))];
    if (!m.length || !m.includes('AGENTE') || m.some((x) => !MODULOS.includes(x))) throw new ErrorPlan('Los módulos tienen que incluir Agente y ser Agente, POS o Panel.');
    data.modulos = m;
  }
  if ('ilimitado' in valores) data.ilimitado = Boolean(valores.ilimitado);
  if ('marcaBlanca' in valores) data.marcaBlanca = Boolean(valores.marcaBlanca);
  if ('modeloIa' in valores) data.modeloIa = valores.modeloIa ? String(valores.modeloIa) : null;
  if ('planFin' in valores) {
    if (!valores.planFin) { data.planFin = null; data.periodoFin = vig.sumarMeses(new Date(), 1200); } else {
      const f = new Date(valores.planFin);
      if (Number.isNaN(f.getTime())) throw new ErrorPlan('La fecha de fin no es válida.');
      data.planFin = f; data.periodoFin = f; data.avisosEnviados = {};
    }
  }
  return prisma.suscripcion.update({ where: { empresaId }, data });
}

/**
 * Crea la suscripcion de prueba de un cliente nuevo: SOLO el modulo Agente, por DIAS_PRUEBA dias.
 * Si todavia no existe la plantilla "PRUEBA", queda en el estado base (sin suscripcion).
 */
async function iniciarPrueba(empresaId, { ahora = new Date() } = {}) {
  const plantilla = await prisma.plan.findUnique({ where: { codigo: CODIGO_PRUEBA } });
  if (!plantilla) return null;
  const fin = new Date(ahora.getTime() + DIAS_PRUEBA * 24 * 60 * 60 * 1000);
  return asignarPlan(empresaId, plantilla.id, { fechaFin: fin, ahora });
}

module.exports = {
  MODULOS, NOMBRES_MODULO, CODIGO_PRUEBA, DIAS_PRUEBA, BASE, CAMPOS_LIMITE, SIN_TOPE, topeNumerico, topeTexto,
  ErrorPlan, valoresDeSuscripcion, valoresDe, tieneModulo, copiaDePlan, asignarPlan, renovar, editarCopia, iniciarPrueba,
};
