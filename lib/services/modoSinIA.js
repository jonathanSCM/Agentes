'use strict';
// lib/services/modoSinIA.js
//
// Lo que hace el bot cuando la IA no puede contestar (sin saldo, caida,
// timeout, circuito abierto): sigue vendiendo con reglas y plantillas.
//
//   menu de categorias -> tarjeta de categoria con link al catalogo -> carrito
//   -> cierre (nombre, entrega, ubicacion, pago, resumen) -> pedido.
//
// Todo eso ya lo hace el flujo determinista (flujoDeterminista.js); aca se
// fuerza aunque el agente no tenga el interruptor activado y se agregan las
// respuestas por reglas (preguntas frecuentes, gracias, pedir un asesor).
//
// Regla de oro del proyecto: lo que el sistema no sabe, no se inventa. Horarios,
// costos y plazos de envio NO existen en la base: se deriva a un asesor.
//
// Tambien sirve fuera de las caidas: respuestaPorReglas() contesta sin gastar
// tokens lo que es 100 % predecible (ver generarRespuesta).

const { prisma } = require('../db');
const { responder } = require('./flujoDeterminista');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s?]/g, ' ').replace(/\s+/g, ' ').trim();

const AVISO_CADA_MS = 30 * 60 * 1000; // el "te atiendo con menu" no se repite en cada mensaje

// ------------------------------------------------------------ reglas puras

const RE_ASESOR = /\b(asesor|asesora|humano|persona real|agente humano|operador|encargad[oa]|duen[oa]|vendedor real|hablar con (alguien|una persona|un humano|el due))/;
const RE_PAGO = /(formas? de pago|metodos? de pago|como (puedo )?pago|como se paga|aceptan (qr|tarjeta|efectivo)|puedo pagar|pagar con|se puede pagar)/;
const RE_DIRECCION = /(donde (estan|queda|quedan|se ubican|esta la tienda)|su direccion|direccion de la tienda|tienen (local|tienda)|tienda fisica|sucursal|donde los encuentro)/;
const RE_ENVIO = /(hacen envios?|envian|hacen delivery|tienen delivery|envio a domicilio|llevan a domicilio|cuanto (cuesta|sale|cobran) (el )?(envio|delivery)|costo (del )?envio|retiro en tienda|puedo recoger)/;
const RE_HORARIO = /(horarios?|a que hora (abren|cierran)|hasta que hora|atienden (los )?(sabados?|domingos?)|estan abiertos|abren hoy)/;
const RE_GRACIAS = /^(muchas )?gracias( .{0,12})?$|^(ok |vale |listo |dale |bueno )?(gracias|muchas gracias)$/;
const RE_DESPEDIDA = /^(chao|chau|adios|hasta luego|nos vemos|bye|que tengas buen dia)\W*$/;
const RE_SALUDO = /^(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|ola|saludos)\b/;

function pideAsesor(texto) { return RE_ASESOR.test(norm(texto)); }
function esSaludo(texto) { return RE_SALUDO.test(norm(texto)); }
function esAgradecimiento(texto) { const t = norm(texto); return RE_GRACIAS.test(t) || RE_DESPEDIDA.test(t); }

function formasDePago(config) {
  const l = [];
  if (config && config.aceptaQr) l.push('QR');
  if (!config || config.aceptaEfectivo !== false) l.push('efectivo');
  if (config && config.aceptaTarjeta) l.push('tarjeta');
  return l;
}

