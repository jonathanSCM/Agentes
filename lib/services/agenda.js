'use strict';
// lib/services/agenda.js
//
// Motor de agenda del modelo de CITAS (portado de AgendaBot): calcula horarios
// libres y crea/mueve/cancela citas. LA IA NUNCA DECIDE SI UN HORARIO ESTA LIBRE:
// siempre pasa por aca (principio del proyecto: el backend decide).
//
// Modelo de capacidad: cada recurso tiene `capacidad`; cada cita consume `carga`
// (1, o la cantidad de personas si el servicio usa personas). Un horario esta
// libre si la suma de cargas solapadas + la nueva <= capacidad. Asi el mismo
// motor sirve para un doctor (capacidad 1) y un salon (40 lugares).
//
// Todo es multi-tenant: cada consulta filtra por empresa.

const { prisma } = require('../db');
const T = require('./tiempo');
const { agendaDe } = require('./configAgenda');
const { fechasCerradas } = require('./feriados');
const limites = require('./limitesCitas');

class ErrorAgenda extends Error {
  constructor(mensaje, codigo = 'AGENDA') {
    super(mensaje);
    this.codigo = codigo;
  }
}

const INACTIVAS = ['CANCELADA', 'NO_ASISTIO'];
const ESTADOS = ['PENDIENTE', 'CONFIRMADA', 'COMPLETADA', 'NO_ASISTIO', 'CANCELADA'];

async function recursosPara(empresaId, servicioId, recursoId) {
  return prisma.recurso.findMany({
    where: {
      empresaId,
      activo: true,
      ...(recursoId ? { id: recursoId } : {}),
      // Un recurso sin servicios asignados atiende todos.
      OR: [{ servicios: { none: {} } }, { servicios: { some: { servicioId } } }],
    },
    orderBy: { id: 'asc' },
  });
}

const cargaDe = (servicio, personas) => (servicio.usaPersonas ? Math.max(1, Number(personas) || 1) : 1);
const solapa = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

/**
 * Horarios libres para un servicio.
 * @returns [{ fecha, hora, inicio: Date, recursos: [{id, nombre}] }] ordenado
 */
