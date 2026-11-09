'use strict';
// lib/services/botCitas.js
//
// BOT DE CITAS (modelo de negocio CITAS; docs/09 fase 3). Misma filosofía que el bot de productos:
//   - El BACKEND decide: horarios libres, cupos y la creación de la cita salen del motor de agenda
//     (agenda.js); nada de lo que ve el cliente lo escribe una IA.
//   - Determinista primero: el recorrido completo (servicio → profesional → día → hora → nombre → resumen →
//     confirmar) se hace con LISTAS y BOTONES de WhatsApp y cuesta 0 llamadas a la IA. Sin IA el bot sigue
//     atendiendo exactamente igual.
//   - Los textos salen del catálogo de mensajes (clave `citas_*`): el negocio los puede cambiar.
//
// Cada botón/fila lleva en su ID TODA la selección hecha hasta ahí (`ct:<acción>:<servicio>:<recurso>:<personas>:
// <cita que se mueve>:<a>:<b>`): no hace falta recordar nada en el servidor, y un botón viejo nunca queda con datos
// equivocados. Lo único con estado es "esperando el nombre" y las opciones del último mensaje (para que el cliente
// pueda contestar con el número si WhatsApp mandó la lista como texto); ambos viven 30 minutos en
// `ClienteFinal.contexto.citas`.
//
// Texto libre (sin IA): intenciones por palabras ("quiero agendar", "mañana a las 4", "cancelar mi cita", "horario"),
// servicio/profesional/fecha/hora que el cliente nombre, FAQ del negocio y guardia contra manipulación. Lo que no se
// entiende vuelve al menú: la reserva se completa tocando opciones.

const { prisma } = require('../db');
const T = require('./tiempo');
const agenda = require('./agenda');
const { agendaDe } = require('./configAgenda');
const mensajesSrv = require('./mensajes');
const rubros = require('./rubros');
const guardia = require('./guardia');
const faq = require('./faq');
const { simboloMoneda } = require('./precios');
const { responder, nombrePlausible } = require('./flujoDeterminista');

const TTL_ESTADO_MS = 30 * 60 * 1000;
const DIAS_A_OFRECER = 14;
const MAX_PERSONAS_LISTA = 8;
const PREFIJO = 'ct';

// ------------------------------------------------------------------ utilidades

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ:/\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const recortar = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** ID de un botón/fila: lleva toda la selección. */
function packId(accion, p = {}) {
  return [PREFIJO, accion, p.sv || 0, p.rec || 0, p.n || 1, p.rp || 0, p.a ?? '', p.b ?? ''].join(':');
}
function leerId(texto) {
  const x = String(texto || '').split(':');
  if (x[0] !== PREFIJO || !x[1]) return null;
  return { accion: x[1], sv: Number(x[2]) || 0, rec: Number(x[3]) || 0, n: Number(x[4]) || 1, rp: Number(x[5]) || 0, a: x[6] || null, b: x[7] || null };
}
const conservar = (p, extra = {}) => ({ sv: p.sv, rec: p.rec, n: p.n, rp: p.rp, ...extra });

const hhmmDeId = (b) => (b && /^\d{4}$/.test(b) ? `${b.slice(0, 2)}:${b.slice(2)}` : null);
const idDeHora = (hora) => hora.replace(':', '');

/** Pagina una lista de WhatsApp (máx. 10 filas): si sobran, la última fila es "Ver más". */
function paginar(items, inicio, tamano = 10) {
  const resto = items.slice(inicio);
  if (resto.length <= tamano) return { visibles: resto, hayMas: false, siguiente: inicio + resto.length };
  return { visibles: resto.slice(0, tamano - 1), hayMas: true, siguiente: inicio + tamano - 1 };
}

// ------------------------------------------------------------------ texto libre

const SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

