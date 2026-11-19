'use strict';
// lib/services/creditosHistorico.js
//
// INFORME RETROACTIVO: con los datos que YA existen, cuantos creditos habria gastado cada empresa y cuanto nos costo atenderla.
// Solo lectura: no escribe nada en el libro de creditos.
//
//   Conversaciones      = filas de `conversaciones` del mes (cada una x precio vigente de CONVERSACION_NUEVA).
//   Respuestas con IA   = llamadas de `usos_ia` completadas, de chat, vuelta 0 (la primera llamada de cada turno) x precio vigente de TURNO_IA.
//   Costo de IA         = costo estimado en USD de TODAS las llamadas completadas (incluye reintentos y embeddings), pasado a Bs con el cambio de cada dia.
//   Ingresos            = pagos confirmados del mes (USD pasados a Bs con el cambio de la fecha del pago).
// Limites: el registro de llamadas a la IA solo existe desde que se empezo a guardar (`cobertura.desde`); antes de esa fecha hay conversaciones
// pero no sabemos cuantas respuestas con IA hubo ni cuanto costaron. Las plantillas salientes no tienen historial confiable y no entran.

const { prisma } = require('../db');
const tipoCambio = require('./tipoCambio');
const cr = require('./creditos');

const r2 = (n) => Math.round(n * 100) / 100;

