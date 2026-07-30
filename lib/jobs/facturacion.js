// Tarea periodica de facturacion. Antes de este archivo, `vencerPaquetes()` y
// `renovarPeriodo()` existian en suscripciones.js pero NADIE los llamaba: los
// periodos de TODAS las suscripciones (de prueba o pagas) vencian en silencio
// a los 30 dias y el agente dejaba de responder sin aviso para nadie. Este
// job corre en el proceso del servidor (sin dependencias nuevas) y:
//
//   1. Marca VENCIDA toda compra de paquete cuya fecha de renovacion ya paso
//      (hoy el calculo de saldo ya las excluye por fecha, pero el campo
//      "estado" quedaba desactualizado y los reportes del admin lo usaban).
//   2. Cuando una suscripcion ACTIVA vence su periodo, la pasa a MOROSA (no
//      la cancela) y avisa al dueño del negocio en su campanita. MOROSA
//      sigue bloqueada para el agente (ver ESTADOS_CON_SERVICIO en
//      suscripciones.js) hasta que Proshop confirme el pago y alguien
//      renueve el periodo manualmente desde /admin/registrados.
//   3. Cuando una suscripcion en PRUEBA vence, avisa que la prueba termino
//      (no cambia de estado: ya queda bloqueada por fecha).
//
// Es deliberado que esto NO renueve automaticamente ninguna suscripcion:
// no hay pasarela de pago integrada todavia, asi que "renovar solo" sin que
// haya un pago confirmado seria regalar el servicio. Renovar sigue siendo
// una accion manual de Proshop tras confirmar el cobro.

const { prisma } = require('../db');
const { vencerPaquetes } = require('../services/suscripciones');
const notif = require('../services/notificaciones');

const INTERVALO_MS = 60 * 60 * 1000; // revisa cada hora

async function avisarVencimientos() {
  const ahora = new Date();

  const vencidasActivas = await prisma.suscripcion.findMany({
    where: { estado: 'ACTIVA', periodoFin: { lte: ahora } },
  });
  for (const sub of vencidasActivas) {
    await prisma.suscripcion.update({ where: { id: sub.id }, data: { estado: 'MOROSA' } });
    await notif.crear(sub.empresaId, {
      titulo: 'Tu período venció',
      mensaje: 'Tu suscripción venció y tu agente dejó de atender. Coordina el pago con nuestro equipo para reactivarlo.',
      tipo: 'PERIODO_VENCIDO',
      conBotones: true,
    });
  }

  // Prueba vencida: no cambia de estado (ya queda bloqueada por fecha), solo
  // se avisa una vez (evita reavisar cada hora mientras siga sin activar).
  const pruebasVencidas = await prisma.suscripcion.findMany({
    where: { estado: 'PRUEBA', periodoFin: { lte: ahora } },
  });
  for (const sub of pruebasVencidas) {
    const yaAvisado = await prisma.notificacion.findFirst({
      where: { empresaId: sub.empresaId, tipo: 'PRUEBA_VENCIDA' },
    });
    if (yaAvisado) continue;
    await notif.crear(sub.empresaId, {
      titulo: 'Tu período de prueba terminó',
      mensaje: 'Tu agente dejó de atender porque terminó tu prueba. Activa tu plan para seguir vendiendo por WhatsApp.',
      tipo: 'PRUEBA_VENCIDA',
      conBotones: true,
    });
  }
}

async function revisarFacturacion() {
  try {
    const paquetesVencidos = await vencerPaquetes();
    await avisarVencimientos();
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
