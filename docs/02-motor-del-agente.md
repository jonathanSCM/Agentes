# El motor del agente (`lib/services/agente.js` + `lib/services/catalogo.js`)

El corazón del producto. Todo lo demás (panel, catálogo, pedidos) existe para alimentarlo o para mostrar lo que produce.

Están separados a propósito:

- **`catalogo.js`** — qué existe de verdad en el inventario: filtros, orden de alternativas, paginación y selección de fotos. Puro y determinista (sin DB ni red), se testea sin levantar nada.
- **`agente.js`** — cómo se le habla al modelo: prompt, tools, ejecución de acciones reales (WhatsApp, pedidos) y memoria del lead.

## Flujo de un mensaje

`server.js` (webhook de WhatsApp) → `lib/services/conversaciones.js` (`procesarMensajeEntrante`: agrupa mensajes en la misma conversación si llegan dentro de una ventana configurable (`CONVERSATION_WINDOW_HOURS`, default 6h), cobra 1 conversación solo si abre una nueva — ver `docs/01-modelo-de-datos.md`) → `generarRespuesta()` en `agente.js`.

`generarRespuesta()`:
1. Carga el agente + config + catálogo activo de la empresa (hasta 200 productos, con `variantes` y `categoria.atributos` incluidos).
2. Extrae filtros deterministas del mensaje **en código** (`extraerFiltros`): categoría (matcheada contra las `Categoria` reales de la empresa), talla, cantidad. Esto existe porque el modelo a veces no llama a la tool `actualizar_datos_lead` aunque debería — es un respaldo, no el camino principal.
3. Arma el prompt de sistema (`construirSystem`) con: identidad del negocio, tono, categorías reales, atributos obligatorios que todavía faltan para la categoría actual del cliente, formas de pago habilitadas, y todo lo que ya se sabe del lead.
4. Loop de hasta 3 vueltas llamando al proveedor de IA (OpenAI/Anthropic) con `tools` disponibles (última vuelta sin tools, para forzar una respuesta final en texto).
5. Ejecuta las tool calls que pida el modelo (`ejecutarFuncion`), devuelve el resultado, y vuelve a llamar al modelo hasta que responda con texto plano (sin más tool calls).

## Las tools disponibles

- **`actualizar_datos_lead`** — guarda cualquier dato nuevo del cliente. Incluye `atributosCategoria` (objeto libre) para atributos que la categoría actual pide y no son ya un campo propio (ej: Género, Uso), `tipoEntrega` y `varianteFavoritaId`.
- **`mostrar_productos`** — la ÚNICA forma correcta de mostrarle productos al cliente (tarjeta con foto + ficha armada por el sistema). El modelo nunca debe describir precio/stock como texto plano — ver "Backstops en código" abajo.
- **`ver_mas_productos`** — la siguiente página de resultados de la misma búsqueda. **El backend elige qué mostrar**, no el modelo: así no repite ni se saltea productos reales.
- **`enviar_fotos_producto`** — fotos de un producto puntual, con aviso de si la foto es del color pedido o solo referencial.
- **`confirmar_pedido`** — arma el resumen real (producto, variante, cantidad, precios de la base, entrega) para que el bot se lo lea al cliente. Obligatoria antes de crear.
- **`crear_pedido`** — revalida stock y precio, arma el pedido. Requiere nombre, tipo de entrega (y dirección si es a domicilio), forma de pago, y **que el cliente haya confirmado ese pedido exacto** (se compara una firma de los ítems contra la que dejó `confirmar_pedido`).
- **`mostrar_categorias`** — arma el menú real: los rubros si el cliente todavía no eligió ninguno, o los tipos del rubro que eligió. Solo aparecen los que tienen stock. **Reemplazó a `mostrar_catalogo`**, que mandaba un link a la web y sacaba al cliente de WhatsApp (ver decisiones recientes, punto 10).
- **`derivar_a_asesor`** — deriva a un humano (pedidos mayoristas, cliente molesto, negociación especial, etc.)

## Backstops en código (no confiar solo en el prompt)

El prompt le pide cosas a la IA, pero varias reglas críticas están **reforzadas en código** porque depender solo de instrucciones de texto falló en la práctica:

