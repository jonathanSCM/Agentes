'use strict';
// lib/services/faq.js
//
// Preguntas frecuentes y horario de atención que el NEGOCIO carga en su panel,
// para que el bot conteste sin IA (0 tokens) y sin inventar. Piezas puras:
//
//   coincideFaq(texto, faq)        -> { pregunta, respuesta } | null
//   formatearHorario(horario)      -> "Lun a Vie 09:00 a 18:00 · Sáb 09:00 a 13:00 · Dom cerrado" | null
//   faqDesdeFormulario(body)       -> lista limpia para guardar
//   horarioDesdeFormulario(body)   -> objeto limpio para guardar (o null si no cargó nada)
//
// La coincidencia es CONSERVADORA: prefiere no contestar (y que lo haga la IA o
// un asesor) a contestar mal. Una respuesta de la FAQ es siempre texto que el
// propio negocio escribió.

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();

const STOP = new Set([
  'que', 'como', 'cual', 'cuales', 'cuanto', 'cuantos', 'cuando', 'donde', 'quien', 'para', 'por', 'con', 'sin', 'del', 'los', 'las', 'una', 'uno', 'unos',
  'unas', 'hay', 'tienen', 'tiene', 'tengo', 'puedo', 'pueden', 'puede', 'quiero', 'quisiera', 'necesito', 'saber', 'favor', 'hola', 'buenas', 'buenos',
  'dias', 'tardes', 'noches', 'gracias', 'ustedes', 'son', 'sus', 'mis', 'esta', 'este', 'esto', 'eso', 'ese', 'esa', 'les', 'nos', 'mas', 'muy', 'solo',
  'ver', 'dar', 'dame', 'dime', 'pregunta', 'consulta', 'tambien', 'algo', 'alguna', 'algun', 'hacen', 'hacer', 'estan', 'esta', 'sera', 'seria',
]);

// Palabras "del tema" de un texto: sin acentos, sin relleno, plurales simples.
function tokens(texto) {
  const out = new Set();
  for (const w of norm(texto).split(' ')) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
  }
  return [...out];
}

const igual = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

/**
 * ¿Alguna pregunta frecuente del negocio es la que hizo el cliente?
 * Exige al menos 2 palabras del tema en común (o la única que tenga la
 * pregunta) y que cubran el 60 % o más de la pregunta guardada. Si dos
 * preguntas empatan con respuestas distintas, no contesta.
 */
function coincideFaq(texto, faq, { umbral = 0.6 } = {}) {
  const lista = (Array.isArray(faq) ? faq : []).filter((f) => f && f.pregunta && f.respuesta);
  if (!lista.length) return null;
  const t = String(texto || '');
  if (t.length > 160) return null; // un parrafo largo es otra cosa
  const delCliente = tokens(t);
  if (!delCliente.length) return null;

  let mejor = null;
  let empate = false;
  for (const f of lista) {
    const delFaq = tokens(f.pregunta);
    if (!delFaq.length) continue;
    const comunes = delFaq.filter((q) => delCliente.some((c) => igual(q, c))).length;
    const minimo = Math.min(2, delFaq.length);
    const puntaje = comunes / delFaq.length;
    if (comunes < minimo || puntaje < umbral) continue;
    if (!mejor || puntaje > mejor.puntaje) { mejor = { f, puntaje }; empate = false; }
    else if (puntaje === mejor.puntaje && f.respuesta !== mejor.f.respuesta) empate = true;
  }
  return mejor && !empate ? { pregunta: mejor.f.pregunta, respuesta: mejor.f.respuesta } : null;
}

// ------------------------------------------------------------------ horario

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const ORDEN = [1, 2, 3, 4, 5, 6, 0]; // la semana empieza el lunes
const HORA = /^([01]?\d|2[0-3]):[0-5]\d$/;

const hh = (h) => String(h).padStart(5, '0');

/** Texto legible del horario guardado, o null si no hay nada cargado. */
function formatearHorario(horario) {
  if (!horario) return null;
  if (typeof horario.texto === 'string' && horario.texto.trim()) return horario.texto.trim();
  const dias = Array.isArray(horario.dias) ? horario.dias : [];
  if (!dias.length) return null;
  const porDia = new Map(dias.map((d) => [Number(d.dia), d]));
  const etiqueta = (n) => {
    const d = porDia.get(n);
    return !d || d.cerrado || !HORA.test(d.abre || '') || !HORA.test(d.cierra || '') ? 'cerrado' : `${hh(d.abre)} a ${hh(d.cierra)}`;
  };
  if (ORDEN.every((n) => etiqueta(n) === 'cerrado')) return null;

  const grupos = [];
  for (const n of ORDEN) {
    const e = etiqueta(n);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.e === e) ultimo.hasta = n; else grupos.push({ e, desde: n, hasta: n });
  }
  return grupos
    .map((g) => `${g.desde === g.hasta ? DIAS[g.desde] : `${DIAS[g.desde]} a ${DIAS[g.hasta]}`} ${g.e}`)
    .join(' · ');
}

// ------------------------------------------------------------- formularios

const lista = (v) => (v === undefined || v === null ? [] : [].concat(v));
const limpiar = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** faqPregunta[] / faqRespuesta[] del formulario -> [{ pregunta, respuesta }] (máx. 30, sin vacías). */
function faqDesdeFormulario(body = {}) {
  const preguntas = lista(body.faqPregunta);
  const respuestas = lista(body.faqRespuesta);
  const salida = [];
  for (let i = 0; i < preguntas.length && salida.length < 30; i += 1) {
    const pregunta = limpiar(preguntas[i], 160);
    const respuesta = String(respuestas[i] || '').trim().slice(0, 600);
    if (pregunta && respuesta) salida.push({ pregunta, respuesta });
  }
  return salida;
}

/** horaAbre0..6 / horaCierra0..6 / horaCerrado0..6 -> { dias: [...] } o null si todo está vacío. */
function horarioDesdeFormulario(body = {}) {
  const dias = [];
  let hayAlgo = false;
  for (let n = 0; n <= 6; n += 1) {
    const abre = limpiar(body[`horaAbre${n}`], 5);
    const cierra = limpiar(body[`horaCierra${n}`], 5);
    const cerrado = body[`horaCerrado${n}`] === '1' || !abre || !cierra;
    const valido = HORA.test(abre) && HORA.test(cierra) && hh(abre) < hh(cierra);
    if (!cerrado && valido) { dias.push({ dia: n, abre: hh(abre), cierra: hh(cierra), cerrado: false }); hayAlgo = true; }
    else dias.push({ dia: n, abre: '', cierra: '', cerrado: true });
  }
  return hayAlgo ? { dias } : null;
}

module.exports = { coincideFaq, formatearHorario, faqDesdeFormulario, horarioDesdeFormulario, tokens, DIAS, ORDEN };
