'use strict';
// lib/services/flujoDeterminista.js
//
// Maquina de estados del backend para el recorrido de venta: menus (listas),
// "¿algo mas?", edicion de carrito y cierre (nombre, entrega, ubicacion,
// pago, resumen, confirmacion). Todo con plantillas: 0 llamadas a la IA.
//
// Solo corre para los agentes con AgenteConfig.flujoDeterminista = true (ver
// generarRespuesta en agente.js). Con el flag apagado nada de esto se usa.
//
// Contrato de intentar(ctx):
//   - devuelve una respuesta  { ok, respuesta, botones?, lista?, solicitarUbicacion?, textoRegistro?, fotos }
//     -> generarRespuesta la retorna tal cual (cuesta 0 llamadas a la IA).
//   - devuelve { reescribir: 'texto' } -> la IA sigue, pero con ese texto como mensaje del cliente.
//   - devuelve null -> no es asunto del flujo: sigue el camino de siempre (IA).
//
// ctx = { id, texto, lead, agente, productos, conversacionId, helpers }
//   id = ID del boton/lista que toco el cliente (null si escribio texto).
//
// Estado persistido en ClienteFinal.contexto.flujo = { paso, ts, intentos }.
// Pasos: NOMBRE | ENTREGA | UBICACION | PAGO | CONFIRMAR. Sin paso = el flujo no espera nada.

const { prisma } = require('../db');
const { carritoDe, guardarCarrito, quitarItem, resumenCarrito } = require('./carrito');

