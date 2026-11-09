'use strict';
// lib/services/modulos.js
//
// Bloqueo por MODULO del plan (docs/11): Agente · Punto de venta · Panel comercial.
// El menu solo muestra candados; lo que de verdad protege es este middleware, que se pone en CADA ruta
// (GET y POST) de un modulo. Sin el modulo en el plan del cliente responde 403 con la pantalla
// "este modulo no esta en tu plan".

const { valoresDe, NOMBRES_MODULO } = require('./planesCliente');

const DESCRIPCION = {
  POS: 'Vendé en el mostrador con caja, recibos, impresora térmica y lector de códigos de barras, con el mismo stock que usa tu agente.',
  PANEL: 'Mirá tus ventas, utilidad y margen, comparalas entre WhatsApp y mostrador, y descargá reportes en Excel.',
  AGENTE: 'El agente de ventas por WhatsApp.',
};

/** Middleware: deja pasar solo si el plan del cliente incluye `modulo`. */
function requireModulo(modulo) {
  return async (req, res, next) => {
    try {
      const v = await valoresDe(req.session && req.session.empresaId);
      if (v.modulos.includes(modulo)) return next();
      if (req.method !== 'GET') return res.status(403).type('text/plain').send(`Tu plan no incluye el módulo ${NOMBRES_MODULO[modulo] || modulo}.`);
      return res.status(403).render('cliente/modulo-bloqueado', {
        title: 'Módulo no incluido - Proshop', tituloPagina: NOMBRES_MODULO[modulo] || modulo, activo: '',
        modulo, nombreModulo: NOMBRES_MODULO[modulo] || modulo, descripcion: DESCRIPCION[modulo] || '', planNombre: v.planNombre,
      });
    } catch (err) { return next(err); }
  };
}

module.exports = { requireModulo, DESCRIPCION };
