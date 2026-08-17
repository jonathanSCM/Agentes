# Bitácora de decisiones recientes

Orden cronológico. Cada punto: qué problema había, qué se decidió, por qué, y qué tocó. Pensado para que otra sesión de IA entienda el "por qué" sin tener que releer todo el historial de chat.

---

## 1. Revisión formal contra un documento de instrucciones del dueño

El dueño del negocio escribió un PDF ("Instrucciones definitivas para el desarrollo del Agente de Ventas") con 50 puntos sobre cómo debería comportarse el bot. Se hizo una revisión honesta punto por punto contra el código real (no contra lo que "se supone" que hace). Hallazgo clave: varios puntos ya estaban bien resueltos (presupuesto nunca reemplaza categoría, nunca cambia de categoría solo, logs estructurados, memoria persistente del lead), pero el punto 16 del documento describía **un bug real que el dueño ya había detectado usando el bot**: "el catálogo puede tener 13 zapatillas, pero el sistema muestra solo 3". Esto validó que el documento no era teoría genérica, sino observación real de uso — se le dio prioridad en base a eso.

**Decisión de alcance importante**: en vez de la recomendación literal del documento (mostrar 3 + "¿querés ver más?" con paginación), se optó por **mostrar todas las opciones reales que apliquen** (con un techo de seguridad alto, no una regla de negocio) — decisión explícita del dueño, no mía.

## 2. Sin tope artificial de 3 productos

**Problema**: `mostrar_productos` tenía un límite duro de 3, tanto en la instrucción al modelo como forzado en código (`.slice(0, 3)` en `buscarProductosFiltrados` y en el manejo de la tool) — ocultaba inventario real.

**Decisión**: `MAX_PRODUCTOS_A_MOSTRAR = 20` (techo de seguridad, no límite de negocio) en `lib/services/agente.js`. Se sacó el "Máximo 3" de la descripción de la tool y se reemplazó por una instrucción explícita de mostrar TODOS los productos reales que apliquen.

## 3. Fotos por variante (antes solo existían a nivel producto)

**Problema**: `Producto.fotos` existía, pero no había forma de que cada color de una variante tuviera su propia foto — el bot siempre mandaba la foto genérica del producto, sin importar qué color pidiera el cliente.

**Decisión**: se agregó `Variante.fotos` (array de URLs). En el panel, "Agregar variante" ahora acepta un rango de tallas separadas por coma (ej: "38, 39, 40") + una sola carga de fotos que se aplica a todas — porque tallas de un mismo color casi siempre comparten foto. Para variantes ya existentes cargadas una por una, hay un botón "Copiar a mismo color" que propaga las fotos a las demás tallas de ese color. El bot (`fotoParaMostrar`) manda la foto de la variante que coincide con el color que el cliente ya dijo; si no hay color especificado o no hay foto propia, cae a la foto genérica del producto (comportamiento de siempre, sin regresión).

**Migración**: `prisma/migrations/20260814040000_fotos_variante`.

## 4. Forma de pago (QR estático, no pasarela real)

**Problema**: el bot nunca preguntaba cómo iba a pagar el cliente, ni sabía qué métodos de pago acepta cada negocio.

**Decisión de alcance** (confirmada explícitamente con el dueño antes de construir, para no sobre-diseñar): el QR es una **imagen estática** que cada negocio ya usa hoy manualmente (no una pasarela de pago real, no hay confirmación automática de cobro). Después de crear el pedido, **un humano cierra todo por fuera del bot** — el bot solo pregunta, guarda la elección, y manda la imagen del QR si corresponde.

**Qué se agregó**: `AgenteConfig.aceptaQr/aceptaEfectivo/aceptaTarjeta` + `qrCobroUrl` (configurable en `/panel/configuracion`), `ClienteFinal.formaPago` y `Pedido.formaPago` (enum `FormaPago`). `crear_pedido` no deja crear el pedido sin forma de pago, y solo entre las que esa tienda tiene habilitadas. Si el cliente elige QR, el bot manda la imagen real **solo si el envío por WhatsApp fue exitoso de verdad** (nunca afirma "te mandé el QR" sin confirmación real de envío — mismo principio anti-invención aplicado a acciones, no solo a datos).