const TTL_PASO_MS = 2 * 60 * 60 * 1000; // un paso abandonado mas de 2 h se olvida
const MAX_INTENTOS = 3; // reintentos de un mismo paso antes de ceder a la IA
const FILAS_MAX = 10; // limite de WhatsApp para mensajes tipo lista

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const recortar = (s, n) => { const t = String(s || ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Palabras que NUNCA son un nombre de persona: lo que el cliente suele escribir
// cuando el bot le pregunta otra cosa ("nada mas", "ok", "terminar"...). El
// nombreValido global es muy permisivo (lo usa el camino de IA, que entiende
// el contexto); un formulario por codigo necesita ser estricto.
const PALABRAS_QUE_NO_SON_NOMBRE = new Set([
  'ok', 'okay', 'oka', 'okey', 'nada', 'mas', 'si', 'no', 'listo', 'lista', 'gracias', 'hola', 'buenas', 'buenos',
  'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'quiero', 'quisiera', 'necesito', 'deseo', 'terminar', 'termina',
  'finalizar', 'cancelar', 'dale', 'claro', 'ya', 'eso', 'es', 'todo', 'nomas', 'menu', 'volver', 'confirmo',
  'confirmar', 'confirmado', 'editar', 'ver', 'comprar', 'otra', 'otro', 'seguir', 'pedido', 'pedir', 'como', 'que',
  'cuanto', 'donde', 'cual', 'bien', 'bueno', 'perfecto', 'correcto', 'vale', 'ninguno', 'ninguna', 'cliente', 'usuario',
  'nn', 'xx',
]);

/**
 * ¿Parece un nombre de persona? Maximo 3 palabras, solo letras (con tildes,
 * apostrofe o guion), 2-20 caracteres por palabra y ninguna palabra de la lista
 * de exclusion. Falsos negativos son baratos (se vuelve a preguntar, y a los 3
 * intentos cede a la IA); un falso positivo guarda basura como nombre del pedido.
 */
function nombrePlausible(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 60) return false;
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'’\- ]+$/.test(t)) return false;
  const palabras = t.split(' ');
  if (palabras.length > 3) return false;
  return palabras.every((w) => w.length >= 2 && w.length <= 20 && !PALABRAS_QUE_NO_SON_NOMBRE.has(norm(w)));
}

// Texto plano de lo que se mostro (lista o botones): es lo que queda en el
// historial y en el panel, para que la IA y el equipo vean que opciones tenia
// el cliente cuando el flujo le contesto con una lista o botones.
function textoDeOpciones(texto, extra) {
  if (extra.lista) {
    const filas = (extra.lista.secciones || []).flatMap((s) => s.filas);
    return `${texto}\n${filas.map((f, i) => `${i + 1}. ${f.titulo}`).join('\n')}`;
  }
  if (extra.botones && extra.botones.length) {
    return `${texto}\n${extra.botones.map((b) => `• ${b.titulo}`).join('\n')}`;
  }
  return texto;
}

const responder = (texto, extra = {}) => {
  const r = { ok: true, demo: false, proveedor: 'sistema', modelo: null, respuesta: texto, fotos: [], ...extra };
  const registro = textoDeOpciones(texto, extra);
  if (registro !== texto) r.textoRegistro = registro;
  return r;
};

const BOTONES_ALGO_MAS = [
  { id: 'mas:si', titulo: 'Seguir comprando' },
  { id: 'mas:no', titulo: 'Finalizar' },
  { id: 'mas:ver', titulo: 'Ver carrito' },
];

function crearFlujo(deps) {
  const {
    ejecutarFuncion, nombreValido, extraerUrlDeMaps, resolverCoordenadas,
    arbolDeCategorias, subcategoriasDe, limpiezaPorCambioDeCategoria,
    atributosFaltantes, preguntasInicialesFaltantes, formatearPrecio,
    pareceQuererVerOtraCosa, pareceQuererCatalogoCompleto,
    logEtapa = () => {},
  } = deps;

  // ---------------------------------------------------------------- estado

  function pasoActual(lead) {
    const f = (lead.contexto || {}).flujo;
    if (!f || !f.paso) return null;
    if (Date.now() - (f.ts || 0) > TTL_PASO_MS) return null;
    return f;
  }

  async function guardar(lead, datos) {
    await prisma.clienteFinal.update({ where: { id: lead.id }, data: datos });
    Object.assign(lead, datos);
  }

  // ejecutarFuncion (confirmar_pedido, crear_pedido, mostrar_tarjeta_categoria)
  // guarda cosas en ClienteFinal.contexto por su cuenta (firma del resumen,
  // carrito vaciado, tarjetas ya mostradas). Si despues el flujo escribiera el
  // contexto desde su copia en memoria, PISARIA eso con datos viejos: despues
  // de cada tool se relee el lead.
  async function refrescar(lead) {
    const fresco = await prisma.clienteFinal.findUnique({ where: { id: lead.id } });
    if (fresco) Object.assign(lead, fresco);
  }

  async function fijarPaso(lead, paso) {
    const contexto = { ...(lead.contexto || {}), flujo: paso ? { paso, ts: Date.now(), intentos: 0 } : null };
    await guardar(lead, { contexto });
  }

  async function sumarIntento(lead) {
    const f = (lead.contexto || {}).flujo || {};
    const intentos = (f.intentos || 0) + 1;
    await guardar(lead, { contexto: { ...(lead.contexto || {}), flujo: { ...f, intentos, ts: Date.now() } } });
    return intentos;
  }

  const itemsDe = (ctx) => carritoDe(ctx.lead.contexto || {}, ctx.conversacionId);
  const precio = (ctx, monto) => formatearPrecio(monto, ctx.helpers.moneda);
  const textoCarrito = (ctx) => resumenCarrito(itemsDe(ctx), (m) => precio(ctx, m));

  // ----------------------------------------------------------------- menus

  function filasPaginadas(filas, pagina, idMas) {
    if (filas.length <= FILAS_MAX) return filas;
    const porPagina = FILAS_MAX - 1; // deja una fila para "Ver mas"
    const desde = pagina * porPagina;
    const visibles = filas.slice(desde, desde + porPagina);
    if (desde + porPagina < filas.length) visibles.push({ id: idMas(pagina + 1), titulo: 'Ver más ▸' });
    return visibles;
  }

  async function menuRubros(ctx, { saludo = '', pagina = 0 } = {}) {
    const arbol = arbolDeCategorias(ctx.productos, ctx.lead);
    if (!arbol.length) return null;
    // Una sola categoria sin tipos: no hay nada que elegir.
    if (arbol.length === 1 && !arbol[0].subcategorias.length) return seleccionarCategoria(ctx, arbol[0].id, saludo);
    const filas = arbol.map((r) => ({ id: `rubro:${r.id}`, titulo: recortar(r.nombre, 24) }));
    return responder(`${saludo}Esto es lo que tenemos, ¿cuál te interesa?`, {
      lista: {
        boton: 'Ver categorías',
        secciones: [{ titulo: 'Categorías', filas: filasPaginadas(filas, pagina, (n) => `menu:pag:rubros:${n}`) }],
      },
    });
  }

  function buscarCategoria(productos, id) {
    for (const p of productos) {
      if (p.categoria && p.categoria.id === id) return p.categoria;
      if (p.categoria && p.categoria.padre && p.categoria.padre.id === id) return p.categoria.padre;
    }
    return null;
  }

  function listaSubcategorias(ctx, cat, pagina = 0) {
    const subs = subcategoriasDe(ctx.productos, cat.id, ctx.lead);
    if (!subs.length) return null;
    const filas = subs.map((s) => ({
      id: `sub:${s.id}`,
      titulo: recortar(s.nombre, 24),
      descripcion: s.productos ? `${s.productos} modelo${s.productos === 1 ? '' : 's'}` : undefined,
    }));
    return responder(`Dentro de ${cat.nombre}, ¿qué tipo buscás?`, {
      lista: {
        boton: 'Ver tipos',
        secciones: [{ titulo: recortar(cat.nombre, 24), filas: filasPaginadas(filas, pagina, (n) => `menu:pag:sub:${cat.id}:${n}`) }],
      },
    });
  }

  async function seleccionarCategoria(ctx, id, saludo = '') {
    const { lead, productos } = ctx;
    const cat = buscarCategoria(productos, id);
    if (!cat) return menuRubros(ctx, {});
    const datos = { categoriaId: cat.id, categoriaInteres: cat.nombre };
    if (cat.id !== lead.categoriaId) Object.assign(datos, limpiezaPorCambioDeCategoria(lead, productos, cat.id));
    await guardar(lead, datos);

    // Datos obligatorios pendientes (ej. Genero): los pregunta la IA, como hoy.
    const falta = preguntasInicialesFaltantes(ctx.agente.config, lead, productos).length
      || atributosFaltantes(cat, lead, 'OBLIGATORIO').length;
    if (falta) return { reescribir: `Me interesa ${cat.nombre}` };

    if (!cat.padreId) {
      const sub = listaSubcategorias(ctx, cat);
      if (sub) return sub;
    }
    ctx.helpers.leadActual = lead;
    const r = await ejecutarFuncion({ name: 'mostrar_tarjeta_categoria', arguments: {} }, productos, ctx.helpers);
    await refrescar(lead);
    if (typeof r === 'string' && r.startsWith('TOOL_SUCCESS')) {
      return responder(
        `${saludo}Échale un vistazo a ${cat.nombre.toLowerCase()} 👆 Cuando algo te guste, decime el nombre del modelo o abrilo en el catálogo.`,
        { fotos: ctx.helpers.fotosParaMostrar || [] },
      );
    }
    if (typeof r === 'string' && r.includes('Ya le mandaste esto')) {
      return responder('Ese catálogo ya te lo mostré 👆 ¿Qué modelo te interesó? Decime el nombre, o elegí otra categoría.', {
        botones: [{ id: 'menu:rubros', titulo: 'Otra categoría' }],
      });
    }
    return { reescribir: `Me interesa ${cat.nombre}` };
  }

  // --------------------------------------------------------------- carrito

  function botonesLinea(pid, vid) {
    return [
      { id: `cant:menos:${pid}:${vid}`, titulo: '➖ 1' },
      { id: `cant:mas:${pid}:${vid}`, titulo: '➕ 1' },
      { id: `cant:quitar:${pid}:${vid}`, titulo: 'Quitar' },
    ];
  }

  function verCarrito(ctx) {
    if (!itemsDe(ctx).length) {
      return responder('Tu carrito está vacío.', { botones: [{ id: 'mas:si', titulo: 'Ver categorías' }] });
    }
    return responder(`Esto llevás:\n${textoCarrito(ctx)}`, {
      botones: [
        { id: 'mas:si', titulo: 'Seguir comprando' },
        { id: 'mas:no', titulo: 'Finalizar' },
        { id: 'carrito:editar', titulo: 'Editar carrito' },
      ],
    });
  }

  function editarCarrito(ctx) {
    const items = itemsDe(ctx).slice(0, FILAS_MAX);
    if (!items.length) return verCarrito(ctx);
    const filas = items.map((i) => ({
      id: `item:${i.productoId}:${i.varianteId || 0}`,
      titulo: recortar(i.nombre, 24),
      descripcion: `${i.cantidad}x · ${precio(ctx, i.precio)} c/u`,
    }));
    return responder('¿Qué producto querés cambiar?', {
      lista: { boton: 'Elegir producto', secciones: [{ titulo: 'Tu carrito', filas }] },
    });
  }

  async function ajustarCantidad(ctx, op, pid, vid) {
    let items = itemsDe(ctx);
    const linea = items.find((i) => i.productoId === pid && (i.varianteId || 0) === vid);
    if (!linea) return verCarrito(ctx);
    const nueva = op === 'mas' ? linea.cantidad + 1 : op === 'menos' ? linea.cantidad - 1 : 0;
    if (op === 'mas') {
      // Valida contra lo ya acumulado, no solo contra la unidad nueva.
      const fila = vid
        ? await prisma.variante.findUnique({ where: { id: vid }, select: { stock: true } })
        : await prisma.producto.findUnique({ where: { id: pid }, select: { stock: true } });
      if (fila && nueva > fila.stock) {
        return responder(`No hay más stock: quedan ${fila.stock}.`, { botones: botonesLinea(pid, vid) });
      }
    }
    if (nueva < 1) items = quitarItem(items, { productoId: pid, varianteId: vid || null });
    else items = items.map((i) => (i === linea ? { ...i, cantidad: nueva } : i));
    await guardar(ctx.lead, { contexto: guardarCarrito(ctx.lead.contexto || {}, ctx.conversacionId, items) });
    return verCarrito(ctx);
  }

  // ---------------------------------------------------------------- cierre

  function metodosDePago(config) {
    return [
      config && config.aceptaQr ? { id: 'pago:QR', titulo: 'QR' } : null,
      !config || config.aceptaEfectivo !== false ? { id: 'pago:EFECTIVO', titulo: 'Efectivo' } : null,
      config && config.aceptaTarjeta ? { id: 'pago:TARJETA', titulo: 'Tarjeta' } : null,
    ].filter(Boolean);
  }

  const pedirUbicacion = (texto) => responder(texto, { solicitarUbicacion: true });

  // Pide la PRIMERA cosa que falta, en el mismo orden que exige confirmar_pedido.
  async function avanzarCierre(ctx) {
    const { lead, agente } = ctx;
    const config = agente.config;
    if (!itemsDe(ctx).length) {
      await fijarPaso(lead, null);
      return responder('Tu carrito está vacío. ¿Qué te muestro?', { botones: [{ id: 'mas:si', titulo: 'Ver categorías' }] });
    }
    // Un nombre YA guardado se juzga con el mismo criterio que confirmar_pedido
    // (nombreValido): si el flujo fuera mas estricto aca, un cliente con nombre de
    // 4 palabras seria interrogado en bucle. La regla estricta es solo para lo nuevo.
    if (!nombreValido(lead.nombre)) {
      await fijarPaso(lead, 'NOMBRE');
      return responder('¿A nombre de quién hago el pedido?');
    }
    if (!lead.tipoEntrega) {
      if (!(config && config.direccionTienda)) {
        await guardar(lead, { tipoEntrega: 'DOMICILIO' });
        return avanzarCierre(ctx);
      }
      await fijarPaso(lead, 'ENTREGA');
      return responder('¿Cómo preferís recibirlo?', {
        botones: [{ id: 'cierre:domicilio', titulo: 'A domicilio' }, { id: 'cierre:recojo', titulo: 'Retiro en tienda' }],
      });
    }
    if (lead.tipoEntrega === 'DOMICILIO' && !lead.ubicacionLat) {
      await fijarPaso(lead, 'UBICACION');
      return pedirUbicacion('Para la entrega necesito tu ubicación. Tocá el botón y compartila, o pegame el link de Google Maps.');
    }
    if (!lead.formaPago) {
      const metodos = metodosDePago(config);
      if (!metodos.length) return null; // sin formas de pago configuradas: lo resuelve la IA / un asesor
      if (metodos.length === 1) {
        await guardar(lead, { formaPago: metodos[0].id.split(':')[1] });
        return avanzarCierre(ctx);
      }
      await fijarPaso(lead, 'PAGO');
      return responder('¿Cómo preferís pagar?', { botones: metodos });
    }
    return mostrarResumen(ctx);
  }

  async function mostrarResumen(ctx) {
    const { lead } = ctx;
    // confirmar_pedido rechaza re-mostrar un resumen ya confirmado en un turno anterior:
    // se limpia la marca para que el resumen siempre refleje los datos actuales.
    await guardar(lead, { contexto: { ...(lead.contexto || {}), resumenConfirmado: null, resumenConfirmadoEnTurno: null } });
    ctx.helpers.leadActual = lead;
    const r = await ejecutarFuncion({ name: 'confirmar_pedido', arguments: {} }, ctx.productos, ctx.helpers);
    await refrescar(lead);
    if (typeof r !== 'string' || !r.startsWith('TOOL_SUCCESS')) {
      if (typeof r === 'string' && r.includes('No hay stock suficiente')) {
        return responder(`Algún producto ya no tiene stock suficiente. Revisemos tu carrito 👇\n${textoCarrito(ctx)}`, {
          botones: [{ id: 'carrito:editar', titulo: 'Editar carrito' }, { id: 'mas:si', titulo: 'Seguir comprando' }],
        });
      }
      return null;
    }
    const bloque = r.replace(/^TOOL_SUCCESS\.[^\n]*\n/, '').split('\n\nTu texto ahora:')[0].trim();
    await fijarPaso(lead, 'CONFIRMAR');
    return responder(`Este es el resumen de tu pedido:\n${bloque}\n\n¿Está todo bien?`, {
      botones: [{ id: 'cierre:confirmar', titulo: 'Confirmar ✅' }, { id: 'cierre:editar', titulo: 'Editar' }],
    });
  }

  async function crearPedido(ctx) {
    const { lead } = ctx;
    ctx.helpers.leadActual = lead;
    const r = await ejecutarFuncion({ name: 'crear_pedido', arguments: {} }, ctx.productos, ctx.helpers);
    await refrescar(lead);
    if (typeof r === 'string' && r.startsWith('TOOL_SUCCESS')) {
      await fijarPaso(lead, null);
      const n = (r.match(/pedido #(\d+)/) || [])[1];
      const qr = lead.formaPago === 'QR'
        ? (r.includes('El QR de pago SI se mando')
          ? ' Te envié el QR 👆 Cuando pagues, mandame el comprobante por acá.'
          : ' Un asesor te va a enviar el QR de pago en un momento.')
        : '';
      const coordina = lead.tipoEntrega === 'RECOJO' ? 'el retiro' : 'la entrega';
      return responder(`¡Listo! Tu pedido${n ? ` #${n}` : ''} quedó registrado ✅${qr} Un asesor va a coordinar ${coordina} con vos.`);
    }
    // "TODAVIA NO crees...": el carrito cambio desde el resumen (boton viejo) o falta
    // stock -> se muestra el resumen de nuevo, nunca se crea un pedido no confirmado.
    return mostrarResumen(ctx);
  }

  // ------------------------------------------------------- entradas por ID

  async function porId(ctx, id) {
    const p = id.split(':');
    const { lead } = ctx;
    switch (p[0]) {
      case 'menu':
        if (p[1] === 'rubros') return menuRubros(ctx, {});
        if (p[1] === 'pag' && p[2] === 'rubros') return menuRubros(ctx, { pagina: Number(p[3]) || 0 });
        if (p[1] === 'pag' && p[2] === 'sub') {
          const cat = buscarCategoria(ctx.productos, Number(p[3]));
          return cat ? listaSubcategorias(ctx, cat, Number(p[4]) || 0) : menuRubros(ctx, {});
        }
        return undefined;
      case 'rubro':
      case 'sub':
        return seleccionarCategoria(ctx, Number(p[1]));
      case 'mas':
        if (p[1] === 'si') return menuRubros(ctx, {});
        if (p[1] === 'no') return avanzarCierre(ctx);
        if (p[1] === 'ver') return verCarrito(ctx);
        return undefined;
      case 'carrito':
        return p[1] === 'editar' ? editarCarrito(ctx) : undefined;
      case 'item':
        return responder('¿Qué hacemos con este producto?', { botones: botonesLinea(Number(p[1]), Number(p[2]) || 0) });
      case 'cant':
        return ajustarCantidad(ctx, p[1], Number(p[2]), Number(p[3]) || 0);
      case 'cierre':
        if (p[1] === 'domicilio' || p[1] === 'recojo') {
          await guardar(lead, { tipoEntrega: p[1] === 'domicilio' ? 'DOMICILIO' : 'RECOJO' });
          return avanzarCierre(ctx);
        }
        if (p[1] === 'confirmar') return crearPedido(ctx);
        if (p[1] === 'editar') {
          await fijarPaso(lead, null);
          return responder('¿Qué querés cambiar?', {
            lista: {
              boton: 'Elegir',
              secciones: [{
                titulo: 'Editar pedido',
                filas: [
                  { id: 'editar:nombre', titulo: 'Nombre' },
                  { id: 'editar:entrega', titulo: 'Tipo de entrega' },
                  { id: 'editar:ubicacion', titulo: 'Ubicación' },
                  { id: 'editar:pago', titulo: 'Forma de pago' },
                  { id: 'editar:productos', titulo: 'Productos' },
                ],
              }],
            },
          });
        }
        return undefined;
      case 'editar': {
        if (p[1] === 'productos') return editarCarrito(ctx);
        const limpiar = {
          nombre: { nombre: null },
          entrega: { tipoEntrega: null, ubicacionLat: null, ubicacionLng: null, direccionEntrega: null },
          ubicacion: { ubicacionLat: null, ubicacionLng: null, direccionEntrega: null },
          pago: { formaPago: null },
        }[p[1]];
        if (!limpiar) return undefined;
        await guardar(lead, limpiar);
        return avanzarCierre(ctx);
      }
      case 'pago': {
        if (!itemsDe(ctx).length) return undefined;
        // Solo formas de pago que esta tienda realmente acepta (un boton viejo
        // de una tienda que ya no acepta QR no puede colar un metodo invalido).
        const validos = metodosDePago(ctx.agente.config).map((m) => m.id.split(':')[1]);
        if (!validos.includes(p[1])) return undefined;
        await guardar(lead, { formaPago: p[1] });
        return avanzarCierre(ctx);
      }
      default:
        return undefined;
    }
  }

  // ----------------------------------------------------- entradas por texto

  function preguntabaAlgoMas(ctx) {
    return /algo m[aá]s|qu[eé] hacemos/i.test(String(ctx.helpers.ultimoMensajeAgente || ''));
  }

  async function porTexto(ctx, f, texto) {
    const { lead } = ctx;
    const t = norm(texto);

    // Escape: quiere ver otra cosa en medio del cierre -> menu, y el cierre se retoma con "Finalizar".
    if (pareceQuererCatalogoCompleto(texto) || pareceQuererVerOtraCosa(texto) || /^(cancelar|menu|volver)\W*$/.test(t)) {
      await fijarPaso(lead, null);
      return menuRubros(ctx, { saludo: 'Claro. ' });
    }

    switch (f.paso) {
      case 'NOMBRE': {
        if (texto.includes('?')) return null; // es una pregunta: que la responda la IA
        const nombre = texto.replace(/^(me llamo|mi nombre es|soy|a nombre de)\s+/i, '').replace(/\s+/g, ' ').trim();
        if (!nombrePlausible(nombre)) {
          if ((await sumarIntento(lead)) >= MAX_INTENTOS) { await fijarPaso(lead, null); return null; }
          return responder('Solo necesito tu nombre para el pedido, por ejemplo: "Ana Pérez" 🙂');
        }
        await guardar(lead, { nombre: nombre.slice(0, 120) });
        return avanzarCierre(ctx);
      }
      case 'ENTREGA': {
        const tieneTienda = Boolean(ctx.agente.config && ctx.agente.config.direccionTienda);
        if (/domicilio|delivery|envio|enviar|casa/.test(t)) await guardar(lead, { tipoEntrega: 'DOMICILIO' });
        else if (tieneTienda && /retir|recoj|recog|tienda|paso/.test(t)) await guardar(lead, { tipoEntrega: 'RECOJO' });
        else {
          if (texto.includes('?')) return null;
          if ((await sumarIntento(lead)) >= MAX_INTENTOS) { await fijarPaso(lead, null); return null; }
          return responder('Elegí una opción 👇', {
            botones: [{ id: 'cierre:domicilio', titulo: 'A domicilio' }, { id: 'cierre:recojo', titulo: 'Retiro en tienda' }],
          });
        }
        return avanzarCierre(ctx);
      }
      case 'UBICACION': {
        // La ubicacion nativa ya la guardo el webhook (interpretarMensajeEntrante).
        if (lead.ubicacionLat) return avanzarCierre(ctx);
        if (extraerUrlDeMaps(texto)) {
          const res = await resolverCoordenadas(texto);
          if (res) {
            await guardar(lead, { direccionEntrega: texto.slice(0, 300), ubicacionLat: res.lat, ubicacionLng: res.lng });
            return avanzarCierre(ctx);
          }
        }
        if (texto.includes('?')) return null;
        if ((await sumarIntento(lead)) >= MAX_INTENTOS) { await fijarPaso(lead, null); return null; }
        return pedirUbicacion('No pude ubicar eso. Compartí tu ubicación con el botón, o pegá un link de Google Maps.');
      }
      case 'PAGO': {
        const validos = metodosDePago(ctx.agente.config).map((m) => m.id.split(':')[1]);
        const elegido = /\bqr\b/.test(t) ? 'QR' : /efectivo/.test(t) ? 'EFECTIVO' : /tarjeta/.test(t) ? 'TARJETA' : null;
        if (!elegido || !validos.includes(elegido)) {
          if (texto.includes('?')) return null;
          if ((await sumarIntento(lead)) >= MAX_INTENTOS) { await fijarPaso(lead, null); return null; }
          return responder('Elegí una forma de pago 👇', { botones: metodosDePago(ctx.agente.config) });
        }
        await guardar(lead, { formaPago: elegido });
        return avanzarCierre(ctx);
      }
      case 'CONFIRMAR': {
        if (/^(si|ok|dale|listo|confirmo|confirmado|correcto|todo bien|esta bien|perfecto)\b/.test(t)) return crearPedido(ctx);
        if (/^(no|cambiar|editar|corregir)\b/.test(t)) return porId(ctx, 'cierre:editar');
        return null; // otra cosa (pregunta, etc.): la IA
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- router

  async function intentarInterno(ctx) {
    const { lead } = ctx;
    const texto = String(ctx.texto || '').trim();
    const contexto = lead.contexto || {};

    // 1) Regreso desde el catalogo web ("Quiero *X*"): confirmacion por plantilla, sin IA.
    if (contexto.carritoWebPendiente && /^quiero\b/i.test(texto) && itemsDe(ctx).length) {
      await guardar(lead, { contexto: { ...contexto, carritoWebPendiente: null } });
      return responder(`¡Buena elección! Ya está en tu carrito 🛒\n${textoCarrito(ctx)}\n\n¿Querés ver algo más?`, { botones: BOTONES_ALGO_MAS });
    }

    // 2) Boton o lista con ID propio.
    if (ctx.id) {
      const r = await porId(ctx, ctx.id);
      if (r !== undefined) return r;
    }

    // 3) Texto mientras el flujo espera un dato.
    const f = pasoActual(lead);
    if (f) return porTexto(ctx, f, texto);

    // 4) Respuesta corta a "¿algo mas?" (cuando el cliente escribe en vez de tocar un boton).
    if (itemsDe(ctx).length && preguntabaAlgoMas(ctx)) {
      const t = norm(texto);
      if (/^(no|nada|nada mas|eso es todo|es todo|finalizar|cerrar|listo|no gracias)\W*$/.test(t)) return avanzarCierre(ctx);
      if (/^(si|dale|claro|quiero ver( mas)?|seguir comprando)\W*$/.test(t)) return menuRubros(ctx, {});
    }
    return null;
  }

  async function intentar(ctx) {
    const paso = ((ctx.lead.contexto || {}).flujo || {}).paso || null;
    const r = await intentarInterno(ctx);
    if (r && r.respuesta) {
      logEtapa('respuesta_por_flujo', ctx.helpers.telefonoCliente, { id: ctx.id || null, pasoAntes: paso });
    }
    return r;
  }

  return { intentar, menuRubros, avanzarCierre, BOTONES_ALGO_MAS };
}

module.exports = { crearFlujo, BOTONES_ALGO_MAS, nombrePlausible };
