'use strict';
// lib/services/creditos.js
//
// CREDITOS (fases 4 a 7 del planning): unidad interna de consumo que reemplaza a las "conversaciones".
//
//   Tarifario  `acciones_credito`: cuantos creditos cuesta cada accion, con vigencia (cambiar un precio no altera el pasado).
//   Lotes      `creditos_lotes`: grupos de creditos con origen (PLAN, COMPRA, AJUSTE, MIGRACION), saldo restante y vencimiento.
//   Libro      `creditos_movimientos`: cada movimiento, inmutable. Un error se corrige con un movimiento nuevo.
//   Saldo      suma de lo que queda en los lotes vigentes. Nunca negativo (CHECK en la base).
//
// Reglas de cobro (siempre):
//   - Atomico y condicionado: "descontar solo si alcanza". Un bloqueo por empresa (advisory lock) serializa los cobros simultaneos.
//   - Idempotente: cada cobro lleva una clave; repetirlo no vuelve a descontar.
//   - Orden de consumo: primero los lotes que vencen antes (los del plan), despues los comprados.
//   - Auditable: cada movimiento guarda accion, precio aplicado, referencia y quien lo hizo.
//
// MODO (variable CREDITOS_MODO):
//   APAGADO  (por defecto) los creditos no hacen nada: manda el sistema de conversaciones.
//   SOMBRA   el sistema de conversaciones sigue mandando y ademas cada consumo se anota como movimiento SOMBRA (no mueve saldo),
//            para comparar y calibrar el tarifario sin que el cliente lo note.
//   ACTIVO   los creditos son la fuente de verdad: se cobra con ellos y sin saldo el agente pasa al modo sin IA.

const crypto = require('node:crypto');
const { prisma } = require('../db');
const trazaIA = require('./trazaIA');

const ACCIONES = { CONVERSACION_NUEVA: 'CONVERSACION_NUEVA', TURNO_IA: 'TURNO_IA', PLANTILLA_SALIENTE: 'PLANTILLA_SALIENTE' };
// Equivalencia de migracion: 1 conversacion = 5 creditos (un plan de 500 conversaciones pasa a 2.500 creditos por mes).
const EQUIVALENCIA = 5;
const MESES_VENCE_COMPRA = 12;
const LOCK = 7001;
const ORIGENES = ['PLAN', 'COMPRA', 'AJUSTE', 'MIGRACION'];
const TIPO_POR_ORIGEN = { PLAN: 'ASIGNACION', COMPRA: 'COMPRA', AJUSTE: 'AJUSTE', MIGRACION: 'MIGRACION' };

class ErrorCreditos extends Error {
  constructor(mensaje, codigo = 'CREDITOS') { super(mensaje); this.codigo = codigo; }
}

function modo(env = process.env) {
  const m = String(env.CREDITOS_MODO || '').trim().toUpperCase();
  return ['SOMBRA', 'ACTIVO'].includes(m) ? m : 'APAGADO';
}

const entero = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const sumaMes = (fecha, meses) => { const d = new Date(fecha); d.setMonth(d.getMonth() + meses); return d; };

// ----------------------------- Tarifario -----------------------------

/** Creditos que cuesta una accion en una fecha (null si no hay precio vigente o la accion esta desactivada). */
async function precio(accion, fecha = new Date(), db = prisma) {
  const f = await db.accionCredito.findFirst({
    where: { accion, activa: true, vigenteDesde: { lte: fecha }, OR: [{ vigenteHasta: null }, { vigenteHasta: { gt: fecha } }] },
    orderBy: { vigenteDesde: 'desc' },
  });
  return f ? f.creditos : null;
}

/** Cambia el precio: cierra el vigente y abre uno nuevo desde `desde` (por defecto ahora). */
async function cambiarPrecio({ accion, creditos, desde = new Date(), nota = null }, db = prisma) {
  const c = entero(creditos);
  if (!Object.values(ACCIONES).includes(accion)) throw new ErrorCreditos('Esa acción no existe en el tarifario.', 'ACCION');
  if (!Number.isInteger(c) || c < 0 || c > 100000) throw new ErrorCreditos('Los créditos tienen que ser un número entero entre 0 y 100.000.', 'PRECIO');
  return db.$transaction(async (tx) => {
    await tx.accionCredito.updateMany({ where: { accion, vigenteHasta: null }, data: { vigenteHasta: desde } });
    return tx.accionCredito.create({ data: { accion, creditos: c, vigenteDesde: desde, nota: nota ? String(nota).slice(0, 200) : null } });
  });
}

