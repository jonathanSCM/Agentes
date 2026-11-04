'use strict';
// lib/services/mensajes.js
//
// Motor de mensajes prefabricados (plan: docs/10-plan-mensajes-prefabricados.md).
//
// Un mensaje = una plantilla (clave + texto con variables). El texto lo escribe
// el negocio (o viene de fabrica); las variables las completa el BACKEND. La IA
// no escribe palabras: en la fase M1 solo elegira una clave y ids/numeros de
// listas cerradas. Aca vive todo lo necesario para pedir un mensaje y obtener el
// texto final, validado:
//
//   const m = await cargarContexto({ empresa, config });   // una vez por turno
//   m.t('pedir_nombre')                                    // -> "¿A nombre de quién hago el pedido?"
//   m.t('cantidad_ya_lleva', { cantidad: 2, carrito })     // -> variables del backend
//   m.render('pedido_creado', {...})                       // -> { texto, clave, origen }
//
// Resolucion: lo que el negocio personalizo o creo (tabla mensajes_agente) manda
// sobre el mensaje de fabrica (mensajesBase.js). Si el texto del negocio esta
// roto (variable que no existe, etc.) se usa el de fabrica y se deja el error en
// el log: un typo de un dueño nunca deja a un cliente sin respuesta.

const { prisma } = require('../db');
const { simboloMoneda } = require('./precios');
const { CATALOGO, obtenerFabrica } = require('./mensajesBase');

const REGISTROS = ['vos', 'tu', 'usted'];
const REGISTRO_POR_DEFECTO = 'vos';
const CACHE_MS = 30 * 1000;
const MAX_TEXTO_VARIABLE = 1000;
const MAX_TEXTO_MENSAJE = 1000;

class ErrorMensaje extends Error {}

// ------------------------------------------------------------- utilidades

/** "{r:Querés|Quieres}" -> la palabra que corresponde al registro. 'usted' usa la 3ª opcion si existe, si no la 2ª. */
function aplicarRegistro(texto, registro) {
  return String(texto).replace(/\{r:([^}]+)\}/g, (_, grupo) => {
    const partes = grupo.split('|');
    if (registro === 'vos') return partes[0];
    if (registro === 'usted') return partes[2] !== undefined ? partes[2] : (partes[1] !== undefined ? partes[1] : partes[0]);
    return partes[1] !== undefined ? partes[1] : partes[0];
  });
}

const hayValor = (v) => v !== undefined && v !== null && v !== '' && v !== false;