**Migración**: `prisma/migrations/20260814050000_forma_pago`.

## 5. Categorías con atributos configurables (el cambio más grande de la sesión)

**Problema**: el bot no sabía qué preguntar según la categoría del producto (usaba las mismas señales genéricas — categoría, presupuesto, marca, talla, color — para cualquier rubro). En particular, no había forma de tratar "Género" como filtro sin hardcodearlo como caso especial en el código.

**Idea del dueño, evaluada y aprobada**: crear una entidad `Categoria` real por empresa, con atributos configurables marcados obligatorio/opcional. Se evaluaron dos opciones (esquema suave = solo guía al bot, sin tocar el catálogo; esquema duro = productos realmente enlazados a una categoría real, con validación). **Se fue directo por la opción dura.**

**Qué se construyó**:
- `Categoria` + `CategoriaAtributo` (por empresa; cada atributo tiene `obligatorio` y `esDeVariante` — decide si vive en `Producto.atributos` o en `Variante.atributos`).
- `Producto.categoria` (texto libre) **se eliminó** y se reemplazó por `Producto.categoriaId` (relación real). Esto tocó ~10 archivos (búsqueda del bot, prompt, formulario de productos, catálogo público, panel admin).
- El formulario de "Agregar/Editar producto" pasa de input de texto libre a un `<select>` real, y **valida de verdad** los atributos obligatorios de nivel producto al guardar (rechaza el guardado si falta uno).
- El bot (`construirSystem`) le dice al modelo, categoría por categoría, qué atributos obligatorios todavía no sabe del cliente — esto resuelve el gap de "Género" sin ningún caso especial: es un atributo más.
- **Migración de datos de los 150 productos existentes**: se creó una `Categoria` por cada uno de los 18 textos distintos que ya existían, y se ligó cada producto — con una migración **idempotente** (`ON CONFLICT DO NOTHING`), escrita para correr sola en cualquier deploy (no un script manual, aprendizaje del punto siguiente).
- **Auto-detección de atributos** (pedido explícito del dueño: "no quiero cargar esto a mano"): una migración separada mira los productos/variantes YA cargados de cada categoría y arma sola sus `CategoriaAtributo` — si un atributo está presente en TODOS los productos de esa categoría, se marca obligatorio; si está en algunos, opcional. No asume nada de rubro (no hardcodea "Género" ni nada específico de ropa) — se deriva 100% de los datos reales, así sirve igual para cualquier tipo de negocio.
- **Rediseño de UI** (pedido explícito del dueño: la lista con las 18 categorías expandidas al mismo tiempo saturaba mucho): `/panel/categorias` es ahora una lista simple, y cada categoría tiene su propia página de detalle (`/panel/categorias/:id`) — mismo patrón que producto → variantes.

**Migraciones**: `20260814060000_categorias` (estructura), `20260814065000_categorias_migrar_datos` (texto → relación real, idempotente), `20260814080000_categorias_atributos_automaticos` (auto-detección, idempotente).

**Nota de seguridad de despliegue**: al preparar el push se detectó que la conversión de datos había quedado como un script manual (no una migración real) entre dos migraciones estructurales — si se pusheaba así tal cual, el deploy iba a borrar la columna vieja de categoría en producción **sin haber migrado nunca esos datos** (pérdida real de la categoría de cada producto). Se corrigió convirtiéndolo en una migración de verdad antes de pushear, y se probó contra datos simulados tipo producción antes de confirmar.

## 6. Bug: saludo genérico en vez de presentación real

**Problema reportado por el dueño** (probando el bot de verdad): el primer mensaje era "¡Hola! ¿En qué puedo ayudarte hoy? 😊" en vez de presentarse (nombre, tienda, qué vende).

