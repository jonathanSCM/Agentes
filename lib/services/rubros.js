'use strict';
// lib/services/rubros.js
//
// Rubros de ARRANQUE del modelo de citas (clinica, salon, restaurante,
// inmobiliaria, otro). Son solo un punto de partida: el vocabulario ("cita" /
// "turno" / "reserva" / "visita"), y datos de ejemplo (servicios, equipo,
// horario) que se cargan como registros comunes. TODO se puede cambiar, borrar o
// ignorar desde el panel: nada queda fijo en el codigo (decision del dueño).
// Idea tomada de AgendaBot (verticales/index.js).

const { prisma } = require('../db');

const PALABRAS_BASE = { cita: 'cita', citas: 'citas', servicio: 'servicio', servicios: 'servicios', profesional: 'profesional', profesionales: 'Profesionales' };

const HORARIO_COMERCIAL = [1, 2, 3, 4, 5].map((d) => [d, '09:00', '18:00']).concat([[6, '09:00', '13:00']]);

const RUBROS = {
  clinica: {
    nombre: 'Clínica / Consultorio',
    vocabulario: { cita: 'cita', citas: 'citas', servicio: 'servicio', servicios: 'servicios', profesional: 'profesional', profesionales: 'Profesionales' },
    horario: HORARIO_COMERCIAL,
    servicios: [
      { nombre: 'Consulta general', duracionMin: 30, precio: 150 },
      { nombre: 'Control / seguimiento', duracionMin: 20, precio: 100 },
      { nombre: 'Limpieza dental', duracionMin: 45, precio: 250 },
    ],
    recursos: [{ nombre: 'Dra. Ana Rojas', especialidad: 'Medicina general' }, { nombre: 'Dr. Luis Paz', especialidad: 'Odontología' }],
  },
  salon: {
    nombre: 'Salón de belleza / Barbería / Spa',
    vocabulario: { cita: 'turno', citas: 'turnos', servicio: 'servicio', servicios: 'servicios', profesional: 'estilista', profesionales: 'Estilistas' },
    horario: [1, 2, 3, 4, 5, 6].map((d) => [d, '10:00', '20:00']),
    servicios: [
      { nombre: 'Corte de cabello', duracionMin: 30, precio: 60 },
      { nombre: 'Corte + barba', duracionMin: 45, precio: 90 },
      { nombre: 'Color / tinte', duracionMin: 120, precio: 300, bufferMin: 15 },
      { nombre: 'Manicure', duracionMin: 45, precio: 80 },
    ],
    recursos: [{ nombre: 'Carla', especialidad: 'Color y cortes' }, { nombre: 'Diego', especialidad: 'Barbería' }],
  },
  restaurante: {
    nombre: 'Restaurante / Café',
    vocabulario: { cita: 'reserva', citas: 'reservas', servicio: 'tipo de reserva', servicios: 'tipos de reserva', profesional: 'área', profesionales: 'Áreas / Salones' },
    horario: [2, 3, 4, 5, 6, 0].flatMap((d) => [[d, '12:00', '15:30'], [d, '19:00', '23:30']]),
    servicios: [{ nombre: 'Reserva de mesa', duracionMin: 90, usaPersonas: true, maxPersonas: 12 }],
    recursos: [{ nombre: 'Salón principal', tipo: 'recurso', capacidad: 40 }, { nombre: 'Terraza', tipo: 'recurso', capacidad: 20 }],
  },
  inmobiliaria: {
    nombre: 'Inmobiliaria',
    vocabulario: { cita: 'visita', citas: 'visitas', servicio: 'servicio', servicios: 'servicios', profesional: 'asesor', profesionales: 'Asesores' },
    horario: HORARIO_COMERCIAL,
    servicios: [{ nombre: 'Visita a propiedad', duracionMin: 45, bufferMin: 15 }, { nombre: 'Asesoría en oficina', duracionMin: 30 }],
    recursos: [{ nombre: 'Asesor comercial', especialidad: 'Ventas y alquileres' }],
  },
  otro: {
    nombre: 'Otro negocio',
    vocabulario: PALABRAS_BASE,
    horario: HORARIO_COMERCIAL,
    servicios: [{ nombre: 'Cita', duracionMin: 30 }],
    recursos: [{ nombre: 'Equipo' }],
  },
};

const lista = () => Object.entries(RUBROS).map(([id, r]) => ({ id, nombre: r.nombre, vocabulario: r.vocabulario }));

/** Las palabras del negocio: las base, las de su rubro y lo que el negocio cambio (lo suyo manda). */
function vocabularioDe(empresa) {
  const rubro = RUBROS[empresa && empresa.rubro];
  const propio = (empresa && empresa.vocabulario) || {};
  const limpio = {};
  for (const [k, v] of Object.entries(propio)) if (k in PALABRAS_BASE && typeof v === 'string' && v.trim()) limpio[k] = v.trim().slice(0, 40);
  return { ...PALABRAS_BASE, ...(rubro ? rubro.vocabulario : {}), ...limpio };
}

/**
 * Carga los datos de ejemplo del rubro SOLO donde el negocio todavia no tiene nada
 * (servicios, equipo, horario por separado), y sin pasarse del tope de servicios del plan.
 * Nunca pisa ni borra lo que el negocio ya cargo.
 * @returns {{ servicios:number, recursos:number, horarios:number, omitidosPorTope:number }}
 */
async function cargarEjemplo(empresaId, rubroId, { topeServicios = Infinity } = {}) {
  const rubro = RUBROS[rubroId];
  if (!rubro) throw new Error('Rubro desconocido.');
  const [nServicios, nRecursos, nHorarios] = await Promise.all([
    prisma.servicio.count({ where: { empresaId } }),
    prisma.recurso.count({ where: { empresaId } }),
    prisma.horarioAtencion.count({ where: { empresaId } }),
  ]);
  const resultado = { servicios: 0, recursos: 0, horarios: 0, omitidosPorTope: 0 };

  if (!nServicios) {
    const activos = await prisma.servicio.count({ where: { empresaId, activo: true } });
    const cupo = Math.max(0, topeServicios - activos);
    const aCrear = rubro.servicios.slice(0, cupo);
    resultado.omitidosPorTope = rubro.servicios.length - aCrear.length;
    for (const [i, s] of aCrear.entries()) await prisma.servicio.create({ data: { empresaId, orden: i, ...s } });
    resultado.servicios = aCrear.length;
  }
  if (!nRecursos) {
    for (const r of rubro.recursos) await prisma.recurso.create({ data: { empresaId, ...r } });
    resultado.recursos = rubro.recursos.length;
  }
  if (!nHorarios) {
    await prisma.horarioAtencion.createMany({ data: rubro.horario.map(([diaSemana, horaInicio, horaFin]) => ({ empresaId, diaSemana, horaInicio, horaFin })) });
    resultado.horarios = rubro.horario.length;
  }
  return resultado;
}

module.exports = { RUBROS, lista, vocabularioDe, cargarEjemplo, PALABRAS_BASE };
