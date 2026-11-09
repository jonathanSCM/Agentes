'use strict';
// lib/rutasReservas.js
//
// Rutas PÚBLICAS de reservas: /reservar/:slug (sin login, pensada para el link de Instagram, Google Maps o el
// WhatsApp del negocio). Cada paso es una página con enlaces (sin JavaScript obligatorio), así funciona en cualquier
// celular y el link de un paso se puede compartir. Toda la lógica de negocio y de seguridad está en
// services/reservaPublica.js; los horarios y cupos salen del motor de agenda.

const express = require('express');
const { DateTime } = require('luxon');
const { prisma } = require('./db');
const agenda = require('./services/agenda');
const T = require('./services/tiempo');
const rubros = require('./services/rubros');
const { simboloMoneda } = require('./services/precios');
const R = require('./services/reservaPublica');

const router = express.Router();

// ------------------------------------------------------------------ límites por IP (en memoria)

const contadores = new Map();
function limitar(tipo, maximo, ventanaMs) {
  return (req, res, next) => {
    const ahora = Date.now();
    if (contadores.size > 5000) for (const [k, v] of contadores) if (ahora - v.desde > v.ventana) contadores.delete(k);
    const clave = `${tipo}:${req.ip}`;
    const reg = contadores.get(clave) || { cuenta: 0, desde: ahora, ventana: ventanaMs };
    if (ahora - reg.desde > ventanaMs) { reg.cuenta = 0; reg.desde = ahora; }
    reg.cuenta += 1;
    contadores.set(clave, reg);
    if (reg.cuenta > maximo) return res.status(429).type('text').send('Demasiados intentos. Esperá un momento y volvé a probar.');
    return next();
  };
}
const limiteVer = limitar('ver', 240, 60 * 1000);
const limiteReservar = limitar('reservar', 6, 60 * 60 * 1000);
const limiteCancelar = limitar('cancelar', 12, 60 * 60 * 1000);

// ------------------------------------------------------------------ utilidades

const entero = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const hhmmUrl = (h) => h;
const colorSeguro = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? c : '#7c3aed');
const MENSAJES = {
  ocupado: 'Ese horario se acaba de ocupar. Elegí otro 👇',
  tope: 'Por ahora este negocio no puede tomar más reservas por la web. Escribinos por WhatsApp.',
  invalido: 'Ese horario ya no está disponible. Elegí otro 👇',
};

async function cargarNegocio(req, res) {
  const n = await R.negocioParaReservar(req.params.slug);
  if (n.motivo === 'NO_EXISTE' || n.motivo === 'NO_ES_DE_CITAS') { res.status(404).render('404', { title: 'Página no encontrada' }); return null; }
  if (n.motivo) {
    res.status(404).render('reservar-no-disponible', { title: 'Reservas no disponibles', negocio: n.empresa.marca || n.empresa.nombre });
    return null;
  }
  const vocab = rubros.vocabularioDe(n.empresa);
  const digitos = n.conexion && n.conexion.numeroVisible ? String(n.conexion.numeroVisible).replace(/\D/g, '') : '';
  return {
    ...n, vocab, slug: n.empresa.slug, nombre: n.empresa.marca || n.empresa.nombre, simbolo: simboloMoneda(n.empresa.moneda),
    color: colorSeguro(n.config && n.config.colorPrimario), logo: n.config && n.config.logoUrl ? n.config.logoUrl : null,
    direccion: n.config && n.config.direccionTienda ? n.config.direccionTienda : null, whatsapp: digitos.length >= 8 ? digitos : null,
  };
}

const base = (neg) => `/reservar/${neg.slug}`;
const enlace = (neg, p) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `${base(neg)}?${s}` : base(neg);
};

const cortoDia = (fecha, zona) => DateTime.fromISO(fecha, { zone: zona }).setLocale('es').toFormat('ccc d LLL');

// ------------------------------------------------------------------ página de reserva (paso a paso)