**Causa raíz**: `AgenteConfig.mensajeBienvenida` tenía como valor por defecto en la base de datos el texto literal "Hola, en que puedo ayudarte?". Como ningún negocio lo configuraba a propósito, el bot igual asumía que **ese era el saludo elegido por el negocio** y lo usaba como base — nunca llegaba a generar la presentación real que el prompt sí sabe hacer cuando el campo está vacío de verdad.

**Decisión**: se sacó el default (ahora `null` = sin personalizar de verdad), se limpiaron en la base las filas que todavía tenían ese texto exacto sin haberlo tocado, y se cambió el placeholder de ejemplo en el panel (que sugería la misma frase mala).

**Migración**: `20260814090000_saludo_generico_default_null`.

## 7. Bug: foto de un producto totalmente distinto ("se está inventando")

**Problema reportado por el dueño** (con capturas reales de WhatsApp): pidió un abrigo/casaca, el bot listó 3 opciones **como texto plano** (con `*Nombre*`, `- Color:`, `- Precio:` escritos a mano en vez de usar tarjetas), el cliente pidió fotos de "la primera opción", y el bot mandó la foto de un **botín** — un producto de otra categoría totalmente distinto.

**Causa raíz encadenada**: al listar productos como texto plano en vez de llamar a `mostrar_productos`, no quedaba ningún ID real ligado a "Abrigo corto Arco" en el historial de la conversación. Cuando el cliente pidió la foto, el modelo tuvo que "adivinar" qué ID correspondía a "la primera opción" — y adivinó mal. El código, además, no validaba en ningún punto que el ID que mandaba el modelo tuviera algo que ver con la conversación real.

**Decisión (dos backstops en código, no solo prompt)**:
- `mostrar_productos`/`enviar_fotos_producto` ahora rechazan cualquier ID que no sea un candidato real de la búsqueda actual, algo ya mostrado en la conversación, o el favorito guardado.
- Si el modelo escribe un listado de productos con precio como texto plano (detectado por patrón: 2+ precios + 2+ ítems de lista, sin ninguna tool call), se rechaza en código y se le exige corregir con `mostrar_productos` antes de mandarlo al cliente.

De paso, se corrigió otro problema notado en la misma captura: `fichaProducto` repetía una línea por talla aunque todas tuvieran exactamente los mismos colores — ahora se colapsa en una sola línea.

## Patrón general que se repitió en toda la sesión

Casi todos estos cambios siguieron el mismo ciclo: **reporte real de uso del dueño → diagnóstico en código real (no suposición) → decisión de alcance explícita cuando había ambigüedad → implementación → verificación con simulación real (`llamarInyectado` inyectando una IA falsa determinista) antes de dar por resuelto.** Varias veces la causa raíz real no era donde el síntoma aparecía (ej: el bug de la foto equivocada no era un problema de "elegir la foto", era un problema de "no haber usado tarjetas antes").

---

## 8. Aplicación completa del documento "Instrucciones definitivas para el desarrollo del Agente de Ventas" (50 puntos)

Se auditaron los 50 puntos del documento contra el código real y se implementó todo lo que faltaba. Lo omitido a pedido explícito del dueño: **todo lo de pago/dinero** (puntos 35 y 36, y la parte de factura/NIT/razón social del 34) — el 35 y 36 ya estaban resueltos igual.

### Decisión de producto revertida a propósito: volver a 2-3 opciones + paginación

La decisión #1 de esta bitácora (mostrar TODAS las opciones, `MAX = 20`) **se reemplazó** por lo que pide el documento: mostrar 3 por vez con paginación real. El motivo por el que se había elegido "mostrar todas" era el miedo del punto 16 ("el catálogo tiene 13 y el bot muestra 3 y dice que son todas"), y ese miedo se resuelve mejor con `total_matches`: ahora el backend cuenta **todos** los resultados reales y le dice al modelo cuántos hay y cuántos quedan sin mostrar, así que el bot nunca puede afirmar "esas son todas" sin saberlo. No se esconde inventario: se muestra de a poco y el bot ofrece el resto.

