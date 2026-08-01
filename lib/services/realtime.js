// Empuja mensajes nuevos al panel en tiempo real (Socket.IO), para que la
// pantalla de una conversacion se actualice sola sin necesitar F5 — clave
// para que un humano pueda "chatear" desde el panel como si fuera WhatsApp
// Web de verdad.
//
// Comparte la sesion de express-session: el socket solo se conecta si el
// navegador ya tiene una sesion de cliente valida, y se une a una sala por
// empresa (nunca ve mensajes de otro negocio).
let io = null;

function initSocket(server, sessionMiddleware) {
  const { Server } = require('socket.io');
  io = new Server(server);

  const compartirSesion = (socket, next) => sessionMiddleware(socket.request, {}, next);
  io.use(compartirSesion);

  io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.clienteId && session.empresaId) return next();
    next(new Error('No autorizado'));
  });

  io.on('connection', (socket) => {
    const { empresaId } = socket.request.session;
    socket.join(`empresa:${empresaId}`);
  });

  return io;
}

/**
 * Avisa a todo el equipo de una empresa que hay un mensaje nuevo en una
 * conversacion (del cliente, del agente de IA, o de un humano del equipo).
 */
function emitMensaje(empresaId, payload) {
  if (io) io.to(`empresa:${empresaId}`).emit('mensaje:nuevo', payload);
}

/**
 * Avisa que cambio el modo (IA/HUMANO) de una conversacion, para que otros
 * miembros del equipo que la tengan abierta vean quien la tomo.
 */
function emitConversacion(empresaId, payload) {
  if (io) io.to(`empresa:${empresaId}`).emit('conversacion:actualizada', payload);
}

module.exports = { initSocket, emitMensaje, emitConversacion };