/** "hoy", "mañana", "pasado mañana", "el viernes", "15/11" → 'YYYY-MM-DD' (o null). */
function interpretarFecha(texto, hoy) {
  const t = norm(texto);
  if (/\bpasado manana\b/.test(t)) return T.sumarDias(hoy, 2);
  // "de la mañana" es una hora del día, no el día siguiente.
  if (/\bmanana\b/.test(t) && !/\b(de|por|en|a) la manana\b/.test(t)) return T.sumarDias(hoy, 1);
  if (/\bhoy\b/.test(t)) return hoy;
  for (const [nombre, dow] of Object.entries(SEMANA)) {
    if (new RegExp(`\\b${nombre}s?\\b`).test(t)) {
      let f = T.sumarDias(hoy, 1);
      for (let i = 0; i < 7; i++) { if (T.diaSemanaDe(f) === dow) return f; f = T.sumarDias(f, 1); }
    }
  }
  const m = t.match(/\b(\d{1,2})[/-](\d{1,2})\b/);
  if (m) {
    const dia = Number(m[1]); const mes = Number(m[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      let anio = Number(hoy.slice(0, 4));
      let f = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      if (!T.esFecha(f)) return null;
      if (f < hoy) { anio += 1; f = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`; }
      return T.esFecha(f) ? f : null;
    }
  }
  return null;
}

/** "a las 4", "16:30", "10 de la mañana", "3pm" → 'HH:MM' (o null). Sin aclaración, de 1 a 7 se entiende de la tarde. */
function interpretarHora(texto) {
  const t = norm(texto);
  let m = t.match(/\b(?:a las|a la|las|la)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|hs|h|horas)?\b/) || t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/) || t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (!m) return null;
  let hora = Number(m[1]);
  const min = /^\d{2}$/.test(m[2] || '') ? Number(m[2]) : 0;
  const sufijo = [m[2], m[3]].find((x) => x === 'am' || x === 'pm') || null;
  if (hora > 23 || min > 59) return null;
  const tarde = sufijo === 'pm' || /\bde la (tarde|noche)\b/.test(t);
  const manana = sufijo === 'am' || /\bde la manana\b/.test(t);
  if (tarde && hora < 12) hora += 12;
  else if (!tarde && !manana && !sufijo && hora >= 1 && hora <= 7) hora += 12;
  return `${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const PALABRAS_VACIAS = new Set(['para', 'por', 'con', 'una', 'uno', 'del', 'los', 'las', 'que', 'quiero', 'cita', 'turno', 'reserva', 'visita', 'agendar', 'reservar']);
const palabrasClave = (texto) => norm(texto).split(' ').filter((w) => w.length >= 3 && !PALABRAS_VACIAS.has(w));

/** El servicio (o recurso) que el cliente nombró: el de mayor cobertura; si hay empate no adivina. */
function buscarPorNombre(texto, candidatos, campo = 'nombre') {
  const t = ` ${norm(texto)} `;
  const puntuados = candidatos.map((c) => {
    const claves = palabrasClave(c[campo]);
    const aciertos = claves.filter((w) => t.includes(` ${w} `) || t.includes(` ${w.replace(/s$/, '')} `)).length;
    return { c, aciertos, cobertura: claves.length ? aciertos / claves.length : 0 };
  }).filter((x) => x.aciertos > 0).sort((a, b) => b.cobertura - a.cobertura || b.aciertos - a.aciertos);
  if (!puntuados.length) return null;
  if (puntuados.length > 1 && puntuados[0].cobertura === puntuados[1].cobertura && puntuados[0].aciertos === puntuados[1].aciertos) return null;
  return puntuados[0].c;
}

/** Qué quiere el cliente (por palabras). */
function intencionDe(texto) {
  const t = ` ${norm(texto)} `;
  if (/ (asesor|asesora|persona|humano|operador|operadora) /.test(t) || / hablar con alguien /.test(t)) return 'asesor';
  if (/ (cancel\w*|anul\w*) /.test(t)) return 'cancelar';
  if (/ (reprogram\w*|reagend\w*) /.test(t) || /( cambiar| mover| pasar| posponer) .*(cita|turno|reserva|visita|hora|dia)/.test(t)) return 'reprogramar';
  if (/ (mi|mis) (cita|citas|turno|turnos|reserva|reservas|visita|visitas) /.test(t) || / cuando (es|tengo|era) /.test(t)) return 'micita';
  if (/ (horario|horarios|abren|cierran|atienden|atencion) /.test(t) || / (donde|ubicacion|direccion|mapa) /.test(t) || / como (llego|llegar) /.test(t)) return 'info';
  if (/ (agendar|agendo|reservar|reserva|cita|turno|disponib\w*|libre|libres|lugar|espacio) /.test(t)) return 'agendar';
  if (/^ (hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|menu|inicio|empezar|ayuda) $/.test(t)) return 'menu';
  return null;
}

// ------------------------------------------------------------------ estado (30 min)

const estadoDe = (cliente) => {
  const e = cliente.contexto && cliente.contexto.citas;
  return e && Date.now() - (e.ts || 0) < TTL_ESTADO_MS ? e : null;
};
async function guardarEstado(ctx, estado) {
  const contexto = { ...(ctx.cliente.contexto || {}) };
  if (estado) contexto.citas = { ...estado, ts: Date.now() }; else delete contexto.citas;
  ctx.cliente.contexto = contexto;
  await prisma.clienteFinal.update({ where: { id: ctx.cliente.id }, data: { contexto } });
}

// ------------------------------------------------------------------ salida

const rotulo = (r) => (r === 'lista' ? 'Ver opciones' : '');

/** Arma la respuesta y recuerda las opciones mostradas (para contestar con el número o el nombre). */
async function salir(ctx, texto, { lista = null, botones = null, estado = undefined } = {}) {
  const opciones = lista ? lista.secciones.flatMap((s) => s.filas).map((f) => ({ id: f.id, titulo: f.titulo })) : (botones || []).map((b) => ({ id: b.id, titulo: b.titulo }));
  const base = estado === undefined ? (estadoDe(ctx.cliente) || {}) : (estado || {});
  const { paso: _p, ...sinPaso } = base;
  await guardarEstado(ctx, { ...(estado === undefined ? sinPaso : base), ultimas: opciones });
  return responder(texto, { ...(lista ? { lista } : {}), ...(botones ? { botones } : {}), modelo: 'citas', proveedor: 'sistema' });
}

const asesorTexto = (ctx) => ctx.m.t('ofrecer_asesor');
const vocabDe = (ctx) => ctx.vocab;

// ------------------------------------------------------------------ menú y datos del negocio

async function menu(ctx) {
  const v = vocabDe(ctx);
  return salir(ctx, ctx.m.t('citas_bienvenida'), {
    botones: [
      { id: packId('agendar'), titulo: recortar(`Agendar ${v.cita}`, 20) },
      { id: packId('micita'), titulo: recortar(`Mi ${v.cita}`, 20) },
      { id: packId('info'), titulo: 'Ubicación y horarios' },
    ],
  });
}
const botonMenu = () => [{ id: packId('menu'), titulo: 'Volver al menú' }];

function horarioTexto(horarios) {
  const porDia = new Map();
  for (const h of horarios.filter((x) => x.recursoId === null)) {
    const d = porDia.get(h.diaSemana) || { dia: h.diaSemana, abre: h.horaInicio, cierra: h.horaFin };
    if (h.horaInicio < d.abre) d.abre = h.horaInicio;
    if (h.horaFin > d.cierra) d.cierra = h.horaFin;
    porDia.set(h.diaSemana, d);
  }
  return faq.formatearHorario({ dias: [...porDia.values()] });
}

async function info(ctx) {
  const horarios = await prisma.horarioAtencion.findMany({ where: { empresaId: ctx.empresa.id } });
  const delNegocio = faq.formatearHorario(ctx.config && ctx.config.horarioAtencion);
  const horario = delNegocio || horarioTexto(horarios);
  const direccion = ctx.config && ctx.config.direccionTienda;
  const partes = [
    direccion ? ctx.m.t('direccion_tienda', { direccion }) : ctx.m.t('direccion_sin_datos', { asesor: asesorTexto(ctx) }),
    horario ? ctx.m.t('horario_info', { horario }) : ctx.m.t('horario_sin_datos', { asesor: asesorTexto(ctx) }),
  ];
  return salir(ctx, partes.join('\n'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${vocabDe(ctx).cita}`, 20) }, ...botonMenu()] });
}

async function derivar(ctx) {
  await prisma.clienteFinal.update({ where: { id: ctx.cliente.id }, data: { estadoLead: 'DERIVADO_A_ASESOR' } });
  await prisma.notificacion.create({
    data: { empresaId: ctx.empresa.id, titulo: 'Pidió hablar con una persona', mensaje: `El cliente ${ctx.cliente.nombre || ctx.telefono} necesita atención de una persona.`, tipo: 'MANUAL' },
  }).catch(() => {});
  return salir(ctx, ctx.m.t('derivar_confirmacion'), { botones: botonMenu() });
}

// ------------------------------------------------------------------ recorrido de agendar

const cargarServicios = (ctx) => prisma.servicio.findMany({ where: { empresaId: ctx.empresa.id, activo: true }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] });
const descripcionServicio = (ctx, s) => [`${s.duracionMin} min`, s.precio !== null && s.precio !== undefined ? `${simboloMoneda(ctx.empresa.moneda)} ${Number(s.precio).toFixed(2)}` : null].filter(Boolean).join(' · ');

async function elegirServicio(ctx, p, inicio = 0) {
  const servicios = await cargarServicios(ctx);
  if (!servicios.length) return salir(ctx, ctx.m.t('citas_sin_servicios', { asesor: asesorTexto(ctx) }), { botones: botonMenu() });
  if (servicios.length === 1) return siguientePasoTrasServicio(ctx, conservar(p, { sv: servicios[0].id }), servicios[0]);
  const { visibles, hayMas, siguiente } = paginar(servicios, inicio);
  const filas = visibles.map((s) => ({ id: packId('sv', conservar(p, { sv: s.id })), titulo: recortar(s.nombre, 24), descripcion: descripcionServicio(ctx, s) }));
  if (hayMas) filas.push({ id: packId('svmas', conservar(p, { a: siguiente })), titulo: 'Ver más ▸' });
  return salir(ctx, ctx.m.t('citas_elegir_servicio'), { lista: { boton: 'Ver opciones', secciones: [{ titulo: cap(ctx.vocab.servicios), filas }] } });
}

async function siguientePasoTrasServicio(ctx, p, servicio) {
  if (servicio.usaPersonas) return elegirPersonas(ctx, p, servicio);
  return elegirProfesional(ctx, p, servicio);
}

async function elegirPersonas(ctx, p, servicio) {
  const tope = Math.min(servicio.maxPersonas || MAX_PERSONAS_LISTA, MAX_PERSONAS_LISTA);
  const filas = Array.from({ length: tope }, (_, i) => ({ id: packId('pe', conservar(p, { n: i + 1 })), titulo: `${i + 1} ${i === 0 ? 'persona' : 'personas'}` }));
  return salir(ctx, ctx.m.t('citas_elegir_personas'), { lista: { boton: 'Ver opciones', secciones: [{ titulo: 'Personas', filas }] } });
}

async function elegirProfesional(ctx, p, servicio) {
  const recursos = ctx.cfg.permiteElegirRecurso ? await agenda.recursosPara(ctx.empresa.id, servicio.id, null) : [];
  if (recursos.length <= 1) return elegirDia(ctx, conservar(p, { rec: recursos.length === 1 ? recursos[0].id : 0 }), servicio, hoyDe(ctx));
  const filas = [
    { id: packId('pr', conservar(p, { rec: 0 })), titulo: 'Cualquiera disponible', descripcion: 'El primero con lugar' },
    ...recursos.slice(0, 9).map((r) => ({ id: packId('pr', conservar(p, { rec: r.id })), titulo: recortar(r.nombre, 24), ...(r.especialidad ? { descripcion: recortar(r.especialidad, 72) } : {}) })),
  ];
  return salir(ctx, ctx.m.t('citas_elegir_profesional', { servicio: servicio.nombre }), { lista: { boton: 'Ver opciones', secciones: [{ titulo: cap(ctx.vocab.profesionales), filas }] } });
}

const hoyDe = (ctx) => T.hoy(ctx.empresa.zonaHoraria);
const cortoDia = (fecha, zona) => {
  const { DateTime } = require('luxon');
  return DateTime.fromISO(fecha, { zone: zona }).setLocale('es').toFormat('ccc d LLL');
};

async function libres(ctx, p, desde, dias) {
  return agenda.horariosLibres(ctx.empresa, { servicioId: p.sv, recursoId: p.rec || undefined, desde, dias, personas: p.n });
}

/** Lista de los próximos días con lugar (con cuántos horarios hay en cada uno). */
async function elegirDia(ctx, p, servicio, desde, { texto = null } = {}) {
  const slots = await libres(ctx, p, desde, DIAS_A_OFRECER);
  const porDia = new Map();
  for (const s of slots) porDia.set(s.fecha, (porDia.get(s.fecha) || 0) + 1);
  const dias = [...porDia.entries()];
  if (!dias.length) {
    const nada = ctx.m.t('citas_sin_horarios', { servicio: servicio.nombre, asesor: asesorTexto(ctx) });
    return salir(ctx, nada, { botones: botonMenu() });
  }
  const { visibles, hayMas } = paginar(dias, 0);
  const filas = visibles.map(([fecha, n]) => ({ id: packId('dia', conservar(p, { a: fecha })), titulo: cortoDia(fecha, ctx.empresa.zonaHoraria), descripcion: `${n} ${n === 1 ? 'horario libre' : 'horarios libres'}` }));
  if (hayMas) filas.push({ id: packId('dias', conservar(p, { a: T.sumarDias(visibles[visibles.length - 1][0], 1) })), titulo: 'Ver más días ▸' });
  const intro = texto || (p.rp ? ctx.m.t('citas_reprogramar', { servicio: servicio.nombre }) : ctx.m.t('citas_elegir_dia', { servicio: servicio.nombre }));
  return salir(ctx, intro, { lista: { boton: 'Ver días', secciones: [{ titulo: 'Días con lugar', filas }] } });
}

/** Lista de horarios libres de un día (mañana / tarde). */
async function elegirHora(ctx, p, servicio, fecha, inicio = 0, { texto = null } = {}) {
  const slots = (await libres(ctx, p, fecha, 1)).filter((s) => s.fecha === fecha);
  if (!slots.length) {
    return elegirDia(ctx, p, servicio, hoyDe(ctx), { texto: ctx.m.t('citas_dia_sin_horarios', { dia: T.diaLegible(fecha, ctx.empresa.zonaHoraria) }) });
  }
  const { visibles, hayMas, siguiente } = paginar(slots, inicio);
  const fila = (s) => ({ id: packId('hr', conservar(p, { a: fecha, b: idDeHora(s.hora) })), titulo: s.hora });
  const manana = visibles.filter((s) => s.hora < '12:00').map(fila);
  const tarde = visibles.filter((s) => s.hora >= '12:00').map(fila);
  const secciones = [];
  if (manana.length) secciones.push({ titulo: 'Por la mañana', filas: manana });
  if (tarde.length) secciones.push({ titulo: 'Por la tarde', filas: tarde });
  if (hayMas) secciones.push({ titulo: 'Más horarios', filas: [{ id: packId('hmas', conservar(p, { a: fecha, b: String(siguiente) })), titulo: 'Ver más ▸' }] });
  return salir(ctx, texto || ctx.m.t('citas_elegir_hora', { dia: T.diaLegible(fecha, ctx.empresa.zonaHoraria) }), { lista: { boton: 'Ver horarios', secciones } });
}

const detalleDe = (ctx, { servicio, recurso, fecha, hora, personas, nombre, mostrarProfesional }) => {
  const filas = [`• ${servicio.nombre}`];
  if (recurso && mostrarProfesional) filas.push(`• ${cap(ctx.vocab.profesional)}: ${recurso.nombre}`);
  filas.push(`• ${T.diaLegible(fecha, ctx.empresa.zonaHoraria)}, ${hora}`);
  if (servicio.usaPersonas) filas.push(`• ${personas} ${personas === 1 ? 'persona' : 'personas'}`);
  if (nombre) filas.push(`• A nombre de: ${nombre}`);
  if (servicio.precio !== null && servicio.precio !== undefined) filas.push(`• Precio: ${simboloMoneda(ctx.empresa.moneda)} ${Number(servicio.precio).toFixed(2)}`);
  return filas.join('\n');
};

/** Verifica el horario y arma el resumen (o pide el nombre primero). */
async function resumen(ctx, p, servicio, fecha, hora) {
  const chequeo = await agenda.verificarHorario(ctx.empresa, { servicioId: servicio.id, recursoId: p.rec || undefined, fecha, hora, personas: p.n });
  if (!chequeo.ok) return elegirHora(ctx, p, servicio, fecha, 0, { texto: ctx.m.t('citas_horario_ocupado') });
  if (!nombrePlausible(ctx.cliente.nombre)) {
    await guardarEstado(ctx, { paso: 'nombre', pendiente: { ...conservar(p), fecha, hora }, intentos: 0 });
    return responderNombre(ctx, 'citas_pedir_nombre');
  }
  const recurso = chequeo.recurso ? await prisma.recurso.findFirst({ where: { id: chequeo.recurso.id, empresaId: ctx.empresa.id } }) : null;
  const total = await prisma.recurso.count({ where: { empresaId: ctx.empresa.id, activo: true } });
  const detalle = detalleDe(ctx, { servicio, recurso, fecha, hora, personas: p.n, nombre: ctx.cliente.nombre, mostrarProfesional: total > 1 });
  return salir(ctx, ctx.m.t('citas_resumen', { resumen: detalle }), {
    botones: [
      { id: packId('ok', conservar(p, { a: fecha, b: idDeHora(hora) })), titulo: 'Confirmar' },
      { id: packId('dias', conservar(p, { a: hoyDe(ctx) })), titulo: 'Cambiar horario' },
      { id: packId('menu'), titulo: 'Cancelar' },
    ],
  });
}

async function responderNombre(ctx, clave) {
  return responder(ctx.m.t(clave), { modelo: 'citas', proveedor: 'sistema' });
}

/** Confirma: crea la cita (o mueve la existente). Nunca duplica si el botón se toca dos veces. */
async function confirmar(ctx, p, fecha, hora) {
  const servicio = await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } });
  if (!servicio) return yaNoDisponible(ctx);
  if (!nombrePlausible(ctx.cliente.nombre)) return resumen(ctx, p, servicio, fecha, hora);
  const inicio = T.aInstante(fecha, hora, ctx.empresa.zonaHoraria);
  const yaTiene = inicio && await prisma.cita.findFirst({
    where: { empresaId: ctx.empresa.id, clienteId: ctx.cliente.id, servicioId: servicio.id, inicio, estado: { in: ['PENDIENTE', 'CONFIRMADA'] } },
    include: { servicio: true, recurso: true },
  });
  if (yaTiene) return citaYaAgendada(ctx, yaTiene);

  let cita;
  try {
    cita = p.rp
      ? await agenda.reprogramarCita(ctx.empresa, p.rp, { fecha, hora, recursoId: p.rec || undefined, origen: 'whatsapp' })
      : await agenda.crearCita(ctx.empresa, { clienteId: ctx.cliente.id, servicioId: servicio.id, recursoId: p.rec || undefined, fecha, hora, personas: p.n, origen: 'whatsapp' });
  } catch (err) {
    if (!(err instanceof agenda.ErrorAgenda)) throw err;
    if (err.codigo === 'HORARIO_OCUPADO') return elegirHora(ctx, p, servicio, fecha, 0, { texto: ctx.m.t('citas_horario_ocupado') });
    if (err.codigo === 'TOPE_CITAS') return salir(ctx, ctx.m.t('citas_tope', { asesor: asesorTexto(ctx) }), { botones: botonMenu() });
    return yaNoDisponible(ctx);
  }
  const completa = await prisma.cita.findUnique({ where: { id: cita.id }, include: { servicio: true, recurso: true } });
  const total = await prisma.recurso.count({ where: { empresaId: ctx.empresa.id, activo: true } });
  const detalle = detalleDe(ctx, { servicio, recurso: completa.recurso, fecha, hora, personas: p.n, mostrarProfesional: total > 1 });
  await prisma.notificacion.create({
    data: {
      empresaId: ctx.empresa.id, titulo: p.rp ? `${cap(ctx.vocab.cita)} · cambio de horario` : `${cap(ctx.vocab.cita)} · nueva por WhatsApp`,
      mensaje: `${ctx.cliente.nombre || ctx.telefono}: ${servicio.nombre}, ${T.legible(inicio, ctx.empresa.zonaHoraria)}.`, tipo: 'MANUAL',
    },
  }).catch(() => {});
  const direccion = ctx.config && ctx.config.direccionTienda;
  const botones = [{ id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, ...(direccion ? [{ id: packId('loc'), titulo: 'Cómo llegar' }] : []), ...botonMenu()].slice(0, 3);
  return salir(ctx, p.rp ? ctx.m.t('citas_reprogramada', { detalle }) : ctx.m.t('citas_creada', { detalle, ...(direccion ? { direccion } : {}) }), { botones, estado: null });
}

async function citaYaAgendada(ctx, cita) {
  const detalle = detalleDe(ctx, { servicio: cita.servicio, recurso: cita.recurso, fecha: fechaDe(ctx, cita.inicio), hora: horaDe(ctx, cita.inicio), personas: cita.personas, mostrarProfesional: false });
  return salir(ctx, ctx.m.t('citas_ya_agendada', { detalle }), { botones: [{ id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, ...botonMenu()] });
}

const yaNoDisponible = (ctx) => salir(ctx, ctx.m.t('citas_ya_no_disponible'), {
  botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, { id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, { id: packId('info'), titulo: 'Ubicación y horarios' }],
});

// ------------------------------------------------------------------ mi cita (ver, cambiar, cancelar)

const fechaDe = (ctx, inicio) => require('luxon').DateTime.fromJSDate(new Date(inicio), { zone: ctx.empresa.zonaHoraria }).toFormat('yyyy-MM-dd');
const horaDe = (ctx, inicio) => require('luxon').DateTime.fromJSDate(new Date(inicio), { zone: ctx.empresa.zonaHoraria }).toFormat('HH:mm');
const detalleCita = (ctx, c) => detalleDe(ctx, { servicio: c.servicio, recurso: c.recurso, fecha: fechaDe(ctx, c.inicio), hora: horaDe(ctx, c.inicio), personas: c.personas, mostrarProfesional: Boolean(c.recurso) });

async function citasDelCliente(ctx) {
  return agenda.citasProximasDeCliente(ctx.empresa.id, ctx.cliente.id);
}
async function citaPropia(ctx, citaId) {
  const c = await prisma.cita.findFirst({ where: { id: citaId, empresaId: ctx.empresa.id, clienteId: ctx.cliente.id, estado: { in: ['PENDIENTE', 'CONFIRMADA'] }, inicio: { gt: new Date() } }, include: { servicio: true, recurso: true } });
  return c;
}

async function miCita(ctx) {
  const citas = await citasDelCliente(ctx);
  if (!citas.length) return salir(ctx, ctx.m.t('citas_sin_citas'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, ...botonMenu()] });
  if (citas.length === 1) return verCita(ctx, citas[0]);
  const filas = citas.slice(0, 10).map((c) => ({ id: packId('ver', { a: String(c.id) }), titulo: recortar(`${cortoDia(fechaDe(ctx, c.inicio), ctx.empresa.zonaHoraria)} ${horaDe(ctx, c.inicio)}`, 24), descripcion: recortar(c.servicio ? c.servicio.nombre : '', 72) }));
  return salir(ctx, ctx.m.t('citas_elegir_cita'), { lista: { boton: 'Ver opciones', secciones: [{ titulo: cap(ctx.vocab.citas), filas }] } });
}

async function verCita(ctx, cita) {
  return salir(ctx, ctx.m.t('citas_mi_cita', { detalle: detalleCita(ctx, cita) }), {
    botones: [
      { id: packId('rep', { a: String(cita.id) }), titulo: 'Cambiar horario' },
      { id: packId('can', { a: String(cita.id) }), titulo: `Cancelar ${ctx.vocab.cita}`.slice(0, 20) },
      ...(ctx.config && ctx.config.direccionTienda ? [{ id: packId('loc'), titulo: 'Cómo llegar' }] : botonMenu()),
    ],
  });
}

async function reprogramar(ctx, citaId) {
  const cita = await citaPropia(ctx, citaId);
  if (!cita || !cita.servicio) return yaNoDisponible(ctx);
  const p = { sv: cita.servicioId, rec: cita.recursoId || 0, n: cita.personas, rp: cita.id };
  return elegirDia(ctx, p, cita.servicio, hoyDe(ctx));
}

async function cancelar(ctx, citaId, confirmado) {
  const cita = await citaPropia(ctx, citaId);
  if (!cita) return yaNoDisponible(ctx);
  if (!confirmado) {
    return salir(ctx, ctx.m.t('citas_confirmar_cancelar', { detalle: detalleCita(ctx, cita) }), {
      botones: [{ id: packId('can2', { a: String(cita.id) }), titulo: 'Sí, cancelar' }, { id: packId('micita'), titulo: 'No, mantener' }],
    });
  }
  await agenda.cancelarCita(ctx.empresa, cita.id);
  await prisma.notificacion.create({
    data: { empresaId: ctx.empresa.id, titulo: `${cap(ctx.vocab.cita)} · cancelación del cliente`, mensaje: `${ctx.cliente.nombre || ctx.telefono}: ${cita.servicio ? cita.servicio.nombre : ''}, ${T.legible(cita.inicio, ctx.empresa.zonaHoraria)}.`, tipo: 'MANUAL' },
  }).catch(() => {});
  return salir(ctx, ctx.m.t('citas_cancelada', { cuando: T.legible(cita.inicio, ctx.empresa.zonaHoraria) }), {
    botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, ...botonMenu()], estado: null,
  });
}

async function comoLlegar(ctx) {
  const direccion = ctx.config && ctx.config.direccionTienda;
  const texto = direccion ? ctx.m.t('direccion_tienda', { direccion }) : ctx.m.t('direccion_sin_datos', { asesor: asesorTexto(ctx) });
  return salir(ctx, texto, { botones: botonMenu() });
}

// ------------------------------------------------------------------ botones y listas

async function porId(ctx, id) {
  const p = leerId(id);
  if (!p) return null;
  const nuevo = () => ({ sv: p.sv, rec: p.rec, n: p.n, rp: p.rp });
  switch (p.accion) {
    case 'menu': await guardarEstado(ctx, null); return menu(ctx);
    case 'agendar': await guardarEstado(ctx, null); return elegirServicio(ctx, { sv: 0, rec: 0, n: 1, rp: 0 });
    case 'svmas': return elegirServicio(ctx, { sv: 0, rec: 0, n: 1, rp: 0 }, Number(p.a) || 0);
    case 'micita': return miCita(ctx);
    case 'info': return info(ctx);
    case 'loc': return comoLlegar(ctx);
    case 'ver': { const c = await citaPropia(ctx, Number(p.a)); return c ? verCita(ctx, c) : yaNoDisponible(ctx); }
    case 'rep': return reprogramar(ctx, Number(p.a));
    case 'can': return cancelar(ctx, Number(p.a), false);
    case 'can2': return cancelar(ctx, Number(p.a), true);
    default: break;
  }
  // Los pasos que siguen necesitan el servicio.
  const servicio = p.sv ? await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } }) : null;
  if (!servicio) return yaNoDisponible(ctx);
  switch (p.accion) {
    case 'sv': return siguientePasoTrasServicio(ctx, nuevo(), servicio);
    case 'pe': return elegirProfesional(ctx, nuevo(), servicio);
    case 'pr': return elegirDia(ctx, nuevo(), servicio, hoyDe(ctx));
    case 'dias': return elegirDia(ctx, nuevo(), servicio, T.esFecha(p.a) ? p.a : hoyDe(ctx));
    case 'dia': return T.esFecha(p.a) ? elegirHora(ctx, nuevo(), servicio, p.a) : yaNoDisponible(ctx);
    case 'hmas': return T.esFecha(p.a) ? elegirHora(ctx, nuevo(), servicio, p.a, Number(p.b) || 0) : yaNoDisponible(ctx);
    case 'hr': { const hora = hhmmDeId(p.b); return T.esFecha(p.a) && hora ? resumen(ctx, nuevo(), servicio, p.a, hora) : yaNoDisponible(ctx); }
    case 'ok': { const hora = hhmmDeId(p.b); return T.esFecha(p.a) && hora ? confirmar(ctx, nuevo(), p.a, hora) : yaNoDisponible(ctx); }
    default: return null;
  }
}

/** Número ("2") o nombre de una opción mostrada → el ID de esa opción (por si WhatsApp mandó la lista como texto). */
function idPorTexto(ctx, texto) {
  const e = estadoDe(ctx.cliente);
  const ultimas = (e && e.ultimas) || [];
  if (!ultimas.length) return null;
  const t = String(texto || '').trim();
  if (/^\d{1,2}$/.test(t)) { const op = ultimas[Number(t) - 1]; return op ? op.id : null; }
  const coincide = ultimas.filter((o) => norm(o.titulo) === norm(t));
  return coincide.length === 1 ? coincide[0].id : null;
}

// ------------------------------------------------------------------ texto libre

/** Lo que dijo el cliente con sus propias palabras: se resuelve por código, sin IA. */
async function textoLibre(ctx, texto) {
  const guardado = guardia.evaluarEntrada(texto);
  if (guardado) return salir(ctx, ctx.m.t('citas_alcance'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, { id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, { id: packId('info'), titulo: 'Ubicación y horarios' }] });

  const respuestaFaq = faq.coincideFaq(texto, ctx.config && ctx.config.faq);
  if (respuestaFaq) return salir(ctx, respuestaFaq.respuesta, { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, ...botonMenu()] });

  const intencion = intencionDe(texto);
  if (intencion === 'asesor') return derivar(ctx);
  if (intencion === 'info') return info(ctx);
  if (intencion === 'micita' || intencion === 'cancelar' || intencion === 'reprogramar') return miCita(ctx);

  const hoy = hoyDe(ctx);
  const fecha = interpretarFecha(texto, hoy);
  const hora = fecha || /\b(a las|a la|las)\b/.test(norm(texto)) ? interpretarHora(texto) : null;
  const servicios = await cargarServicios(ctx);
  const servicio = buscarPorNombre(texto, servicios) || (servicios.length === 1 && (intencion === 'agendar' || fecha) ? servicios[0] : null);
  if (intencion === 'agendar' || servicio || fecha) {
    if (!servicios.length) return salir(ctx, ctx.m.t('citas_sin_servicios', { asesor: asesorTexto(ctx) }), { botones: botonMenu() });
    if (!servicio) {
      // Se acuerda de lo que ya dijo (día y hora) para usarlo cuando elija el servicio.
      await guardarEstado(ctx, { preferencia: { fecha: fecha || null, hora: hora || null } });
      return elegirServicio(ctx, { sv: 0, rec: 0, n: 1, rp: 0 });
    }
    return desdeServicioNombrado(ctx, servicio, texto, { fecha, hora });
  }
  if (intencion === 'menu' || !intencion) return intencion === 'menu' ? menu(ctx) : salir(ctx, ctx.m.t('citas_menu_aclarar'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, { id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, { id: packId('info'), titulo: 'Ubicación y horarios' }] });
  return menu(ctx);
}

async function desdeServicioNombrado(ctx, servicio, texto, { fecha, hora }) {
  let p = { sv: servicio.id, rec: 0, n: 1, rp: 0 };
  if (servicio.usaPersonas) {
    const m = norm(texto).match(/\b(?:para|somos|de)\s+(\d{1,2})\b/);
    const personas = m ? Number(m[1]) : 0;
    if (!personas) return elegirPersonas(ctx, p, servicio);
    if (servicio.maxPersonas && personas > servicio.maxPersonas) return salir(ctx, ctx.m.t('citas_grupo_grande', { max: servicio.maxPersonas, asesor: asesorTexto(ctx) }), { botones: botonMenu() });
    p = { ...p, n: personas };
  }
  const recursos = ctx.cfg.permiteElegirRecurso ? await agenda.recursosPara(ctx.empresa.id, servicio.id, null) : [];
  const recurso = recursos.length > 1 ? buscarPorNombre(texto, recursos) : (recursos.length === 1 ? recursos[0] : null);
  if (recurso) p = { ...p, rec: recurso.id };
  else if (recursos.length > 1 && !fecha) return elegirProfesional(ctx, p, servicio);
  if (fecha && hora) return resumen(ctx, p, servicio, fecha, hora);
  if (fecha) return elegirHora(ctx, p, servicio, fecha);
  return elegirDia(ctx, p, servicio, hoyDe(ctx));
}

// ------------------------------------------------------------------ entrada

/**
 * Responde un mensaje del cliente en un negocio de CITAS.
 * @param {{ agente, empresa, config, telefonoCliente, texto, idBoton }} entrada
 */
async function responderCitas(entrada) {
  // Un cliente a la vez: dos toques seguidos (o simultaneos) del mismo boton no pueden crear dos citas.
  return require('./conversaciones').conBloqueoDeCliente(`citas:${entrada.empresa.id}:${entrada.telefonoCliente}`, () => atender(entrada));
}

async function atender({ empresa, config, telefonoCliente, texto, idBoton = null }) {
  const cliente = await prisma.clienteFinal.upsert({
    where: { empresaId_telefono: { empresaId: empresa.id, telefono: telefonoCliente } },
    update: {}, create: { empresaId: empresa.id, telefono: telefonoCliente },
  });
  const vocab = rubros.vocabularioDe(empresa);
  const m = await mensajesSrv.cargarContexto({ empresa, config, vocab });
  const ctx = { empresa, config, cfg: agendaDe(empresa), m, vocab, cliente, telefono: telefonoCliente };

  try {
    const estado = estadoDe(cliente);
    // 1) Toque de botón/lista (o número / nombre de una opción mostrada).
    const id = idBoton || (!(estado && estado.paso) ? idPorTexto(ctx, texto) : null);
    if (id && String(id).startsWith(`${PREFIJO}:`)) {
      const preferencia = estado && estado.preferencia;
      const r = await porIdConPreferencia(ctx, id, preferencia);
      if (r) return r;
      return yaNoDisponible(ctx);
    }
    // 2) Esperando el nombre para cerrar la cita.
    if (estado && estado.paso === 'nombre' && estado.pendiente) return recibirNombre(ctx, estado, texto);
    // 3) Texto libre.
    return await textoLibre(ctx, texto);
  } catch (err) {
    console.error(`[botCitas] error atendiendo a ${telefonoCliente}:`, err);
    return responder(m.t('error_tecnico'), { modelo: 'citas', proveedor: 'sistema', error: true });
  }
}

/** Si el cliente ya dijo un día/hora ("mañana a las 4") y ahora elige el servicio, se usa. */
async function porIdConPreferencia(ctx, id, preferencia) {
  const p = leerId(id);
  if (preferencia && p && p.accion === 'sv') {
    await guardarEstado(ctx, null); // la preferencia se usa una sola vez
    const servicio = await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } });
    if (servicio && !servicio.usaPersonas && (preferencia.fecha)) {
      const recursos = ctx.cfg.permiteElegirRecurso ? await agenda.recursosPara(ctx.empresa.id, servicio.id, null) : [];
      if (recursos.length <= 1) {
        const pp = { sv: servicio.id, rec: recursos.length === 1 ? recursos[0].id : 0, n: 1, rp: 0 };
        if (preferencia.hora) return resumen(ctx, pp, servicio, preferencia.fecha, preferencia.hora);
        return elegirHora(ctx, pp, servicio, preferencia.fecha);
      }
    }
  }
  return porId(ctx, id);
}

async function recibirNombre(ctx, estado, texto) {
  const intencion = intencionDe(texto);
  if (intencion === 'asesor') return derivar(ctx);
  if (!nombrePlausible(texto)) {
    const intentos = (estado.intentos || 0) + 1;
    if (intentos >= 3) { await guardarEstado(ctx, null); return derivar(ctx); }
    await guardarEstado(ctx, { ...estado, intentos });
    return responderNombre(ctx, 'citas_nombre_ejemplo');
  }
  const nombre = String(texto).replace(/\s+/g, ' ').trim();
  await prisma.clienteFinal.update({ where: { id: ctx.cliente.id }, data: { nombre } });
  ctx.cliente.nombre = nombre;
  const { fecha, hora, ...p } = estado.pendiente;
  const servicio = await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } });
  if (!servicio) return yaNoDisponible(ctx);
  await guardarEstado(ctx, null);
  return resumen(ctx, p, servicio, fecha, hora);
}

module.exports = { responderCitas, packId, leerId, interpretarFecha, interpretarHora, intencionDe, buscarPorNombre, paginar, horarioTexto, TTL_ESTADO_MS };