### Motor de búsqueda separado (`lib/services/catalogo.js`)

`agente.js` era "cómo se le habla al modelo" y "qué existe en el inventario" mezclados. La segunda mitad se movió a `lib/services/catalogo.js` (filtros, cascada de alternativas, paginación, selección de fotos). `agente.js` reexporta lo que los tests ya usaban, así que nada se rompió.

### Qué cambió, punto por punto

- **Primero entender, después mostrar (puntos 2, 8, 13, 42, 44).** `filtrosCompletos` ya no se conforma con saber la categoría: si esa categoría tiene atributos de nivel `OBLIGATORIO` que todavía no se saben, `seccionProductos` **no le pasa ningún producto al modelo** y `mostrar_productos` lo rechaza en código. Antes era solo una línea de texto en el prompt, y el modelo mostraba productos igual apenas escuchaba "zapatillas".
- **Tres niveles de atributo (punto 44).** `CategoriaAtributo.obligatorio` (boolean) → `CategoriaAtributo.nivel` (`OBLIGATORIO` / `RECOMENDADO` / `OPCIONAL`). Obligatorio bloquea de verdad; recomendado se pregunta si la charla da pie; opcional solo filtra si el cliente lo menciona. El panel pasó de checkbox a selector.
- **Género como filtro real (punto 3).** Los atributos del lead (`atributosLead`) ahora **filtran la búsqueda**, no solo suman puntaje. Antes, con `Genero = Hombre` guardado, la búsqueda seguía devolviendo productos de mujer. Criterio: si el producto tiene el atributo cargado, tiene que coincidir; si no lo tiene, no se lo excluye (no hay dato que lo contradiga y descartarlo escondería inventario mal etiquetado). El género nunca se afloja, ni como último recurso.
- **Orden de alternativas del documento (punto 11).** `buscarConFallback` afloja de a un filtro por vez y en este orden: exacto → color → marca → presupuesto → talla. Nunca afloja categoría ni atributos del lead. Devuelve **cuál** filtro aflojó.
- **Preguntar antes de ampliar la búsqueda (punto 12).** Si el resultado apareció aflojando un filtro, no se muestra nada: el bot tiene que decir qué no encontró y preguntar si quiere ver las parecidas. Reforzado en código, y con control de turno para que el modelo no pueda preguntar y autorresponderse en la misma vuelta.
- **`total_matches` y paginación (puntos 15, 16, 17).** `RESULTADOS_POR_PAGINA = 3`. El bloque de resultados le dice al modelo el total real, cuántos ya vio el cliente y cuántos quedan. Tool nueva `ver_mas_productos`: la página siguiente **la elige el backend**, no el modelo, así no repite ni se saltea resultados.
- **Fotos de otro color (puntos 22, 23).** `fotoParaMostrar` ya no devuelve una URL pelada: devuelve `{url, colorDeLaFoto, esDelColorPedido, coloresConFoto, coloresSinFoto}`. Si el cliente pidió gris y solo hay foto blanca, se manda la blanca **marcada como referencial** y el bot recibe la orden explícita de aclararlo. También sabe qué colores tienen foto y cuáles no.
- **TOOL_SUCCESS / TOOL_FAILED de verdad (puntos 26, 41).** `mostrar_productos` y `enviar_fotos_producto` miran el resultado real de `wa.enviarImagenes`/`enviarTexto`. Si el envío falla, el resultado de la tool arranca con `TOOL_FAILED` y le prohíbe al modelo decir que mandó algo. Antes solo el QR de pago verificaba esto.
- **Moneda del backend (punto 29).** `Empresa.moneda` (configurable en `/panel/configuracion`). La ficha pasó de `Precio: 370.00` pelado a `Precio: Bs 370.00`. El modelo tiene prohibido convertir o cambiar el símbolo. También se aplicó al catálogo público y a las vistas de ventas del panel (los precios de los planes de Proshop siguen como estaban: son otra cosa).
- **Resumen de confirmación obligatorio (punto 39).** Tool nueva `confirmar_pedido`: arma el resumen real (producto, variante, cantidad, precios de la base, entrega) para que el bot se lo lea. `crear_pedido` **rechaza** si el cliente no confirmó ese pedido exacto (se compara una firma de los ítems), así que ningún pedido se crea sin confirmación real.
- **Tipo de entrega y retiro en tienda (puntos 34, 37, 38).** Enum `TipoEntrega` (`DOMICILIO` / `RECOJO`) en `ClienteFinal` y `Pedido`. `AgenteConfig.direccionTienda/tiendaLat/tiendaLng`: si el negocio no cargó su dirección, el bot **no ofrece retiro** en vez de inventar una. Al crear un pedido con retiro, manda la ubicación real y solo afirma haberla mandado si el envío fue exitoso.
- **Cambio de opinión (punto 46).** `limpiezaPorCambioDeCategoria`: al cambiar de rubro se sueltan favorito, variante favorita, descartados, confirmación pendiente y los atributos que no existen en la categoría nueva; se conserva lo que sigue valiendo (género, talla, presupuesto, nombre, dirección). Aplica tanto por la tool como por la detección determinista.
- **Memoria estructurada (punto 6).** `presupuestoMin`/`presupuestoMax` numéricos (el texto libre queda solo para repetírselo al cliente) y `varianteFavoritaId`.
- **Estados de compra (punto 7).** Se agregaron `DATOS_DE_PEDIDO`, `ENTREGA` y `PEDIDO_COMPLETADO` (el estado `PAGO` se omitió por ser de dinero).
- **SKU de producto (punto 19)** y **no inventar datos ni justificaciones de precio (puntos 28, 30)**, reforzado explícitamente en el prompt.
- **Logs (punto 48).** `logEtapa` ahora incluye `total_matches`, `results_returned`, `missing_attributes`, `purchase_stage`, `tool_result` y `selected_variant`.
- **Los 12 tests del punto 47.** `test/documento-12-casos.test.js`, uno por caso y en el mismo orden que el documento (45 asserts). Para poder testear los casos 5-8 sin WhatsApp ni base de datos, se extrajeron dos funciones puras: `avisosDeFoto` y `resultadoDeEnvio`.

