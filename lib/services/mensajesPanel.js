'use strict';
// lib/services/mensajesPanel.js
//
// Lo que el panel "Mensajes del agente" y "Datos de mi negocio" hacen en la base
// (fase M2, docs/10-plan-mensajes-prefabricados.md):
//   - cambiar el texto de un mensaje de fabrica (y volver al original),
//   - crear mensajes PROPIOS (hasta el tope del plan: planes.maxMensajesPropios),
//   - cargar datos añadibles del negocio ({{dato.garantia}}).
// Todo lo que se guarda pasa por validarTextoDelNegocio: solo variables permitidas,
// bloques cerrados y largo maximo. El motor (mensajes.js) cae al texto de fabrica
// si algo guardado no sirve, asi que un error aca nunca deja al cliente sin respuesta.

const { prisma } = require('../db');
const { CATALOGO, obtenerFabrica } = require('./mensajesBase');
const { validarTextoDelNegocio, invalidar } = require('./mensajes');

const TOPE_POR_DEFECTO = 30;
const MAX_DATOS = 60;

class ErrorPanel extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'MENSAJES'; }
}

const slug = (t, max = 30) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);

async function topePropios(empresaId) {
  const s = await prisma.suscripcion.findUnique({ where: { empresaId }, include: { plan: true } });
  return (s && s.plan && s.plan.maxMensajesPropios) || TOPE_POR_DEFECTO;
}

async function datosExistentes(empresaId) {
  return (await prisma.datoNegocio.findMany({ where: { empresaId }, select: { clave: true } })).map((d) => d.clave);
}

function revisar(texto, permitidas, existentes) {
  const problemas = validarTextoDelNegocio(texto, permitidas, { datosExistentes: existentes });
  if (problemas.length) throw new ErrorPanel(problemas.join(' '));
}

/** Todo lo que muestra la pantalla de mensajes. */
async function listar(empresaId) {
  const [filas, datos, tope] = await Promise.all([
    prisma.mensajeAgente.findMany({ where: { empresaId } }),
    prisma.datoNegocio.findMany({ where: { empresaId }, orderBy: { etiqueta: 'asc' } }),
    topePropios(empresaId),
  ]);
  const porClave = new Map(filas.map((f) => [f.clave, f]));
  const grupos = new Map();
  for (const f of CATALOGO) {
    const fila = porClave.get(f.clave);
    const g = grupos.get(f.categoria) || [];
    g.push({
      clave: f.clave, descripcion: f.descripcion, textoFabrica: f.texto,
      textoActual: fila && fila.activo ? fila.texto : f.texto, personalizado: Boolean(fila && fila.activo),
      variables: Object.keys(f.variables || {}), ejemplo: f.ejemplo || {},
    });
    grupos.set(f.categoria, g);
  }
  const propios = filas.filter((f) => !obtenerFabrica(f.clave));
  return {
    grupos: [...grupos.entries()].map(([categoria, mensajes]) => ({ categoria, mensajes })),
    propios, datos, limite: { usados: propios.length, tope },
  };
}

async function guardarTexto(empresaId, clave, texto) {
  const f = obtenerFabrica(clave);
  if (!f) throw new ErrorPanel('Ese mensaje no existe.');
  const limpio = String(texto || '').trim();
  revisar(limpio, Object.keys(f.variables || {}), await datosExistentes(empresaId));
  if (limpio === f.texto) return restaurar(empresaId, clave);
  await prisma.mensajeAgente.upsert({
    where: { empresaId_clave: { empresaId, clave } },
    create: { empresaId, clave, categoria: f.categoria, descripcion: f.descripcion, texto: limpio, origen: 'PERSONALIZADO' },
    update: { texto: limpio, activo: true },
  });
  invalidar(empresaId);
}

async function restaurar(empresaId, clave) {
  await prisma.mensajeAgente.deleteMany({ where: { empresaId, clave } });
  invalidar(empresaId);
}

