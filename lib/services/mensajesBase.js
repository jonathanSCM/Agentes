'use strict';
// lib/services/mensajesBase.js
//
// CATALOGO DE FABRICA de mensajes del agente (plan: docs/10-plan-mensajes-prefabricados.md).
//
// Cada mensaje es como una plantilla de WhatsApp: una clave, una descripcion de
// cuando se usa (es lo que leera la IA en la fase M1 para ELEGIRLO, ya que la IA
// no escribe), el texto con variables y el tipo de cada variable.
//
// Sintaxis del texto (la resuelve lib/services/mensajes.js):
//   {{variable}}             valor que pone el sistema (el backend), nunca la IA
//   {{dato.garantia}}        dato añadible del negocio (tabla datos_negocio)
//   {{vocab.cita}}           vocabulario del negocio (cita / turno / reserva ...)
//   {{negocio}}              nombre del negocio
//   {{#var}}...{{/var}}      se muestra solo si la variable tiene valor
//   {r:vos|tu}               la palabra segun como habla el agente (registro del negocio)
//
// Tipos de variable: texto | numero | monto | lista. Un "?" al final = opcional.
// Los textos en "vos" son EXACTAMENTE los que antes estaban escritos en el codigo.
//
// Las claves "apertura_*" son frases cortas de apertura que se pasan como {{saludo}}.

const M = (clave, categoria, descripcion, texto, variables = {}, ejemplo = {}) => ({ clave, categoria, descripcion, texto, variables, ejemplo });