**Migración**: `prisma/migrations/20260815010000_documento_agente_ventas` (idempotente, incluye la conversión de `obligatorio` → `nivel`).

⚠️ **La migración quedó escrita pero NO aplicada**: el entorno donde se hizo este trabajo no tenía credenciales de la base. Antes del próximo deploy hay que aplicarla y correr `npx prisma migrate resolve --applied 20260815010000_documento_agente_ventas` + `npx prisma generate`, como indica `CLAUDE.md`.

### Corrección encontrada al verificar contra el dump real de producción

Al revisar el backup local (`proshop_local_20260815_1130.sql`, 150 productos / 18 categorías / 2.290 variantes) apareció un problema que no se veía en los tests: **las 18 categorías tienen 8 atributos marcados `obligatorio`** (Corte, Estilo, Género, Material, Ocasión, Talla, Temporada, Tipo). Vienen de la migración de auto-detección (`20260814080000`), que marcaba obligatorio a todo atributo presente en TODOS los productos de la categoría.

Eso era inofensivo mientras `obligatorio` fuera solo una sugerencia en el prompt. Con el gate nuevo pasa a **bloquear**: el bot habría exigido las 8 respuestas antes de mostrar un solo producto — justo el interrogatorio que prohíbe el punto 4 del mismo documento.

**Decisión**: el backfill mapea `obligatorio = true` → **`RECOMENDADO`**, no a `OBLIGATORIO`. Es la traducción fiel de lo que ese flag hacía (pedir sin bloquear). `OBLIGATORIO` es comportamiento nuevo y activarlo sobre datos existentes sería un cambio silencioso y dañino. Cada negocio promueve a obligatorio los 1-2 que de verdad importan (típicamente Género y Talla) desde `/panel/categorias/:id`.

