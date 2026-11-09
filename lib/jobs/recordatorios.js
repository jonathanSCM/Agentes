'use strict';
// Tarea periodica de recordatorios de citas (lib/services/recordatorios.js). Corre en el proceso del servidor cada pocos
// minutos; cada recordatorio se reclama de forma atomica, asi que aunque haya dos instancias no se manda dos veces.

const recordatorios = require('../services/recordatorios');

const INTERVALO_MS = 5 * 60 * 1000;

async function revisarRecordatorios() {
  try {
    const r = await recordatorios.procesar();
    if (r.enviadas || r.fallos) console.log(`--- recordatorios: ${r.enviadas} enviado(s), ${r.omitidas} omitido(s), ${r.fallos} con fallo`);
  } catch (err) {
    console.error('Error revisando recordatorios:', err.message);
  }
}

function iniciarJobRecordatorios() {
  const t = setInterval(revisarRecordatorios, INTERVALO_MS);
  if (t.unref) t.unref();
  return t;
}

module.exports = { revisarRecordatorios, iniciarJobRecordatorios };
