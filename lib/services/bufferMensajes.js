// Agrupa mensajes seguidos del mismo cliente antes de generar la respuesta.
//
// En WhatsApp real la gente escribe fragmentado: "hola" / "quiero una
// mochila" / "que sea negra" en 3 mensajes seguidos en vez de una sola
// frase. Sin esto, cada mensaje disparaba su propia llamada a la IA y su
// propia respuesta: el cliente recibia 3 contestaciones sueltas (una posible
// a medio pensar, con el "hola" solo) en vez de una sola respuesta a la idea
// completa - ademas de gastar 3 llamadas a la IA por lo que es una sola
// intencion de compra.
//
// Cada mensaje se sigue guardando y cobrando al instante (ver
// conversaciones.js:procesarMensajeEntrante); esto SOLO retrasa el momento
// de generar y enviar la respuesta, esperando a que el cliente deje de
// escribir por un rato corto.
// 5 segundos: es el punto medio entre agrupar los mensajes cortos seguidos y
// no dejar al cliente esperando. Estaba en 8s y se sentia lento del otro lado.
// Bajarlo mas agrupa menos y gasta mas llamadas a la IA (cada tanda es una
// llamada); subirlo hace que el cliente sienta que el bot no contesta.
const DEBOUNCE_MS = Number(process.env.MENSAJE_DEBOUNCE_MS || 5000);

const timers = new Map(); // clave (agenteId:telefono) -> Timeout

/**
 * Programa "tarea" para ejecutarse cuando el cliente lleve DEBOUNCE_MS sin
 * mandar un mensaje nuevo. Si llega otro mensaje del mismo cliente antes de
 * que se cumpla el plazo, se cancela lo anterior y se reprograma con la
 * tarea nueva (que ya tiene el contexto mas reciente, porque el historial en
 * BD para ese momento incluye todos los mensajes recibidos hasta ahi).
 */
function encolarRespuesta(clave, tarea) {
  clearTimeout(timers.get(clave));
  const timer = setTimeout(async () => {
    timers.delete(clave);
    try {
      await tarea();
    } catch (err) {
      console.error(`Error generando respuesta agrupada (${clave}):`, err.message);
    }
  }, DEBOUNCE_MS);
  timers.set(clave, timer);
}

module.exports = { encolarRespuesta, DEBOUNCE_MS };
