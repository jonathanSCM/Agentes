'use strict';
// lib/services/limitesRol.js
//
// LÍMITES DE USUARIOS POR ROL (PAVP-5): además del tope total de usuarios, un plan puede limitar cuántos administradores,
// colaboradores, cajeros y profesionales tiene el negocio. Reglas puras (sin base de datos):
//   - El DUEÑO no cuenta en ningún rol (es siempre uno); sí cuenta en el tope total.
//   - Cuentan los usuarios que ya están MÁS las invitaciones pendientes (no vencidas) de ese rol.
//   - Un tope vacío (null) = sin límite para ese rol (solo manda el total). Un tope en 0 = ese rol no se puede usar en ese plan.
//   - Bajar un tope por debajo de lo que ya hay no echa a nadie: solo impide sumar más.

const ROLES = [
  { rol: 'ADMIN', campo: 'maxAdmins', singular: 'administrador', plural: 'administradores', etiqueta: 'Administradores' },
  { rol: 'STAFF', campo: 'maxStaff', singular: 'colaborador', plural: 'colaboradores', etiqueta: 'Colaboradores' },
  { rol: 'CAJERO', campo: 'maxCajeros', singular: 'cajero', plural: 'cajeros', etiqueta: 'Cajeros' },
  { rol: 'PROFESIONAL', campo: 'maxProfesionales', singular: 'profesional', plural: 'profesionales', etiqueta: 'Profesionales' },
];
const CAMPOS = ROLES.map((r) => r.campo);
const POR_ROL = new Map(ROLES.map((r) => [r.rol, r]));

/** El rol con el que quedaría una invitación (mismo criterio que al crearla: lo desconocido es colaborador). */
const rolEfectivo = (rol) => (POR_ROL.has(String(rol)) ? String(rol) : 'STAFF');

const esTope = (v) => v !== null && v !== undefined && v !== '';

/**
 * Cuántos hay y cuántos permite el plan, por rol.
 * @param {{ rol: string }[]} usuarios  los usuarios del negocio
 * @param {{ rol: string }[]} invitaciones  invitaciones pendientes y no vencidas
 * @param {object} limites  `valores.limites` del plan (con maxAdmins, maxStaff, maxCajeros, maxProfesionales)
 * @returns {{ rol, etiqueta, singular, plural, usados, tope, hayTope, lleno }[]}
 */
function estadoPorRol(usuarios = [], invitaciones = [], limites = {}) {
  return ROLES.map((r) => {
    const usados = usuarios.filter((u) => u.rol === r.rol).length + invitaciones.filter((i) => rolEfectivo(i.rol) === r.rol).length;
    const hayTope = esTope(limites[r.campo]);
    const tope = hayTope ? Number(limites[r.campo]) : null;
    return { rol: r.rol, etiqueta: r.etiqueta, singular: r.singular, plural: r.plural, usados, tope, hayTope, lleno: hayTope && usados >= tope };
  });
}

/** ¿Se puede invitar a alguien con este rol? { ok } o { ok:false, mensaje } en palabras del dueño. */
function puedeSumar(rol, usuarios, invitaciones, limites) {
  const e = estadoPorRol(usuarios, invitaciones, limites).find((x) => x.rol === rolEfectivo(rol));
  if (!e || !e.lleno) return { ok: true };
  if (e.tope === 0) return { ok: false, mensaje: `Tu plan no incluye ${e.plural}. Para sumarlos, cambiá de plan o escribinos.` };
  return { ok: false, mensaje: `Tu plan permite ${e.tope} ${e.tope === 1 ? e.singular : e.plural} (contando las invitaciones pendientes). Para sumar más, cambiá de plan o escribinos.` };
}

/** Lo que llega de un formulario del superadmin: vacío = sin límite; si no, un entero de 0 o más. */
function leerTope(valor, nombre = 'El límite') {
  if (valor === '' || valor === null || valor === undefined) return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(`${nombre} tiene que ser un número entero de 0 o más (o vacío para sin límite).`);
  return n;
}

module.exports = { ROLES, CAMPOS, rolEfectivo, estadoPorRol, puedeSumar, leerTope };
