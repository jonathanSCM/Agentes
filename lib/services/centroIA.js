'use strict';
// lib/services/centroIA.js
//
// CONSULTAS DEL CENTRO DE IA (superadmin, fase 8): resumen de salud del agente, lista filtrable de turnos (fallas e historial) y detalle de un turno.
// Solo lectura. Lo de las pruebas del panel (`prueba = true`) no cuenta en las cifras.

const { prisma } = require('../db');

const RESULTADOS = ['OK', 'DERIVADO', 'SIN_RESPUESTA', 'ERROR', 'EN_CURSO'];
const RUTAS = ['FLUJO', 'IA', 'SIN_IA', 'CITAS', 'GUARDIA'];
const POR_PAGINA = 25;

const desdeDias = (dias) => new Date(Date.now() - Math.max(1, Number(dias) || 7) * 24 * 60 * 60 * 1000);

async function resumen({ dias = 7 } = {}, db = prisma) {
  const desde = desdeDias(dias);
  const base = { createdAt: { gte: desde }, prueba: false };
  const [porResultado, porRuta, agregados, tiposEvento, porDia, empresasProblema] = await Promise.all([
    db.turnoIA.groupBy({ by: ['resultado'], where: base, _count: true }),
    db.turnoIA.groupBy({ by: ['ruta'], where: base, _count: true }),
    db.turnoIA.aggregate({ where: base, _sum: { llamadasIA: true, fallidasIA: true }, _avg: { latenciaMs: true }, _count: true }),
    db.eventoIA.groupBy({ by: ['tipo', 'gravedad'], where: { createdAt: { gte: desde }, gravedad: { in: ['AVISO', 'ERROR'] } }, _count: true }),
    db.$queryRaw`SELECT (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz')::date::text AS dia, COUNT(*)::int AS turnos,
                        COUNT(*) FILTER (WHERE "resultado" = 'ERROR')::int AS errores
                 FROM "ia_turnos" WHERE "createdAt" >= ${desde} AND "prueba" = false GROUP BY 1 ORDER BY 1`,
    db.turnoIA.groupBy({ by: ['empresaId'], where: { ...base, resultado: { in: ['ERROR', 'SIN_RESPUESTA'] } }, _count: true, orderBy: { _count: { empresaId: 'desc' } }, take: 5 }),
  ]);
  const n = (arr, k, v) => (arr.find((x) => x[k] === v) || { _count: 0 })._count;
  const total = agregados._count;
  const errores = n(porResultado, 'resultado', 'ERROR');
  const sinRespuesta = n(porResultado, 'resultado', 'SIN_RESPUESTA');
  const nombres = new Map((await db.empresa.findMany({ where: { id: { in: empresasProblema.map((e) => e.empresaId) } }, select: { id: true, nombre: true } })).map((e) => [e.id, e.nombre]));
  return {
    dias, total, errores, sinRespuesta,
    derivados: n(porResultado, 'resultado', 'DERIVADO'),
    pctProblemas: total ? Math.round(((errores + sinRespuesta) / total) * 1000) / 10 : 0,
    porRuta: RUTAS.map((r) => ({ ruta: r, n: n(porRuta, 'ruta', r) })),
    llamadas: agregados._sum.llamadasIA || 0, fallidas: agregados._sum.fallidasIA || 0,
    latenciaMs: Math.round(agregados._avg.latenciaMs || 0),
    eventos: tiposEvento.map((t) => ({ tipo: t.tipo, gravedad: t.gravedad, n: t._count })).sort((a, b) => b.n - a.n),
    porDia, empresasProblema: empresasProblema.map((e) => ({ empresaId: e.empresaId, nombre: nombres.get(e.empresaId) || `Empresa #${e.empresaId}`, n: e._count })),
  };
}

/** @param {{ dias?, resultado?, ruta?, empresaId?, soloProblemas?, pagina? }} f */
async function listarTurnos(f = {}, db = prisma) {
  const where = { createdAt: { gte: desdeDias(f.dias || 7) }, prueba: false };
  if (RESULTADOS.includes(f.resultado)) where.resultado = f.resultado;
  else if (f.soloProblemas) where.resultado = { in: ['ERROR', 'SIN_RESPUESTA'] };
  if (RUTAS.includes(f.ruta)) where.ruta = f.ruta;
  if (Number(f.empresaId) > 0) where.empresaId = Number(f.empresaId);
  const pagina = Math.max(1, Number(f.pagina) || 1);
  const [total, filas] = await Promise.all([
    db.turnoIA.count({ where }),
    db.turnoIA.findMany({ where, orderBy: { id: 'desc' }, skip: (pagina - 1) * POR_PAGINA, take: POR_PAGINA, include: { empresa: { select: { nombre: true } }, _count: { select: { eventos: true } } } }),
  ]);
  return { total, pagina, paginas: Math.max(1, Math.ceil(total / POR_PAGINA)), filas };
}

async function detalleTurno(id, db = prisma) {
  const turno = await db.turnoIA.findUnique({ where: { id: Number(id) }, include: { empresa: { select: { id: true, nombre: true } }, eventos: { orderBy: { id: 'asc' } } } });
  if (!turno) return null;
  const usos = await db.usoIA.findMany({ where: { turnoId: turno.id }, orderBy: { id: 'asc' } });
  return { turno, usos };
}

module.exports = { RESULTADOS, RUTAS, POR_PAGINA, resumen, listarTurnos, detalleTurno };
