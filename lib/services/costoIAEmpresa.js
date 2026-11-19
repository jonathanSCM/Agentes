'use strict';
// lib/services/costoIAEmpresa.js
//
// DETALLE DEL COSTO DE IA DE UNA EMPRESA: no solo cuanto, sino EN QUE se fue.
//   - Por tipo de token: texto enviado a la IA (nuevo), texto reutilizado (cache, mas barato) y respuesta generada (salida).
//   - Para que se uso: respuesta principal, continuacion tras usar herramientas, correccion automatica del sistema, busqueda semantica.
//   - Por herramienta: en los turnos donde el agente uso cada herramienta (desde que existe el historial de turnos).
//   - Por modelo, por dia y los turnos mas caros.
// Solo lectura. El costo es el estimado con la tarifa vigente de cada fecha; si una llamada no tiene tarifa, queda sin costo (no se inventa).

const { prisma } = require('../db');

const ETQ_ETAPA = {
  PRINCIPAL: { nombre: 'Respuesta principal', ayuda: 'La primera llamada de cada turno: entender al cliente y decidir qué hacer.' },
  CONTINUACION: { nombre: 'Continuación tras usar herramientas', ayuda: 'Después de buscar productos, armar el carrito, etc., la IA vuelve a leer el resultado para redactar la respuesta.' },
  CORRECCION: { nombre: 'Corrección automática del sistema', ayuda: 'El sistema detectó un error en la respuesta y pidió rehacerla. Es costo nuestro, no del cliente.' },
  BUSQUEDA: { nombre: 'Búsqueda semántica', ayuda: 'Entender qué producto busca el cliente aunque use otras palabras (embeddings).' },
};
const ETQ_HERRAMIENTA = {
  actualizar_datos_lead: 'Recordar datos del cliente', mostrar_productos: 'Mostrar productos', ver_mas_productos: 'Ver más productos', enviar_fotos_producto: 'Enviar fotos de un producto',
  buscar_producto: 'Buscar un producto', agregar_al_carrito: 'Agregar al carrito', ver_carrito: 'Ver el carrito', quitar_del_carrito: 'Quitar del carrito',
  cambiar_cantidad_carrito: 'Cambiar cantidad en el carrito', confirmar_pedido: 'Confirmar el pedido', crear_pedido: 'Crear el pedido', derivar_a_asesor: 'Pasar con una persona',
  mostrar_categorias: 'Mostrar categorías', mostrar_tarjeta_categoria: 'Mostrar la tarjeta de una categoría',
};
const nombreHerramienta = (t) => ETQ_HERRAMIENTA[t] || String(t).replace(/_/g, ' ');

const r6 = (n) => Math.round(Number(n || 0) * 1e6) / 1e6;