async function horariosLibres(empresa, { servicioId, recursoId, desde, dias = 7, personas = 1, excluirCitaId = null, horaExacta = null }) {
  const zona = empresa.zonaHoraria;
  const cfg = agendaDe(empresa);
  const servicio = await prisma.servicio.findFirst({ where: { id: servicioId, empresaId: empresa.id, activo: true } });
  if (!servicio) throw new ErrorAgenda('Servicio inexistente o inactivo.');
  if (servicio.usaPersonas && servicio.maxPersonas && personas > servicio.maxPersonas) {
    throw new ErrorAgenda(`El maximo por reserva es ${servicio.maxPersonas} personas.`);
  }

  const recursos = await recursosPara(empresa.id, servicio.id, recursoId);
  if (!recursos.length) return [];

  const hoyLocal = T.hoy(zona);
  const inicioRango = !desde || desde < hoyLocal ? hoyLocal : desde;
  const maxFecha = T.sumarDias(hoyLocal, cfg.diasMaximos);
  const finRango = [T.sumarDias(inicioRango, dias - 1), maxFecha].sort()[0];
  if (inicioRango > finRango) return [];

  const rangoIni = T.aInstante(inicioRango, '00:00', zona);
  const rangoFin = T.aInstante(T.sumarDias(finRango, 1), '00:00', zona);
  const ids = recursos.map((r) => r.id);

  const [horarios, bloqueos, citas] = await Promise.all([
    prisma.horarioAtencion.findMany({ where: { empresaId: empresa.id } }),
    prisma.bloqueoAgenda.findMany({ where: { empresaId: empresa.id, inicio: { lt: rangoFin }, fin: { gt: rangoIni } } }),
    // El buffer de cada cita alarga su ocupacion: se trae un margen de 1 dia y se afina en memoria.
    prisma.cita.findMany({
      where: {
        empresaId: empresa.id,
        recursoId: { in: ids },
        estado: { notIn: INACTIVAS },
        inicio: { lt: rangoFin },
        fin: { gt: new Date(rangoIni.getTime() - 24 * 60 * 60 * 1000) },
        ...(excluirCitaId ? { id: { not: excluirCitaId } } : {}),
      },
      select: { recursoId: true, inicio: true, fin: true, bufferMin: true, carga: true },
    }),
  ]);
  const ocupadas = citas.filter((c) => c.fin.getTime() + c.bufferMin * 60000 > rangoIni.getTime());

  const feriados = await fechasCerradas(empresa, inicioRango, finRango);
  const generales = horarios.filter((h) => h.recursoId === null);
  const minimoInicio = Date.now() + cfg.anticipacionMin * 60000;
  const carga = cargaDe(servicio, personas);
  const ocupacionMs = (servicio.duracionMin + servicio.bufferMin) * 60000;
  const porHora = new Map();

  for (let fecha = inicioRango; fecha <= finRango; fecha = T.sumarDias(fecha, 1)) {
    if (feriados.has(fecha)) continue;
    const dow = T.diaSemanaDe(fecha);
    for (const r of recursos) {
      const propios = horarios.filter((h) => h.recursoId === r.id);
      const ventanas = (propios.length ? propios : generales).filter((h) => h.diaSemana === dow);
      for (const v of ventanas) {
        const inicioVentana = T.minutos(v.horaInicio);
        const fin = T.minutos(v.horaFin);
        // Con horaExacta se evalua solo ese minuto (el cliente puede pedir 16:15
        // aunque la grilla sea de 30 min: vale si entra en el horario).
        const candidatos = [];
        if (horaExacta) candidatos.push(T.minutos(horaExacta));
        else for (let m = inicioVentana; m + servicio.duracionMin <= fin; m += cfg.intervaloMin) candidatos.push(m);
        for (const m of candidatos) {
          if (m < inicioVentana || m + servicio.duracionMin > fin) continue;
          const hora = T.hhmm(m);
          const ini = T.aInstante(fecha, hora, zona);
          if (!ini || ini.getTime() < minimoInicio) continue;
          const finMs = ini.getTime() + ocupacionMs;

          const bloqueado = bloqueos.some((b) => (b.recursoId === null || b.recursoId === r.id) && solapa(ini.getTime(), finMs, b.inicio.getTime(), b.fin.getTime()));
          if (bloqueado) continue;

          const usada = ocupadas
            .filter((c) => c.recursoId === r.id)
            .filter((c) => solapa(ini.getTime(), finMs, c.inicio.getTime(), c.fin.getTime() + c.bufferMin * 60000))
            .reduce((s, c) => s + c.carga, 0);
          if (usada + carga > r.capacidad) continue;

          const clave = `${fecha} ${hora}`;
          if (!porHora.has(clave)) porHora.set(clave, { fecha, hora, inicio: ini, recursos: [] });
          porHora.get(clave).recursos.push({ id: r.id, nombre: r.nombre });
        }
      }
    }
  }
  return [...porHora.values()].sort((a, b) => a.inicio - b.inicio);
}

/** ¿Ese horario exacto esta libre? Si no, devuelve alternativas del mismo dia. */
async function verificarHorario(empresa, { servicioId, recursoId, fecha, hora, personas, excluirCitaId }) {
  if (!T.esFecha(fecha) || !T.esHora(hora)) return { ok: false, motivo: 'Fecha u hora con formato invalido (usar YYYY-MM-DD y HH:MM).', alternativas: [] };
  const exacto = await horariosLibres(empresa, { servicioId, recursoId, desde: fecha, dias: 1, personas, excluirCitaId, horaExacta: hora });
  const slot = exacto.find((s) => s.fecha === fecha && s.hora === hora);
  if (slot) return { ok: true, recurso: slot.recursos[0] };
  const libres = await horariosLibres(empresa, { servicioId, recursoId, desde: fecha, dias: 1, personas, excluirCitaId });
  const alternativas = libres.slice(0, 4).map((s) => s.hora);
  return {
    ok: false,
    alternativas,
    motivo: alternativas.length ? `Ese horario no esta libre. Ese dia quedan: ${alternativas.join(', ')}.` : 'Ese dia no hay horarios libres para ese servicio.',
  };
}

/**
 * Crea la cita dentro de una transaccion que BLOQUEA la fila del recurso: dos
 * clientes pidiendo el mismo ultimo lugar a la vez no pueden duplicarse.
 * Con excluirCitaId es una reprogramacion: la original se cancela y no gasta cupo del plan.
 */