const CATALOGO = [
  // ------------------------------------------------------------ aperturas
  M('apertura_dale', 'Aperturas', 'Frase corta para arrancar de nuevo con el menu (el cliente quiere empezar una compra).', 'Dale 🛍️'),
  M('apertura_claro', 'Aperturas', 'Frase corta de acuerdo ("Claro.") antes de mostrar otra vez el menu.', 'Claro.'),
  M('apertura_regalo', 'Aperturas', 'Frase corta cuando el cliente busca un regalo.', '¡Qué lindo detalle! 🎁'),
  M('apertura_carrito_vacio', 'Aperturas', 'Frase corta que avisa que el carrito esta vacio antes del menu.', 'Tu carrito está vacío.'),
  M('apertura_hola', 'Aperturas', 'Saludo corto de bienvenida antes del menu.', '¡Hola! 👋'),

  // ------------------------------------------------------ bienvenida y catalogo
  M('menu_rubros', 'Catálogo', 'Presenta las categorias de la tienda (viene con la lista para elegir).',
    '{{#saludo}}{{saludo}} {{/saludo}}Esto es lo que tenemos, ¿cuál te interesa?', { saludo: 'texto?' }, { saludo: 'Dale 🛍️' }),
  M('subcategorias', 'Catálogo', 'Pregunta que tipo de producto busca dentro de una categoria (viene con la lista de tipos).',
    'Dentro de {{categoria}}, ¿qué tipo {r:buscás|buscas}?', { categoria: 'texto' }, { categoria: 'Calzado' }),
  M('tarjeta_categoria', 'Catálogo', 'Acompaña la tarjeta con foto de una categoria y invita a elegir un modelo.',
    '{{#saludo}}{{saludo}} {{/saludo}}Échale un vistazo a {{categoria}} 👆 Cuando algo te guste, {r:decime|dime} el nombre del modelo o {r:abrilo|ábrelo} en el catálogo.',
    { saludo: 'texto?', categoria: 'texto' }, { categoria: 'zapatillas' }),
  M('catalogo_ya_mostrado', 'Catálogo', 'La tarjeta de esa categoria ya se mando: pide el nombre del modelo o que elija otra categoria.',
    'Ese catálogo ya te lo mostré 👆 ¿Qué modelo te interesó? {r:Decime|Dime} el nombre, o {r:elegí|elige} otra categoría.'),
  M('aclarar_opcion', 'Catálogo', 'Dos o mas opciones calzan con lo que dijo el cliente: se le pregunta cual.',
    '¿Cuál de estas?\n{{opciones}}\n{r:Respondé|Responde} con el número o el nombre 🙂', { opciones: 'lista' }, { opciones: '1) Zapatilla Runner\n2) Zapatilla Trail' }),

  // ---------------------------------------------------------------- carrito
  M('carrito_vacio', 'Carrito', 'El carrito esta vacio.', 'Tu carrito está vacío.'),
  M('carrito_vacio_que_muestro', 'Carrito', 'El cliente quiere finalizar pero el carrito esta vacio.', 'Tu carrito está vacío. ¿Qué te muestro?'),
  M('carrito_resumen', 'Carrito', 'Muestra lo que lleva el cliente en el carrito.', 'Esto {r:llevás|llevas}:\n{{carrito}}', { carrito: 'lista' }, { carrito: '- 1x Zapatilla Runner — Bs 300.00' }),
  M('editar_carrito_pregunta', 'Carrito', 'Pregunta cual producto del carrito quiere cambiar (viene con la lista).', '¿Qué producto {r:querés|quieres} cambiar?'),
  M('item_que_hacemos', 'Carrito', 'Pregunta que hacer con el producto elegido del carrito (viene con los botones).', '¿Qué hacemos con este producto?'),
  M('cantidad_ya_lleva', 'Carrito', 'El cliente pidio una cantidad que ya tenia: se le muestra el carrito.', 'Ya {r:llevás|llevas} {{cantidad}}:\n{{carrito}}', { cantidad: 'numero', carrito: 'lista' }, { cantidad: 1, carrito: '- 1x Zapatilla Runner — Bs 300.00' }),
  M('cantidad_sin_stock', 'Carrito', 'Pidio mas unidades de las que hay en stock.', 'No hay tanto stock: quedan {{stock}}.\n{{carrito}}', { stock: 'numero', carrito: 'lista' }, { stock: 3, carrito: '- 1x Zapatilla Runner — Bs 300.00' }),
  M('sin_mas_stock', 'Carrito', 'Ya no hay mas unidades para sumar.', 'No hay más stock: quedan {{stock}}.', { stock: 'numero' }, { stock: 3 }),
  M('cantidad_actualizada', 'Carrito', 'Se cambio la cantidad de un producto.', 'Listo, lo dejé en {{cantidad}} 👍\n{{carrito}}', { cantidad: 'numero', carrito: 'lista' }, { cantidad: 2, carrito: '- 2x Zapatilla Runner — Bs 600.00' }),
  M('producto_quitado', 'Carrito', 'Se saco el unico producto del carrito.', 'Listo, lo saqué de tu carrito. ¿{r:Querés|Quieres} ver otra cosa?'),
  M('confirmar_vaciar', 'Carrito', 'Pide confirmacion antes de vaciar el carrito (viene con los botones).', '¿{r:Querés|Quieres} vaciar tu carrito?'),
  M('carrito_vaciado', 'Carrito', 'Se vacio el carrito.', 'Listo, vacié tu carrito 🧹 ¿{r:Querés|Quieres} ver algo?'),
  M('regreso_web', 'Carrito', 'El cliente volvio del catalogo web con un producto en el carrito.',
    '¡Buena elección! Ya está en tu carrito 🛒\n{{carrito}}\n\n¿{r:Querés|Quieres} ver algo más?', { carrito: 'lista' }, { carrito: '- 1x Zapatilla Runner — Bs 300.00' }),
  M('aviso_carrito_web', 'Carrito', 'Aviso por WhatsApp de que algo se agrego al carrito desde el catalogo web.',
    '✅ *Agregado a tu carrito*\n{{carrito}}\n\n{{cierre}}', { carrito: 'lista', cierre: 'texto' }, { carrito: '- 1x Zapatilla Runner — Bs 300.00', cierre: '¿Qué hacemos?' }),
  M('aviso_carrito_web_cierre_botones', 'Carrito', 'Cierre del aviso del carrito web cuando hay botones.', '¿Qué hacemos?'),
  M('aviso_carrito_web_cierre_texto', 'Carrito', 'Cierre del aviso del carrito web cuando NO hay botones.',
    '{r:Escribime|Escríbeme} "finalizar" cuando quieras cerrar tu pedido, o {r:decime|dime} qué más {r:querés|quieres} ver.'),

  // ----------------------------------------------------------------- cierre
  M('pedir_nombre', 'Cierre', 'Pide el nombre para el pedido.', '¿A nombre de quién hago el pedido?'),
  M('nombre_ejemplo', 'Cierre', 'No se entendio el nombre: se pide de nuevo con un ejemplo.', 'Solo necesito tu nombre para el pedido, por ejemplo: "Ana Pérez" 🙂'),
  M('pedir_entrega', 'Cierre', 'Pregunta si quiere envio a domicilio o retiro en tienda (viene con los botones).', '¿Cómo {r:preferís|prefieres} recibirlo?'),
  M('elegir_opcion', 'Cierre', 'Pide que toque una de las opciones mostradas.', '{r:Elegí|Elige} una opción 👇'),
  M('pedir_ubicacion', 'Cierre', 'Pide la ubicacion para la entrega a domicilio (viene con el boton de ubicacion).',
    'Para la entrega necesito tu ubicación. {r:Tocá|Toca} el botón y {r:compartila|compártela}, o {r:pegame|pégame} el link de Google Maps.'),
  M('ubicacion_no_ubicada', 'Cierre', 'No se pudo ubicar lo que mando: se vuelve a pedir la ubicacion.',
    'No pude ubicar eso. {r:Compartí|Comparte} tu ubicación con el botón, o {r:pegá|pega} un link de Google Maps.'),
  M('pedir_pago', 'Cierre', 'Pregunta como va a pagar (viene con los botones de las formas de pago del negocio).', '¿Cómo {r:preferís|prefieres} pagar?'),
  M('elegir_pago', 'Cierre', 'Pide que elija una de las formas de pago mostradas.', '{r:Elegí|Elige} una forma de pago 👇'),
  M('stock_cambio_cierre', 'Cierre', 'Un producto del carrito ya no tiene stock suficiente al cerrar.',
    'Algún producto ya no tiene stock suficiente. Revisemos tu carrito 👇\n{{carrito}}', { carrito: 'lista' }, { carrito: '- 1x Zapatilla Runner — Bs 300.00' }),
  M('resumen_pedido', 'Cierre', 'Resumen del pedido para confirmar (viene con los botones Confirmar / Editar).',
    'Este es el resumen de tu pedido:\n{{resumen}}\n\n¿Está todo bien?', { resumen: 'lista' }, { resumen: '- 1x Zapatilla Runner — Bs 300.00\nTotal: Bs 300.00' }),
  M('editar_pedido_que', 'Cierre', 'Pregunta que dato del pedido quiere cambiar (viene con la lista).', '¿Qué {r:querés|quieres} cambiar?'),
  M('pedido_creado', 'Cierre', 'El pedido quedo registrado.',
    '¡Listo! Tu pedido{{#numero}} #{{numero}}{{/numero}} quedó registrado ✅{{#qr}} {{qr}}{{/qr}} Un asesor va a coordinar {{coordina}} {r:con vos|contigo}.',
    { numero: 'numero?', qr: 'texto?', coordina: 'texto' }, { numero: 15, qr: 'Un asesor te va a enviar el QR de pago en un momento.', coordina: 'la entrega' }),
  M('qr_enviado', 'Cierre', 'Se mando la imagen del QR de pago.', 'Te envié el QR 👆 Cuando pagues, {r:mandame|mándame} el comprobante por acá.'),
  M('qr_pendiente', 'Cierre', 'El QR no se pudo mandar: un asesor lo envia.', 'Un asesor te va a enviar el QR de pago en un momento.'),

  // ------------------------------------------------------------ información
  M('ofrecer_asesor', 'Información', 'Frase para ofrecer que una persona confirme algo.', 'Si {r:querés|quieres}, {r:escribí|escribe} "asesor" y una persona te lo confirma.'),
  M('gracias_respuesta', 'Información', 'El cliente agradecio o se despidio.', '¡Con gusto! Cuando quieras seguir, acá estoy 🙂'),
  M('pago_formas', 'Información', 'Responde con que formas de pago acepta la tienda.',
    'En {{negocio}} {r:podés|puedes} pagar con {{formas}}. ¿Seguimos con tu pedido?', { formas: 'texto' }, { formas: 'QR y efectivo' }),
  M('pago_sin_datos', 'Información', 'La tienda no cargo sus formas de pago: se ofrece un asesor.', 'La forma de pago te la confirma un asesor. {{asesor}}', { asesor: 'texto' }, { asesor: 'Si querés, escribí "asesor" y una persona te lo confirma.' }),
  M('direccion_tienda', 'Información', 'Responde donde esta el local.', 'Estamos en: {{direccion}}. También hacemos entregas a domicilio.', { direccion: 'texto' }, { direccion: 'Av. Siempre Viva 123' }),
  M('direccion_sin_datos', 'Información', 'La tienda no cargo su direccion: se ofrece un asesor.', 'Todavía no tengo la dirección cargada. {{asesor}}', { asesor: 'texto' }, { asesor: 'Si querés, escribí "asesor" y una persona te lo confirma.' }),
  M('envio_info', 'Información', 'Responde si hacen envios. No inventa costos ni plazos: los confirma un asesor.',
    'Sí, hacemos entregas a domicilio{{#retiro}} y retiro en tienda{{/retiro}}. El costo y el tiempo exacto te los confirma un asesor al cerrar el pedido. {{asesor}}',
    { retiro: 'texto?', asesor: 'texto' }, { retiro: 'si', asesor: 'Si querés, escribí "asesor" y una persona te lo confirma.' }),
  M('horario_info', 'Información', 'Responde el horario de atencion que cargo el negocio.', 'Nuestro horario de atención: {{horario}}.', { horario: 'texto' }, { horario: 'Lun a Vie 09:00 a 18:00' }),
  M('horario_sin_datos', 'Información', 'La tienda no cargo su horario: no se inventa, se ofrece un asesor.', 'El horario exacto te lo confirma un asesor. {{asesor}}', { asesor: 'texto' }, { asesor: 'Si querés, escribí "asesor" y una persona te lo confirma.' }),

  // ------------------------------------------- conversacion (los elige la IA, M1)
  M('saludo', 'Conversación', 'Saluda al cliente que escribio solo un saludo y le pregunta en que ayudar.',
    '¡Hola! 👋 Bienvenido a {{negocio}}. ¿En qué te puedo ayudar?'),
  M('productos_mostrados', 'Conversación', 'Despues de mandar las tarjetas de productos: invita a elegir uno o pedir mas.',
    '{{#cantidad}}Te mostré {{cantidad}} opción(es) 👆 {{/cantidad}}¿Cuál te gusta? {r:Decime|Dime} el nombre y lo armamos.', { cantidad: 'numero?' }, { cantidad: 3 }),
  M('sin_resultados', 'Conversación', 'No hay productos que calcen con lo que pidio el cliente.',
    'No encontré eso en {{negocio}} 🙏 ¿{r:Querés|Quieres} que te muestre otras opciones?'),
  M('producto_no_existe', 'Conversación', 'El cliente pregunto por un producto que no existe en el catalogo.',
    'Ese producto no lo tengo en el catálogo. ¿{r:Querés|Quieres} ver lo que sí tenemos?'),
  M('producto_agotado', 'Conversación', 'El producto que pidio esta agotado.',
    '{{producto}} está agotado por ahora 😕 ¿{r:Querés|Quieres} ver algo parecido?', { producto: 'texto' }, { producto: 'Zapatilla Runner' }),
  M('producto_precio', 'Conversación', 'Responde el precio de un producto (el monto lo pone el sistema).',
    '{{producto}} cuesta {{precio}}. ¿{r:Querés|Quieres} agregarlo a tu carrito?', { producto: 'texto', precio: 'monto' }, { producto: 'Zapatilla Runner', precio: 300 }),
  M('producto_dato', 'Conversación', 'Responde un dato cargado de un producto (color, material, talla, descripcion).',
    'De {{producto}}: {{atributo}} {{valor}}.', { producto: 'texto', atributo: 'texto', valor: 'texto' }, { producto: 'Zapatilla Runner', atributo: 'material:', valor: 'cuero' }),
  M('producto_dato_no_disponible', 'Conversación', 'Preguntaron un dato que el producto no tiene cargado: no se inventa.',
    'Ese dato de {{producto}} no lo tengo cargado 🙏 Si {r:querés|quieres}, {r:escribí|escribe} "asesor" y una persona te lo confirma.', { producto: 'texto' }, { producto: 'Zapatilla Runner' }),
  M('pedir_variante', 'Conversación', 'Falta elegir talla o color antes de agregar al carrito.',
    'Para agregar {{producto}} necesito saber {{falta}}. ¿Cuál {r:preferís|prefieres}?', { producto: 'texto', falta: 'texto' }, { producto: 'Zapatilla Runner', falta: 'la talla' }),
  M('producto_sin_stock', 'Conversación', 'No alcanza el stock para la cantidad pedida.',
    'De {{producto}} quedan {{stock}}. ¿{r:Querés|Quieres} esa cantidad o ver otra opción?', { producto: 'texto', stock: 'numero' }, { producto: 'Zapatilla Runner', stock: 2 }),
  M('ya_en_carrito', 'Conversación', 'El producto ya estaba en el carrito.',
    '{{producto}} ya está en tu carrito 🛒 ¿{r:Querés|Quieres} cambiar la cantidad o seguir con otra cosa?', { producto: 'texto' }, { producto: 'Zapatilla Runner' }),
  M('agregado_al_carrito', 'Conversación', 'Se agrego un producto al carrito (viene con los botones de "algo mas").',
    'Listo, agregué {{producto}} a tu carrito 🛒', { producto: 'texto' }, { producto: 'Zapatilla Runner' }),
  M('fotos_enviadas', 'Conversación', 'Se mandaron las fotos de un producto.',
    'Ahí {r:tenés|tienes} las fotos de {{producto}} 📸 ¿Qué te parece?', { producto: 'texto' }, { producto: 'Zapatilla Runner' }),
  M('faq_respuesta', 'Conversación', 'Responde una pregunta frecuente que el negocio cargo (el texto sale de la pregunta elegida).',
    '{{respuesta}}', { respuesta: 'texto' }, { respuesta: 'Aceptamos QR y efectivo.' }),

  // ---------------------------------------------------------------- sistema
  M('aviso_modo_menu', 'Sistema', 'Aviso de que, por ahora, el agente atiende con menu (la IA no esta disponible).', 'Estoy atendiendo con menú en este momento, así que puede que no entienda frases largas 🙏'),
  M('pista_asesor', 'Sistema', 'Recuerda que puede pedir hablar con una persona.', '(Si {r:preferís|prefieres} hablar con una persona, {r:escribí|escribe} "asesor".)'),
  M('derivar_confirmacion', 'Sistema', 'Se avisa a un asesor para que escriba al cliente.', 'Listo, aviso a un asesor para que te escriba.'),
  M('no_entendi_derivar', 'Sistema', 'Tema que el agente no conoce: pasa con una persona del equipo.', 'No estoy seguro de poder ayudarte con eso 🙏 Le aviso a una persona del equipo para que te escriba por acá.'),
  M('sin_menu', 'Sistema', 'No se pudo armar el menu: se ofrece un asesor.', 'Ahora mismo no puedo mostrarte el menú. {r:Escribí|Escribe} "asesor" y una persona te atiende enseguida.'),
  M('error_tecnico', 'Sistema', 'Fallo tecnico que impidio procesar el mensaje.', 'Tuve un problema técnico y no pude procesar tu mensaje. {r:Probá|Prueba} de nuevo en un momento o {r:escribí|escribe} "asesor" y una persona te atiende.'),
  M('perdon_demora', 'Sistema', 'Disculpa que antecede a una respuesta que quedo pendiente por una falla de la IA.', 'Perdón la demora 🙏'),
  M('alcance_manipulacion', 'Sistema', 'El cliente intento cambiar las reglas del agente.', 'Solo puedo ayudarte con lo que ofrece {{negocio}} 😊 ¿Seguimos con tu compra?'),
  M('alcance_fuera_de_tema', 'Sistema', 'El cliente pidio algo ajeno a la tienda.', 'Eso se sale de lo que puedo ayudarte: estoy para atenderte con lo de {{negocio}} 😊 ¿Seguimos con tu compra?'),
  M('alcance_privacidad', 'Sistema', 'El cliente pidio datos de otros clientes.', 'Por privacidad no comparto datos de otros clientes, ni de sus compras 🙏 Si {r:necesitás|necesitas} algo tuyo (tu pedido, tus datos), te ayudo con gusto.'),
  M('precio_equivocado', 'Sistema', 'La respuesta de la IA traia un monto que no existe: se reemplaza.', 'Prefiero no darte un precio equivocado 🙏 El valor exacto lo ves en el catálogo, o {r:escribí|escribe} "asesor" y una persona te lo confirma.'),
];

const POR_CLAVE = new Map(CATALOGO.map((m) => [m.clave, m]));
if (POR_CLAVE.size !== CATALOGO.length) throw new Error('mensajesBase: hay claves repetidas');

const CATEGORIAS = [...new Set(CATALOGO.map((m) => m.categoria))];

module.exports = { CATALOGO, CATEGORIAS, obtenerFabrica: (clave) => POR_CLAVE.get(clave) || null };
