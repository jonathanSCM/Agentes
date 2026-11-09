// Tarea periodica de facturacion. Antes de este archivo, `vencerPaquetes()` y
// `renovarPeriodo()` existian en suscripciones.js pero NADIE los llamaba: los
// periodos de TODAS las suscripciones (de prueba o pagas) vencian en silencio
// a los 30 dias y el agente dejaba de responder sin aviso para nadie. Este
// job corre en el proceso del servidor (sin dependencias nuevas) y:
//
//   1. Marca VENCIDA toda compra de paquete cuya fecha de renovacion ya paso
//      (hoy el calculo de saldo ya las excluye por fecha, pero el campo
//      "estado" quedaba desactualizado y los reportes del admin lo usaban).
//   2. Avisos y cortes del plan (lib/services/avisosPlan.js): 7 dias antes, 2 dias
//      antes y el dia del corte; 5 dias de gracia con todo funcionando; pasada la
//      gracia la suscripcion pasa a MOROSA (el agente deja de atender) y avisos de
//      uso de conversaciones al 80 % y 95 %. MOROSA sigue bloqueada para el agente
//      hasta que el superadmin renueve el plan desde /admin/registrados.
//
// Es deliberado que esto NO renueve automaticamente ninguna suscripcion:
// no hay pasarela de pago integrada todavia, asi que "renovar solo" sin que
// haya un pago confirmado seria regalar el servicio. Renovar sigue siendo
// una accion manual de Proshop tras confirmar el cobro.

const { prisma } = require('../db');
const { vencerPaquetes } = require('../services/suscripciones');
const avisosPlan = require('../services/avisosPlan');

const INTERVALO_MS = 60 * 60 * 1000; // revisa cada hora

async function revisarFacturacion() {
  try {
    const paquetesVencidos = await vencerPaquetes();
    const r = await avisosPlan.revisarTodas();
    if (r.avisos) console.log(`--- facturacion: ${r.avisos} aviso(s) de plan enviados`);
    if (paquetesVencidos) console.log(`--- facturacion: ${paquetesVencidos} paquete(s) marcados como VENCIDA`);
  } catch (err) {
    console.error('Error revisando facturacion:', err.message);
  }
}

function iniciarJobFacturacion() {
  revisarFacturacion();
  setInterval(revisarFacturacion, INTERVALO_MS);
}

module.exports = { revisarFacturacion, iniciarJobFacturacion };
