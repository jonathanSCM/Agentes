'use strict';
// lib/services/conversionCreditos.js
//
// CONVERSION DE SALDOS (fase 7): pasa lo que cada empresa tiene hoy en conversaciones a creditos, con la equivalencia aprobada
// (1 conversacion = 5 creditos): saldo en creditos = saldo antiguo x equivalencia.
//
//   - Lo que QUEDA del cupo del plan en el periodo vigente  -> lote PLAN que vence al cerrar el periodo (misma clave que la entrega
//     mensual de creditosConsumo.otorgarPlanes, asi nunca se entrega dos veces el mismo periodo).
//   - Cada paquete comprado con saldo y vigente              -> lote MIGRACION con su misma fecha de vencimiento.
//   - NO se convierten: planes ilimitados, paquetes vencidos o agotados, suscripciones canceladas.
//   - Idempotente (claves por periodo y por paquete): se puede correr varias veces sin duplicar.
//   - `planificar` solo calcula (modo simulacion); `aplicar` escribe. El informe compara, empresa por empresa, lo esperado con lo creado:
//     la diferencia tiene que ser CERO.
// Los datos de conversaciones NO se tocan: la reversa es volver a CREDITOS_MODO=SOMBRA o APAGADO.

const { prisma } = require('../db');
const vig = require('./vigenciaPlan');
const { valoresDeSuscripcion } = require('./planesCliente');
const { obtenerEstadoConsumo } = require('./suscripciones');
const cr = require('./creditos');

const ESTADOS = ['ACTIVA', 'PRUEBA', 'MOROSA'];

/** Calcula, sin escribir nada, que se convertiria para cada empresa. */
async function planificar({ empresaId = null, ahora = new Date(), db = prisma } = {}) {
  const subs = await db.suscripcion.findMany({ where: { estado: { in: ESTADOS }, ...(empresaId ? { empresaId } : {}) }, include: { plan: true, empresa: { select: { nombre: true } } }, orderBy: { empresaId: 'asc' } });
  const filas = [];
  for (const s of subs) {
    const valores = valoresDeSuscripcion(s, ahora);
    const fila = { empresaId: s.empresaId, nombre: s.empresa.nombre, estado: s.estado, omitida: null, lotes: [], conversaciones: 0, creditosEsperados: 0 };
    if (valores.ilimitado) { fila.omitida = 'PLAN_ILIMITADO'; filas.push(fila); continue; }
    const consumo = await obtenerEstadoConsumo(s.id);
    const { desde, hasta } = vig.periodoMensual(valores.planInicio || s.periodoInicio, ahora);

    // Cupo del plan: solo si el plan sigue vigente (si no, no tiene cupo propio que convertir).
    if (valores.vigencia.puedeUsarAgente && ESTADOS.slice(0, 2).includes(s.estado) && consumo.incluidasDisponibles > 0) {
      const clave = `plan:${s.empresaId}:${desde.toISOString()}`;
      fila.lotes.push({ origen: 'PLAN', conversaciones: consumo.incluidasDisponibles, creditos: consumo.incluidasDisponibles * cr.EQUIVALENCIA, vence: hasta, clave, referencia: clave, nota: `Conversión: quedaban ${consumo.incluidasDisponibles} conversaciones del plan` });
    }
    // Paquetes comprados con saldo y vigentes.
    const compras = await db.compraPaquete.findMany({ where: { empresaId: s.empresaId, estado: 'ACTIVA', fechaRenovacion: { gt: ahora } }, orderBy: { fechaCompra: 'asc' } });
    for (const c of compras) {
      const resto = c.cantidad - c.consumidas;
      if (resto <= 0) continue;
      fila.lotes.push({ origen: 'MIGRACION', conversaciones: resto, creditos: resto * cr.EQUIVALENCIA, vence: c.fechaRenovacion, clave: `migracion:compra:${c.id}`, referencia: `compra:${c.id}`, nota: `Conversión: quedaban ${resto} conversaciones del paquete #${c.id}` });
    }
    fila.conversaciones = fila.lotes.reduce((a, l) => a + l.conversaciones, 0);
    fila.creditosEsperados = fila.lotes.reduce((a, l) => a + l.creditos, 0);
    filas.push(fila);
  }
  const pendientes = await db.solicitudConversaciones.count({ where: { estado: 'PENDIENTE', ...(empresaId ? { empresaId } : {}) } });
  return { filas, solicitudesPendientes: pendientes };
}

/** Escribe los lotes del plan. Devuelve el informe con la diferencia entre lo esperado y lo que quedo en la base (debe ser 0). */
async function aplicar({ empresaId = null, ahora = new Date(), db = prisma } = {}) {
  const plan = await planificar({ empresaId, ahora, db });
  for (const f of plan.filas) {
    for (const l of f.lotes) {
      await cr.otorgar({ empresaId: f.empresaId, origen: l.origen, cantidad: l.creditos, vence: l.vence, referencia: l.referencia, clave: l.clave, nota: l.nota, quien: 'conversion' }, db);
    }
  }
  return { ...plan, verificacion: await verificar(plan, { db }) };
}

/** Compara lo esperado con lo que hay en los lotes (solo los de esta conversion). Diferencia distinta de 0 = hay que investigar. */
async function verificar(plan, { db = prisma } = {}) {
  const filas = [];
  for (const f of plan.filas) {
    if (f.omitida) continue;
    let creado = 0;
    for (const l of f.lotes) {
      const m = await db.creditoMovimiento.findFirst({ where: { empresaId: f.empresaId, claveIdempotencia: l.clave, tipo: { in: ['ASIGNACION', 'MIGRACION'] } }, include: { lote: true } });
      if (m) creado += m.lote.cantidadInicial;
    }
    const cuadre = await cr.verificarCuadre(f.empresaId, db);
    filas.push({ empresaId: f.empresaId, nombre: f.nombre, esperado: f.creditosEsperados, creado, diferencia: creado - f.creditosEsperados, cuadreLibro: cuadre.ok });
  }
  return { filas, ok: filas.every((x) => x.diferencia === 0 && x.cuadreLibro) };
}

module.exports = { planificar, aplicar, verificar };