/** @param {number} empresaId @param {{ dias?: number }} opt */
async function detalle(empresaId, { dias = 30 } = {}, db = prisma) {
  const d = [7, 30, 90].includes(Number(dias)) ? Number(dias) : 30;
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000);

  const [empresa, partes, etapas, modelos, porDia, herramientas, caros, convs, turnosTotal, tieneTurnos] = await Promise.all([
    db.empresa.findUnique({ where: { id: empresaId }, select: { id: true, nombre: true } }),
    // Costo por tipo de token (usa la tarifa que se aplico a cada llamada).
    db.$queryRaw`SELECT COUNT(*)::int AS llamadas,
                        COALESCE(SUM(u."promptTokens" - u."cachedTokens"), 0)::float AS "entradaTok", COALESCE(SUM(u."cachedTokens"), 0)::float AS "cacheTok", COALESCE(SUM(u."completionTokens"), 0)::float AS "salidaTok",
                        COALESCE(SUM((u."promptTokens" - u."cachedTokens") * t."entradaUsdPorM" / 1000000), 0)::float AS "entradaUsd",
                        COALESCE(SUM(u."cachedTokens" * t."cacheUsdPorM" / 1000000), 0)::float AS "cacheUsd",
                        COALESCE(SUM(u."completionTokens" * t."salidaUsdPorM" / 1000000), 0)::float AS "salidaUsd",
                        COALESCE(SUM(u."costoUsd"), 0)::float AS total, COUNT(*) FILTER (WHERE u."costoUsd" IS NULL)::int AS "sinTarifa"
                 FROM "usos_ia" u LEFT JOIN "tarifas_ia" t ON t."id" = u."tarifaId"
                 WHERE u."empresaId" = ${empresaId} AND u."createdAt" >= ${desde} AND u."estado" = 'COMPLETADA'`,
    db.$queryRaw`SELECT CASE WHEN "servicio" = 'embedding' THEN 'BUSQUEDA' WHEN "proposito" = 'reintento_forzado' THEN 'CORRECCION' WHEN "vuelta" > 0 THEN 'CONTINUACION' ELSE 'PRINCIPAL' END AS etapa,
                        COUNT(*)::int AS llamadas, COALESCE(SUM("promptTokens" - "cachedTokens"), 0)::float AS "entradaTok", COALESCE(SUM("cachedTokens"), 0)::float AS "cacheTok",
                        COALESCE(SUM("completionTokens"), 0)::float AS "salidaTok", COALESCE(SUM("costoUsd"), 0)::float AS usd
                 FROM "usos_ia" WHERE "empresaId" = ${empresaId} AND "createdAt" >= ${desde} AND "estado" = 'COMPLETADA' GROUP BY 1`,
    db.$queryRaw`SELECT "proveedor", "modelo", COUNT(*)::int AS llamadas, COALESCE(SUM("promptTokens" + "completionTokens"), 0)::float AS tokens, COALESCE(SUM("costoUsd"), 0)::float AS usd
                 FROM "usos_ia" WHERE "empresaId" = ${empresaId} AND "createdAt" >= ${desde} AND "estado" = 'COMPLETADA' GROUP BY 1, 2 ORDER BY 5 DESC`,
    db.$queryRaw`SELECT ((("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz')::date)::text AS dia, COUNT(*)::int AS llamadas,
                        COALESCE(SUM("promptTokens" + "completionTokens"), 0)::float AS tokens, COALESCE(SUM("costoUsd"), 0)::float AS usd
                 FROM "usos_ia" WHERE "empresaId" = ${empresaId} AND "createdAt" >= ${desde} AND "estado" = 'COMPLETADA' GROUP BY 1 ORDER BY 1 DESC`,
    // Por herramienta: costo de los turnos donde se uso (un turno con dos herramientas cuenta en ambas).
    db.$queryRaw`WITH uso AS (SELECT DISTINCT e."turnoId", e."detalle"->>'tool' AS tool FROM "ia_eventos" e WHERE e."empresaId" = ${empresaId} AND e."tipo" = 'herramienta' AND e."createdAt" >= ${desde} AND e."turnoId" IS NOT NULL AND e."detalle"->>'tool' IS NOT NULL),
                      costo AS (SELECT "turnoId", SUM("costoUsd") AS usd, SUM("promptTokens" + "completionTokens") AS tokens, COUNT(*) AS llamadas FROM "usos_ia" WHERE "turnoId" IS NOT NULL AND "estado" = 'COMPLETADA' GROUP BY 1)
                 SELECT uso.tool, COUNT(*)::int AS turnos, COALESCE(SUM(costo.usd), 0)::float AS usd, COALESCE(SUM(costo.tokens), 0)::float AS tokens, COALESCE(SUM(costo.llamadas), 0)::int AS llamadas
                 FROM uso LEFT JOIN costo ON costo."turnoId" = uso."turnoId" GROUP BY 1 ORDER BY 3 DESC`,
    db.$queryRaw`SELECT t."id", t."createdAt", t."resultado", t."llamadasIA", (t."tokensEntrada" + t."tokensSalida")::int AS tokens, t."costoUsd"::float AS usd,
                        COALESCE((SELECT string_agg(DISTINCT e."detalle"->>'tool', ', ') FROM "ia_eventos" e WHERE e."turnoId" = t."id" AND e."tipo" = 'herramienta'), '') AS herramientas
                 FROM "ia_turnos" t WHERE t."empresaId" = ${empresaId} AND t."createdAt" >= ${desde} AND t."prueba" = false AND t."costoUsd" IS NOT NULL ORDER BY t."costoUsd" DESC LIMIT 10`,
    db.$queryRaw`SELECT COUNT(DISTINCT "conversacionId")::int AS n FROM "usos_ia" WHERE "empresaId" = ${empresaId} AND "createdAt" >= ${desde} AND "estado" = 'COMPLETADA' AND "servicio" = 'chat' AND "conversacionId" IS NOT NULL`,
    db.turnoIA.count({ where: { empresaId, createdAt: { gte: desde }, prueba: false, llamadasIA: { gt: 0 } } }),
    db.turnoIA.count({ where: { empresaId } }),
  ]);
  if (!empresa) return null;

  const p = partes[0];
  const total = p.total || 0;
  const pct = (usd) => (total > 0 ? Math.round((usd / total) * 1000) / 10 : 0);
  const porToken = [
    { clave: 'entrada', nombre: 'Texto enviado a la IA', ayuda: 'El prompt: las instrucciones, el catálogo, el historial y el mensaje del cliente (lo que no estaba en caché).', tokens: p.entradaTok, usd: r6(p.entradaUsd), pct: pct(p.entradaUsd) },
    { clave: 'cache', nombre: 'Texto reutilizado (caché)', ayuda: 'Parte del prompt que el proveedor ya tenía guardada: se cobra mucho más barato.', tokens: p.cacheTok, usd: r6(p.cacheUsd), pct: pct(p.cacheUsd) },
    { clave: 'salida', nombre: 'Respuesta generada', ayuda: 'Lo que escribió la IA (la respuesta al cliente y los pedidos de herramientas). Es lo más caro por token.', tokens: p.salidaTok, usd: r6(p.salidaUsd), pct: pct(p.salidaUsd) },
  ];
  const porEtapa = ['PRINCIPAL', 'CONTINUACION', 'CORRECCION', 'BUSQUEDA'].map((k) => {
    const f = etapas.find((x) => x.etapa === k) || { llamadas: 0, entradaTok: 0, cacheTok: 0, salidaTok: 0, usd: 0 };
    return { clave: k, ...ETQ_ETAPA[k], llamadas: f.llamadas, entradaTok: f.entradaTok, cacheTok: f.cacheTok, salidaTok: f.salidaTok, usd: r6(f.usd), pct: pct(f.usd) };
  }).filter((x) => x.llamadas > 0);

  const nConv = (convs[0] && convs[0].n) || 0;
  return {
    empresa, dias: d, totalUsd: r6(total), llamadas: p.llamadas, sinTarifa: p.sinTarifa, conversaciones: nConv, turnosConIA: turnosTotal,
    costoPorConversacion: nConv > 0 ? r6(total / nConv) : null,
    porToken, porEtapa, modelos: modelos.map((m) => ({ ...m, usd: r6(m.usd), pct: pct(m.usd) })),
    porDia: porDia.map((x) => ({ ...x, usd: r6(x.usd) })),
    herramientas: herramientas.map((h) => ({ tool: h.tool, nombre: nombreHerramienta(h.tool), turnos: h.turnos, usd: r6(h.usd), usdPorTurno: h.turnos ? r6(h.usd / h.turnos) : 0, tokens: h.tokens })),
    masCaros: caros.map((c) => ({ ...c, herramientas: c.herramientas ? c.herramientas.split(', ').map(nombreHerramienta).join(', ') : '' })),
    hayHistorialTurnos: tieneTurnos > 0,
  };
}

module.exports = { ETQ_ETAPA, nombreHerramienta, detalle };