// Lo que viene de afuera (nombres de productos, direcciones...) no puede traer sintaxis del motor ni caracteres de control.
function limpiar(valor, max = MAX_TEXTO_VARIABLE) {
  return String(valor)
    .replace(/\{\{|\}\}|\{r:/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, max);
}

function especificacion(spec = {}) {
  const salida = {};
  for (const [nombre, tipoCrudo] of Object.entries(spec)) {
    const opcional = String(tipoCrudo).endsWith('?');
    salida[nombre] = { tipo: String(tipoCrudo).replace('?', ''), opcional };
  }
  return salida;
}

/** Variables que usa un texto: { simples: ['carrito'], datos: ['dato.garantia'], ... }. */
function variablesDeTexto(texto) {
  const encontradas = new Set();
  for (const m of String(texto).matchAll(/\{\{\s*#?\/?\s*([\w.]+)\s*\}\}/g)) encontradas.add(m[1]);
  return [...encontradas];
}

const PREFIJOS_DEL_SISTEMA = ['dato.', 'vocab.', 'negocio'];
const esDelSistema = (nombre) => PREFIJOS_DEL_SISTEMA.some((p) => nombre === p || nombre.startsWith(p));

// ------------------------------------------------------------- renderizado

function formatear(valor, tipo, ctx, nombre, clave) {
  switch (tipo) {
    case 'numero': {
      const n = Number(valor);
      if (!Number.isFinite(n)) throw new ErrorMensaje(`${clave}: "${nombre}" debe ser un número`);
      return String(n);
    }
    case 'monto': {
      const n = Number(valor);
      if (!Number.isFinite(n)) throw new ErrorMensaje(`${clave}: "${nombre}" debe ser un monto`);
      return `${simboloMoneda(ctx.moneda || 'BOB')} ${n.toFixed(2)}`;
    }
    case 'lista':
      return limpiar(Array.isArray(valor) ? valor.join('\n') : valor, 8000);
    default:
      return limpiar(valor);
  }
}

/**
 * Convierte un texto con variables en el mensaje final.
 * @param texto  texto ya elegido (con {{variables}} y {r:..})
 * @param spec   { nombre: tipo | 'tipo?' } de las variables que el BACKEND puede pasar
 */
function renderizarTexto(texto, spec, vars, ctx, clave) {
  const especificaciones = especificacion(spec);
  const resolver = (nombre) => {
    if (nombre === 'negocio' || nombre === 'negocio.nombre') return { valor: ctx.negocio && ctx.negocio.nombre, tipo: 'texto', opcional: false };
    // Un dato del negocio que falta (o esta oculto) NO se deja en blanco: el mensaje no se puede armar.
    if (nombre.startsWith('dato.')) return { valor: ctx.datos.get(nombre.slice(5)), tipo: 'texto', opcional: false };
    if (nombre.startsWith('vocab.')) return { valor: (ctx.vocab || {})[nombre.slice(6)], tipo: 'texto', opcional: false };
    const e = especificaciones[nombre];
    if (!e) throw new ErrorMensaje(`${clave}: la variable "${nombre}" no existe en este mensaje`);
    return { valor: vars[nombre], tipo: e.tipo, opcional: e.opcional };
  };

  let salida = aplicarRegistro(texto, ctx.registro);
  // Bloques condicionales: {{#var}}...{{/var}}
  salida = salida.replace(/\{\{#\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (_, nombre, dentro) => (hayValor(resolver(nombre).valor) ? dentro : ''));
  if (/\{\{[#/]/.test(salida)) throw new ErrorMensaje(`${clave}: hay un bloque {{#...}} sin cerrar`);
  // Variables
  salida = salida.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, nombre) => {
    const { valor, tipo, opcional } = resolver(nombre);
    if (!hayValor(valor)) {
      if (opcional) return '';
      throw new ErrorMensaje(`${clave}: falta el valor de "${nombre}"`);
    }
    return formatear(valor, tipo, ctx, nombre, clave);
  });
  salida = salida.trim();
  if (!salida) throw new ErrorMensaje(`${clave}: el mensaje quedó vacío`);
  if (salida.length > MAX_TEXTO_MENSAJE * 4) throw new ErrorMensaje(`${clave}: el mensaje es demasiado largo`);
  return salida;
}

// ------------------------------------------------------------ contexto

function textosDe(fila) {
  return [fila.texto, ...(Array.isArray(fila.variantes) ? fila.variantes : [])].filter((t) => typeof t === 'string' && t.trim());
}

function especificacionDeFila(fila, fabrica) {
  if (fabrica) return fabrica.variables;
  const spec = {};
  for (const v of Array.isArray(fila.variables) ? fila.variables : []) spec[v.nombre] = `${v.tipo || 'texto'}${v.obligatoria === false ? '?' : ''}`;
  return spec;
}

/**
 * Contexto de mensajes de UN negocio. Sin base de datos: recibe las filas ya cargadas.
 * @param overrides filas de mensajes_agente   @param datos filas de datos_negocio
 */
function crearContexto({ registro = REGISTRO_POR_DEFECTO, overrides = [], datos = [], negocio = {}, moneda = 'BOB', vocab = {}, semilla = 0 } = {}) {
  const ctx = {
    registro: REGISTROS.includes(registro) ? registro : REGISTRO_POR_DEFECTO,
    negocio, moneda, vocab, semilla,
    datos: new Map(datos.filter((d) => d.visible !== false).map((d) => [d.clave, d.valor])),
  };
  const filas = new Map(overrides.filter((o) => o.activo !== false).map((o) => [o.clave, o]));

  function render(clave, vars = {}) {
    const fabrica = obtenerFabrica(clave);
    const fila = filas.get(clave);
    if (!fabrica && !fila) throw new ErrorMensaje(`No existe el mensaje "${clave}"`);

    if (fila) {
      try {
        const textos = textosDe(fila);
        const elegido = textos[Math.abs(ctx.semilla) % textos.length];
        return { texto: renderizarTexto(elegido, especificacionDeFila(fila, fabrica), vars, ctx, clave), clave, origen: 'negocio' };
      } catch (err) {
        if (!(err instanceof ErrorMensaje) || !fabrica) throw err;
        console.error(`[mensajes] el texto del negocio para "${clave}" no sirve (${err.message}); se usa el de fábrica`);
      }
    }
    const textos = textosDe(fabrica);
    const elegido = textos[Math.abs(ctx.semilla) % textos.length];
    return { texto: renderizarTexto(elegido, fabrica.variables, vars, ctx, clave), clave, origen: 'fabrica' };
  }

  return {
    registro: ctx.registro,
    render,
    t: (clave, vars) => render(clave, vars).texto,
    propios: () => [...filas.values()].filter((f) => !obtenerFabrica(f.clave)).map((f) => ({ clave: f.clave, descripcion: f.descripcion || '' })),
    existe: (clave) => Boolean(obtenerFabrica(clave) || filas.has(clave)),
    claves: () => [...new Set([...CATALOGO.map((m) => m.clave), ...filas.keys()])],
  };
}

/** Contexto sin negocio: textos de fabrica en "vos". Para pruebas y para cuando todavia no hay empresa. */
const porDefecto = crearContexto({ negocio: { nombre: 'la tienda' } });

// Cache por empresa (30 s): los mensajes casi no cambian y se piden en cada turno.
const cache = new Map();

function invalidar(empresaId) {
  if (empresaId === undefined) cache.clear(); else cache.delete(empresaId);
}

async function filasDeLaEmpresa(empresaId) {
  const c = cache.get(empresaId);
  if (c && Date.now() - c.en < CACHE_MS) return c;
  const [overrides, datos] = await Promise.all([
    prisma.mensajeAgente.findMany({ where: { empresaId, activo: true } }),
    prisma.datoNegocio.findMany({ where: { empresaId, visible: true } }),
  ]);
  const nuevo = { en: Date.now(), overrides, datos };
  cache.set(empresaId, nuevo);
  return nuevo;
}

/**
 * Contexto de mensajes para un turno.
 * @param empresa { id, nombre, marca, moneda }  @param config AgenteConfig (registro)
 * Nunca lanza: si la base falla, se usan los mensajes de fabrica.
 */
async function cargarContexto({ empresa, config, vocab = {}, semilla = 0 }) {
  let filas = { overrides: [], datos: [] };
  try {
    if (empresa && empresa.id) filas = await filasDeLaEmpresa(empresa.id);
  } catch (err) {
    console.error(`[mensajes] no se pudieron leer los mensajes del negocio: ${err.message}`);
  }
  return crearContexto({
    registro: (config && config.registro) || REGISTRO_POR_DEFECTO,
    overrides: filas.overrides, datos: filas.datos,
    negocio: { nombre: (empresa && (empresa.marca || empresa.nombre)) || 'la tienda' },
    moneda: (empresa && empresa.moneda) || 'BOB', vocab, semilla,
  });
}

// ------------------------------------------------------------ validacion (panel)

/**
 * Revisa un texto que escribio el negocio ANTES de guardarlo.
 * @param variablesPermitidas nombres que ese mensaje puede usar (las suyas + datos del negocio)
 * @returns {string[]} problemas legibles; vacio = se puede guardar
 */
function validarTextoDelNegocio(texto, variablesPermitidas = [], { datosExistentes = [] } = {}) {
  const problemas = [];
  const t = String(texto || '');
  if (!t.trim()) return ['El mensaje no puede estar vacío.'];
  if (t.length > MAX_TEXTO_MENSAJE) problemas.push(`El mensaje es demasiado largo (máximo ${MAX_TEXTO_MENSAJE} caracteres).`);
  const abiertos = [...t.matchAll(/\{\{#\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
  const cerrados = [...t.matchAll(/\{\{\/\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
  if (abiertos.sort().join() !== cerrados.sort().join()) problemas.push('Hay un bloque {{#...}} sin cerrar.');
  for (const nombre of variablesDeTexto(t)) {
    if (nombre.startsWith('dato.')) {
      if (!datosExistentes.includes(nombre.slice(5))) problemas.push(`El dato "${nombre.slice(5)}" no existe en "Datos de mi negocio".`);
    } else if (!esDelSistema(nombre) && !variablesPermitidas.includes(nombre)) {
      problemas.push(`La variable {{${nombre}}} no se puede usar en este mensaje.`);
    }
  }
  return problemas;
}

module.exports = {
  REGISTROS, REGISTRO_POR_DEFECTO, ErrorMensaje,
  crearContexto, cargarContexto, porDefecto, invalidar,
  aplicarRegistro, renderizarTexto, variablesDeTexto, validarTextoDelNegocio,
  CATALOGO,
};