/** @param {{ meses?: number }} opt  cuantos meses hacia atras (incluye el actual) */
async function informe({ meses = 6 } = {}, db = prisma) {
  const n = Math.min(24, Math.max(1, Number(meses) || 6));
  const ahora = new Date();
  const desde = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - (n - 1), 1));
  const [pConv, pTurno] = [await cr.precio(cr.ACCIONES.CONVERSACION_NUEVA, ahora, db), await cr.precio(cr.ACCIONES.TURNO_IA, ahora, db)];

  const [convs, usos, pagos, empresas, primerUso] = await Promise.all([
    db.$queryRaw`SELECT a."empresaId", to_char(((c."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz')::date, 'YYYY-MM') AS mes, COUNT(*)::int AS n
                 FROM "conversaciones" c JOIN "agentes" a ON a."id" = c."agenteId" WHERE c."createdAt" >= ${desde} GROUP BY 1, 2`,
    db.$queryRaw`SELECT "empresaId", ((("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz')::date)::text AS dia,
                        COALESCE(SUM("costoUsd"), 0)::float AS usd, COUNT(*) FILTER (WHERE "servicio" = 'chat' AND "vuelta" = 0)::int AS turnos
                 FROM "usos_ia" WHERE "createdAt" >= ${desde} AND "estado" = 'COMPLETADA' GROUP BY 1, 2`,
    db.pago.findMany({ where: { estado: 'CONFIRMADO', fecha: { gte: desde } }, select: { empresaId: true, monto: true, moneda: true, fecha: true } }),
    db.empresa.findMany({ select: { id: true, nombre: true } }),
    db.$queryRaw`SELECT MIN("createdAt") AS desde FROM "usos_ia"`,
  ]);

  // Para dias anteriores al primer tipo de cambio guardado se usa ese primer valor, marcado como APROXIMADO (mejor una estimacion declarada que cero).
  const primero = await db.tipoCambio.findFirst({ orderBy: [{ fecha: 'asc' }, { fuente: 'asc' }] });
  const aprox = { usd: 0, desde: primero ? primero.fecha.toISOString().slice(0, 10) : null, bobPorUsd: primero ? Number(primero.bobPorUsd) : null };
  const cache = new Map();
  const cambioDe = async (dia) => {
    if (!cache.has(dia)) {
      const tc = await tipoCambio.delDia(dia, db);
      cache.set(dia, tc || (primero ? { bobPorUsd: aprox.bobPorUsd, aproximado: true } : null));
    }
    return cache.get(dia);
  };
  const celdas = new Map(); // `${mes}|${empresaId}`
  const celda = (mes, empresaId) => {
    const k = `${mes}|${empresaId}`;
    if (!celdas.has(k)) celdas.set(k, { mes, empresaId, conversaciones: 0, turnos: 0, costoUsd: 0, costoBs: 0, costoSinConvertirUsd: 0, ingresosBs: 0 });
    return celdas.get(k);
  };

  for (const c of convs) celda(c.mes, c.empresaId).conversaciones += c.n;
  for (const u of usos) {
    const x = celda(u.dia.slice(0, 7), u.empresaId); const tc = await cambioDe(u.dia);
    x.turnos += u.turnos; x.costoUsd += u.usd;
    if (tc && tc.aproximado) aprox.usd += u.usd;
    if (tc) x.costoBs += u.usd * tc.bobPorUsd; else x.costoSinConvertirUsd += u.usd;
  }
  for (const p of pagos) {
    const dia = p.fecha.toISOString().slice(0, 10);
    const x = celda(dia.slice(0, 7), p.empresaId); const monto = Number(p.monto);
    if (p.moneda === 'USD') { const tc = await cambioDe(dia); if (tc) x.ingresosBs += monto * tc.bobPorUsd; } else x.ingresosBs += monto;
  }

  const nombres = new Map(empresas.map((e) => [e.id, e.nombre]));
  const filas = [...celdas.values()].map((x) => {
    const creditos = x.conversaciones * (pConv || 0) + x.turnos * (pTurno || 0);
    return { ...x, nombre: nombres.get(x.empresaId) || `Empresa #${x.empresaId}`, creditos, costoUsd: Math.round(x.costoUsd * 1e6) / 1e6, costoBs: r2(x.costoBs), ingresosBs: r2(x.ingresosBs), margenBs: r2(x.ingresosBs - x.costoBs), costoBsPorCredito: creditos > 0 ? Math.round((x.costoBs / creditos) * 10000) / 10000 : null };
  }).sort((a, b) => (a.mes < b.mes ? 1 : a.mes > b.mes ? -1 : b.creditos - a.creditos));

  const sumar = (lista) => lista.reduce((t, f) => ({ conversaciones: t.conversaciones + f.conversaciones, turnos: t.turnos + f.turnos, creditos: t.creditos + f.creditos, costoUsd: t.costoUsd + f.costoUsd, costoBs: t.costoBs + f.costoBs, ingresosBs: t.ingresosBs + f.ingresosBs, costoSinConvertirUsd: t.costoSinConvertirUsd + f.costoSinConvertirUsd }), { conversaciones: 0, turnos: 0, creditos: 0, costoUsd: 0, costoBs: 0, ingresosBs: 0, costoSinConvertirUsd: 0 });
  const redond = (t) => ({ ...t, costoUsd: Math.round(t.costoUsd * 1e6) / 1e6, costoBs: r2(t.costoBs), ingresosBs: r2(t.ingresosBs), margenBs: r2(t.ingresosBs - t.costoBs), costoBsPorCredito: t.creditos > 0 ? Math.round((t.costoBs / t.creditos) * 10000) / 10000 : null });

  const porMes = [...new Set(filas.map((f) => f.mes))].sort().reverse().map((mes) => ({ mes, ...redond(sumar(filas.filter((f) => f.mes === mes))) }));
  const porEmpresa = [...new Set(filas.map((f) => f.empresaId))].map((id) => ({ empresaId: id, nombre: nombres.get(id) || `Empresa #${id}`, ...redond(sumar(filas.filter((f) => f.empresaId === id))) })).sort((a, b) => b.creditos - a.creditos);
  const desdeUso = primerUso[0] && primerUso[0].desde ? primerUso[0].desde : null;

  return {
    meses: n, desde, cambioAproximado: aprox.usd > 0 ? { usd: Math.round(aprox.usd * 1e6) / 1e6, bobPorUsd: aprox.bobPorUsd, desde: aprox.desde } : null, precios: { conversacion: pConv, turno: pTurno }, porMes, porEmpresa, filas, totales: redond(sumar(filas)),
    cobertura: { desde: desdeUso, mesesSinIA: porMes.filter((m) => desdeUso && m.mes < desdeUso.toISOString().slice(0, 7)).map((m) => m.mes) },
  };
}

module.exports = { informe };