/** Mensaje propio: el negocio lo escribe, la IA lo puede elegir leyendo su descripcion. */
async function crearPropio(empresaId, { nombre, descripcion, texto }) {
  const n = String(nombre || '').trim();
  const d = String(descripcion || '').trim();
  const t = String(texto || '').trim();
  if (n.length < 3) throw new ErrorPanel('Ponele un nombre al mensaje (mínimo 3 letras).');
  if (d.length < 10) throw new ErrorPanel('Explicá cuándo se usa (mínimo 10 letras): es lo que lee el agente para elegirlo.');
  const base = `propio_${slug(n)}`;
  if (base === 'propio_') throw new ErrorPanel('El nombre necesita letras o números.');
  revisar(t, [], await datosExistentes(empresaId));
  const [usados, tope] = await Promise.all([
    prisma.mensajeAgente.count({ where: { empresaId, origen: 'PROPIO' } }),
    topePropios(empresaId),
  ]);
  if (usados >= tope) throw new ErrorPanel(`Llegaste al tope de ${tope} mensajes propios de tu plan. Borrá alguno o mejorá tu plan.`);
  let clave = base; let i = 2;
  while (await prisma.mensajeAgente.findUnique({ where: { empresaId_clave: { empresaId, clave } } }) || obtenerFabrica(clave)) clave = `${base}_${i++}`;
  await prisma.mensajeAgente.create({ data: { empresaId, clave, categoria: 'Propios', descripcion: d, texto: t, origen: 'PROPIO', variables: [] } });
  invalidar(empresaId);
  return clave;
}

async function editarPropio(empresaId, clave, { descripcion, texto, activo }) {
  const fila = await prisma.mensajeAgente.findUnique({ where: { empresaId_clave: { empresaId, clave } } });
  if (!fila || fila.origen !== 'PROPIO') throw new ErrorPanel('Ese mensaje no existe.');
  const data = {};
  if (descripcion !== undefined) {
    if (String(descripcion).trim().length < 10) throw new ErrorPanel('Explicá cuándo se usa (mínimo 10 letras).');
    data.descripcion = String(descripcion).trim();
  }
  if (texto !== undefined) {
    revisar(String(texto).trim(), [], await datosExistentes(empresaId));
    data.texto = String(texto).trim();
  }
  if (activo !== undefined) data.activo = Boolean(activo);
  await prisma.mensajeAgente.update({ where: { id: fila.id }, data });
  invalidar(empresaId);
}

async function eliminarPropio(empresaId, clave) {
  await prisma.mensajeAgente.deleteMany({ where: { empresaId, clave, origen: 'PROPIO' } });
  invalidar(empresaId);
}

// ------------------------------------------------------------ datos del negocio

async function guardarDato(empresaId, { etiqueta, valor, clave }) {
  const e = String(etiqueta || '').trim();
  const v = String(valor || '').trim();
  if (e.length < 2) throw new ErrorPanel('Ponele un nombre al dato (ej. "Garantía").');
  if (!v) throw new ErrorPanel('El dato necesita un valor.');
  if (v.length > 500) throw new ErrorPanel('El valor es demasiado largo (máximo 500 caracteres).');
  const k = clave || slug(e);
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(k)) throw new ErrorPanel('El nombre del dato necesita letras (sin símbolos).');
  const total = await prisma.datoNegocio.count({ where: { empresaId } });
  const ya = await prisma.datoNegocio.findUnique({ where: { empresaId_clave: { empresaId, clave: k } } });
  if (!ya && total >= MAX_DATOS) throw new ErrorPanel(`Máximo ${MAX_DATOS} datos.`);
  await prisma.datoNegocio.upsert({
    where: { empresaId_clave: { empresaId, clave: k } },
    create: { empresaId, clave: k, etiqueta: e, valor: v }, update: { etiqueta: e, valor: v },
  });
  invalidar(empresaId);
  return k;
}

async function eliminarDato(empresaId, clave) {
  const usado = await prisma.mensajeAgente.findFirst({ where: { empresaId, texto: { contains: `{{dato.${clave}}}` } } });
  if (usado) throw new ErrorPanel(`El mensaje "${usado.clave}" usa este dato. Cambiá ese mensaje primero.`);
  await prisma.datoNegocio.deleteMany({ where: { empresaId, clave } });
  invalidar(empresaId);
}

/** Lo que el agente no supo contestar (pasó con una persona): las ultimas, con la pregunta del cliente. */
async function sinRespuesta(empresaId, limite = 50) {
  return prisma.notificacion.findMany({ where: { empresaId, tipo: 'SIN_RESPUESTA' }, orderBy: { createdAt: 'desc' }, take: limite });
}

module.exports = {
  ErrorPanel, listar, guardarTexto, restaurar, crearPropio, editarPropio, eliminarPropio,
  guardarDato, eliminarDato, sinRespuesta, topePropios, slug,
};