const unir = (l) => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}`);

/**
 * Respuesta de texto para una pregunta frecuente, SOLO con datos que la tienda
 * cargo en su configuracion. Devuelve null si el texto no es una de esas
 * preguntas. Nunca inventa horarios, costos ni plazos.
 */
function respuestaPorReglas(texto, { config, empresa } = {}) {
  const t = norm(texto);
  if (!t || t.length > 120) return null;
  const marca = (empresa && (empresa.marca || empresa.nombre)) || 'la tienda';
  const asesor = 'Si querés, escribí "asesor" y una persona te lo confirma.';

  if (RE_GRACIAS.test(t) || RE_DESPEDIDA.test(t)) return '¡Con gusto! Cuando quieras seguir, acá estoy 🙂';
  if (RE_PAGO.test(t)) {
    const formas = formasDePago(config);
    return formas.length
      ? `En ${marca} podés pagar con ${unir(formas)}. ¿Seguimos con tu pedido?`
      : `La forma de pago te la confirma un asesor. ${asesor}`;
  }
  if (RE_DIRECCION.test(t)) {
    return config && config.direccionTienda
      ? `Estamos en: ${config.direccionTienda}. También hacemos entregas a domicilio.`
      : `Todavía no tengo la dirección cargada. ${asesor}`;
  }
  if (RE_ENVIO.test(t)) {
    const retiro = config && config.direccionTienda ? ' y retiro en tienda' : '';
    return `Sí, hacemos entregas a domicilio${retiro}. El costo y el tiempo exacto te los confirma un asesor al cerrar el pedido. ${asesor}`;
  }
  if (RE_HORARIO.test(t)) return `El horario exacto te lo confirma un asesor. ${asesor}`;
  return null;
}

// ------------------------------------------------------------------ modulo

function crearModoSinIA(deps) {
  const {
    flujo, ejecutarFuncion, extraerFiltros, categoriaDelLead,
    datoPendienteParaMostrar, preguntaDeDatoPendiente, logEtapa = () => {},
  } = deps;

  const marcar = (r, paso) => ({ ...r, proveedor: 'sistema', modoSinIA: true, pasoSinIA: paso });

  async function avisarEmpresa(empresaId) {
    try {
      const ya = await prisma.notificacion.findFirst({ where: { empresaId, tipo: 'IA_NO_DISPONIBLE', leida: false } });
      if (ya) return;
      await prisma.notificacion.create({
        data: {
          empresaId,
          tipo: 'IA_NO_DISPONIBLE',
          titulo: 'Tu agente está atendiendo con menú',
          mensaje: 'El servicio de IA no está respondiendo en este momento. Tus clientes pueden seguir viendo el catálogo, armando su carrito y haciendo pedidos con el menú; las preguntas libres quedan en Conversaciones para que las respondas. Se normaliza solo cuando vuelva la IA.',
        },
      });
    } catch (e) { logEtapa('error_aviso_sin_ia', '-', { error: e.message }); }
  }

  /** Aviso de "te atiendo con menu", una vez cada 30 min por cliente. */
  async function conAvisoInicial(lead, r) {
    const ctx = lead.contexto || {};
    const ultimo = ctx.sinIA && ctx.sinIA.avisadoEn;
    if (ultimo && Date.now() - ultimo < AVISO_CADA_MS) return r;
    try {
      const contexto = { ...ctx, sinIA: { ...(ctx.sinIA || {}), avisadoEn: Date.now() } };
      await prisma.clienteFinal.update({ where: { id: lead.id }, data: { contexto } });
      lead.contexto = contexto;
    } catch (e) { /* si no se guarda, solo se repite el aviso */ }
    const intro = 'Estoy atendiendo con menú en este momento, así que puede que no entienda frases largas 🙏 ';
    const texto = `${intro}${r.respuesta}`;
    return { ...r, respuesta: texto, ...(r.textoRegistro ? { textoRegistro: `${intro}${r.textoRegistro}` } : {}) };
  }

  async function guardarPendiente(lead, texto) {
    try {
      const contexto = { ...(lead.contexto || {}), pendienteIA: { texto: String(texto).slice(0, 300), ts: Date.now() } };
      await prisma.clienteFinal.update({ where: { id: lead.id }, data: { contexto } });
      lead.contexto = contexto;
    } catch (e) { /* no es critico */ }
  }

  /**
   * ctx = { agente, productos, lead, mensajeCliente, idBoton, conversacionId, helpers, motivo }
   * Siempre devuelve una respuesta (nunca null) con la forma de generarRespuesta.
   */
  async function responderSinIA(ctx) {
    const { agente, productos, mensajeCliente, idBoton, conversacionId, helpers, motivo } = ctx;
    const tel = helpers.telefonoCliente;
    const texto = String(mensajeCliente || '').trim();
    const empresa = { nombre: helpers.empresaNombre, marca: helpers.empresaMarca };
    // Lead fresco: lo que se guardo durante el turno (categoria, datos) ya esta en la base.
    const lead = (await prisma.clienteFinal.findUnique({ where: { id: ctx.lead.id } })) || ctx.lead;
    const fin = (r, paso) => {
      logEtapa('respuesta_modo_sin_ia', tel, { motivo: motivo || null, paso });
      return marcar(r, paso);
    };
    avisarEmpresa(helpers.empresaId);

    const base = { id: idBoton || null, texto, lead, agente, productos, conversacionId, helpers };

    // 1) El flujo de botones (carrito, cierre, menus): es el corazon del modo sin IA.
    const delFlujo = await flujo.intentar(base);
    if (delFlujo && delFlujo.respuesta) return fin(delFlujo, 'flujo');

    // 2) Pidio una persona.
    if (pideAsesor(texto)) {
      helpers.leadActual = lead;
      const r = await ejecutarFuncion({ name: 'derivar_a_asesor', arguments: { tipo: 'solicitud_expresa', motivo: 'Pidió hablar con una persona (la IA no estaba disponible)' } }, productos, helpers);
      return fin(responder(typeof r === 'string' ? r : 'Listo, aviso a un asesor para que te escriba.'), 'asesor');
    }

    // 3) Preguntas frecuentes y cortesias, con datos reales de la configuracion.
    const porReglas = respuestaPorReglas(texto, { config: agente.config, empresa });
    if (porReglas) return fin(await conAvisoInicial(lead, responder(porReglas, { botones: [{ id: 'menu:rubros', titulo: 'Ver categorías' }] })), 'reglas');

    // 4) Eligio o nombro una categoria: se le piden los datos pendientes o se le muestra la tarjeta.
    const cambios = extraerFiltros(texto, productos, lead.categoriaId) || {};
    const categoria = cambios.categoriaId || delFlujo?.reescribir ? categoriaDelLead(productos, lead) : null;
    if (categoria) {
      const pendiente = datoPendienteParaMostrar(agente.config, lead, productos, categoria);
      if (pendiente) return fin(responder(preguntaDeDatoPendiente(pendiente, categoria.nombre)), 'dato_pendiente');
      const r = await flujo.intentar({ ...base, id: `rubro:${categoria.id}`, texto: '' });
      if (r && r.respuesta) return fin(await conAvisoInicial(lead, r), 'categoria');
    }

    // 5) Nada que el sistema sepa resolver: menu + opcion de asesor, y queda anotado para el equipo.
    await guardarPendiente(lead, texto);
    const menu = await flujo.menuRubros({ ...base, texto: '' }, { saludo: esSaludo(texto) ? '¡Hola! 👋 ' : '' });
    if (menu && menu.respuesta) {
      const conAsesor = { ...menu, respuesta: `${menu.respuesta}\n(Si preferís hablar con una persona, escribí "asesor".)` };
      if (menu.textoRegistro) conAsesor.textoRegistro = `${menu.textoRegistro}\n(Si preferís hablar con una persona, escribí "asesor".)`;
      return fin(await conAvisoInicial(lead, conAsesor), 'menu');
    }
    return fin(responder('Ahora mismo no puedo mostrarte el menú. Escribí "asesor" y una persona te atiende enseguida.'), 'sin_menu');
  }

  return { responderSinIA };
}

module.exports = { crearModoSinIA, respuestaPorReglas, pideAsesor, esSaludo, esAgradecimiento, formasDePago };