router.get('/:slug', limiteVer, async (req, res, next) => {
  try {
    const neg = await cargarNegocio(req, res);
    if (!neg) return;
    const { empresa, vocab } = neg;
    const q = req.query;
    const zona = empresa.zonaHoraria;
    const vista = { title: `Reservá ${vocab.cita} en ${neg.nombre}`, neg, vocab, aviso: MENSAJES[q.e] || null, cap, hoy: T.hoy(zona), seleccion: [] };

    const servicio = entero(q.servicio) ? await prisma.servicio.findFirst({ where: { id: entero(q.servicio), empresaId: empresa.id, activo: true } }) : null;
    if (!servicio) {
      const servicios = await prisma.servicio.findMany({ where: { empresaId: empresa.id, activo: true }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] });
      return res.render('reservar', {
        ...vista, paso: 'servicio',
        servicios: servicios.map((s) => ({ ...s, precioTexto: s.precio !== null && s.precio !== undefined ? `${neg.simbolo} ${Number(s.precio).toFixed(2)}` : null, href: enlace(neg, { servicio: s.id }) })),
      });
    }
    vista.seleccion.push({ etiqueta: cap(vocab.servicio), valor: servicio.nombre, href: base(neg) });
    let params = { servicio: servicio.id };

    // personas (solo servicios que las usan)
    let personas = 1;
    if (servicio.usaPersonas) {
      personas = entero(q.personas);
      const tope = Math.min(servicio.maxPersonas || 8, 20);
      if (!personas || personas > tope) {
        return res.render('reservar', { ...vista, paso: 'personas', opciones: Array.from({ length: Math.min(tope, 12) }, (_, i) => ({ n: i + 1, href: enlace(neg, { ...params, personas: i + 1 }) })), tope });
      }
      params = { ...params, personas };
      vista.seleccion.push({ etiqueta: 'Personas', valor: String(personas), href: enlace(neg, { servicio: servicio.id }) });
    }

    // profesional (solo si hay varios y el negocio deja elegir)
    const recursos = neg.cfg.permiteElegirRecurso ? await agenda.recursosPara(empresa.id, servicio.id, null) : [];
    let recursoId = 0;
    if (recursos.length > 1) {
      if (q.profesional === undefined) {
        return res.render('reservar', {
          ...vista, paso: 'profesional',
          opciones: [{ id: 0, nombre: 'Cualquiera disponible', especialidad: 'El primero con lugar', href: enlace(neg, { ...params, profesional: 0 }) },
            ...recursos.map((r) => ({ id: r.id, nombre: r.nombre, especialidad: r.especialidad, href: enlace(neg, { ...params, profesional: r.id }) }))],
        });
      }
      recursoId = recursos.some((r) => r.id === entero(q.profesional)) ? entero(q.profesional) : 0;
      params = { ...params, profesional: recursoId };
      const elegido = recursos.find((r) => r.id === recursoId);
      vista.seleccion.push({ etiqueta: cap(vocab.profesional), valor: elegido ? elegido.nombre : 'Cualquiera disponible', href: enlace(neg, { servicio: servicio.id, ...(servicio.usaPersonas ? { personas } : {}) }) });
    } else if (recursos.length === 1) recursoId = recursos[0].id;

    const motor = { servicioId: servicio.id, recursoId: recursoId || undefined, personas };

    // día
    const fecha = T.esFecha(String(q.fecha || '')) ? String(q.fecha) : null;
    if (!fecha) {
      const desde = T.esFecha(String(q.desde || '')) ? String(q.desde) : vista.hoy;
      const slots = await agenda.horariosLibres(empresa, { ...motor, desde, dias: 14 });
      const porDia = new Map();
      for (const s of slots) porDia.set(s.fecha, (porDia.get(s.fecha) || 0) + 1);
      const dias = [...porDia.entries()];
      const visibles = dias.slice(0, 12);
      // "Ver más días": sigue donde terminó la lista; si no hubo nada en estos 14 días, salta a los 14 siguientes.
      const ultimo = visibles.length ? visibles[visibles.length - 1][0] : desde;
      const siguienteDesde = visibles.length === dias.length ? T.sumarDias(desde, 14) : T.sumarDias(ultimo, 1);
      const hayMas = siguienteDesde <= T.sumarDias(vista.hoy, neg.cfg.diasMaximos);
      return res.render('reservar', {
        ...vista, paso: 'dia', hayDias: dias.length > 0, esPrimera: desde === vista.hoy,
        dias: visibles.map(([f, n]) => ({ fecha: f, etiqueta: cap(T.diaLegible(f, zona)), corto: cortoDia(f, zona), n, href: enlace(neg, { ...params, fecha: f }) })),
        masHref: hayMas ? enlace(neg, { ...params, desde: siguienteDesde }) : null,
      });
    }
    vista.seleccion.push({ etiqueta: 'Día', valor: cap(T.diaLegible(fecha, zona)), href: enlace(neg, params) });
    params = { ...params, fecha };

    // hora
    const hora = T.esHora(String(q.hora || '')) ? String(q.hora) : null;
    if (!hora) {
      const slots = (await agenda.horariosLibres(empresa, { ...motor, desde: fecha, dias: 1 })).filter((s) => s.fecha === fecha);
      if (!slots.length) return res.redirect(enlace(neg, { ...params, fecha: undefined, e: 'invalido' }));
      const fila = (s) => ({ hora: s.hora, href: enlace(neg, { ...params, hora: hhmmUrl(s.hora) }) });
      return res.render('reservar', {
        ...vista, paso: 'hora', manana: slots.filter((s) => s.hora < '12:00').map(fila), tarde: slots.filter((s) => s.hora >= '12:00').map(fila),
      });
    }

    // datos del cliente (se vuelve a comprobar que el horario siga libre)
    const chequeo = await agenda.verificarHorario(empresa, { ...motor, fecha, hora });
    if (!chequeo.ok) return res.redirect(enlace(neg, { ...params, hora: undefined, e: 'ocupado' }));
    vista.seleccion.push({ etiqueta: 'Hora', valor: hora, href: enlace(neg, { ...params, hora: undefined }) });
    return res.render('reservar', {
      ...vista, paso: 'datos', servicio, recurso: chequeo.recurso || null, paises: R.PAISES, codigo: R.codigoPorDefecto(empresa), error: null, valores: {},
      oculto: { servicio: servicio.id, profesional: recursoId, personas, fecha, hora },
      precioTexto: servicio.precio !== null && servicio.precio !== undefined ? `${neg.simbolo} ${Number(servicio.precio).toFixed(2)}` : null,
      diaTexto: cap(T.diaLegible(fecha, zona)),
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------------ reservar

router.post('/:slug', limiteReservar, async (req, res, next) => {
  let neg;
  try {
    neg = await cargarNegocio(req, res);
    if (!neg) return;
    const b = req.body || {};
    // Trampa para robots: un campo que una persona no ve. Si viene lleno, no se hace nada (sin avisar).
    if (String(b.sitio_web || '').trim()) return res.redirect(base(neg));
    const params = { servicio: entero(b.servicio), profesional: entero(b.profesional) || 0, personas: entero(b.personas) || undefined, fecha: b.fecha, hora: b.hora };
    try {
      const { cita, telefono } = await R.reservar(neg.empresa, {
        servicioId: params.servicio, recursoId: params.profesional, personas: params.personas, fecha: b.fecha, hora: b.hora,
        nombre: b.nombre, codigo: b.codigo, telefono: b.telefono,
      });
      return res.redirect(`${base(neg)}/listo/${cita.id}?t=${R.tokenDeCita(cita, telefono)}`);
    } catch (err) {
      if (err instanceof agenda.ErrorAgenda) {
        if (err.codigo === 'HORARIO_OCUPADO') return res.redirect(enlace(neg, { ...params, hora: undefined, e: 'ocupado' }));
        if (err.codigo === 'TOPE_CITAS') return res.redirect(enlace(neg, { ...params, e: 'tope' }));
        return res.redirect(enlace(neg, { ...params, fecha: undefined, hora: undefined, e: 'invalido' }));
      }
      if (!(err instanceof R.ErrorReserva)) throw err;
      // Datos mal escritos: se vuelve al formulario con lo que escribió y el motivo.
      const servicio = await prisma.servicio.findFirst({ where: { id: params.servicio, empresaId: neg.empresa.id, activo: true } });
      if (!servicio || !T.esFecha(String(b.fecha)) || !T.esHora(String(b.hora))) return res.redirect(base(neg));
      const zona = neg.empresa.zonaHoraria;
      return res.status(400).render('reservar', {
        title: `Reservá ${neg.vocab.cita} en ${neg.nombre}`, neg, vocab: neg.vocab, aviso: null, cap, hoy: T.hoy(zona), paso: 'datos', servicio, recurso: null, paises: R.PAISES,
        codigo: String(b.codigo || R.codigoPorDefecto(neg.empresa)), error: err.message, valores: { nombre: String(b.nombre || '').slice(0, 60), telefono: String(b.telefono || '').slice(0, 20) },
        oculto: { servicio: servicio.id, profesional: params.profesional, personas: params.personas || 1, fecha: b.fecha, hora: b.hora },
        seleccion: [{ etiqueta: cap(neg.vocab.servicio), valor: servicio.nombre, href: base(neg) }],
        precioTexto: servicio.precio !== null && servicio.precio !== undefined ? `${neg.simbolo} ${Number(servicio.precio).toFixed(2)}` : null, diaTexto: cap(T.diaLegible(b.fecha, zona)),
      });
    }
  } catch (err) { next(err); }
});

// ------------------------------------------------------------------ confirmación, cancelar y calendario

router.get('/:slug/listo/:id(\\d+)', limiteVer, async (req, res, next) => {
  try {
    const neg = await cargarNegocio(req, res);
    if (!neg) return;
    const cita = await R.citaConToken(neg.empresa.id, req.params.id, req.query.t);
    if (!cita) return res.status(404).render('404', { title: 'Página no encontrada' });
    const zona = neg.empresa.zonaHoraria;
    const activa = ['PENDIENTE', 'CONFIRMADA'].includes(cita.estado);
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.render('reservar-listo', {
      title: `Tu ${neg.vocab.cita} en ${neg.nombre}`, neg, vocab: neg.vocab, cap, cita, activa,
      puedeCancelar: activa && cita.inicio.getTime() > Date.now(), cuando: cap(T.legible(cita.inicio, zona)), token: String(req.query.t),
      mensaje: req.query.ok === 'cancelada' ? 'Tu reserva quedó cancelada.' : null, error: req.query.err ? String(req.query.err).slice(0, 200) : null,
      whatsappTexto: `Hola, soy ${cita.cliente.nombre || ''}. Consulta sobre mi ${neg.vocab.cita} del ${T.legible(cita.inicio, zona)}.`,
    });
  } catch (err) { next(err); }
});

router.post('/:slug/listo/:id(\\d+)/cancelar', limiteCancelar, async (req, res, next) => {
  try {
    const neg = await cargarNegocio(req, res);
    if (!neg) return;
    const t = String((req.body || {}).t || '');
    try {
      await R.cancelarConToken(neg.empresa, req.params.id, t);
      return res.redirect(`${base(neg)}/listo/${req.params.id}?t=${encodeURIComponent(t)}&ok=cancelada`);
    } catch (err) {
      if (!(err instanceof R.ErrorReserva)) throw err;
      if (err.codigo === 'NO_EXISTE') return res.status(404).render('404', { title: 'Página no encontrada' });
      return res.redirect(`${base(neg)}/listo/${req.params.id}?t=${encodeURIComponent(t)}&err=${encodeURIComponent(err.message)}`);
    }
  } catch (err) { next(err); }
});

const escIcs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const fechaIcs = (d) => DateTime.fromJSDate(d, { zone: 'utc' }).toFormat("yyyyMMdd'T'HHmmss'Z'");
router.get('/:slug/listo/:id(\\d+)/calendario.ics', limiteVer, async (req, res, next) => {
  try {
    const neg = await cargarNegocio(req, res);
    if (!neg) return;
    const cita = await R.citaConToken(neg.empresa.id, req.params.id, req.query.t);
    if (!cita) return res.status(404).render('404', { title: 'Página no encontrada' });
    const resumen = `${cita.servicio ? cita.servicio.nombre : cap(neg.vocab.cita)} en ${neg.nombre}`;
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Proshop//Reservas//ES', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:reserva-${cita.id}@${neg.slug}`, `DTSTAMP:${fechaIcs(new Date())}`, `DTSTART:${fechaIcs(cita.inicio)}`, `DTEND:${fechaIcs(cita.fin)}`,
      `SUMMARY:${escIcs(resumen)}`, ...(neg.direccion ? [`LOCATION:${escIcs(neg.direccion)}`] : []), 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="reserva-${cita.id}.ics"`, 'X-Robots-Tag': 'noindex, nofollow' });
    res.send(ics);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.limitar = limitar;