- **Primero entender, después mostrar.** Si la categoría del cliente tiene atributos de nivel `OBLIGATORIO` que todavía no se saben (ej: Género, Talla), el bloque de resultados **no existe** en el prompt y `mostrar_productos` rechaza la llamada. Pedírselo por texto no alcanzaba: el modelo mostraba productos apenas escuchaba una categoría.
- **Pocas opciones por vez, pero sin mentir sobre el total.** `RESULTADOS_POR_PAGINA = 3`. El prompt siempre lleva el `total_matches` real y cuántos quedan sin mostrar, así el bot nunca puede decir "esas son todas" sin saberlo. Para ver más, `ver_mas_productos`.
- **Nunca se afloja un filtro en silencio.** `buscarConFallback` afloja de a uno y en orden (color → marca → presupuesto → talla), nunca categoría ni atributos del lead, y devuelve cuál aflojó. Si hubo que aflojar, no se muestra nada hasta que el cliente diga que quiere ver alternativas (verificado contra el turno, para que el modelo no se autorresponda).
- **Toda acción confirma su resultado.** Los envíos por WhatsApp miran el resultado real de la API: el resultado de la tool arranca con `TOOL_SUCCESS` o `TOOL_FAILED`, y si falló le prohíbe al modelo decir que mandó algo.
- **La moneda la pone el backend.** `Empresa.moneda` + `formatearPrecio()`: nunca sale un precio pelado que el modelo pueda "decorar" con el símbolo que le parezca.
- **Validación de que el ID de producto sea real y relevante.** `mostrar_productos`/`enviar_fotos_producto` rechazan cualquier ID que no sea parte de: los candidatos actuales de la búsqueda, algo ya mostrado en esta conversación, o el favorito guardado. Esto existe porque hubo un bug real: el bot mandó la foto de un producto totalmente distinto al que se estaba hablando.
- **Detección de "listado en texto plano".** Si el modelo responde sin tool calls pero el texto tiene pinta de listado de productos con precio (2+ precios + 2+ ítems de lista), se rechaza en código y se le exige corregir usando `mostrar_productos` antes de mandarlo al cliente. Esto ataca la causa raíz del bug anterior: sin tarjeta real, no queda un ID verdadero ligado al producto, y si el cliente pide "la foto de la primera opción" después, el modelo tiene que adivinar.
- **Atributos obligatorios por categoría.** Si la categoría del cliente tiene atributos marcados `obligatorio` (nivel producto) que todavía no se saben, el prompt se lo dice explícitamente al modelo — no depende de que "se acuerde" de preguntar género/uso/etc. según el rubro.

## Selección de fotos

`fotoParaMostrar(producto, lead)` devuelve `{url, colorDeLaFoto, esDelColorPedido, colorPedido, coloresConFoto, coloresSinFoto}` — no una URL suelta.

Si el cliente ya dijo qué color busca y ese color tiene fotos propias en alguna `Variante`, se manda esa (`esDelColorPedido: true`). Si **no** hay foto de ese color, se manda la que haya pero marcada como referencial, y `avisosDeFoto()` genera la instrucción explícita de aclarárselo al cliente: "hay stock gris, pero la foto es del blanco". Hacer pasar la foto de un color por otro es la regla que el negocio marcó como error grave.

La talla no influye en la foto a propósito (las fotos se comparten entre tallas de un mismo color, ver carga por rango de tallas en el panel).

## `fichaProducto` — cómo se arma el texto de una tarjeta

Agrupa las variantes por talla. Si **todas** las tallas mostradas tienen exactamente los mismos colores disponibles, colapsa todo en una sola línea ("Tallas 36, 37, 38: Negro, Beige") en vez de repetir la misma lista de colores una vez por talla (que antes generaba mensajes muy largos y redundantes).

## Anti-invención (principio transversal)

`respuestaErrorTecnico()` — si falla el proveedor de IA o una consulta a la base, el bot **nunca** inventa disponibilidad; responde honestamente que hubo un problema técnico. Cubierto por tests en `test/regresion-agente.test.js` (punto 9/10 de la primera revisión de reglas de negocio que se hizo sobre este proyecto).