async function tarifario(db = prisma) {
  return db.accionCredito.findMany({ orderBy: [{ accion: 'asc' }, { vigenteDesde: 'desc' }] });
}

// ----------------------------- Saldo -----------------------------

const vigentes = (ahora) => ({ restante: { gt: 0 }, OR: [{ vence: null }, { vence: { gt: ahora } }] });

async function saldo(empresaId, { db = prisma, ahora = new Date() } = {}) {
  const lotes = await db.creditoLote.findMany({ where: { empresaId, ...vigentes(ahora) }, orderBy: [{ vence: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] });
  const porOrigen = {};
  let total = 0;
  for (const l of lotes) { total += l.restante; porOrigen[l.origen] = (porOrigen[l.origen] || 0) + l.restante; }
  return { total, porOrigen, lotes };
}

async function saldoTx(tx, empresaId, ahora) {
  const r = await tx.creditoLote.aggregate({ where: { empresaId, ...vigentes(ahora) }, _sum: { restante: true } });
  return r._sum.restante || 0;
}

const bloquear = (tx, empresaId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK}, ${empresaId})`;

// ----------------------------- Entradas -----------------------------

/**
 * Suma creditos en un lote nuevo. Idempotente por `clave`: repetirla no vuelve a acreditar.
 * @param {{ empresaId, origen, cantidad, vence?, referencia?, clave, nota?, quien? }} d
 */
async function otorgar(d, db = prisma) {
  const cantidad = entero(d.cantidad);
  if (!ORIGENES.includes(d.origen)) throw new ErrorCreditos('Origen de lote inválido.', 'ORIGEN');
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw new ErrorCreditos('La cantidad de créditos tiene que ser un entero positivo.', 'CANTIDAD');
  if (!d.clave) throw new ErrorCreditos('Falta la clave de idempotencia.', 'CLAVE');
  const tipo = TIPO_POR_ORIGEN[d.origen];
  return db.$transaction(async (tx) => {
    await bloquear(tx, d.empresaId);
    const previo = await tx.creditoMovimiento.findFirst({ where: { empresaId: d.empresaId, claveIdempotencia: d.clave, tipo } });
    if (previo) return { ok: true, repetido: true, loteId: previo.loteId };
    const lote = await tx.creditoLote.create({ data: { empresaId: d.empresaId, origen: d.origen, cantidadInicial: cantidad, restante: cantidad, vence: d.vence || null, referencia: d.referencia || null } });
    const despues = await saldoTx(tx, d.empresaId, new Date());
    await tx.creditoMovimiento.create({ data: { empresaId: d.empresaId, loteId: lote.id, tipo, cantidad, saldoDespues: despues, referencia: d.referencia || null, claveIdempotencia: d.clave, nota: d.nota ? String(d.nota).slice(0, 200) : null, quien: d.quien || 'sistema' } });
    return { ok: true, repetido: false, loteId: lote.id };
  });
}

// ----------------------------- Salidas -----------------------------

class SinSaldo extends Error {}

/** Descuenta `cantidad` de los lotes (los que vencen antes primero). Debe correr dentro de una transaccion con el bloqueo tomado. */
async function descontarTx(tx, { empresaId, cantidad, tipo, accion, precioAplicado, referencia, clave, nota, quien }, ahora) {
  const lotes = await tx.creditoLote.findMany({ where: { empresaId, ...vigentes(ahora) }, orderBy: [{ vence: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] });
  let disponible = lotes.reduce((s, l) => s + l.restante, 0);
  if (disponible < cantidad) throw new SinSaldo();
  let falta = cantidad;
  for (const l of lotes) {
    if (falta <= 0) break;
    const toma = Math.min(falta, l.restante);
    // Condicionado: solo descuenta si el lote sigue teniendo lo que se vio.
    const r = await tx.creditoLote.updateMany({ where: { id: l.id, restante: { gte: toma } }, data: { restante: { decrement: toma } } });
    if (r.count !== 1) throw new SinSaldo();
    disponible -= toma; falta -= toma;
    await tx.creditoMovimiento.create({ data: { empresaId, loteId: l.id, tipo, cantidad: -toma, saldoDespues: disponible, accion: accion || null, precioAplicado: precioAplicado ?? null, referencia: referencia || null, claveIdempotencia: clave, nota: nota || null, quien: quien || 'sistema' } });
  }
  return disponible;
}

/**
 * Cobra una accion. Atomico, condicionado e idempotente.
 * @param {{ empresaId, accion, cantidad?, clave, referencia?, nota?, quien? }} d  cantidad: por defecto el precio vigente del tarifario
 * @returns {{ ok: boolean, cantidad?: number, repetido?: boolean, saldo?: number, motivo?: string }}
 */
async function consumir(d, db = prisma, ahora = new Date()) {
  if (!d.clave) throw new ErrorCreditos('Falta la clave de idempotencia.', 'CLAVE');
  const cantidad = d.cantidad !== undefined && d.cantidad !== null ? entero(d.cantidad) : await precio(d.accion, ahora, db);
  if (cantidad === null || !Number.isInteger(cantidad) || cantidad < 0) return { ok: false, motivo: 'SIN_PRECIO' };
  if (cantidad === 0) return { ok: true, cantidad: 0, repetido: false };
  try {
    return await db.$transaction(async (tx) => {
      await bloquear(tx, d.empresaId);
      const previo = await tx.creditoMovimiento.findFirst({ where: { empresaId: d.empresaId, claveIdempotencia: d.clave, tipo: 'CONSUMO' } });
      if (previo) return { ok: true, repetido: true, cantidad };
      const queda = await descontarTx(tx, { ...d, cantidad, tipo: 'CONSUMO', precioAplicado: cantidad }, ahora);
      return { ok: true, repetido: false, cantidad, saldo: queda };
    });
  } catch (err) {
    if (err instanceof SinSaldo) return { ok: false, motivo: 'SIN_SALDO' };
    throw err;
  }
}

/** Devuelve lo cobrado con `clave` (por ejemplo si la accion fallo y el cliente no recibio respuesta). Idempotente. */
async function devolver({ empresaId, clave, nota = null, quien = 'sistema' }, db = prisma) {
  return db.$transaction(async (tx) => {
    await bloquear(tx, empresaId);
    const claveDev = `dev:${clave}`;
    if (await tx.creditoMovimiento.findFirst({ where: { empresaId, claveIdempotencia: claveDev, tipo: 'DEVOLUCION' } })) return { ok: true, repetido: true };
    const cobros = await tx.creditoMovimiento.findMany({ where: { empresaId, claveIdempotencia: clave, tipo: 'CONSUMO' } });
    if (!cobros.length) return { ok: false, motivo: 'NO_EXISTE' };
    let devuelto = 0;
    for (const c of cobros) {
      const monto = -c.cantidad;
      await tx.creditoLote.update({ where: { id: c.loteId }, data: { restante: { increment: monto } } });
      devuelto += monto;
      await tx.creditoMovimiento.create({ data: { empresaId, loteId: c.loteId, tipo: 'DEVOLUCION', cantidad: monto, saldoDespues: await saldoTx(tx, empresaId, new Date()), accion: c.accion, referencia: c.referencia, claveIdempotencia: claveDev, nota: nota || 'Devolución', quien } });
    }
    return { ok: true, repetido: false, devuelto };
  });
}

/** Ajuste manual del superadmin (suma o resta), con motivo obligatorio. Queda en el libro. */
async function ajustar({ empresaId, cantidad, motivo, quien }, db = prisma) {
  const c = entero(cantidad);
  if (!Number.isInteger(c) || c === 0) throw new ErrorCreditos('La cantidad del ajuste tiene que ser un entero distinto de cero.', 'CANTIDAD');
  if (!motivo || String(motivo).trim().length < 3) throw new ErrorCreditos('Escribí el motivo del ajuste (queda en el libro y en la auditoría).', 'MOTIVO');
  const clave = `ajuste:${crypto.randomUUID()}`;
  if (c > 0) return otorgar({ empresaId, origen: 'AJUSTE', cantidad: c, clave, nota: String(motivo).slice(0, 200), quien: quien || 'superadmin' }, db);
  try {
    return await db.$transaction(async (tx) => {
      await bloquear(tx, empresaId);
      const queda = await descontarTx(tx, { empresaId, cantidad: -c, tipo: 'AJUSTE', clave, nota: String(motivo).slice(0, 200), quien: quien || 'superadmin' }, new Date());
      return { ok: true, saldo: queda };
    });
  } catch (err) {
    if (err instanceof SinSaldo) throw new ErrorCreditos('No se puede restar más créditos de los que tiene la empresa.', 'SIN_SALDO');
    throw err;
  }
}

/** Vence los lotes cuya fecha ya paso: el restante pasa a 0 con un movimiento VENCIMIENTO. */
async function vencer(ahora = new Date(), db = prisma) {
  const lotes = await db.creditoLote.findMany({ where: { restante: { gt: 0 }, vence: { lte: ahora } } });
  let n = 0;
  for (const l of lotes) {
    await db.$transaction(async (tx) => {
      await bloquear(tx, l.empresaId);
      const fresco = await tx.creditoLote.findUnique({ where: { id: l.id } });
      if (!fresco || fresco.restante <= 0) return;
      await tx.creditoLote.update({ where: { id: l.id }, data: { restante: 0 } });
      await tx.creditoMovimiento.create({ data: { empresaId: l.empresaId, loteId: l.id, tipo: 'VENCIMIENTO', cantidad: -fresco.restante, saldoDespues: await saldoTx(tx, l.empresaId, ahora), referencia: l.referencia, claveIdempotencia: `venc:${l.id}`, nota: 'El lote venció', quien: 'sistema' } });
      n += 1;
    });
  }
  return n;
}

// ----------------------------- Modo sombra -----------------------------

/** Anota un consumo simulado (no mueve saldo) para comparar con el sistema de conversaciones. Idempotente por clave. */
async function registrarSombra({ empresaId, accion, clave, referencia = null }, db = prisma) {
  try {
    if (await db.creditoMovimiento.findFirst({ where: { empresaId, claveIdempotencia: clave, tipo: 'SOMBRA' } })) return { ok: true, repetido: true };
    const p = await precio(accion, new Date(), db);
    if (p === null) return { ok: false, motivo: 'SIN_PRECIO' };
    await db.creditoMovimiento.create({ data: { empresaId, tipo: 'SOMBRA', cantidad: -p, accion, precioAplicado: p, referencia, claveIdempotencia: clave, quien: 'sistema' } });
    return { ok: true, repetido: false };
  } catch (err) { console.error('[creditos] sombra:', err.message); return { ok: false, motivo: 'ERROR' }; }
}

/** Compara, por empresa, lo que se habria cobrado en creditos (sombra) con las conversaciones reales del mismo período. */
async function informeSombra({ dias = 14 } = {}, db = prisma) {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const filas = await db.$queryRaw`
    SELECT m."empresaId", e."nombre",
           COUNT(*) FILTER (WHERE m."accion" = 'CONVERSACION_NUEVA')::int AS "conversaciones",
           COUNT(*) FILTER (WHERE m."accion" = 'TURNO_IA')::int AS "turnosIA",
           COALESCE(SUM(-m."cantidad"), 0)::int AS "creditos"
    FROM "creditos_movimientos" m JOIN "empresas" e ON e."id" = m."empresaId"
    WHERE m."tipo" = 'SOMBRA' AND m."createdAt" >= ${desde} GROUP BY 1, 2 ORDER BY 5 DESC`;
  return { dias, filas };
}

// ----------------------------- Utilidades -----------------------------

/** Comprueba que el saldo de cada lote cuadra con el libro. */
async function verificarCuadre(empresaId, db = prisma) {
  const lotes = await db.creditoLote.findMany({ where: { empresaId } });
  const descuadres = [];
  for (const l of lotes) {
    const r = await db.creditoMovimiento.aggregate({ where: { loteId: l.id, tipo: { not: 'SOMBRA' } }, _sum: { cantidad: true } });
    const esperado = (r._sum.cantidad || 0);
    if (esperado !== l.restante || l.restante < 0) descuadres.push({ loteId: l.id, restante: l.restante, libro: esperado });
  }
  return { ok: descuadres.length === 0, descuadres };
}

/** ¿Se puede hacer una respuesta con IA? Solo restringe en modo ACTIVO; los planes ilimitados nunca se frenan. */
async function puedeUsarIA(empresaId, db = prisma) {
  if (modo() !== 'ACTIVO') return true;
  try {
    const sus = await db.suscripcion.findUnique({ where: { empresaId }, select: { ilimitado: true } });
    if (sus && sus.ilimitado) return true;
    const p = await precio(ACCIONES.TURNO_IA, new Date(), db);
    if (!p) return true;
    return (await saldo(empresaId, { db })).total >= p;
  } catch (err) { console.error('[creditos] puedeUsarIA:', err.message); return true; }
}

/** Cuantas conversaciones "equivalen" a una cantidad de creditos (para que el cambio sea facil de entender). */
async function equivalenteConversaciones(creditos, db = prisma) {
  const p = (await precio(ACCIONES.CONVERSACION_NUEVA, new Date(), db)) || EQUIVALENCIA;
  return p > 0 ? Math.floor(creditos / p) : 0;
}

module.exports = { ACCIONES, EQUIVALENCIA, MESES_VENCE_COMPRA, ErrorCreditos, modo, precio, cambiarPrecio, tarifario, saldo, otorgar, consumir, devolver, ajustar, vencer, registrarSombra, informeSombra, verificarCuadre, puedeUsarIA, equivalenteConversaciones, sumaMes, trazaIA };
