'use strict';
// lib/services/citasPanel.js
//
// AGENDA del panel (modelo CITAS): las citas de un día, indicadores y cambios de estado. Todo por empresa.
// Reglas de los cambios de estado (para que la agenda no quede incoherente):
//   - PENDIENTE  → CONFIRMADA | CANCELADA
//   - CONFIRMADA → COMPLETADA | NO_ASISTIO | CANCELADA   (completada / no asistió solo cuando la cita ya empezó)
//   - COMPLETADA, NO_ASISTIO y CANCELADA son finales (reabrir una cita podría pisar el cupo de otra).
// Cada cambio "reclama" la cita de forma atómica (updateMany con el estado anterior): dos personas tocando a la vez
// no se pisan.

const { DateTime } = require('luxon');
const { prisma } = require('../db');
const T = require('./tiempo');
const auditoria = require('./auditoria');

const ACTIVAS = ['PENDIENTE', 'CONFIRMADA'];
const TRANSICIONES = {
  PENDIENTE: ['CONFIRMADA', 'CANCELADA'],
  CONFIRMADA: ['COMPLETADA', 'NO_ASISTIO', 'CANCELADA'],
};
const SOLO_SI_YA_EMPEZO = ['COMPLETADA', 'NO_ASISTIO'];

class ErrorCitaPanel extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'CITA'; }
}

const formato = (fecha, zona, f) => DateTime.fromJSDate(fecha, { zone: zona }).toFormat(f);

/** "Recordatorio enviado" / "Recordatorio no enviado (sin plantilla)" a partir de lo que anotó el job. */
function textoRecordatorio(rec) {
  if (!rec) return null;
  const ult = rec['2h'] || rec['24h'];
  if (!ult || ult.estado === 'enviando') return null;
  if (ult.estado === 'enviado') return ult.via === 'plantilla' ? 'Recordatorio enviado (plantilla)' : 'Recordatorio enviado';
  if (ult.estado === 'omitido' && ult.motivo === 'sin_plantilla') return 'Recordatorio no enviado: fuera de las 24 h y sin plantilla';
  if (ult.estado === 'fallo') return 'Recordatorio con error';
  return null;
}

/** Citas de un día (fecha 'YYYY-MM-DD' en la zona del negocio), ordenadas por hora. */
async function delDia(empresa, fecha) {
  const zona = empresa.zonaHoraria;
  const desde = T.aInstante(fecha, '00:00', zona);
  const hasta = T.aInstante(T.sumarDias(fecha, 1), '00:00', zona);
  const citas = await prisma.cita.findMany({
    where: { empresaId: empresa.id, inicio: { gte: desde, lt: hasta } },
    include: { cliente: { select: { nombre: true, nombrePerfil: true, telefono: true } }, servicio: { select: { nombre: true } }, recurso: { select: { nombre: true } } },
    orderBy: [{ inicio: 'asc' }, { id: 'asc' }],
  });
  const ahora = Date.now();
  // Cuenta viva de cada cita (abierta o ya cobrada): para ir a cobrar o ver lo cobrado.
  const cuentas = citas.length ? await prisma.cuenta.findMany({ where: { empresaId: empresa.id, citaId: { in: citas.map((c) => c.id) }, estado: { in: ['ABIERTA', 'COBRADA'] } }, select: { id: true, citaId: true, estado: true, ventaId: true } }) : [];
  const cuentaDe = new Map(cuentas.map((x) => [x.citaId, x]));
  return citas.map((c) => ({
    cuenta: cuentaDe.get(c.id) || null,
    id: c.id, estado: c.estado, origen: c.origen, personas: c.personas, notas: c.notas,
    confirmoAsistencia: Boolean(c.recordatorios && c.recordatorios.confirmada),
    recordatorio: textoRecordatorio(c.recordatorios),
    hora: formato(c.inicio, zona, 'HH:mm'), horaFin: formato(c.fin, zona, 'HH:mm'),
    cliente: c.cliente.nombre || c.cliente.nombrePerfil || 'Cliente sin nombre', telefono: c.cliente.telefono,
    servicio: c.servicio ? c.servicio.nombre : 'Servicio eliminado', recurso: c.recurso ? c.recurso.nombre : null,
    yaEmpezo: c.inicio.getTime() <= ahora,
    acciones: (TRANSICIONES[c.estado] || []).filter((e) => !SOLO_SI_YA_EMPEZO.includes(e) || c.inicio.getTime() <= ahora),
  }));
}

/** Indicadores: hoy, próximos 7 días, pendientes de confirmar y las que no asistieron en los últimos 30 días. */
async function indicadores(empresa) {
  const zona = empresa.zonaHoraria;
  const hoy = T.hoy(zona);
  const ini = (f) => T.aInstante(f, '00:00', zona);
  const [hoyN, proximas, pendientes, noAsistio] = await Promise.all([
    prisma.cita.count({ where: { empresaId: empresa.id, estado: { in: ACTIVAS }, inicio: { gte: ini(hoy), lt: ini(T.sumarDias(hoy, 1)) } } }),
    prisma.cita.count({ where: { empresaId: empresa.id, estado: { in: ACTIVAS }, inicio: { gte: ini(hoy), lt: ini(T.sumarDias(hoy, 8)) } } }),
    prisma.cita.count({ where: { empresaId: empresa.id, estado: 'PENDIENTE', inicio: { gte: new Date() } } }),
    prisma.cita.count({ where: { empresaId: empresa.id, estado: 'NO_ASISTIO', inicio: { gte: ini(T.sumarDias(hoy, -30)), lt: ini(T.sumarDias(hoy, 1)) } } }),
  ]);
  return { hoy: hoyN, proximas7: proximas, pendientes, noAsistio30: noAsistio };
}

/** Cambia el estado de una cita respetando las reglas de arriba. */
async function cambiarEstado(empresa, citaId, estado, usuario = null) {
  const cita = await prisma.cita.findFirst({ where: { id: Number(citaId), empresaId: empresa.id }, include: { servicio: { select: { nombre: true } }, cliente: { select: { nombre: true, telefono: true } } } });
  if (!cita) throw new ErrorCitaPanel('Esa cita no existe.');
  const permitidos = TRANSICIONES[cita.estado] || [];
  if (!permitidos.includes(estado)) throw new ErrorCitaPanel(permitidos.length ? 'Ese cambio no corresponde para esta cita.' : 'Esa cita ya está cerrada: no se puede cambiar.');
  if (SOLO_SI_YA_EMPEZO.includes(estado) && cita.inicio.getTime() > Date.now()) throw new ErrorCitaPanel('Todavía no llegó la hora de esa cita.');
  const reclamo = await prisma.cita.updateMany({ where: { id: cita.id, empresaId: empresa.id, estado: cita.estado }, data: { estado } });
  if (reclamo.count === 0) throw new ErrorCitaPanel('Esa cita acaba de cambiar. Actualizá la página.');
  if (estado === 'CANCELADA') {
    await auditoria.registrarSinRiesgo({
      empresaId: empresa.id, actor: usuario || { nombre: 'Sistema' }, accion: 'CITA_CANCELADA', entidad: 'Cita', entidadId: cita.id,
      detalle: { cliente: cita.cliente.nombre || cita.cliente.telefono, servicio: cita.servicio ? cita.servicio.nombre : '', fecha: formato(cita.inicio, empresa.zonaHoraria, 'yyyy-MM-dd HH:mm') },
    });
  }
  return prisma.cita.findUnique({ where: { id: cita.id } });
}

module.exports = { ErrorCitaPanel, ACTIVAS, TRANSICIONES, delDia, indicadores, cambiarEstado };
