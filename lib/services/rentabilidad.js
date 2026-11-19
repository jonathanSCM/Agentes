'use strict';
// lib/services/rentabilidad.js
//
// RENTABILIDAD POR EMPRESA (fase 9): lo que cada negocio le paga a Proshop frente a lo que cuesta atenderlo con IA, todo en bolivianos.
//   Ingresos = pagos CONFIRMADOS del período (los USD se pasan a Bs con el tipo de cambio de la fecha del pago).
//   Costo de IA = solicitudes COMPLETADAS (USD) pasadas a Bs con el tipo de cambio de CADA día, no con el de hoy.
//   Margen = ingresos - costo de IA. Es un margen sobre el costo de IA solamente (no incluye servidores, comisiones ni sueldos).
// Si falta el tipo de cambio de un día, ese costo NO se convierte ni se inventa: queda aparte (`costoSinConvertirUsd`) y se avisa.

const { prisma } = require('../db');
const tipoCambio = require('./tipoCambio');

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {{ dias?: number }} opt  período hacia atrás desde hoy
 */
async function porEmpresa({ dias = 30 } = {}, db = prisma) {
  const desde = new Date(Date.now() - Math.max(1, Number(dias) || 30) * 24 * 60 * 60 * 1000);
  const [costos, pagos, conversaciones, empresas] = await Promise.all([
    db.$queryRaw`SELECT "empresaId", ((("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz')::date)::text AS dia,
                        COALESCE(SUM("costoUsd"), 0)::float AS usd, COUNT(*)::int AS llamadas
                 FROM "usos_ia" WHERE "createdAt" >= ${desde} AND "estado" = 'COMPLETADA' GROUP BY 1, 2`,
    db.pago.findMany({ where: { estado: 'CONFIRMADO', fecha: { gte: desde } }, select: { empresaId: true, monto: true, moneda: true, fecha: true } }),
    db.$queryRaw`SELECT a."empresaId", COUNT(*)::int AS n FROM "conversaciones" c JOIN "agentes" a ON a."id" = c."agenteId" WHERE c."createdAt" >= ${desde} GROUP BY 1`,
    db.empresa.findMany({ select: { id: true, nombre: true } }),
  ]);

  const cache = new Map();
  const cambioDe = async (dia) => { if (!cache.has(dia)) cache.set(dia, await tipoCambio.delDia(dia, db)); return cache.get(dia); };
  const fila = new Map();
  const de = (id) => { if (!fila.has(id)) fila.set(id, { empresaId: id, ingresosBs: 0, ingresosSinConvertir: 0, costoBs: 0, costoUsd: 0, costoSinConvertirUsd: 0, llamadas: 0, conversaciones: 0 }); return fila.get(id); };

  for (const c of costos) {
    const f = de(c.empresaId); const tc = await cambioDe(c.dia);
    f.costoUsd += c.usd; f.llamadas += c.llamadas;
    if (tc) f.costoBs += c.usd * tc.bobPorUsd; else f.costoSinConvertirUsd += c.usd;
  }
  for (const p of pagos) {
    const f = de(p.empresaId); const monto = Number(p.monto);
    if (p.moneda === 'USD') {
      const tc = await cambioDe(p.fecha.toISOString().slice(0, 10));
      if (tc) f.ingresosBs += monto * tc.bobPorUsd; else f.ingresosSinConvertir += monto;
    } else f.ingresosBs += monto;
  }
  for (const c of conversaciones) de(c.empresaId).conversaciones = c.n;

  const nombres = new Map(empresas.map((e) => [e.id, e.nombre]));
  const filas = [...fila.values()].map((f) => {
    const ingresosBs = r2(f.ingresosBs); const costoBs = r2(f.costoBs); const margenBs = r2(ingresosBs - costoBs);
    return {
      ...f, nombre: nombres.get(f.empresaId) || `Empresa #${f.empresaId}`, ingresosBs, costoBs, costoUsd: Math.round(f.costoUsd * 1e6) / 1e6, margenBs,
      margenPct: ingresosBs > 0 ? Math.round((margenBs / ingresosBs) * 1000) / 10 : null,
      costoPorConversacionBs: f.conversaciones > 0 ? r2(costoBs / f.conversaciones) : null,
      // PERDIDA: cuesta más de lo que paga | SIN_INGRESOS: usa IA pero no pagó en el período | OK
      estado: ingresosBs <= 0 && costoBs > 0 ? 'SIN_INGRESOS' : margenBs < 0 ? 'PERDIDA' : 'OK',
    };
  }).sort((a, b) => a.margenBs - b.margenBs);

  const suma = (k) => r2(filas.reduce((acc, f) => acc + f[k], 0));
  const ingresosBs = suma('ingresosBs'); const costoBs = suma('costoBs');
  return {
    dias, filas,
    totales: {
      ingresosBs, costoBs, margenBs: r2(ingresosBs - costoBs), margenPct: ingresosBs > 0 ? Math.round(((ingresosBs - costoBs) / ingresosBs) * 1000) / 10 : null,
      costoSinConvertirUsd: Math.round(filas.reduce((acc, f) => acc + f.costoSinConvertirUsd, 0) * 1e6) / 1e6,
      ingresosSinConvertir: r2(filas.reduce((acc, f) => acc + f.ingresosSinConvertir, 0)),
      empresasEnPerdida: filas.filter((f) => f.estado === 'PERDIDA').length, empresasSinIngresos: filas.filter((f) => f.estado === 'SIN_INGRESOS').length,
    },
  };
}

module.exports = { porEmpresa };
