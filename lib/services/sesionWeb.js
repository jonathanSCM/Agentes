// Token de sesion para el catalogo web publico.
//
// El catalogo (/catalogo/:slug) no tiene login: el cliente llega desde un
// link que le manda el bot por WhatsApp. Para que la web sepa "quien sos"
// sin pedirle usuario/contrasena, el bot firma un token con la identidad que
// YA conoce (empresa + telefono + conversacion) y se lo pasa en la URL. La
// web valida ese token en cada accion que toca el carrito; sin token valido
// se puede mirar el catalogo pero no agregar nada (evita que cualquiera
// escriba el carrito de otro cliente adivinando o copiando una URL vieja).
//
// Puro: nada de DB ni red, se testea sin levantar nada (igual que carrito.js).

const crypto = require('crypto');

const SEPARADOR = '.';
const MINUTOS_DE_VIDA_POR_DEFECTO = 60 * 24; // 24h: el link no deberia durar mas que la conversacion misma.

// Reusa la misma variable de entorno que ya protege los tokens de WhatsApp
// cifrados (ver lib/crypto.js) en vez de pedir una nueva. Mismo fallback de
// desarrollo que ahi: en produccion, lib/crypto.js ya revienta el arranque
// si falta, asi que para cuando esto se ejecuta la variable real ya esta.
const SECRETO = process.env.APP_ENCRYPTION_KEY || 'clave-de-desarrollo-cambia-esto-en-produccion';

function firmar(payloadTexto) {
  return crypto.createHmac('sha256', SECRETO).update(payloadTexto).digest('base64url');
}

/**
 * Genera un token para que el cliente pueda agregar al carrito desde la web
 * sin loguearse. Codifica lo minimo indispensable: con que empresa/telefono/
 * conversacion actuar, y cuando vence.
 */
function generarTokenSesion({ empresaId, telefono, conversacionId }, minutosDeVida = MINUTOS_DE_VIDA_POR_DEFECTO) {
  if (!empresaId || !telefono) throw new Error('generarTokenSesion necesita empresaId y telefono.');
  const vence = Date.now() + minutosDeVida * 60 * 1000;
  const payload = { empresaId, telefono, conversacionId: conversacionId || null, vence };
  const payloadTexto = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const firma = firmar(payloadTexto);
  return `${payloadTexto}${SEPARADOR}${firma}`;
}

/**
 * Valida un token recibido por query param. Devuelve el payload si es
 * valido y no vencio, o null si es invalido/manipulado/vencido - nunca
 * tira una excepcion por un token malformado (puede venir de cualquier
 * lado, un usuario pegando una URL rota no puede romper la pagina).
 */
function verificarTokenSesion(token) {
  if (!token || typeof token !== 'string' || !token.includes(SEPARADOR)) return null;
  const [payloadTexto, firma] = token.split(SEPARADOR);
  if (!payloadTexto || !firma) return null;

  const firmaEsperada = firmar(payloadTexto);
  // Comparacion en tiempo constante: es una firma de seguridad, no un id
  // cualquiera - no queremos filtrar por timing cuanto de la firma coincide.
  const bufA = Buffer.from(firma);
  const bufB = Buffer.from(firmaEsperada);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadTexto, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.vence !== 'number' || Date.now() > payload.vence) return null;
  if (!payload.empresaId || !payload.telefono) return null;
  return payload;
}

module.exports = { generarTokenSesion, verificarTokenSesion, MINUTOS_DE_VIDA_POR_DEFECTO };
