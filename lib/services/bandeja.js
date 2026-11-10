'use strict';
// lib/services/bandeja.js
//
// La BANDEJA de conversaciones (estilo CRM): la lista de la izquierda con una fila por cliente,
// su ultimo mensaje, no leidos y quien lo atiende. Todo por empresa (agenteIds de la empresa).
//
//   - Un cliente que vuelve despues de 6 h genera una Conversacion nueva (se cobra aparte): en la
//     lista se agrupan por telefono (una fila por cliente).
//   - "No leidos" = mensajes del CLIENTE posteriores a conversaciones.leidoAt.
//   - Filtros: todas · no leidas · con persona (la atiende un humano o pidio hablar con uno).

const { prisma } = require('../db');

const FILTROS = ['todas', 'no_leidas', 'persona'];
const LIMITE_CONVERSACIONES = 300;

// Colores del avatar: salen de la paleta del panel (morado marca, menta, lila y 3 de apoyo).
const COLORES_AVATAR = ['#8b5cf6', '#2fe3a6', '#c084fc', '#f59e0b', '#38bdf8', '#fb7185'];

/** Color estable por contacto (mismo telefono, mismo color). */
function colorDe(clave) {
  let h = 0;
  for (const c of String(clave || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORES_AVATAR[h % COLORES_AVATAR.length];
}

/** "Ana Pérez" -> "AP"; sin nombre, el telefono -> "#". */
function inicialesDe(nombre, telefono) {
  const limpio = String(nombre || '').trim();
  if (!limpio) return '#';
  const p = limpio.split(/\s+/).filter(Boolean);
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/** Texto corto del ultimo mensaje para la lista (con su tipo si no es texto). */
function previewDe(m) {
  if (!m) return { texto: '', tipo: null };
  if (m.mediaTipo === 'imagen') return { texto: m.contenido || 'Foto', tipo: 'imagen' };
  if (m.mediaTipo === 'audio') return { texto: m.contenido || 'Nota de voz', tipo: 'audio' };
  if (m.mediaTipo === 'video') return { texto: m.contenido || 'Video', tipo: 'video' };
  if (m.mediaTipo === 'documento') return { texto: (m.meta && m.meta.nombre) || m.contenido || 'Documento', tipo: 'documento' };
  if (m.mediaTipo === 'ubicacion') return { texto: 'Ubicación', tipo: 'ubicacion' };
  return { texto: String(m.contenido || '').replace(/\s+/g, ' ').trim(), tipo: null };
}

/** { conversacionId -> no leidos } de las conversaciones de la empresa (una sola consulta). */
async function noLeidosPorConversacion(agenteIds) {
  if (!agenteIds.length) return new Map();
  const filas = await prisma.$queryRaw`
    SELECT c."id" AS "id", COUNT(m."id")::int AS "n"
    FROM "conversaciones" c
    JOIN "mensajes" m ON m."conversacionId" = c."id"
    WHERE c."agenteId" = ANY(${agenteIds}::int[])
      AND m."rol" = 'CLIENTE'
      AND m."createdAt" > COALESCE(c."leidoAt", TIMESTAMP 'epoch')
    GROUP BY c."id"`;
  return new Map(filas.map((f) => [f.id, f.n]));
}

/** Cuantos CLIENTES tienen mensajes sin leer (el contador del menu lateral). */
async function contarNoLeidos(agenteIds) {
  const por = await noLeidosPorConversacion(agenteIds);
  if (!por.size) return 0;
  const convs = await prisma.conversacion.findMany({ where: { id: { in: [...por.keys()] } }, select: { telefonoCliente: true } });
  return new Set(convs.map((c) => c.telefonoCliente)).size;
}

/**
 * La lista de la izquierda.
 * @param {number} empresaId
 * @param {number[]} agenteIds
 * @param {{ filtro?: string, q?: string }} [opciones]
 */
async function listar(empresaId, agenteIds, { filtro = 'todas', q = '' } = {}) {
  if (!agenteIds.length) return [];
  const [conversaciones, noLeidos] = await Promise.all([
    prisma.conversacion.findMany({
      where: { agenteId: { in: agenteIds } },
      orderBy: { ultimoMensajeAt: 'desc' },
      take: LIMITE_CONVERSACIONES,
      include: { mensajes: { orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
    noLeidosPorConversacion(agenteIds),
  ]);
  const telefonos = [...new Set(conversaciones.map((c) => c.telefonoCliente))];
  const clientes = telefonos.length
    ? await prisma.clienteFinal.findMany({
      where: { empresaId, telefono: { in: telefonos } },
      select: { telefono: true, nombre: true, nombrePerfil: true, estadoLead: true },
    })
    : [];
  const clientePorTel = new Map(clientes.map((c) => [c.telefono, c]));

  // Una fila por cliente: la primera aparicion es la sesion mas reciente (ya viene ordenado).
  const filas = new Map();
  for (const c of conversaciones) {
    const cf = clientePorTel.get(c.telefonoCliente);
    if (!filas.has(c.telefonoCliente)) {
      const nombre = (cf && (cf.nombre || cf.nombrePerfil)) || null;
      const ultimo = previewDe(c.mensajes[0]);
      filas.set(c.telefonoCliente, {
        telefono: c.telefonoCliente,
        nombre,
        titulo: nombre || c.telefonoCliente,
        iniciales: inicialesDe(nombre, c.telefonoCliente),
        color: colorDe(c.telefonoCliente),
        ultimoTexto: ultimo.texto,
        ultimoTipo: ultimo.tipo,
        ultimoAutor: c.mensajes[0] ? c.mensajes[0].rol : null,
        ultimoAt: c.ultimoMensajeAt,
        humano: c.modo === 'HUMANO',
        pidioPersona: Boolean(cf && cf.estadoLead === 'DERIVADO_A_ASESOR'),
        noLeidos: 0,
        sesiones: 0,
        conversacionIds: [],
      });
    }
    const f = filas.get(c.telefonoCliente);
    f.noLeidos += noLeidos.get(c.id) || 0;
    f.sesiones += 1;
    f.conversacionIds.push(c.id);
  }

  let lista = [...filas.values()];
  const texto = String(q || '').trim().toLowerCase();
  if (texto) {
    const digitos = texto.replace(/\D/g, '');
    lista = lista.filter((f) => f.titulo.toLowerCase().includes(texto) || (digitos && f.telefono.includes(digitos)) || f.ultimoTexto.toLowerCase().includes(texto));
  }
  if (filtro === 'no_leidas') lista = lista.filter((f) => f.noLeidos > 0);
  else if (filtro === 'persona') lista = lista.filter((f) => f.humano || f.pidioPersona);
  return lista;
}

/** Marca como leidas todas las conversaciones de ese cliente (de la empresa). */
async function marcarLeida(agenteIds, telefono, ahora = new Date()) {
  if (!agenteIds.length) return 0;
  const r = await prisma.conversacion.updateMany({ where: { agenteId: { in: agenteIds }, telefonoCliente: telefono }, data: { leidoAt: ahora } });
  return r.count;
}

/** Datos de la ficha del contacto (derecha): lo que se sabe del cliente y sus pedidos. */
async function ficha(empresaId, telefono) {
  const cliente = await prisma.clienteFinal.findFirst({ where: { empresaId, telefono } });
  const pedidos = cliente
    ? await prisma.pedido.findMany({ where: { empresaId, clienteId: cliente.id }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, total: true, estado: true, createdAt: true } })
    : [];
  const totalComprado = pedidos.filter((p) => p.estado !== 'CANCELADO').reduce((s, p) => s + Number(p.total), 0);
  return { cliente, pedidos, totalComprado };
}

module.exports = { FILTROS, colorDe, inicialesDe, previewDe, noLeidosPorConversacion, contarNoLeidos, listar, marcarLeida, ficha };
