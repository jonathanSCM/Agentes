'use strict';
// lib/services/topeIA.js
//
// Topes de gasto de IA, para que un cliente en bucle (o abusando) o una sola
// empresa no se coman el saldo compartido de todos. Al pasarse del tope el
// turno sigue en modo sin IA (modoSinIA.js): nunca se corta la atencion.
//
//  - Por cliente: maximo de llamadas a la IA por hora (IA_MAX_LLAMADAS_CLIENTE_HORA, 60).
//  - Por empresa: maximo de tokens por dia (IA_TOPE_TOKENS_DIA_EMPRESA; 0 = sin tope).

const { prisma } = require('../db');

// Bajo el runner de pruebas (node --test) el tope por cliente viene apagado: las
// pruebas largas usan un solo telefono. Cada prueba que lo necesita lo prende.
const enPruebas = Boolean(process.env.NODE_TEST_CONTEXT);

const cfg = {
  maxLlamadasClienteHora: Number(process.env.IA_MAX_LLAMADAS_CLIENTE_HORA || (enPruebas ? 0 : 60)),
  topeTokensDiaEmpresa: Number(process.env.IA_TOPE_TOKENS_DIA_EMPRESA || 0),
  cacheMs: 60 * 1000,
};

const HORA = 60 * 60 * 1000;
const porCliente = new Map(); // clave -> [timestamps]
const tokensHoy = new Map(); // empresaId -> { dia, tokens, leidoEn }

function reiniciar() { porCliente.clear(); tokensHoy.clear(); }
function configurar(c) { Object.assign(cfg, c || {}); }

const diaDe = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

async function tokensDelDia(empresaId, ahora) {
  const c = tokensHoy.get(empresaId);
  if (c && c.dia === diaDe(ahora) && ahora - c.leidoEn < cfg.cacheMs) return c.tokens;
  const r = await prisma.usoIA.aggregate({
    where: { empresaId, createdAt: { gte: new Date(diaDe(ahora)) } },
    _sum: { promptTokens: true, completionTokens: true },
  });
  const tokens = (r._sum.promptTokens || 0) + (r._sum.completionTokens || 0);
  tokensHoy.set(empresaId, { dia: diaDe(ahora), tokens, leidoEn: ahora });
  return tokens;
}

/**
 * ¿Se puede hacer otra llamada a la IA para este cliente/empresa?
 * Cuenta la llamada si se permite. Devuelve { ok, motivo? }. Nunca lanza: ante
 * un fallo de la base de datos deja pasar (el tope no debe tumbar la atencion).
 */
async function revisar({ empresaId, telefono }, ahora = Date.now()) {
  try {
    if (cfg.maxLlamadasClienteHora > 0 && telefono) {
      const clave = `${empresaId}:${telefono}`;
      const recientes = (porCliente.get(clave) || []).filter((t) => ahora - t < HORA);
      if (recientes.length >= cfg.maxLlamadasClienteHora) { porCliente.set(clave, recientes); return { ok: false, motivo: 'TOPE_CLIENTE' }; }
      recientes.push(ahora);
      porCliente.set(clave, recientes);
    }
    if (cfg.topeTokensDiaEmpresa > 0 && empresaId) {
      if ((await tokensDelDia(empresaId, ahora)) >= cfg.topeTokensDiaEmpresa) return { ok: false, motivo: 'TOPE_EMPRESA' };
    }
  } catch (e) {
    console.error(`[tope-ia] no se pudo revisar el tope: ${e.message}`);
  }
  return { ok: true };
}

module.exports = { cfg, revisar, reiniciar, configurar };
