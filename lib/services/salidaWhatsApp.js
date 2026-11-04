'use strict';
// lib/services/salidaWhatsApp.js
//
// Manda por WhatsApp lo que armó el motor: lista, pedido de ubicación,
// botones o texto. Si WhatsApp rechaza un mensaje interactivo (título
// demasiado largo, etc.) se cae a texto plano con las opciones, para que el
// cliente nunca se quede sin respuesta.
//
// Lo usan el webhook (server.js) y la recuperación de mensajes pendientes.

const wa = require('./whatsapp');

async function enviarSalidaPorWhatsApp(conexion, telefonoCliente, salida) {
  const textoPlano = salida.textoRegistro || salida.respuesta;
  let envio;
  if (salida.lista) {
    envio = await wa.enviarLista(conexion, telefonoCliente, salida.respuesta, salida.lista);
  } else if (salida.solicitarUbicacion) {
    envio = await wa.enviarSolicitudUbicacion(conexion, telefonoCliente, salida.respuesta);
  } else if (salida.botones && salida.botones.length) {
    envio = await wa.enviarBotones(conexion, telefonoCliente, salida.respuesta, salida.botones);
  } else {
    return wa.enviarTexto(conexion, telefonoCliente, salida.respuesta);
  }
  if (!envio.ok) {
    console.error(`--- whatsapp: fallo el mensaje interactivo a ${telefonoCliente}, se manda como texto: ${envio.error}`);
    envio = await wa.enviarTexto(conexion, telefonoCliente, textoPlano);
  }
  return envio;
}

module.exports = { enviarSalidaPorWhatsApp };