async function crearCita(empresa, { clienteId, servicioId, recursoId, fecha, hora, personas = 1, origen = 'whatsapp', notas = null, excluirCitaId = null }) {
  if (!excluirCitaId) {
    const tope = await limites.puedeCrearCita(empresa.id);
    if (!tope.ok) throw new ErrorAgenda(`Se alcanzo el tope de citas del plan (${tope.usados} de ${tope.tope} este periodo).`, 'TOPE_CITAS');
  }
  const chequeo = await verificarHorario(empresa, { servicioId, recursoId, fecha, hora, personas, excluirCitaId });
  if (!chequeo.ok) throw new ErrorAgenda(chequeo.motivo, 'HORARIO_OCUPADO');
  const recursoElegido = chequeo.recurso.id;
  const servicio = await prisma.servicio.findFirst({ where: { id: servicioId, empresaId: empresa.id } });
  const inicio = T.aInstante(fecha, hora, empresa.zonaHoraria);
  const fin = new Date(inicio.getTime() + servicio.duracionMin * 60000);
  const finConBuffer = new Date(fin.getTime() + servicio.bufferMin * 60000);
  const carga = cargaDe(servicio, personas);

  const cita = await prisma.$transaction(async (tx) => {
    const [recurso] = await tx.$queryRaw`SELECT "capacidad" FROM "recursos" WHERE "id" = ${recursoElegido} AND "empresaId" = ${empresa.id} FOR UPDATE`;
    if (!recurso) throw new ErrorAgenda('El recurso ya no existe.');
    const [{ usada }] = await tx.$queryRaw`
      SELECT COALESCE(SUM("carga"), 0)::int AS usada FROM "citas"
      WHERE "recursoId" = ${recursoElegido} AND "estado"::text NOT IN ('CANCELADA', 'NO_ASISTIO')
        AND (${excluirCitaId}::int IS NULL OR "id" <> ${excluirCitaId}::int)
        AND "inicio" < ${finConBuffer}::timestamp AND ("fin" + make_interval(mins => "bufferMin")) > ${inicio}::timestamp`;
    if (usada + carga > recurso.capacidad) throw new ErrorAgenda('Ese horario se acaba de ocupar. Elige otro.', 'HORARIO_OCUPADO');

    const nueva = await tx.cita.create({
      data: { empresaId: empresa.id, clienteId, servicioId, recursoId: recursoElegido, inicio, fin, bufferMin: servicio.bufferMin, personas, carga, estado: 'CONFIRMADA', origen, notas },
    });
    if (excluirCitaId) {
      const vieja = await tx.cita.findUnique({ where: { id: excluirCitaId } });
      await tx.cita.update({ where: { id: excluirCitaId }, data: { estado: 'CANCELADA', notas: `${(vieja && vieja.notas) || ''} [reprogramada a cita #${nueva.id}]`.trim() } });
    }
    return nueva;
  });
  if (!excluirCitaId) limites.revisarAvisos(empresa.id, 'citas');
  return cita;
}

async function reprogramarCita(empresa, citaId, { fecha, hora, recursoId, origen }) {
  const actual = await prisma.cita.findFirst({ where: { id: citaId, empresaId: empresa.id } });
  if (!actual || ['CANCELADA', 'COMPLETADA', 'NO_ASISTIO'].includes(actual.estado)) throw new ErrorAgenda('Esa cita no existe o ya no esta activa.');
  return crearCita(empresa, {
    clienteId: actual.clienteId,
    servicioId: actual.servicioId,
    recursoId: recursoId === undefined ? actual.recursoId : recursoId,
    fecha, hora, personas: actual.personas, origen: origen || actual.origen, notas: actual.notas, excluirCitaId: actual.id,
  });
}

async function cambiarEstadoCita(empresa, citaId, estado) {
  if (!ESTADOS.includes(estado)) throw new ErrorAgenda('Estado invalido.');
  const r = await prisma.cita.updateMany({ where: { id: citaId, empresaId: empresa.id }, data: { estado } });
  if (!r.count) throw new ErrorAgenda('Cita inexistente.');
  return prisma.cita.findUnique({ where: { id: citaId } });
}

const cancelarCita = (empresa, citaId) => cambiarEstadoCita(empresa, citaId, 'CANCELADA');

async function citasProximasDeCliente(empresaId, clienteId) {
  return prisma.cita.findMany({
    where: { empresaId, clienteId, estado: { in: ['PENDIENTE', 'CONFIRMADA'] }, inicio: { gt: new Date() } },
    include: { servicio: true, recurso: true },
    orderBy: { inicio: 'asc' },
  });
}

module.exports = { recursosPara, horariosLibres, verificarHorario, crearCita, reprogramarCita, cambiarEstadoCita, cancelarCita, citasProximasDeCliente, ErrorAgenda, ESTADOS };