Además se agregó `MAX_ATRIBUTOS_SUGERIDOS = 3`: aunque una categoría tenga 8 recomendados, al modelo se le sugieren 3 por vez, para que el prompt no se vuelva un checklist.

**Lección repetida**: los tests deterministas pasaban al 100% y el problema igual estaba. Solo apareció mirando datos reales.

## 9. El bot preguntaba demasiado: más directo, menos interrogatorio

**Problema reportado por el dueño** (capturas reales de WhatsApp, conversación "vestido para mi novia"): tres fallas encadenadas en una sola conversación.

1. El bot pidió **marca, ocasión y talla juntas**, en una lista con viñetas — un formulario, justo lo que prohíbe el punto 4 del documento.
2. El cliente respondió marca y talla, y el bot **volvió a preguntar** ocasión y estilo en vez de mostrar productos.
3. Cerró con *"Voy a buscar algunas opciones... Dame un momento 🚀"* y **no mostró nada**: el turno termina en ese mensaje, así que el cliente quedó esperando algo que nunca llegó.

**Causa raíz**: el prompt tenía una regla que fomentaba usar listas ("USA LISTAS CUANDO AYUDEN"), sin excluir las preguntas; y los atributos `RECOMENDADO` se le ofrecían al modelo *antes* de mostrar, invitándolo a seguir preguntando para "afinar".

**Decisión (prompt + backstops en código, el patrón de siempre)**:

- Regla dura de **una sola pregunta por mensaje**, y listas permitidas solo para opciones entre las que el cliente elige, nunca para preguntas.
- Los atributos `RECOMENDADO` pasan a ser explícitamente **para después de mostrar**: "no los preguntes antes, solo sirven si el cliente vio las opciones y ninguna le convenció".
- Cuando faltan datos obligatorios, el sistema le dice **cuál preguntar** (solo el primero), no la lista entera.
- `pareceInterrogatorio()` — si el mensaje trae 2+ signos de pregunta, se rechaza en código y se le exige reescribirlo con una sola.
- `pareceAnuncioDeBusqueda()` — si promete buscar ("dame un momento", "ya te muestro", "voy a revisar"), se rechaza y se le exige mostrar de verdad o hacer la pregunta que falta.

Ambos backstops corren en el mismo punto del loop que el de "listado en texto plano", y están cubiertos por tests con los mensajes textuales de las capturas.

## 10. Catálogo en dos niveles y sin link a la web

**Problema reportado por el dueño** (capturas de WhatsApp): el cliente pedía "muéstrame los productos" / "tus categorías" y el bot mandaba **el link al catálogo web**, dos veces seguidas. El cliente tiene que salir de WhatsApp, abrir una página y volver — se pierde la venta en el camino. Además, con 18 categorías sueltas, listarlas era un muro de texto.

### Qué se decidió

- **El link se elimina del bot.** La tool `mostrar_catalogo` se reemplazó por `mostrar_categorias`, que arma la lista con lo que existe de verdad **y tiene stock**. La página `/catalogo/:slug` sigue existiendo para compartirla por otros medios; el bot no la usa.
- **Menú de dos niveles.** `Categoria.padreId` (auto-relación): un **rubro** agrupa **subcategorías**. El cliente pide el catálogo → ve los rubros; elige uno → ve los tipos; elige un tipo → recién ahí productos. Más de dos niveles no se hizo a propósito: en WhatsApp un tercer nivel es un laberinto.
- **Los productos cuelgan siempre de la hoja.** Si el rubro está dividido, sus productos viven en las subcategorías; si no, en el rubro.
- **Forzado en código, no solo en el prompt**: si el cliente está parado en un rubro que se subdivide, `seccionProductos` no le pasa ningún producto al modelo y `mostrar_productos` rechaza la llamada. Mismo patrón que el gate de atributos obligatorios.

### Por qué NO se usó el atributo `Tipo` que ya existía

Era la opción sin migración, pero los datos la descartaron: en el catálogo real hay **12 valores distintos de `Tipo` para 13 jeans**, 10 para 12 pantalones, 9 para 14 poleras. `Tipo` es el nombre del modelo ("Jean skinny", "Jean mom"), no un agrupador — un menú con eso tendría casi tantas opciones como productos.

