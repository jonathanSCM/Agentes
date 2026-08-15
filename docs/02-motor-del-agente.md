# El motor del agente (`lib/services/agente.js`)

Este archivo es el corazón del producto. Todo lo demás (panel, catálogo, pedidos) existe para alimentarlo o para mostrar lo que produce.

## Flujo de un mensaje

`server.js` (webhook de WhatsApp) → `lib/services/conversaciones.js` (`procesarMensajeEntrante`: agrupa mensajes en la misma conversación si llegan dentro de una ventana de 24h, cobra 1 conversación solo si abre una nueva — ver `docs/01-modelo-de-datos.md`) → `generarRespuesta()` en `agente.js`.

`generarRespuesta()`:
1. Carga el agente + config + catálogo activo de la empresa (hasta 200 productos, con `variantes` y `categoria.atributos` incluidos).
2. Extrae filtros deterministas del mensaje **en código** (`extraerFiltros`): categoría (matcheada contra las `Categoria` reales de la empresa), talla, cantidad. Esto existe porque el modelo a veces no llama a la tool `actualizar_datos_lead` aunque debería — es un respaldo, no el camino principal.
3. Arma el prompt de sistema (`construirSystem`) con: identidad del negocio, tono, categorías reales, atributos obligatorios que todavía faltan para la categoría actual del cliente, formas de pago habilitadas, y todo lo que ya se sabe del lead.
4. Loop de hasta 3 vueltas llamando al proveedor de IA (OpenAI/Anthropic) con `tools` disponibles (última vuelta sin tools, para forzar una respuesta final en texto).
5. Ejecuta las tool calls que pida el modelo (`ejecutarFuncion`), devuelve el resultado, y vuelve a llamar al modelo hasta que responda con texto plano (sin más tool calls).

## Las tools disponibles

- **`actualizar_datos_lead`** — guarda cualquier dato nuevo del cliente. Incluye `atributosCategoria` (objeto libre) para atributos que la categoría actual pide y no son ya un campo propio (ej: Género, Uso).
- **`mostrar_productos`** — la ÚNICA forma correcta de mostrarle productos al cliente (tarjeta con foto + ficha armada por el sistema). El modelo nunca debe describir precio/stock como texto plano — ver "Backstops en código" abajo.
- **`enviar_fotos_producto`** — fotos de un producto puntual.
- **`crear_pedido`** — valida stock, arma el pedido. Requiere nombre, dirección y forma de pago ya guardados (si falta alguno, rechaza y le dice al modelo qué preguntar).
- **`mostrar_catalogo`** — manda el link público del catálogo (`/catalogo/:slug`), con el dominio tomado del request real, no de una variable de entorno (ver decisiones recientes).
- **`derivar_a_asesor`** — deriva a un humano (pedidos mayoristas, cliente molesto, negociación especial, etc.)

## Backstops en código (no confiar solo en el prompt)

El prompt le pide cosas a la IA, pero varias reglas críticas están **reforzadas en código** porque depender solo de instrucciones de texto falló en la práctica:

- **Sin tope artificial de productos mostrados.** `MAX_PRODUCTOS_A_MOSTRAR = 20` (antes 3) — si hay 13 productos reales que aplican, se ofrecen los 13, nunca se esconde inventario real por prolijidad.
- **Validación de que el ID de producto sea real y relevante.** `mostrar_productos`/`enviar_fotos_producto` rechazan cualquier ID que no sea parte de: los candidatos actuales de la búsqueda, algo ya mostrado en esta conversación, o el favorito guardado. Esto existe porque hubo un bug real: el bot mandó la foto de un producto totalmente distinto al que se estaba hablando.
- **Detección de "listado en texto plano".** Si el modelo responde sin tool calls pero el texto tiene pinta de listado de productos con precio (2+ precios + 2+ ítems de lista), se rechaza en código y se le exige corregir usando `mostrar_productos` antes de mandarlo al cliente. Esto ataca la causa raíz del bug anterior: sin tarjeta real, no queda un ID verdadero ligado al producto, y si el cliente pide "la foto de la primera opción" después, el modelo tiene que adivinar.
- **Atributos obligatorios por categoría.** Si la categoría del cliente tiene atributos marcados `obligatorio` (nivel producto) que todavía no se saben, el prompt se lo dice explícitamente al modelo — no depende de que "se acuerde" de preguntar género/uso/etc. según el rubro.

## Selección de fotos

`fotoParaMostrar(producto, lead)`: si el cliente ya dijo qué color busca y ese color tiene fotos propias cargadas en alguna `Variante`, se manda esa — nunca la genérica del producto ni la de otro color. Si no hay match, cae a `Producto.fotos[0]`. La talla no influye en la foto a propósito (las fotos se comparten entre tallas de un mismo color, ver carga por rango de tallas en el panel).

## `fichaProducto` — cómo se arma el texto de una tarjeta

Agrupa las variantes por talla. Si **todas** las tallas mostradas tienen exactamente los mismos colores disponibles, colapsa todo en una sola línea ("Tallas 36, 37, 38: Negro, Beige") en vez de repetir la misma lista de colores una vez por talla (que antes generaba mensajes muy largos y redundantes).

## Anti-invención (principio transversal)

`respuestaErrorTecnico()` — si falla el proveedor de IA o una consulta a la base, el bot **nunca** inventa disponibilidad; responde honestamente que hubo un problema técnico. Cubierto por tests en `test/regresion-agente.test.js` (punto 9/10 de la primera revisión de reglas de negocio que se hizo sobre este proyecto).