### Reorganización del catálogo existente

Se hizo en una migración, verificada contra una copia del backup real (150 productos):

- **18 categorías sueltas → 7 rubros con 13 subcategorías.**
- **Se fusionaron dos pares que eran la misma prenda partida por género**: `Casacas` (solo mujer) con `Casacas y abrigos` (solo hombre), y `Chompas` con `Chompas y chalecos`. El género ya es un atributo de cada producto (los 150 lo tienen cargado) y el buscador filtra por él, así que una clienta sigue viendo solo lo de mujer — pero el menú deja de mostrar dos opciones que parecían repetidas.
- `Zapatos hombre` → `Zapatos de vestir`: el género no va en el nombre de la categoría, lo filtra el atributo.

La migración solo toca empresas que tengan al menos 8 de esos 18 nombres (o sea, ese catálogo), y solo mueve categorías que sigan siendo de primer nivel: no pisa una reorganización hecha después a mano.

### En el panel

`/panel/categorias` muestra **solo los rubros**. Las subcategorías se agregan **dentro** de cada rubro, en su página de detalle — así es imposible crear un rubro suelto queriendo agregar un tipo, que era la duda concreta del dueño. En el formulario de producto, el selector de categoría pasó a agrupar por rubro (`optgroup`) y se elige la hoja.

### Además

La espera antes de responder bajó de 8 a **5 segundos** (`MENSAJE_DEBOUNCE_MS`). Se sentía lento del otro lado. Más abajo agrupa menos mensajes seguidos y gasta más llamadas a la IA.

## 11. Preguntar antes de mostrar, y ofrecer los valores que existen de verdad

Dos pedidos del dueño después de probar el bot, que resultaron ser el mismo problema de fondo: **el bot preguntaba sin dar contexto y mostraba sin filtrar**.

### El bot pedía un color sin decir cuáles había

Captura real: el bot pregunta *"¿qué color prefieres?"* sin haber mostrado ningún color. El cliente responde *"no sé qué colores tienes"* y el bot le devuelve la pregunta: *"decime qué colores te gustan y reviso"*. Conversación trabada.

El sistema **sí conocía** los colores reales (viven en `Variante.atributos.Color`), simplemente nunca se los pasaba al modelo.

**Solución**: `opcionesDisponibles()` calcula los valores que existen con stock en lo que el cliente está mirando, y `bloqueDeOpciones()` los inyecta en el prompt. El modelo ahora recibe `Color: Azul marino, Beige, Blanco, Gris, Negro, Rosa palo` y tiene prohibido preguntar al aire. Los valores se separan por coma (un atributo puede guardar `"Diario, Salida"`) y las tallas se ordenan por talle real, no alfabéticamente.

### Preguntar el género antes de mostrar nada

`AgenteConfig.preguntasIniciales` (array, default `["Genero"]`): datos que el bot pide **antes que nada**, ni siquiera el menú de rubros. Son filtros que aplican a todo el catálogo, a diferencia de `CategoriaAtributo`, que depende de una categoría ya elegida — y acá justamente todavía no hay ninguna.

Forzado en código en los tres puntos de salida: `seccionProductos`, `mostrar_categorias` y `mostrar_productos`.

**La talla NO va por defecto**, aunque el dueño la mencionó: en el mismo catálogo conviven talla `42` (calzado) y `M` (ropa). Preguntarla antes de saber qué busca confunde. Queda configurable desde `/panel/configuracion` por si el negocio prefiere lo contrario.

### El menú se adapta a lo que ya sabe

`arbolDeCategorias(productos, lead)` filtra por los atributos ya conocidos. Con el catálogo real:

- Sin género: 7 rubros
- **Hombre: 4 rubros** (75 productos) — desaparecen Vestidos, Ropa Deportiva y Ropa de baño, que ahí no tienen nada para él
- **Mujer: 7 rubros** (75 productos)

Un rubro sin nada que ofrecerle a ese cliente no se muestra: el menú deja de ser una lista fija y pasa a ser lo que de verdad le sirve.

## 12. BUG GRAVE: el bot veía 1 de 4 productos y decía que era el único

**Reportado por el dueño** con capturas: la tienda tenía 4 zapatillas cargadas y el bot insistía *"las Zapatillas Park St 2.0 son el único modelo que tenemos en el inventario"*. Además dejó de mandar tarjetas con foto.

Reproducido con un escenario idéntico. Eran **dos causas distintas**:

### 1. El filtro de género escondía productos (regresión propia)

`coincideAtributosLead` comparaba el valor palabra por palabra. Un producto etiquetado `Genero: "Masculino"` quedaba invisible para un cliente que dijo *"hombre"*. Lo mismo con *Varón*, *Caballero*, *Femenino*, *Dama*.

**Solución**: tabla de equivalencias (`hombre ≡ masculino ≡ varón ≡ caballero`, etc.) usada al comparar valores de atributo. No es lógica de rubro, es vocabulario del idioma: agregar un sinónimo es sumar una palabra a su fila. Además, un producto puede declarar varios valores (`"Hombre, Mujer"`) y alcanza con que uno coincida.

Sigue separando de verdad los géneros distintos: una zapatilla de mujer no le aparece a un hombre.

### 2. Decía "es el único" cuando solo era el único *para él*

`total_matches` cuenta lo que calza con lo que pidió ese cliente. El modelo lo leía como "todo el inventario".

**Solución**: bloque `PANORAMA REAL` en el prompt, con cuántos productos hay cargados en la categoría, cuántos con stock y cuántos calzan con este cliente, más la prohibición explícita de decir *"es el único modelo que tenemos"*. Lo correcto es acotarlo: *"de hombre tengo estos 3"*.

De paso resuelve el otro pedido del dueño ("analizá si hay stock o no y de qué hay"): el modelo ahora sabe cuántos están agotados y tiene prohibido ofrecerlos.

### Lo de las fotos NO era del código

Las tarjetas dejaron de llegar porque **`public/uploads` se borra en cada redeploy** mientras no se monte el volumen en Coolify (ver `docs/04`). Sin las imágenes en disco, las URLs dan 404 y WhatsApp no puede adjuntarlas. El código ya detecta el fallo y le prohíbe al bot decir que las mandó — pero la foto no existe hasta que se monte el volumen y se vuelvan a subir.

## 13. BUG: el bot pedía permiso en bucle y nunca mostraba

**Captura del dueño**: el bot ofrece mostrar opciones que no calzan exacto, el cliente responde *"sí muéstrame todas las opciones"*, y el bot vuelve a preguntar lo mismo. Tres veces seguidas. La conversación queda trabada sin mostrar un solo producto.

**Causa raíz**: el permiso para mostrar alternativas con un filtro aflojado exige que el cliente haya contestado *en un turno posterior* al de la pregunta. El número de turno salía de `historial.length`… y `obtenerHistorial` corta en los **últimos 20 mensajes**. En una conversación larga ese largo **se queda clavado en 20**, el número de turno deja de avanzar, y el sistema nunca se entera de que el cliente contestó.

Es un caso clásico de "funciona en pruebas cortas, falla en uso real": ninguna conversación de test pasaba de 20 mensajes.

**Solución**: el turno pasa a ser la cantidad de mensajes del CLIENTE en la conversación (`prisma.mensaje.count`), que es monótona de verdad. Sin `conversacionId` (chat de prueba del panel) cae a `historial.length`, que ahí alcanza.

**Tope duro además**: si ya se pidió permiso **dos veces** por el mismo filtro, se muestra igual. Preferimos mostrar de más que dejar al cliente golpeando una puerta cerrada. Cualquier bug futuro de este tipo se degrada a "mostró una opción de más" en vez de "el bot no funciona".

Cubierto por un test que arma una conversación de 30 mensajes, justamente para que el corte del historial esté en juego.
