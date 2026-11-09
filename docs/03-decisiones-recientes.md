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

## 14. BUG: pedir otro color de un producto ya mostrado no mandaba nada

**Captura del dueño**: el bot muestra la tarjeta de las Park St 2.0, el cliente pregunta *"¿en qué otro color las tenés?"*, el bot responde bien (*"blanco, gris y negro"*), el cliente pide *"mostrame en blanco"* y el bot contesta **"ya te envié las fotos en color blanco"** — sin haber mandado ninguna.

**Causa**: `enviar_fotos_producto` cortaba si el **producto** ya figuraba en `fotosEnviadas`. Como la tarjeta inicial ya lo había marcado, cualquier pedido posterior de otro color devolvía "ya te envié todas las fotos" sin enviar nada, y el modelo se lo repetía al cliente.

**Solución**: el control de duplicados pasa a ser **por foto**, no por producto (`contexto.urlsFotosEnviadas`). Además, pedir un color ahora manda **todas** las fotos de ese color (un color suele estar repartido en varias tallas, cada una con sus imágenes), respetando el tope de 3 por turno.

Verificado de punta a punta: tarjeta → pide blanco → llegan las 2 fotos blancas → pide gris → llega la gris → pide blanco de nuevo → ahí sí avisa que ya se la mandó, sin reenviar.

## 15. El panel ahora dice por qué el agente no muestra un producto

El dueño reportó que tenía 4 productos cargados y el bot mostraba 1. Dos estaban sin stock, pero **eso solo se descubría hablando con el bot**.

`/panel/productos` gana una columna **"¿El agente lo muestra?"** con el motivo exacto cuando no:

- está desactivado
- no tiene stock (el agente nunca ofrece algo agotado)
- no tiene categoría
- **su categoría es un rubro dividido en subcategorías**: el cliente siempre elige una subcategoría, así que un producto colgado del rubro padre nunca se alcanza. Hay que moverlo a la subcategoría que corresponda.

Ese último caso es una trampa nueva que trajo el menú de dos niveles y no era evidente desde el panel.

## 16. BUG: "blancas" no matcheaba con "blanco" (y el bot mandaba la foto negra)

**Reportado con capturas.** El cliente pide *"blancas"*, el bot responde *"aquí tienes las Park St 2.0 en blanco"* y manda **una zapatilla negra**. Después pide *"talla 9 en blanco"* y la ficha dice **"Talla 9: negro"**.

**Causa raíz, una sola para los tres síntomas**: la comparación de color era literal (`"blanco".includes("blancas")` → `false`). Nadie escribe "quiero unas blanco": de unas zapatillas se dice *blancas*. Al no encontrar el color pedido, el sistema caía a la primera variante con foto —la negra— y la mandaba.

**Solución**: `valoresEquivalentes` compara en tres pasadas, de más exacta a más laxa: igualdad literal → grupo de equivalencia (`hombre ≡ masculino`) → **raíces de palabra**, que tolera plural y género (`blancas ≈ blanco ≈ Blanco nube`, `grises ≈ Gris`, `azules ≈ Azul marino`). Sigue distinguiendo colores distintos: `blancas` nunca matchea `negro`. La misma comparación se usa en la selección de foto y en la ficha, así que los dos síntomas se corrigen juntos.

**Además, ya no se manda la foto de otro color.** Antes se enviaba "como referencia" con un aviso, y el modelo se comía el aviso y la presentaba como si fuera el color pedido. Ahora `fotoParaMostrar` devuelve **sin foto** cuando el color pedido no tiene imagen, e informa cuál se podría **ofrecer** como referencia — que es lo que pide el punto 22 del documento: preguntar antes, no mandar y avisar después.

**Y el "aquí tienes" vacío**: regla nueva en el prompt. Esa frase (y "acá te dejo", "te paso") anuncia un adjunto; si en ese turno no se envió ninguna imagen, el cliente lee la frase y no ve nada. Cuando solo se está contando lo que hay, va *"tenemos"* / *"ahora mismo contamos con"*.

## 17. Reinicio de "lo ya mostrado" y prohibido nombrar un producto sin su tarjeta

Dos pedidos del dueño, y el segundo era la causa del primero.

### El bot se negaba a repetir lo que ya había mostrado

Captura: el cliente pregunta *"¿qué modelos tenés?"* y el bot contesta en texto *"tenemos las Zapatillas Park St 2.0... **ya te mostré las opciones antes**"*. El cliente no ve ninguna tarjeta: ni foto, ni precio, ni tallas.

Dos cambios:

- **`MINUTOS_PARA_REINICIAR_VISTOS = 10`** (configurable por `MINUTOS_REINICIO_VISTOS`): si el cliente estuvo ese rato sin escribir, se olvida **qué se le mostró** y las tarjetas vuelven a salir. Lo que el cliente **dijo** —categoría, talla, color, nombre, dirección— se conserva: esa memoria sí le sirve. En WhatsApp, a los 20 mensajes una tarjeta vieja ya no está a la vista.
- **El bloqueo de reenvío pasa a ser por turno, no por conversación.** Antes, una vez mostrado un producto, `mostrar_productos` lo rechazaba para siempre. Ahora solo evita repetir la misma tarjeta dentro del mismo mensaje (que era el problema original: el modelo la mandaba tres veces seguidas). Si el cliente la pide de nuevo, se le manda.

### Nombrar un producto en texto sin mandar la tarjeta

Backstop nuevo (`nombraUnProductoReal`): si el texto final menciona el nombre de un producto real del catálogo y en ese turno **no se envió ninguna tarjeta**, se rechaza y se le exige llamar a `mostrar_productos`.

El de "listado en texto plano" que ya existía sólo saltaba con 2+ precios y 2+ viñetas; con **un solo producto** no se activaba, que es justo el caso de la captura. Este cubre ese hueco.

Verificado contra la base: tras 15 min reenvía la tarjeta, a los 2 min también si el cliente la pide, y el modelo que nombra el producto sin tarjeta es forzado a mandarla.

## 18. BUG: "quiero otras opciones" → "no tenemos más", teniendo más

**Charla real del dueño del negocio con el bot**: le muestran las Park St 2.0, dice *"no quiero esas, quiero otras opciones"* y el bot responde *"lamento que no tengamos más opciones por el momento"*. En la categoría había **otro producto con stock**.

**Causa**: `buscarConFallback` recorre escalones (exacto → aflojar color → marca → presupuesto → talla) y **corta en el primero que devuelve algo**. Si el cliente venía pidiendo un color y UN producto calzaba exacto, la cascada terminaba ahí y los que estaban a un color de distancia **nunca se calculaban**. El bot decía "no hay más" con total honestidad: para él no existían.

Es un bug de diseño de la cascada, no del modelo.

**Solución**: `buscarConFallback` devuelve además `adicionales` — lo que aparece aflojando todo lo aflojable (nunca la categoría ni el género), menos lo que ya está en `resultados`. Cuando el cliente ya vio los exactos, `seccionProductos` se los ofrece:

> *"OJO, SÍ HAY MÁS PRODUCTOS que este cliente todavía no vio... PROHIBIDO contestarle que no hay más: tenés N opción(es) para ofrecerle."*

Y cuando de verdad no queda nada, el bloque sigue diciendo que no hay más — sin `adicionales`, el texto es el de antes.

**De paso**: se levantó la prohibición de repetir una tarjeta ya mostrada. Negarle al cliente una tarjeta que está pidiendo porque "ya se la mostraron" hace 20 mensajes lo trata mal; en WhatsApp esa tarjeta ya no está a la vista. Solo se evita repetirla dentro del mismo mensaje.

## 19. Mostrar primero, afinar después (revierte parte del punto 2 del documento)

**Charla real del dueño con el bot**: pide comprar, el bot le pregunta el color; pide ver, el bot le vuelve a pedir el color; elige *"Blanco nube"* —un color que **el propio bot le había ofrecido**— y recibe *"no tenemos zapatillas exactamente en Blanco nube"*. Nunca vio una foto. Veredicto del dueño: **"no tiene que preguntar por color ni por talla, tiene que mostrar primero"**.

**Causa**: el bloque `VALORES REALES DISPONIBLES` (punto 11 de esta bitácora) se agregó para que el bot pudiera **responder** *"¿qué colores tenés?"*. El modelo lo leyó como una lista de datos **para pedir antes de mostrar** y convirtió la conversación en un formulario.

**Decisión**: se invierte la prioridad.

- El bloque de valores ahora dice explícitamente que es **para responder y para afinar después de mostrar**, no un cuestionario previo.
- Regla dura en el prompt: *si hay productos en el bloque de resultados, se muestran ya*. Color, talla, marca y presupuesto solo se piden **después** de que el cliente vio opciones.
- Backstop en código (`pidePreferenciaSinMostrar`): si hay candidatos listos y el modelo pide color/talla/marca/presupuesto sin haber mandado ninguna tarjeta en ese turno, se rechaza y se le exige mostrar.

**Esto matiza el punto 2 del documento original** ("antes de mostrar productos debe entender al cliente"). Sigue vigente para lo que la tienda marcó como `OBLIGATORIO` —típicamente el género, que parte el catálogo en dos—, pero **el color y la talla dejaron de ser previos**: no aportan lo suficiente como para pagar el costo de que el cliente abandone antes de ver nada. Es una decisión explícita del dueño después de probarlo en vivo, no un olvido.

## 20. La tarjeta mostraba una sola variante de seis

**Reportado por el dueño con una captura del panel**: el producto tiene 6 variantes cargadas y la tarjeta que recibe el cliente dice *"Talla 9: blanco"* y nada más.

**Causa**: `fichaProducto` recortaba las variantes a la talla y el color que el cliente hubiera pedido antes. En ese producto el blanco **solo tiene stock en la talla 9** (el 10 y el 8.5 están en 0), así que la intersección "talla 9 + blanco" dejaba una línea sola. Un producto con 6 combinaciones parecía tener una.

Esa regla se había puesto para no saturar la tarjeta con 15-20 combinaciones. El costo real resultó peor: el cliente no ve el abanico y no puede elegir.

**Solución**: la tarjeta muestra **todo lo que tiene stock**, y lo que el cliente pidió no se esconde — se le dice aparte, arriba de la lista:

```
· *Lo que buscabas* (talla 9 en blanco): disponible ✅

*Tallas y colores disponibles*:
· Talla 9: blanco, Gris
· Talla 9.5: Gris
· Talla 10: Gris
```

Y si esa combinación no tiene stock: *"sin stock por ahora, pero mirá lo que sí hay 👇"*. Antes, en ese caso, la tarjeta caía al listado completo sin explicar nada.

Sigue vigente el agrupado por talla y el colapso cuando todas comparten los mismos colores, que es lo que evita la saturación de verdad.

## 21. Carrito y el recorrido de venta acordado con el negocio

Después de que el ingeniero del cliente probara el bot en vivo, se acordó punto por punto el recorrido que tiene que seguir. Esta es la referencia: si algo del bot no encaja acá, es un bug.

```
1. Cliente pregunta qué vendés  → el bot lista las CATEGORÍAS
2. Elige una (por número, por nombre o "me interesa")
                                → el bot manda las TARJETAS, máximo 3
3. "más"                        → 3 más, hasta agotar el stock
4. Elige mirando la tarjeta ("la Ginger Tav en blanco talla 9")
                                → agregar_al_carrito
5. "¿Deseás ver algo más?"      SÍ → vuelve al MENÚ DE CATEGORÍAS
                                NO → cierre
6. Cierre: nombre, entrega, forma de pago → resumen → crear_pedido
```

### La decisión que más cambia el flujo

**"Las tallas disponibles están en la tarjeta"** (textual del ingeniero). El bot **no pregunta talla ni color** para buscar: el cliente los lee en la tarjeta y los dice. La única vez que se pregunta una talla es cuando ya eligió un producto y falta saber qué combinación exacta se lleva — ahí no está filtrando, está completando la compra.

### El carrito

No existía: el pedido se armaba de una sola vez y el modelo tenía que "acordarse" de todos los ítems. Si se olvidaba uno, se vendía de menos.

`lib/services/carrito.js` + tres herramientas (`agregar_al_carrito`, `ver_carrito`, `quitar_del_carrito`). `confirmar_pedido` y `crear_pedido` ahora **cobran lo que hay en el carrito**; el parámetro `items` quedó opcional.

Vive en `ClienteFinal.contexto.carrito`, no en una tabla, y guarda el `conversacionId`: **si el cliente vuelve otro día, arranca limpio** (decisión explícita del negocio). Se vacía también al crear el pedido.

Decisiones puntuales que confirmó el negocio:
- **Forma de pago**: se ofrece en el cierre, después del carrito.
- **Nombre y dirección**: se piden al final, cuando ya aceptó todo lo que va a comprar.
- **"¿Algo más?" → sí**: vuelve al menú de categorías, no a las tarjetas de la misma.
- **Género**: se mantiene como pregunta inicial.

Verificado de punta a punta contra la base: el cliente agrega dos productos distintos en dos momentos, y el pedido creado tiene los dos, con el total correcto y el carrito vacío después.

---

## 22. BUG: un producto "Unisex" era invisible para todo el mundo

**Qué pasó.** El dueño vio en el panel `ZAPATILLAS TEKKIRA CUP`, **stock 10**, columna "¿El agente lo muestra?" en **"Lo ofrece"** — y en WhatsApp el bot le contestó al cliente *"lamento decirte que no tenemos zapatillas Tekkira Cup en nuestro inventario actualmente"*. Un producto con stock, negado en la cara del cliente: el peor error posible para un agente de ventas.

**Causa.** El producto está cargado con `Genero: Unisex` y el cliente había dicho "hombre". En `EQUIVALENCIAS` (`lib/services/catalogo.js`) `unisex` era su propio grupo de sinónimos, así que `valoresEquivalentes('Hombre', 'Unisex')` daba `false` y `coincideAtributosLead` lo descartaba. El efecto era peor de lo que suena: como el bot siempre pregunta el género al inicio, **un producto unisex quedaba oculto para el cliente que dijo hombre Y para el que dijo mujer**. O sea, para todos.

La columna del panel no mentía: ahí el producto se evalúa sin lead, y sin género pedido sí se ofrece.

**Decisión.** Un valor "unisex" (o "ambos", "todos") **satisface cualquier valor pedido para ese atributo**. No es un sinónimo de hombre ni de mujer — es un comodín, y se trata como tal en `coincideAtributosLead`, saltando el filtro para ese atributo. `Hombre` y `Mujer` siguen sin mezclarse entre sí.

## 23. El bot ahora busca antes de decir "no lo tenemos"

**Qué pasó.** En la misma conversación, el cliente preguntó por un modelo *por su nombre* ("¿no tenés de casualidad las Tekkira Cup?"). El bot solo ve el bloque de resultados que le arma el backend, y ese bloque viene **filtrado por lo que el cliente venía pidiendo** (género, color, talla, presupuesto). Si el producto no entraba en ese filtro, para el modelo simplemente no existía, y respondía que no lo manejaban.

Arreglar el filtro de unisex tapa este caso puntual, pero no la clase de bug: cualquier filtro activo puede esconder algo que el cliente nombra explícitamente.

**Decisión.** Nueva tool `buscar_producto(nombre)`. Cuando el cliente nombra algo que el modelo no ve en su bloque, busca en **todo el catálogo de la empresa, sin los filtros de la conversación**, y devuelve una de tres respuestas, todas terminantes:

| Situación | Qué se le devuelve al modelo |
|---|---|
| Existe y tiene stock | La ficha completa + "PROHIBIDO decirle que no lo tenés: lo tenés" |
| Existe, sin stock | "SÍ existe pero está SIN STOCK: decile que lo manejan pero ahora no hay" |
| No existe | "No existe ningún producto con ese nombre. Ahora sí podés decirle que no lo manejan" |

El id encontrado se agrega a los ids válidos de `mostrar_productos`, para que pueda mostrarlo en el acto en vez de solo describirlo.

La búsqueda (`buscarPorNombre`, en `catalogo.js`, pura y testeada sin base de datos) **puntúa por cuántas palabras del pedido aparecen en el nombre y se queda con las mejores**. Sin eso, buscar "ZAPATILLAS TEKKIRA CUP" también devolvía "ZAPATILLAS GINGER TAV" — comparten "zapatillas" — y el bot le terminaba nombrando al cliente un producto que no pidió. Acepta nombres parciales: "tekkira" encuentra "ZAPATILLAS TEKKIRA CUP".

**Lo que sigue sin cubrir:** nombres mal escritos ("tekira" con una k). No se agregó búsqueda difusa a propósito: confundir un producto con otro parecido es peor que no encontrarlo.

## 24. BUG GRAVE: el bot preguntaba el género para siempre y nunca mostraba nada

Reportado con captura. Chat real, tienda "Tienda Demo — Zapatillas Urbanas Para Hombre":

```
cliente: hola
bot:     ¡Hola! Soy Raúl... ¿Qué andas buscando hoy?
cliente: que modelos tienes
bot:     ¿Buscas algo para hombre o para mujer?
cliente: hombre
bot:     ¡Perfecto! Solo para confirmar, ¿es para hombre o para mujer?
cliente: hombre
bot:     ¿Es para vos o para regalar?
cliente: para mi
bot:     ¿Y qué género estás buscando?
cliente: hombre
bot:     Una última cosita, ¿podés decirme el género?
```

El cliente contestó **tres veces** y nunca vio un producto.

### Por qué pasaba (cuatro fallas encadenadas, no una)

1. **No había respaldo en código.** El gate de `preguntasIniciales` solo se
   destrababa si el modelo llamaba a `actualizar_datos_lead`. `extraerFiltros`
   —el respaldo determinista que existe justamente porque el modelo a veces no
   llama a la tool— extraía categoría, talla y cantidad, pero **no** los
   atributos. La palabra "hombre" no la leía nadie.
2. **La clave se comparaba literal.** `atributosLead[a.nombre]`, sensible a
   mayúsculas y tildes. El negocio configura "Genero" a mano en el panel y el
   modelo escribe "género" cuando se le canta: el dato quedaba guardado bajo
   una clave y el gate seguía mirando la otra.
3. **Se preguntaba algo que el catálogo no podía responder.** La migración
   `20260815040000_preguntas_iniciales` puso `DEFAULT ARRAY['Genero']` para
   **todas** las tiendas ya existentes, incluidas las que no cargaron el
   atributo en ningún producto (Tienda Demo tiene `atributos: {}` en todos) y
   las que venden un solo género. La respuesta no podía cambiar lo que se
   mostraba: era puro trámite.
4. **La pregunta era abierta.** El texto del gate le daba al modelo ejemplos
   como *"¿es para vos o para regalar?"*, y el modelo la usó literal. La
   respuesta ("para mi") no contesta el género, así que ni siquiera un
   respaldo podía resolverla. Sumado a la instrucción de "variá cómo
   preguntás", el cliente veía la misma pregunta con cuatro redacciones.

### Qué se hizo

- **`resolverValorDeAtributo(texto, atributo, productos)`** en `catalogo.js`:
  lee la respuesta del cliente **en código** y la resuelve contra los valores
  que existen de verdad en el catálogo ("hombre" → `Hombre`, "para caballero"
  → `Masculino`, reusando el diccionario de equivalencias que ya estaba).
  Se llama desde `generarRespuesta` al lado de `extraerFiltros`: mismo patrón,
  mismo lugar.
- **Búsqueda tolerante de la clave** (`valorEnAtributosLead` / `leadYaTiene`):
  "Genero", "Género" y "GENERO" son el mismo dato. Además, al escribir desde
  `actualizar_datos_lead` se reusa la clave que ya existía, para no terminar
  con dos entradas del mismo atributo.
- **No se pregunta lo que no sirve.** `preguntasInicialesFaltantes` ahora
  recibe el catálogo y descarta los atributos con menos de dos valores reales.
  Con un solo valor, `resolverDatosIniciales` lo completa solo. Esto apaga la
  pregunta en Tienda Demo y en cualquier tienda de un solo rubro/género.
- **La pregunta pasa a ser cerrada.** El gate le pasa al modelo los valores
  reales y le exige nombrarlos ("¿lo buscás de Hombre o de Mujer?"). Una
  pregunta abierta no se puede resolver después.
- **Anti-bucle duro.** `contexto.intentosPreguntaInicial` cuenta los turnos en
  que el dato siguió sin resolverse; a los 2, el gate se libera y el cliente ve
  el catálogo igual. Es preferible mostrar de más que dejarlo atrapado. Queda
  el log `gate_inicial_liberado` para detectar tiendas mal configuradas.

### Falso positivo encontrado al escribir los tests

La primera versión del resolvedor daba `Genero: Hombre` para la respuesta
**"para mi"**. Causa: `valoresEquivalentes` termina en `coincideTexto`, que por
diseño devuelve `true` cuando el lado del cliente no tiene ninguna palabra útil
— y "para" es un conector genérico que `palabrasClave` descarta, dejando la
lista vacía. Un "para" suelto matcheaba contra *cualquier* valor. Se arregló
tokenizando con `palabrasClave` y exigiendo al menos una palabra real.

Cubierto por `test/preguntas-iniciales.test.js` (16 casos, incluido el chat de
la captura completo). Suite determinista: 174 tests en verde.

### Pendiente para el dueño

Las tiendas que **sí** venden varios géneros y quieran la pregunta tienen que
tener el atributo cargado en los productos (`/panel/productos`). Si el catálogo
no lo tiene, el bot ya no pregunta — mostrar todo es mejor que preguntar al
pedo. La pregunta se prende y apaga desde `/panel/configuracion`.

## 25. BUG: el color frenaba la venta, y "cualquiera" no contaba como respuesta

Reportado por el negocio (JGO) después de probar el bot:

> *"quedamos en que ya no le preguntaba genero y color... que eso aparecería en
> las tarjetas. El bot lo sigue obligando a escoger un color. Si el usuario dice
> cualquiera el bot le dice: no, tienes que escoger un color antes de seguir."*

Eran **dos fallas distintas**, no una.

### 1. El bot trataba los atributos de variante como bloqueo

`atributosFaltantes()` miraba solo `nivel === 'OBLIGATORIO'` e ignoraba
`esDeVariante`. Si la tienda marcaba **Color** (o Talla) como obligatorio, el
gate de `mostrar_productos` no dejaba mandar una sola tarjeta hasta tenerlo.

Lo llamativo es que **el panel ya hacía lo contrario**: al guardar un producto,
`atributosObligatoriosFaltantes()` en `server.js` filtra por
`esDeVariante: false` justamente porque los de variante *"son guía, no
bloqueo"*. El bot era el único lugar del sistema que los trataba como
requisito, y contradecía además a su propio prompt, que dice textual: *"Las
tallas y colores VAN EN LA TARJETA"*.

Ahora `atributosFaltantes` descarta los de variante cuando el nivel es
OBLIGATORIO. En RECOMENDADO se siguen incluyendo: ahí no bloquean nada, son
sugerencias para afinar **después** de que el cliente vio opciones.

### 2. "cualquiera" no se reconocía como respuesta

Contestar *"me da igual"* dejaba el dato como faltante para siempre: el cliente
había respondido, pero el sistema seguía esperando un valor concreto y volvía a
preguntar. `expresaSinPreferencia()` (en `catalogo.js`, puro y testeable)
reconoce las formas normales de decirlo, y `generarRespuesta` anota los
atributos pendientes en **`contexto.sinPreferencia`**.

Se guarda ahí a propósito y **no** como si fuera un valor del lead: poner
`lead.color = 'cualquiera'` habría hecho que el buscador filtrara por un color
inexistente y no encontrara nada. Marcado así, el dato deja de faltar **y** la
búsqueda no se filtra por él.

Deliberadamente **"no sé" NO cuenta** como falta de preferencia. Son clientes
distintos: el que dice "cualquiera" renunció a elegir; el que dice "no sé"
necesita que le muestren opciones para poder decidir. Tratarlos igual haría que
el bot le diera por respondida una pregunta a alguien que estaba pidiendo ayuda.

### Dos tests viejos que hubo que cambiar (no borrar)

`documento-12-casos.test.js` afirmaba que faltando la **talla** el bot no podía
mostrar (punto 42 del documento original del dueño). Esa regla quedó revertida
por decisión explícita del negocio — la misma reversión que ya había empezado
en los puntos 19 y 21 ("las tallas disponibles están en la tarjeta", textual
del ingeniero). Los dos tests se actualizaron a la regla nueva, con el motivo
anotado al lado; no se eliminaron, para que quede el rastro de qué cambió y
por qué.

`docs/04-pendientes-y-gaps.md` también quedó desactualizado: decía que el dueño
tenía que promover Género **y Talla** a Obligatorio. Ya lleva la nota de que
promover Talla o Color no hace nada.

### Verificación

`test/atributos-bloqueantes.test.js` (11 casos) cubre las dos fallas y el chat
reportado. Suite determinista completa: **194 tests en verde**.


## 26. Flujo determinista del Vendedor IA (menús, carrito y cierre con listas y botones, sin IA)

**Problema.** Cada mensaje costaba entre 1,5 y 1,9 llamadas a la IA (~7 mil tokens de entrada cada una), aunque buena parte del recorrido es un menú o un formulario: elegir categoría, "¿algo más?", editar el carrito y cerrar el pedido (nombre, entrega, ubicación, pago, resumen, confirmar). En la conversación real #134 ≈60 % de las llamadas eran de esos turnos.

**Decisión.** Módulo `lib/services/flujoDeterminista.js` (máquina de estados, estado en `ClienteFinal.contexto.flujo = { paso, ts, intentos }`) que responde con plantillas, listas y botones de WhatsApp y reutiliza `mostrar_tarjeta_categoria`, `confirmar_pedido` y `crear_pedido` (los totales y el stock siguen calculándolos esos handlers). La IA queda para preguntas abiertas: cada paso cede a la IA si el cliente pregunta (`?`) o falla 3 veces. Parte de los archivos del jefe (`flujoDeterminista.js`, `whatsapp-interactivo.js`, `maquina-de-estados.md`), con estos ajustes tras la revisión:

- **Detrás de un flag por agente** (`AgenteConfig.flujoDeterminista`, default `false`, checkbox en Configuración). Apagado = comportamiento anterior. Rollback: desmarcar.
- **Nombre estricto** (`nombrePlausible`): `nombreValido` aceptaba "Ok", "Nada mas", "Terminar" o "hola buenas tardes" como nombre. El flujo exige ≤3 palabras solo con letras y ninguna palabra de una lista de exclusión (un nombre ya guardado se sigue juzgando con `nombreValido`, igual que `confirmar_pedido`).
- **Los toques de botón/lista saltean el debounce de 5 s** y todo lo que genera respuesta de un cliente corre en serie (`conBloqueoDeCliente`, clave `gen:`): si no, dos "➕ 1" seguidos contaban uno y un comando podía correr a la vez que un texto.
- **Deduplicación del webhook por `mensaje.id`** (`lib/services/dedupe.js`, en memoria, TTL 1 h): con comandos con estado un reenvío de Meta no es inocuo.
- **El historial conserva las opciones** (`textoRegistro`): la IA y el panel ven "1. Calzado / 2. …" y no solo "¿cuál te interesa?".
- **Bloques de rescate de la última vuelta** (la IA falla en pleno cierre y el cliente pide una categoría): con el flag activo los tipos/rubros salen como lista y no como texto numerado.
- **Respaldo a texto** si WhatsApp rechaza una lista/botones/pedido de ubicación (`enviarSalidaPorWhatsApp` en `server.js`).
- `interpretarMensajeEntrante` devuelve el **título** del botón/lista (no el ID técnico); el ID viaja aparte como `idBoton`.
- **Bug del diseño original encontrado por los tests**: tras `confirmar_pedido`/`crear_pedido` el flujo escribía el `contexto` desde su copia en memoria y pisaba la firma del resumen y el vaciado del carrito; ahora relee el lead después de cada tool (`refrescar`).
- Con el flag activo, el regreso desde la web ("Quiero *X*") lo contesta el flujo: `carritoWebPendiente` ya no se consume antes en `generarRespuesta` en ese caso exacto.

**Carrito web ↔ WhatsApp (hallazgo 3 del audit).** El link del catálogo vive 24 h pero una conversación se renueva a las 6 h; la web guardaba el carrito con el `conversacionId` firmado en el link (viejo) y pisaba/ocultaba el actual. Ahora usa la conversación abierta del cliente (`conversacionParaCarritoWeb`) o `null` (adoptable por la próxima conversación dentro de las 24 h). Se mantiene "carrito por conversación" (decisión de negocio de `carrito.js`).

**Archivos.** `lib/services/flujoDeterminista.js`, `dedupe.js`, `whatsapp.js` (`enviarLista`, `enviarSolicitudUbicacion`, `textoDeLista`), `conversaciones.js`, `agente.js`, `server.js`, `views/cliente/configuracion.ejs`, migración `20261027120000_agente_flujo_determinista`.

**Medición.** Cada respuesta del flujo emite el log `respuesta_por_flujo` (no genera fila en `usos_ia`, porque no hay llamada). Comparar llamadas por mensaje y por pedido en `/admin/costo-ia` antes y después de activar el flag en un agente piloto.

**Fuera de alcance (siguiente fase).** Comprobante de pago por estado (evitar visión), atributos obligatorios con botones, filtrar tools por estado, modelos más baratos para las llamadas que queden.

### Verificación

`test/flujo-determinista.test.js` (23 casos: menús, carrito, cierre a domicilio y con retiro en tienda, pago con QR, paginación "Ver más", rescate de última vuelta y flag apagado, con una IA inyectada que cuenta llamadas y debe quedar en 0), `test/dedupe.test.js`, `test/whatsapp.test.js` (listas/ubicación), `test/carrito.test.js` y `test/carrito-web-conversacion.test.js`. Suite completa: **490 tests en verde**. Prueba de humo por el webhook real: duplicado ignorado, `respuesta_por_flujo` sin llamadas a la IA, respaldo a texto cuando Meta rechaza el mensaje, y dos toques simultáneos de "➕ 1" aplicados ambos.


## 27. Catálogo público más liviano: caché en memoria, sin embeddings y con compresión

**Problema.** `/catalogo/:slug` cargaba TODO el catálogo de la empresa (productos + variantes + categorías) desde Postgres en cada visita, incluyendo el vector `Producto.embedding` (1536 números por producto) que solo usa el bot. No había caché HTTP ni compresión. Una promo con muchas visitas pegaba a la base una vez por visita.

**Decisión.** Se queda Postgres como fuente de verdad (ver análisis Postgres vs NoSQL: los atributos flexibles ya viven en columnas `Json`). Se agrega solo una capa de lectura:
1. **Consulta liviana**: `omit: { embedding: true }` en el listado y en la ficha de producto.
2. **Compresión** (`compression`, br/gzip) y `Cache-Control: public, max-age=30d, immutable` para `/uploads` (los nombres de archivo son únicos: timestamp + aleatorio). `public/` (css/js) sigue revalidando porque conserva nombres entre deploys.
3. **Caché en memoria por empresa** (`lib/services/catalogoCache.js`, TTL 45 s, tope 500 entradas): solo el LISTADO. El filtro por categoría/color/talla se aplica sobre la copia cacheada. Visitas simultáneas comparten una sola carga, y una carga que empezó antes de una invalidación no puede guardar su dato viejo.

**Invalidación.** Cualquier escritura (POST/PUT/DELETE) bajo `/panel` invalida la empresa de la sesión y bajo `/admin` invalida todo (`invalidarCatalogoAlTerminarEscritura` en `server.js`); eso cubre productos, variantes, stock manual, categorías, importación de Excel, cancelaciones con restock y config. El bot descuenta stock al crear un pedido, que no pasa por el panel: `agente.js` invalida la empresa justo después de la transacción.

**Qué NO cambia.** El stock real se sigue validando contra Postgres al agregar al carrito y al confirmar el pedido: lo peor que puede mostrar el listado es un número con hasta 45 s de atraso. La ficha de producto y el carrito no se cachean.

**Limitación.** Caché en la memoria del proceso (instancia única, igual que `dedupe.js`). Con más de una instancia habría que pasarla a Redis; el TTL corto acota el atraso mientras tanto. Variable opcional: `CATALOGO_CACHE_TTL_MS`.

**Archivos.** `lib/services/catalogoCache.js` (nuevo), `server.js`, `lib/services/agente.js`, `package.json` (`compression`), `test/catalogo-cache.test.js` (10 casos). Suite: **500 tests en verde**. Medido en local con 150 productos: primera visita ~94 ms, siguientes ~10 ms, respuesta comprimida (133 KB de HTML).


## 28. Panel más simple para usuarios nuevos: "Primeros pasos" y producto guiado

**Problema.** Un negocio nuevo no entendía qué hacer: Inicio mostraba métricas en cero, y crear un producto con variantes exigía 12 campos en una sola página, guardar, volver a editar y cargar cada variante como pares "Talla = 42" en un segundo formulario. Tres campos se superponían (Descripción, Características y Atributos).

**Fase A: "Primeros pasos" en Inicio** (`lib/services/primerosPasos.js`, `views/cliente/inicio.ejs`). Tarjeta con 3 pasos (agregar un producto, conectar WhatsApp, activar el agente), cada uno con su botón y marcado solo cuando está hecho de verdad (productos > 0, `ConexionWhatsApp.estado = CONECTADO`, `Agente.estado = ACTIVO`). El siguiente pendiente es el único con botón principal. Desaparece cuando los tres están hechos.

**Fase B: formulario de producto guiado** (`views/cliente/producto-form.ejs`, `partials/constructor-variantes.ejs`, `lib/services/variantesForm.js`).
1. *¿Qué vendés?*: nombre, grupo (categoría, que se puede crear ahí mismo con `categoriaNueva`), precio, stock y fotos con vista previa. Es lo único obligatorio.
2. *¿Viene en varias opciones?* (solo al crear): "No, es uno solo" / "Sí". Con "Sí" se elige Talla/Color/otra, se escriben los valores separados por coma y el navegador arma la tabla de combinaciones, donde solo se pone stock (y precio propio si hace falta), con "mismo stock para todas". Todo se crea junto con el producto en una sola operación (`variantes: { create }`).
3. *Más detalles* (plegado): descripción, SKU, características, datos extra y visibilidad. Se abre solo si el grupo elegido exige atributos obligatorios.
- Al editar, la sección "Opciones de este producto" muestra las variantes existentes y el mismo constructor para agregar más: las combinaciones que ya existen se saltean (`sinLasExistentes`, sin distinguir mayúsculas ni orden).
- El servidor valida todo `variantesJson` de nuevo (máx. 100 combinaciones por vez, 6 opciones por variante, stock ≥ 0, precio válido o vacío). Las rutas viejas (campos `atributoClave[]` por variante) siguen funcionando.
- Con variantes, `Producto.stock` queda en 0 (criterio de siempre).
- Si la categoría nueva ya existe como rubro (sin importar mayúsculas) se reutiliza, para no duplicar el menú del bot. Solo se crea después de validar el resto.
- Arreglado de paso: re-renderizar la edición con error fallaba con `errorVariante` indefinido.

**Verificado** en el navegador (escritorio y celular, sin scroll horizontal): alta con categoría nueva + 6 combinaciones, edición agregando 2 combinaciones donde 1 ya existía (se creó solo la nueva), y bloqueo del envío si se elige "Sí" sin armar combinaciones. Suite: 516 tests (+12 de `variantes-form`, +4 de `primeros-pasos`).

**Pendiente de esta línea (fases siguientes del plan de UI):** menú lateral agrupado, categorías más simples, configuración en pestañas y pasada de diseño (quedan ~190 `style=` en línea; la tabla de variantes existentes todavía los usa).


## 29. Menú lateral agrupado y categorías más simples

**Problema.** El menú tenía 13 ítems planos en "Operación" (más 3 de facturación) y la pantalla de Categorías explicaba rubros, subcategorías y atributos en tres párrafos antes de dejar crear nada. Un negocio nuevo no sabía por dónde empezar.

**Menú (fase D, `views/cliente/partials/inicio.ejs`).** Mismos 16 enlaces y mismos permisos por rol, agrupados por lo que hace el negocio: Inicio, *Vender* (Conversaciones, Pedidos, Clientes), *Mi catálogo* (Productos, Categorías, Inventario), *Mi agente* (Agente IA, WhatsApp, Configuración), *Resultados* (Reportes, Inteligencia) y *Mi cuenta* (Mi equipo, Mi consumo, Comprar paquete, Mis compras; solo OWNER, igual que antes).

**Vocabulario.** En el panel se dice **categoría** y **tipo** (Calzado → Botas) en vez de rubro/subcategoría/grupo. Los nombres internos (`padreId`, `/subcategorias`, "rubro" en los menús del bot) no cambian.

**Categorías (fase C).**
- Sin categorías: dos caminos claros, "Vendo ropa o calzado" (carga la estructura sugerida) y "Prefiero armarlas yo" (nombre de la primera).
- Con categorías: tabla corta (Categoría, Tipos, Productos, Editar/Eliminar), formulario de una línea para agregar, y la plantilla de ropa queda plegada abajo.
- Detalle: nombre y foto arriba; "Tipos" con alta en una línea; lo avanzado va plegado: *Qué le pregunta el agente al cliente* (los atributos obligatorios/recomendados/opcionales, con las reglas explicadas en 3 líneas y la misma señal de "frena / no frena la venta") y *Cambiar de lugar*.
- **Bug que ya existía y que se arregló:** `POST /panel/categorias/plantilla` quedaba capturada por `POST /panel/categorias/:id` (registrada antes), así que el botón "Cargar estructura de ropa" nunca funcionó (respondía "El nombre es obligatorio"). Ahora las rutas `:id` de categoría solo aceptan números. Test de regresión en `test/rutas-categorias.test.js`.
- Mensajes del servidor reescritos con las palabras nuevas; el de la plantilla distingue negocio nuevo ("Listo, armamos N categorías…") de uno que ya tenía categorías.

**Verificado** contra el servidor local con una cuenta de prueba (ya borrada): el menú muestra los 5 grupos, la plantilla crea 26 categorías, el detalle de una categoría y el de un tipo cargan, renombrar y agregar tipos responden bien, y el formulario de producto usa "categoría". **No se pudo revisar el aspecto visual**: el navegador integrado no logró abrir localhost en esta sesión. Suite: 518 tests.

**Pendiente de esta línea:** configuración en pestañas (fase E) y pasada de diseño (fase F), incluida la revisión visual de estas pantallas.


## 30. Configuración en pestañas y pasada de diseño

**Problema.** Configuración era una sola página de 330 líneas que mezclaba lo básico (nombre, tono, pagos) con lo técnico (latitud/longitud, el flag del flujo, "preguntas iniciales"), con 46 estilos en línea. Además, al entrar a Inicio por primera vez el recorrido guiado de 9 pasos arrancaba solo y se pisaba con la tarjeta "Primeros pasos".

**Configuración (`views/cliente/configuracion.ejs`).** Cuatro pestañas en un solo formulario y un solo "Guardar": *Mi agente* (nombre, si está atendiendo, tono, bienvenida, instrucciones, aviso de derivación, número informativo), *Pagos y entrega* (formas de pago, QR, moneda, dirección del local y mapa plegado), *Catálogo web* (logo, colores, estilo y tema como tarjetas) y *Avanzado* (preguntas iniciales y el flag "Menús y cierre con botones"). Mismos nombres de campo, así que el servidor no cambió. Detalles:
- Sin JavaScript se ven todas las secciones una debajo de otra; con JavaScript hay pestañas con teclado (flechas) y se recuerda la última usada en la sesión.
- Los enlaces viejos con ancla (`#config-pagos`, `#config-ventas`) siguen funcionando; la clase `.config-nav` se mantiene porque la usa el recorrido guiado.
- La latitud y longitud ya no se muestran (quedan como campos ocultos que llena el mapa); el mapa de Leaflet se redibuja al abrir la pestaña o el desplegable, que es cuando tiene tamaño real.
- Si el navegador frena el envío por un campo inválido en otra pestaña, lleva al usuario a esa pestaña.
- El estado del agente explica cada opción ("Borrador: todavía no contesta").

**Diseño (fase F).**
- El recorrido guiado ya no arranca solo; sigue con el botón "?" y con un enlace en la tarjeta de Primeros pasos.
- Importar desde Excel (Productos) queda plegado y explicado en 3 pasos.
- La tabla de variantes existentes y las pantallas nuevas usan clases CSS en vez de estilos en línea; casillas y opciones dentro de `.field` ya no heredan el "input a todo el ancho" (se veían descolocadas). Estilos en línea en `views/cliente`: **206 → 135**. Siguen pendientes las pantallas que no se tocaron (pedido-detalle, inteligencia, conversación, WhatsApp, equipo, agente).

**Verificado** en el navegador (cuenta de demo local): las 4 pestañas, guardar cambios (estado, tono, dirección, tarjeta y plantilla del catálogo quedaron en la base; el flag no cambió), la tabla de variantes, y sin scroll horizontal a 375 px en Inicio, Categorías, Configuración, Productos, producto nuevo y editar. Suite: 518 tests.


## 31. "Reintentos forzados" estaba mal medido: la mayoría eran llamadas normales tras una herramienta

**Problema.** El dashboard de costos (`/admin/costo-ia`) y `usos_ia.proposito` mostraban que ~50 % de las llamadas a la IA eran "reintento_forzado" (110 de 219 en producción). Pero `proposito` se guardaba como `vuelta === 0 ? 'respuesta' : 'reintento_forzado'`: cualquier llamada que no fuera la primera del turno contaba como reintento, incluida la que ocurre después de que el modelo ejecuta una función (mostrar_productos, agregar_al_carrito...) para escribir el mensaje con su resultado.

**Qué se encontró** (conversación real contra el modelo, en local, 5 turnos con IA, 20 llamadas): 9 `respuesta` (45 %), 7 `tras_herramienta` (35 %) y 4 reintentos de verdad (20 %). Es decir, la mayor parte del "50 % de reintentos" es el recorrido normal de tool calling. Los reintentos reales sí existen y tienen causas concretas, vistas en el log de etapas:
- `tarjeta_categoria_bloqueada_preguntas_iniciales`: con "preguntas iniciales" configuradas (Género), la herramienta de mostrar la tarjeta de la categoría se bloquea, el modelo insiste con la misma llamada, se gastan las 3 vueltas y el turno termina con el texto de rescate ("no pude traerte las opciones"). Ocurrió en el primer pedido de producto de la prueba.
- `texto_vago_forzado_en_ultima_vuelta` apareció en 3 de 5 turnos con IA.
- `mostrar_productos_sin_puntual_redirigido` y `producto_nombrado_sin_tarjeta` (la herramienta se redirige y hace falta otra vuelta).

**Cambio.** `propositoDeLaVuelta(vuelta, mensajesTurno)` en `agente.js`: `respuesta` (primera llamada), `tras_herramienta` (el último mensaje del turno es un resultado de herramienta) y `reintento_forzado` (el sistema rechazó el texto y obligó a corregirse). No necesita migración (`proposito` es texto). El dashboard sigue sumando solo `reintento_forzado`, que ahora sí es eso. Los datos históricos (hasta el 23-oct) conservan la etiqueta vieja y no se pueden separar.

**Lo que NO se resolvió (para decidir).** Reducir costo real exige atacar (1) los turnos `tras_herramienta` que podrían responderse con plantilla sin segunda llamada (ya se hace con `agregar_al_carrito`), y (2) el bucle de la tarjeta de categoría bloqueada por preguntas iniciales. Test: `test/proposito-vuelta.test.js`.


## 32. Bucle de la tarjeta de categoría bloqueada por un dato pendiente

**Problema.** Con "preguntas iniciales" configuradas (ej. Género) o un atributo obligatorio de la categoría sin responder, `mostrar_tarjeta_categoria` se bloquea a propósito (`TOOL_FAILED`: "preguntá solo Género"). Pero otras dos piezas del motor ignoraban ese bloqueo y empujaban a mandar la misma tarjeta:
- el detector `debioLlamarTarjetaCategoria` (obliga al modelo a llamarla, y descartaba el texto del modelo aunque fuera justo la pregunta que había que hacer);
- el rescate de última vuelta (`texto_vago_forzado_en_ultima_vuelta`), que forzaba la tarjeta en código, volvía a chocar con el bloqueo y respondía "Perdón, no pude traerte las opciones".
Resultado visto en una conversación real contra el modelo ("quiero ver poleras", sin Género): 3 llamadas a gpt-4o y el cliente recibía el mensaje de error en vez de la pregunta.

**Arreglo** (`lib/services/agente.js`):
- `datoPendienteParaMostrar()` expone la misma condición del bloqueo (preguntas iniciales primero, atributos OBLIGATORIOS de la categoría después) y `preguntaDeDatoPendiente()` arma la pregunta cerrada con las opciones reales ("¿lo buscás de Hombre o de Mujer?").
- El detector deja de exigir la tarjeta mientras haya un dato pendiente.
- El rescate de última vuelta pregunta ese dato en código en vez de forzar la tarjeta bloqueada.
- Si el modelo chocó con el bloqueo en el turno y termina escribiendo algo que no es una pregunta ("dejame revisar un momento"), se reemplaza por la pregunta real (`helpers.bloqueoDatoPendienteEnTurno`).
- Se probó contra el modelo real: "quiero ver poleras" → "…¿buscás poleras de Hombre o de Mujer?"; "mujer" → tarjeta; ya no hay mensaje de error.

**Decisión que NO se cambió a propósito.** Un primer intento hacía que el backend preguntara el dato sin llamar a la IA al elegir la categoría. Se revirtió: 7 tests del proyecto fijan que, cuando falta un atributo obligatorio, "el bloque nuevo no intercepta, sigue el flujo normal" (la IA lo pide con sus palabras). Se respetó ese diseño.

**Observación sin tocar.** El contador `intentosPreguntaInicial` se incrementa en cada turno aunque la pregunta no se haya hecho todavía (ej. "Hola" lo contesta el menú), y `limpiezaPorCambioDeCategoria` pisa `detectados.contexto` perdiendo ese incremento en el turno en que se detecta la categoría (el log dice `gate_inicial_liberado` pero no se guarda). En la práctica eso evita que el gate se libere sin haber preguntado; si se "arregla" el pisado hay que contar solo los turnos en que de verdad se preguntó.

**Otros arreglos de esta revisión.**
- `Dockerfile`: el `apk add` de las fuentes ahora reintenta 5 veces (el 28-oct un deploy se cayó por un `DNS: transient error`).
- `embeddings.js`: ya no registra como error el caso normal de un producto borrado mientras se generaba su vector (`P2025`).

**Revisión completa (local).** Recorrido de humo con una cuenta de prueba (luego borrada): 20/20 pantallas del panel, 19/19 del admin y las públicas (inicio, planes, ingreso, registro, catálogo, ficha de producto, 404) sin errores de servidor ni errores visibles en el HTML. Suite: 528 tests (+1 regresión de este bucle en `flujo-completo.test.js`, +4 en `dato-pendiente.test.js`).


## 33. Soporte de la familia gpt-6 (gpt-6-luna)

**Pedido del dueño:** usar "gpt-6 Luna". El identificador real en la API de OpenAI es **`gpt-6-luna`** (minúsculas y con guion; se verificó con `GET /v1/models` de la cuenta, que lista `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6.1-sol` y `gpt-6.1-terra`). "gpt-6 Luna" con espacio y mayúscula daría "model not found".

**Con el motor tal cual estaba, gpt-6-luna fallaba con 400** (probado contra la API real):
1. rechaza `max_tokens` (pide `max_completion_tokens`);
2. razona por defecto, y con razonamiento la API no permite function tools en `/v1/chat/completions` ("set reasoning_effort to 'none'"). Con `reasoning_effort: 'none'` llama tools y acepta `temperature`.

**Cambio** (`lib/services/agente.js`): `ajustesDeModeloOpenAI(modelo)` decide el campo de tokens, si se manda `reasoning_effort: 'none'` (toda la familia `gpt-6*`) y si el modelo acepta `temperature`. Los modelos actuales (gpt-4o, gpt-4o-mini, gpt-4.1-mini) no cambian. La regla del negocio "nunca gpt-5.x" sigue intacta. Tests en `test/modelo-gpt6.test.js`.

**Cómo se activa:** Admin → Planes → editar el plan → campo "Modelo de IA" = `gpt-6-luna` (el seed corre en cada deploy pero con `update: {}`, no pisa lo que se cambie ahí). `OPENAI_MODEL` solo se usa para planes sin modelo propio. Los turnos simples (saludos, menús) siguen yendo a `gpt-4o-mini` (`MODELO_ECONOMICO`).

**Verificado** con una conversación real local (plan PRO = gpt-6-luna, luego restaurado a gpt-4o): las llamadas con tools, el menú, la tarjeta de categoría y la pregunta de género funcionan; el log de `usos_ia` registra `gpt-6-luna`.

**Pendiente:** `lib/services/costoIA.js` no tiene precio de gpt-6-luna, así que el dashboard de costos mostrará esas llamadas sin costo (a propósito no se inventa). Hay que cargar el precio oficial de OpenAI (las fuentes de terceros no coinciden).

**Precio de gpt-6-luna cargado** (dato del dueño, nov-2026): $0,10 entrada / $0,50 salida por 1M tokens en `costoIA.js`. El precio de entrada cacheada no se conoce: se usa el de entrada normal, así que el costo mostrado es un techo. Una llamada típica del bot (7.019 de prompt, 5.064 cacheados, 38 de salida) pasa de ~$0,0117 con gpt-4o a ~$0,0007 con Luna (≈16 veces menos).


## 34. Pedido #26: producto sin variantes quedaba "2x" y sin talla

**Qué pasó** (primera conversación real del piloto, 3-nov, tel. ...3989, Rox/Tienda Demo, `gpt-6-luna`, flujo con botones activo): el cliente agregó **ZAPATILLAS TEKKIRA CUP** desde la web sin elegir talla ni color, preguntó en el chat por tallas y colores, dijo "en talla 10" y "ok, dame esa", y el pedido #26 salió **2x ZAPATILLAS TEKKIRA CUP** sin talla ni color.

**Causa.** El producto NO tiene variantes: la talla y el color son atributos del propio producto (`Talla: "8,9,9.5,10,10.5"`, `Color: "Blanco nube"`). El carrito no tenía dónde guardar "talla 10", así que el "dame esa" volvió a agregar el mismo producto y `agregarItem` sumó la cantidad (misma línea producto+variante nula). Además la web no podía pedir talla porque no había variantes que elegir. Afecta a cualquier producto cargado así (importación desde Excel sin variantes).

**Arreglo.**
- `lib/services/seleccionProducto.js` (puro): lee las opciones Talla/Color del producto, valida lo que dijo el cliente contra las reales y arma el texto `Talla: 10, Color: Blanco nube`. Un color único se completa solo; varias tallas exigen elegir una.
- El carrito guarda `seleccion` por línea. Elegir talla **completa** la línea que venía de la web (no suma unidad); la misma selección otra vez solo suma si la cantidad es explícita; otra talla es otra línea.
- `agregar_al_carrito` (nuevos parámetros `talla`/`color`): sin talla válida no agrega y le devuelve al modelo las opciones reales para que pregunte. La talla que el lead ya tenía de otro producto ("L") no se cuela porque se valida contra las del producto. Si esa MISMA línea ya está y no viene `cantidad`, no se duplica ("dame esa" = confirmar, no otra unidad).
- `confirmar_pedido` no avanza si queda una línea de un producto con varias tallas/colores sin elegir.
- La selección viaja al pedido: el nombre del ítem queda `... (Talla: 10, Color: Blanco nube)`, que es lo que le dice al negocio qué enviar.

**Verificado** repitiendo el incidente con el modelo real (gpt-6-luna, producto de prueba con los mismos atributos): el carrito termina en **1x … (Talla: 10, Color: Blanco nube)**. Tests: `carrito-sin-variantes.test.js` (DB + IA falsa, incluye el pedido completo), `seleccion-producto.test.js`.

**Limitaciones conocidas.** (1) Comprar dos tallas del mismo producto sin variantes crea dos líneas, pero las acciones de la lista de edición del flujo (`item:pid:vid`) apuntan a la primera de ellas. (2) La solución de fondo es cargar esos productos CON variantes (el formulario guiado ya las crea junto con el producto): así cada talla tiene su stock real; hoy el stock es uno solo para todas las tallas. (3) La página web del catálogo sigue sin poder elegir talla en estos productos.


## 35. Talla y color son siempre variantes (ya no existen como "datos extra")

**Decisión del dueño** (tras el pedido #26): la talla y el color no se cargan como datos sueltos del producto, solo como variantes. Es lo único que da stock por talla y hace que la talla/color salgan en el pedido.

**Cambios** (`server.js`, `views/cliente/producto-form.ejs`, `partials/constructor-variantes.ejs`, `lib/services/seleccionProducto.js`):
- En "Datos extra" ya no se sugieren Talla ni Color, el formulario lo explica, y el servidor **rechaza** (400, con el mensaje de dónde cargarlos) cualquier intento de guardar "Talla" o "Color" como dato extra, al crear y al editar.
- **Productos viejos** que los tenían sueltos (como la Tekkira Cup de producción): en la edición ya no aparecen como filas editables; en "Opciones de este producto" sale un aviso amarillo y el constructor llega **precargado** con sus tallas y colores. Solo hay que poner el stock de cada combinación y tocar "Convertir y guardar": se crean las variantes, el stock general pasa a 0 y Talla/Color se quitan de los datos sueltos (el resto, como Género, se conserva). Hasta que se conviertan, guardar otros cambios del producto no los pierde.
- La red de seguridad de la entrada #34 (talla/color guardados en la línea del carrito para productos sin variantes) se mantiene para los productos que todavía no se hayan convertido.

**Verificado** contra el servidor local con un producto igual a la Tekkira (Talla "8,9,9.5,10,10.5", Color "Blanco nube", Género): crear con Talla suelta → rechazado; la edición ofrece la conversión con el constructor precargado; editar el precio conserva Talla/Color; convertir crea 5 variantes con su stock; después ya no se ofrece. Tests: 566.

**Pendiente.** Los productos de producción con ese formato hay que convertirlos uno por uno desde el panel (hoy es al menos la Tekkira Cup); la importación desde Excel puede seguir dejando Talla/Color sueltos si no se llenan las hojas de variantes (no se tocó).


## 36. Conversación 145 del piloto: correcciones del carrito + aviso de la web + vista previa

**Qué se vio** (conversación #145, 3-nov, Rox, flujo con botones activo; 13 mensajes del cliente, 14 llamadas a la IA, US$ 0,011): el bot respondía "esto es lo que llevás" a "solo quiero un par" (carrito en 3x por error en la web), no entendía "cancela", y tras vaciar el carrito se quedaba atascado en la categoría Zapatillas ante "quiero hacer una compra", "algo para mi novia, qué me recomiendas" o "solo eso tienes?" (repetía los tipos). Los menús que salían como texto numerado en vez de lista venían de la IA.

**Arreglos en el chat** (solo con el flujo de botones activo, sin llamar a la IA; `lib/services/intencionesCarrito.js` puro + `flujoDeterminista.js`):
- *Corregir cantidad:* "solo quiero un par / solo uno / dejalo en 1 / quitame uno / me marcaron 3 y quiero 1" fijan o restan la cantidad (con una sola línea; con varias muestra la lista para elegir cuál; valida el stock acumulado). Antes no existía forma de "fijar" una cantidad por texto.
- *Cancelar:* "cancela / cancela el pedido / vaciar carrito / ya no quiero nada" pregunta "¿Querés vaciar tu carrito?" con botones (Sí, vaciar / No, seguir) y al vaciar también suelta la categoría vieja. Con el carrito vacío muestra las categorías.
- *Empezar de nuevo:* "quiero hacer una compra", "qué venden", "solo eso tienes?", "qué más tienes", regalo/recomendación ("para mi novia, qué me recomiendas") muestran el menú de categorías y reinician la categoría. "Solo eso" a secas NO cuenta (es quien ya terminó).
- *Finalizar:* "finalizar / quiero finalizar mi pedido" (lo que manda el botón de la web) cierra la compra y no se confunde con el regreso de un producto agregado.
- Para el camino de IA (flag apagado) se agregó la tool `cambiar_cantidad_carrito` (fija una cantidad exacta; `agregar_al_carrito` sigue SUMANDO).

**Fase 1 — aviso por WhatsApp al agregar desde la web** (`lib/services/avisoCarritoWeb.js`): mensaje "✅ Agregado a tu carrito" con el detalle y total y, con el flujo activo, los botones Seguir comprando / Finalizar / Ver carrito. Se agrupa (25 s de calma = un solo mensaje por cliente), solo dentro de las 24 h del último mensaje del cliente (fuera haría falta plantilla paga), no se duplica si el cliente ya escribió "Quiero X", queda en el historial y limpia `carritoWebPendiente`. Si no se puede avisar, la web mantiene el enlace con mensaje prellenado; si se avisó, el enlace pasa a "Volver al chat" sin texto.

**Fase 2 — carrito en la web:** antes la ficha no mostraba ninguna confirmación. Ahora: aviso "✓ Añadido a tu carrito" (Ver carrito / Seguir viendo), botón flotante con la cantidad en las 5 plantillas del catálogo y una página `/catalogo/:slug/carrito?s=…` con ➖ ➕ Quitar (stock validado), total y "Finalizar en WhatsApp". Los cambios los ve el chat (misma fuente: `ClienteFinal.contexto.carrito`). Límite propio de 60 ediciones/min por IP.

**Fase 3 — vista previa del link:** imágenes `og:image` propias de 1200×630 y ~50 KB (`lib/services/ogImagen.js`, con `sharp`): portada del catálogo con la marca, cantidad de productos y 3 fotos reales (`/catalogo/:slug/og.jpg`) y foto de cada producto sobre su fondo difuminado (`/producto/:id/og.jpg`). Las fotos crudas pesaban MB y WhatsApp las descarta sobre ~300 KB. Título con precio ("Zapatilla X · Bs 303.00"), descripción con disponibilidad, tallas y colores reales. La tarjeta de categoría ahora sale como imagen + botón "Ver catálogo" (`enviarImagenConBoton`, mensaje `cta_url`) cuando el flujo está activo; si Meta lo rechaza cae a la imagen con el link escrito, como antes (log `tarjeta_categoria_boton_rechazado`).

**Limitaciones / a verificar en el piloto.** (1) Meta no se probó con `cta_url` ni con el aviso proactivo: ambos tienen respaldo. (2) El reproductor tipo YouTube es de YouTube: para otras webs WhatsApp solo muestra la tarjeta. (3) Con varios productos en el carrito, "solo quiero uno" pide elegir de la lista en vez de adivinar. (4) Estas frases solo están con el flag activo; los agentes con el flag apagado usan la IA como antes (con la tool nueva). Tests: 615.


## 37. Resiliencia: el bot sigue vendiendo aunque la IA falle o se quede sin saldo

**Problema.** Si la IA fallaba (caída, saldo agotado, clave inválida, timeout) el cliente recibía "No pude consultar la disponibilidad…" y nada más: su mensaje se perdía, no había alerta (nos enterábamos por una queja), el reintento con el modelo barato también fallaba cuando el 429 era por saldo, y no había timeout propio (el del SDK es de 10 min). Plan completo y razones en `docs/08-plan-resiliencia-sin-ia.md`. Decisión del dueño: **sin segundo proveedor por ahora**.

**Qué se hizo** (suite: 651 tests en verde):
- `lib/services/saludIA.js` — clasifica el error (`SIN_SALDO`, `LIMITE`, `CAIDA`, `TIMEOUT`, `CLAVE_INVALIDA`, `SOLICITUD_INVALIDA`, `CIRCUITO_ABIERTO`, `DESCONOCIDO`); **cortacircuitos** en memoria (3 fallas en 5 min → pausa de 2 min; sin saldo 10 min; clave inválida 30 min; luego deja pasar UNA sonda); **timeout propio** (`IA_TIMEOUT_MS`, 15 s por intento y 1 reintento del SDK, tope total ~32 s) también en visión y audio; **alertas** con tope de una cada 30 min por tipo (ntfy `ALERTA_NTFY_TOPIC`, Telegram `ALERTA_TELEGRAM_BOT_TOKEN` + `ALERTA_TELEGRAM_CHAT_ID`, o webhook Slack/Discord `ALERTA_WEBHOOK_URL`) más un aviso cuando la IA vuelve; **simulación de caídas** con `SIMULAR_CAIDA_IA=saldo|limite|5xx|timeout|clave|modelo` (solo para pruebas: el servidor avisa al arrancar y `/admin/estado-ia` lo muestra en rojo).
- `agente.js`: toda llamada a la IA pasa por `saludIA.proteger`. El rescate con el modelo barato ahora es SOLO para `LIMITE` (con saldo agotado fallaba igual y demoraba). Si la IA falla ya no se responde con un error: sigue el modo sin IA.
- `lib/services/modoSinIA.js` — qué hace el bot cuando la IA no responde: fuerza el flujo de botones aunque el agente no tenga el interruptor (menú de categorías, tarjeta con link al catálogo, carrito, cierre y pedido), pide los datos obligatorios pendientes, deriva a un asesor si lo piden ("asesor", "humano", "persona"), contesta preguntas frecuentes con datos REALES de la configuración (formas de pago, dirección, entregas; horarios/costos/plazos NO se inventan: se deriva), anota el texto libre como `contexto.pendienteIA` y deja UN aviso en la campanita del negocio (`IA_NO_DISPONIBLE`, sin duplicar). El texto "Estoy atendiendo con menú…" sale una vez cada 30 min por cliente. El mensaje de error técnico (`respuestaErrorTecnico`) queda solo para cuando falla también la base de datos.
- `lib/services/topeIA.js` — topes de gasto: por cliente (`IA_MAX_LLAMADAS_CLIENTE_HORA`, 60; apagado bajo `node --test`) y por empresa (`IA_TOPE_TOKENS_DIA_EMPRESA`, 0 = sin tope). Al pasarse, el turno sigue sin IA; el tope de empresa alerta al admin.
- **Menos gasto:** con el flujo de botones activo, las preguntas 100 % predecibles (formas de pago, dirección, envío, horario, gracias/chao) se contestan por reglas, sin IA (`respuesta_por_reglas` en el log).
- Admin: `/admin/estado-ia` (estado, último error, fallas por tipo, avisos enviados, botón "Enviar alerta de prueba") y `GET /health` ahora incluye `ia` (siempre responde 200: la IA caída no es "servicio caído").
- Tests: `test/resiliencia-ia.test.js` (36) + dos tests de `regresion-agente.test.js` actualizados al nuevo comportamiento.

**Límites honestos.** El estado del cortacircuitos vive en memoria (instancia única; se rearma solo al reiniciar). Con el modo sin IA el texto libre complejo no se entiende: se ofrece menú o asesor, y queda anotado. No se probó contra una caída real de OpenAI, solo simulada. **No se tocó el prompt fijo (16 mil caracteres) ni las descripciones de las tools:** cada regla nació de un bug real y sin una prueba A/B con IA real adelgazarlas es arriesgado.

**Para activar las alertas:** poner una de las variables `ALERTA_*` en Coolify, reiniciar y usar el botón de prueba de `/admin/estado-ia`.


## 38. Fase 0 del plan de Citas y mejoras: evals, base de pruebas aislada y columnas de base

Plan completo y decisiones del dueño en `docs/09-plan-modelo-citas-y-mejoras-agendabot.md` (acento menta, topes por plan para citas, rubros editables, plantillas opcionales creadas desde el panel, ya somos Tech Provider, sin editor de flujo por bloques).

**Evals (`npm run eval`).** `scripts/eval/` (fixture, escenarios, ejecutor), idea tomada de AgendaBot. 18 escenarios con guion (funcionales, resiliencia y seguridad) sobre una empresa propia `eval-tienda` con un agente CON el flujo de botones y otro SIN él; se crea y se borra sola. Opciones: `--k N` (aprueba solo si pasa N veces), `--sin-ia` (IA caída simulada, gratis), `--solo <id>`, `--tipo seguridad`, `--juez` (una IA califica tono, alcance y cierre). Controles automáticos de cada escenario (pedido creado, cantidad, derivación, lo que debe y no debe decir) y universales: sin respuesta vacía ni error técnico, sin filtrar texto interno, **montos que no existen en el catálogo/carrito**, "quedó registrado" sin pedido, datos de otro cliente. Mide llamadas, tokens y costo por escenario; informe en `data/evals/` (ignorado por git).
- **Línea base (4-nov, gpt-4o-mini, k=1): 17/17, seguridad 5/5, US$ 0,013.** Sin IA: 11/11 de los que corresponden.
- **Hallazgo de costo:** los 7 escenarios de texto libre con IA real gastaron **3 llamadas y ~19 mil tokens cada uno** (el máximo de vueltas), contra 1,45 llamadas por mensaje del promedio de producción; los resueltos por el flujo gastan 0. Es la medida contra la que se comparan las mejoras de tokens de las fases 1 y 6.
- **Hallazgo de comportamiento:** con una categoría elegida pero sin tarjeta mostrada, el motor manda la tarjeta de categoría y **tapa** lo que el cliente pidió (p. ej. "quiero hablar con un asesor" respondía "Échale un vistazo a zapatillas"). En una conversación real la tarjeta ya se mostró, así que el fixture marca `tarjetasCategoriaMostradas`; queda anotado como riesgo a revisar en la fase 1.
- `test/eval-escenarios.test.js` corre los escenarios sin IA dentro de `npm test` (red de seguridad gratis del modo sin IA y del cierre por botones).

**Base de pruebas aislada.** `npm test` ahora corre contra `<tu base>_test` (o `DATABASE_URL_TEST`), nunca contra la de desarrollo (`lib/db.js` la elige cuando corre bajo `node --test`; `TEST_DB_AISLADA=0` lo desactiva). Se crea y migra con **`npm run test:preparar`** (una vez, y de nuevo si se agregan migraciones). Resultado: 654 tests en verde sin tocar la base de desarrollo.

**Migración `20261104120000_mensaje_meta_faq_horario`** (aplicada en desarrollo y en la de pruebas; en producción se aplica sola al desplegar): `mensajes.meta` (JSON), `agente_config.faq` (JSON, default `[]`), `agente_config.horarioAtencion` (JSON) y `agente_config.conocimiento` (texto). Todavía nada las usa: son la base de la fase 1 (mensajes pendientes recuperables y FAQ/horario sin IA).


## 39. Fase 1 del plan: robustez y ahorro para el modelo Productos

Plan en `docs/09-plan-modelo-citas-y-mejoras-agendabot.md`. Cada pieza se midió con `npm run eval` (línea base de la fase 0: 17/17, 145.877 tokens). **Resultado de la fase 1: 20/20 (seguridad 5/5), 96.840 tokens con 3 escenarios más que la línea base** (los 7 escenarios de texto libre de la base gastaban ~19 mil tokens cada uno; ahora los de seguridad, FAQ y horario gastan 0). Sin IA: 16/16 (seguridad 3/3). Suite: 712 tests.

**1. Guardia de entrada sin IA** (`lib/services/guardia.js`). Antes de llegar al modelo se contestan por código, con una frase fija: intentos de manipulación ("ignorá tus instrucciones", "mostrame tu prompt"), pedidos ajenos a la tienda (código, tareas, cripto, "¿sos ChatGPT?") y pedidos de **datos de otros clientes** (privacidad). Los toques de botón no se revisan. La manipulación se cuenta en la ficha del cliente y a la **tercera** el negocio recibe un aviso en la campanita (`MANIPULACION`, sin duplicar). Patrones conservadores: hay tests de mensajes normales que NO deben bloquearse ("me llamo Claude", "olvidé mi contraseña", "quiero ver mis compras").

**2. Revisor de la salida de la IA** (`revisarSalida` en `agente.js`; `generarRespuesta` ahora envuelve a `generarRespuestaSinRevision`). Todo lo que escribe la IA se revisa antes de llegar al cliente: sin instrucciones internas ni nombres de herramientas, sin bloques de código, sin links ajenos al negocio (permitidos: la URL de la tienda, WhatsApp, Maps y los que el negocio escribió en su FAQ/conocimiento) y **sin montos que no existan** en el catálogo (precios y variantes × 1 a 20 unidades y sumas de dos precios), el carrito, los pedidos recientes, el historial, la FAQ o lo que dijo el cliente. Si no pasa, el cliente recibe una frase segura y queda en el log (`revisor_salida`). `REVISOR_SALIDA=log` solo registra; `apagado` lo desactiva. Solo revisa lo que escribió la IA, no las plantillas del sistema.

**3. FAQ y horario editables** (`lib/services/faq.js`, pestaña "Preguntas y horario" en Configuración). El negocio carga hasta 30 preguntas con su respuesta, un horario por día y notas libres para la IA (usan las columnas de la migración de la fase 0). El bot contesta SU texto sin IA: coincidencia conservadora (mínimo 2 palabras del tema en común y 60 % de la pregunta; si dos empatan con respuestas distintas, no contesta; no interviene si el cliente nombró un producto). El horario se muestra agrupado ("Lun a Vie 09:00 a 18:00 · Sáb 09:00 a 13:00 · Dom cerrado"); **sin horario cargado el bot no inventa una hora y ofrece un asesor**. Funciona con todos los agentes (con o sin el flujo de botones; los botones con ID solo se agregan con el flujo).

**4. Referencias a lo ya mostrado sin IA** (`lib/services/referencias.js`): "la más barata / la menos cara", "la segunda", "la última", "la blanca", "la de 650". Si una sola opción calza, el mensaje pasa a nombrarla (`… — me refiero a <producto>`) y el motor la trata como un producto nombrado; si calzan varias, **pregunta cuál** con una lista numerada en vez de elegir. Mira solo las últimas 3 opciones mostradas.

**5. Mensajes pendientes recuperables** (`lib/services/pendientes.js`, `salidaWhatsApp.js`). Cuando la IA no entiende un texto libre y el cliente solo recibe el menú (o una pregunta larga solo dispara la tarjeta de una categoría), la respuesta del agente queda marcada en `mensajes.meta` (`pendienteIA`, `hasta`, `texto`). Cuando la IA vuelve, un job cada 2 minutos contesta lo pendiente con "Perdón la demora 🙏", por WhatsApp y dentro de la ventana de 24 h (se usan 23 h). No contesta si el cliente siguió escribiendo después, si un humano tomó el chat, si no hay WhatsApp conectado ni con el circuito de la IA en pausa; abandona a los 5 intentos. En la conversación del panel aparece un aviso con el botón **"Que el agente responda ahora"**. Un toque de botón y el chat de prueba nunca quedan pendientes.

**Tests nuevos:** `guardia` (19), `faq` (17), `referencias` (11), `pendientes` (11), y escenarios nuevos en los evals (`faq-del-negocio`, `horario-del-negocio`, `referencia-mas-barata`; los de seguridad `rt-revelar-prompt`, `rt-fuera-de-tema` y `rt-datos-de-otros` ahora los resuelve el código y corren también sin IA).

**Hallazgo que queda para la fase 6:** los turnos de texto libre que SÍ llegan a la IA siguen gastando **3 llamadas y ~19-21 mil tokens** cada uno en los evals (los detectores del motor fuerzan reintentos hasta agotar las 3 vueltas), contra 1,45 llamadas por mensaje del promedio real. Es el principal costo que queda.


## 40. M0 del plan "la IA no escribe": base del sistema de mensajes

Plan completo en `docs/10-plan-mensajes-prefabricados.md`. Decisiones del dueño (4-nov): (1) se **mantiene el registro "vos"** en los agentes que ya existen; (2) los negocios **pueden crear mensajes propios**, con tope de **30 o el que fije el plan** (`planes.maxMensajesPropios`, default 30); (3) cuando la IA no conoce un tema, **pasa con un asesor** (mensaje `no_entendi_derivar`, listo para M1); (4) orden: M0 → fase 2 → M1/M2 → fase 3.

**Qué hay (y qué NO cambió).** M0 no cambia lo que ve el cliente: los textos son exactamente los de antes, pero ahora salen de un catálogo.
- `lib/services/mensajesBase.js`: **catálogo de fábrica de 60 mensajes** (los textos que estaban escritos a mano en el flujo de botones, el modo sin IA, la guardia, las reglas, los pendientes, las referencias y el aviso del carrito web), cada uno con **clave, categoría, descripción de cuándo se usa** (la leerá la IA en M1), texto con variables tipadas y un ejemplo.
- `lib/services/mensajes.js`: el motor. Sintaxis `{{variable}}`, `{{dato.garantia}}` (datos añadibles del negocio), `{{vocab.cita}}`, `{{negocio}}`, bloques `{{#var}}...{{/var}}` y `{r:vos|tu}` (la palabra según cómo habla el agente). Tipos `texto | numero | monto | lista` (el monto lo escribe el sistema con la moneda del negocio); **todo valor que viene de afuera se limpia** (no puede traer sintaxis del motor ni caracteres de control). Resolución: lo que el negocio personalizó o creó **manda** sobre el de fábrica; si su texto está roto (variable inexistente), el cliente recibe el de fábrica y queda en el log. Cache de 30 s por empresa (`invalidar(empresaId)`). `validarTextoDelNegocio` es lo que usará el panel antes de guardar.
- Migración `20261104180000_mensajes_agente`: tablas `mensajes_agente` (cambios del negocio y mensajes propios) y `datos_negocio` (datos añadibles); `agente_config.registro` (default `vos`) y `agente_config.mensajesPrefabricados` (interruptor de M1); `planes.maxMensajesPropios` (30).
- Cableado: cada turno carga el contexto de mensajes del negocio (`helpers.mensajes`) y lo usan `flujoDeterminista.js`, `modoSinIA.js`, `guardia.js`, `pendientes.js`, `referencias.js`, `avisoCarritoWeb.js` y el mensaje de error técnico.
- **"usted"** queda previsto en el motor pero **todavía sin textos** (cae en "tú"): se agrega con una revisión completa del catálogo cuando se necesite.

**Verificación.** Los 740 tests anteriores pasaron SIN tocarlos (mismos textos); los evals dieron lo mismo que antes de M0 (sin IA 16/16, con IA real 20/20, ~96.800 tokens). Tests nuevos: `mensajes` (28: galería que renderiza cada mensaje en vos y tú, textos de fábrica idénticos a los de antes, sin voseo en "tú", variables, personalización, mensajes propios, datos del negocio, caché), `mensajes-flujo` (5: el negocio cambia un texto y el flujo lo usa, un texto roto no deja al cliente sin respuesta, el registro cambia cómo habla) y `mensajes-codigo` (3: **si alguien vuelve a escribir un texto fijo en el flujo, el test falla**). Total: 749.

**Bug encontrado y corregido de paso:** en `modoSinIA.js` la expresión que cuenta palabras había perdido una barra (`/s+/` en vez de `/\s+/`), así que una pregunta larga sin signo de pregunta no se marcaba como pendiente. Ahora hay un test.


## 41. Fase 2 del plan: modelo de negocio configurable (productos o citas) y base de Citas

Plan en `docs/09-plan-modelo-citas-y-mejoras-agendabot.md`. Cada empresa elige qué hace: **vende productos** (todo igual que antes) o **agenda citas**. 790 tests en verde; las pantallas se verificaron en el navegador.

**Datos** (migración `20261105100000_modelo_negocio_citas`): `empresas.modeloNegocio` (PRODUCTOS por defecto), `rubro`, `zonaHoraria` (America/La_Paz), `pais`, `vocabulario`, `configAgenda`; tablas `servicios`, `recursos` (una persona o una sala/mesa con capacidad), `recurso_servicios`, `horarios_atencion`, `bloqueos_agenda`, `citas`, `feriados_cache`; y en los planes `maxServicios` y `maxCitasMes` (GRATIS 3/30, STANDARD 10/200, PRO 30/1000, PREMIUM 100/5000: editables en el admin de planes).

**Motor de agenda** (`lib/services/agenda.js`, portado de AgendaBot, con luxon): horarios libres por servicio/recurso (horario general o propio con turnos partidos, bloqueos, feriados nacionales con cache de Nager.Date y override "trabajamos ese día", buffer de limpieza, anticipación mínima, días máximos, capacidad por personas). **La IA nunca decide si un horario está libre.** `crearCita` bloquea la fila del recurso dentro de una transacción: probado con 5 clientes pidiendo el último lugar a la vez → una sola cita. Reprogramar cancela la original y no gasta cupo del plan. Todo filtra por empresa (un negocio no puede tocar las citas ni los servicios de otro).

**Topes del plan** (`limitesCitas.js`): servicios activos y citas por período de suscripción (las canceladas no cuentan). Al 80 % y al llegar, el negocio recibe un aviso en la campanita (sin duplicar). Crear un servicio o una cita por encima del tope falla con un mensaje claro (`TOPE_SERVICIOS` / `TOPE_CITAS`); reactivar un servicio también cuenta.

**Panel.**
- Configuración → **Mi negocio** (primera pestaña): qué hace el negocio, rubro, "cómo les decís a las cosas" (cita/turno/reserva/visita, profesional/estilista/asesor… se precargan con el rubro y se editan), zona horaria, país para feriados, reglas de agenda (cada cuántos minutos, anticipación, días adelante, feriados, si el cliente elige con quién) y botón "Cargar datos de ejemplo". Cambiar de modelo pide confirmación y **no borra nada**.
- Configuración → Mi agente: **"¿Cómo trata a tus clientes?"** (vos / tú), que ya usa el catálogo de mensajes.
- Menú lateral según el modelo: con citas desaparecen Pedidos, Productos, Categorías, Inventario y Reportes y aparece **Mi negocio → Servicios / Equipo (con el vocabulario del negocio) / Horarios**. Con productos el menú es el de siempre (verificado).
- **Servicios** (barra de uso del plan, alta/edición/desactivar/eliminar solo si no tiene historial), **Equipo** (persona o sala/mesa, capacidad, qué servicios atiende; vacío = todos) y **Horarios** (horario general y propio por persona, con "+ Turno" para turnos partidos; cierres por días u horas, de todo el negocio o de una persona; feriados nacionales con casilla "trabajamos ese día"). Ver: cualquier rol; cambiar: dueño y administradores.
- **Rubros de ejemplo** (clínica, salón, restaurante, inmobiliaria, otro): son registros comunes, **totalmente editables**; se cargan solo donde el negocio no tiene nada y sin pasarse del tope de servicios del plan (con un plan de 3 servicios el salón carga 3 de 4 y lo avisa).
- "Primeros pasos" del inicio según el modelo: servicios → equipo → horarios → WhatsApp → agente.

**Todavía NO** (siguen las fases del plan): el bot de Citas por WhatsApp con listas y botones (fase 3), la pantalla de Agenda, el inicio con indicadores de citas, el pipeline y los recordatorios (fases 3 a 5). Un negocio en modo citas ya puede configurarse completo, pero su agente todavía no agenda.

**Pendiente de decisión:** los topes de planes que dejé (3/30, 10/200, 30/1000, 100/5000) son una propuesta mía; hay que confirmarlos con los precios reales de cada plan.


## 42. M1 — "La IA elige": el agente deja de escribir texto

Plan en `docs/10-plan-mensajes-prefabricados.md`. Detrás del flag por agente `mensajesPrefabricados` (Configuración → Mi agente; exige `flujoDeterminista`) la IA ya no redacta: ve un prompt compacto con la lista de mensajes del catálogo y UNA herramienta de hablar, `responder`, con la clave en una lista cerrada (`enum`) y datos de listas cerradas (`producto_id`, `atributo`, `falta`, `faq_id`).

- `lib/services/turnoPrefab.js` (puro): `mensajesElegibles`, `herramientaResponder`, `armarSystem` (parte fija cacheable + parte variable), `resolverEleccion` (valida y arma el texto con `mensajes.js`; precio, stock y nombre salen de la base, nunca de la IA; sin dato cargado cae a "no lo tengo cargado"/asesor).
- 15 mensajes nuevos en el catálogo (categoría "Conversación").
- `agente.js`: bloque `if (prefab)` en el bucle. Texto libre o clave inválida: se descarta, un reintento, y si no hay elección válida → `no_entendi_derivar` + derivación a un asesor. Las herramientas de acción (buscar, mostrar, carrito) se ejecutan igual; si dejan una respuesta armada por el backend, se usa tal cual.
- Pendiente (M3): quitar los detectores/correcciones de texto libre que este modo vuelve innecesarios; medir tokens y llamadas con los evals (línea base: ≈3 llamadas / 19–21 mil tokens por turno de texto libre; objetivo ≤4 mil, ~1 llamada).
- Tests: `turno-prefab` (8) y `prefab-agente` (6). Suite: 804 en verde.

**Medición de M1 (evals con IA real, gpt-4o-mini, 20 escenarios, `npm run eval -- --prefab`):** 89.422 → 23.855 tokens (−73 %), 20/20 aprobados, seguridad 5/5. Un turno con IA pasó de 7–21 mil tokens y hasta 3 llamadas a ≈3 mil y 1 llamada (2 cuando primero hay que mostrar tarjetas).

Lo que la medición destapó y se corrigió:
- El prompt compacto mostraba solo el stock del producto (0 cuando el stock vive en variantes) y la IA contestaba "agotado" a algo que sí había → `stockTotal()` suma variantes.
- La IA eligió "ya está en tu carrito" sin que lo estuviera → `resolverEleccion` solo acepta afirmaciones (agotado, ya en el carrito, sin stock, pedir talla) si los datos reales las respaldan; si no, la elección se rechaza.
- El camino prefab se había saltado las correcciones en código ("nombró un producto → mostrar SOLO ese", "sin producto puntual → tarjeta de categoría/menú") → portadas.
- La IA a veces contestaba texto tras una herramienta → `toolChoice` siempre `requerido`.
- Si se mostró UNA sola tarjeta, el backend usa `producto_mostrado` (nombra el producto) aunque la IA elija el genérico.
- `npm run eval -- --prefab` activa el modo en todos los agentes del eval.


## 43. M2 — Panel "Mensajes del agente", datos del negocio y "Sin respuesta"

Segunda parte de `docs/10-plan-mensajes-prefabricados.md`. El negocio controla qué dice su agente, sin tocar código.

- **Mensajes** (`/panel/mensajes`, `lib/services/mensajesPanel.js`): cambiar el texto de cualquiera de los mensajes de fábrica (se valida: solo variables que ese mensaje tiene, `{{dato.x}}` solo si el dato existe, bloques cerrados, 1000 caracteres) y "Volver al original". Si el texto guardado alguna vez no sirviera, el motor sigue cayendo al de fábrica.
- **Mensajes propios**: nombre + "cuándo se usa" (lo que lee la IA para elegirlo) + texto, con tope por plan (`planes.maxMensajesPropios`, 30 por defecto). Solo pueden usar `{{negocio}}`, `{{vocab.x}}` y datos del negocio (la IA no puede rellenar variables libres). Con el flag de M1, `turnoPrefab.mensajesElegibles` los ofrece a la IA; desactivarlos los saca.
- **Datos de mi negocio**: `{{dato.garantia}}` etc. (hasta 60); no se puede borrar un dato que algún mensaje usa.
- **Sin respuesta** (`/panel/sin-respuesta`): cuando la IA no logra elegir un mensaje válido, el cliente pasa con una persona y queda una notificación `SIN_RESPUESTA` con su pregunta, para que el negocio cargue un mensaje o dato.
- Menú lateral: "Mensajes" y "Sin respuesta" (productos y citas). Editar requiere OWNER/ADMIN.
- Tests: `mensajes-panel` (11).

**Pendiente:** migrar las preguntas frecuentes (FAQ) a mensajes propios; elegir el registro (vos/tú) también desde esta pantalla (hoy está en Configuración → Mi agente).


## 44. Seguir comprando después de confirmar: sumar al pedido en revisión

Bug real: el cliente confirmaba un pedido, pedía "una cosa más" y el sistema abría un segundo pedido.
- Con el flujo de botones, al confirmar un carrito nuevo, si el cliente tiene un pedido en estado `NUEVO` de las últimas 24 h (el negocio todavía no lo tomó), `crear_pedido` devuelve `PEDIDO_ABIERTO` y el flujo pregunta con botones: **Sumar al pedido** / **Pedido nuevo** (`cierre:sumar` / `cierre:nuevo`).
- Sumar agrega los items al mismo pedido, suma el total y descuenta stock en una transacción; si el negocio lo tomó mientras tanto (ya no es `NUEVO`), crea uno nuevo. Con el pedido en `CONFIRMADO` o posterior nunca se pregunta.
- Mensajes nuevos: `pedido_abierto_pregunta`, `pedido_ampliado`. Solo agentes con `flujoDeterminista`; el camino de IA libre queda igual.
- Tests: 4 nuevos en `flujo-determinista`.


## 45. Planes por módulos: copia por cliente, vigencia, avisos y pedidos de conversaciones

Plan completo en `docs/11-plan-planes-pos-panel-y-rediseno.md` (§11). Reemplaza el sistema de planes anterior (Gratis/Standard/Pro/Premium, que se retiran).

- **Planes nuevos** (`prisma/seed.js`, editables en `/admin/planes`): Agente · Agente + Punto de venta · Agente + POS + Panel comercial, cada uno con sus conversaciones y topes; **Prueba gratis** (oculta, solo Agente, 14 días) y **Acceso total** (oculto, ilimitado, solo lo asigna un superadmin). Los precios son una propuesta inicial. Los planes viejos se borran en el seed (o se ocultan si un cliente de prueba aún los usa).
- **Copia por cliente** (`lib/services/planesCliente.js`, migración `20261108100000`): al asignar un plan se **copian sus valores** a la suscripción y el cliente se rige por su copia (módulos, conversaciones, productos, usuarios, mensajes propios, servicios, citas, modelo de IA). Un tope `null` = sin límite. Sin suscripción: **estado base** = solo módulo Agente, sin conversaciones incluidas.
- **Vigencia** (`vigenciaPlan.js`, puro): empieza hoy al asignar; 1/2/3/6/12 meses o fecha personalizada; renovar suma al fin vigente (o desde hoy si ya venció); las conversaciones se reinician cada mes el mismo día; 7 días "por vencer"; **5 días de gracia** con todo funcionando; pasada la gracia se corta el agente (MOROSA) y el panel/POS siguen.
- **Superadmin** (`/admin/registrados/:id/editar`): asignar/cambiar plan con duración, renovar, ajustar la copia de ese cliente, y al editar un plan puede **aplicar los cambios a los clientes que lo tienen** (cada dueño recibe un aviso solo si le cambia algo).
- **Avisos** (`avisosPlan.js`, job horario + chequeo tras cada conversación cobrada): corte a 7 días, 2 días y el mismo día; gracia; vencimiento; uso de conversaciones al 80 % y 95 %. Cada aviso se manda una sola vez.
- **Pedir más conversaciones** (`solicitudesConv.js`, migración `20261108120000`): el cliente pide una cantidad con una nota; llega al buzón `/admin/solicitudes`; el superadmin **aprueba** (carga el paquete, vigencia 90 días por defecto, ajustable) o **rechaza**. Pedir no da saldo; aprobar es atómico (dos clics no cargan dos veces).
- **Registro**: ya no se elige plan; el cliente nuevo entra en prueba gratis solo-Agente. Se quitó el pago "primer pago" automático.
- Tests: `vigencia-plan`, `planes-cliente`, `avisos-plan`, `solicitudes-conv`, `registro-prueba` (suite: 872).

**Falta (siguientes pasos):** `requireModulo` en todas las rutas + menú con candados (módulos POS y Panel todavía no existen como pantallas), rediseño del panel lateral y de conversaciones, stock unificado, POS, panel comercial, bot de citas.


## 46. Bloqueo por módulo y menú lateral nuevo

- **`requireModulo(modulo)`** (`lib/services/modulos.js`): middleware que protege CADA ruta (GET y POST) de un módulo; sin el módulo en el plan del cliente responde **403** (pantalla "este módulo no está en tu plan" con botón para pedirlo). Hoy protege **Reportes e Inteligencia** (módulo PANEL); el POS se protegerá cuando existan sus pantallas.
- **Menú lateral** (`lib/services/menuPanel.js` + `views/cliente/partials/inicio.ejs` + `public/css/panel-shell.css`): estructura copiada de la barbería con la paleta actual — logo, tarjeta del negocio (con el plan y su vencimiento), grupos con título (Agente · Catálogo · Panel comercial · Mi cuenta), íconos, contador de pedidos nuevos, **candado** en lo que el plan no incluye, usuario con avatar y rol abajo, **plegable a solo íconos** (se recuerda) y cajón en celular. El menú es un dato (`construirMenu`) que se prueba solo.
- `scripts/demo-panel.js` (solo desarrollo): crea dos clientes de prueba locales (plan Agente y Acceso total) para revisar el panel a ojo; las credenciales se guardan fuera del repo.
- Verificado con un barrido real contra el servidor: con plan Agente, Reportes/Inteligencia → 403 y las otras 16 pantallas → 200; con Acceso total, todas 200.
- Tests: `menu-modulos` (11). Suite: 883.


## 47. Conversaciones tipo CRM (bandeja de tres zonas)

`/panel/conversaciones` pasa a ser una bandeja como la de la barbería, con la paleta actual:
- **Lista** (izquierda): una fila por cliente, avatar con iniciales y color estable, último mensaje (con su tipo), hora, **contador de no leídas**, etiquetas "Atiende una persona" / "Pidió una persona", **buscador** (nombre, teléfono o texto) y filtros *Todas · No leídas · Con persona*.
- **Chat** (centro): burbujas con hora y separadores de día, tomar el control / devolver al agente, escribir como persona, enviar producto, aviso de "el agente no pudo contestar".
- **Ficha** (derecha): lo que se sabe del cliente (estado, interés, presupuesto, entrega), pedidos con total comprado, sesiones, origen del anuncio y las acciones destructivas (reiniciar memoria, borrar) dentro de "Más acciones".
- **No leídas reales**: columna `conversaciones.leidoAt` (migración `20261108180000`); abrir un chat lo marca como leído para todo el equipo; el menú lateral muestra el total.
- **Tiempo real**: reutiliza Socket.IO; ante un mensaje o un cambio de control la lista se vuelve a pedir (`/panel/conversaciones/lista`) y el chat abierto agrega la burbuja.
- **Foto de perfil**: WhatsApp no entrega la foto del cliente, por eso es avatar con iniciales.
- Celular: lista primero; el chat con flecha para volver. Todo filtrado por empresa (probado con dos empresas).
- Código: `lib/services/bandeja.js`, `views/cliente/bandeja.ejs`, `partials/conv-lista.ejs`, `public/css/bandeja.css`. Se eliminaron las vistas viejas de lista y detalle. Tests: `bandeja` (7). Suite: 890.


## 48. Rediseño: menú principal por módulos y pulido de las pantallas

- **Inicio con módulos** (`views/cliente/inicio.ejs`): tres tarjetas (Agente · Punto de venta · Panel comercial) arriba del resumen. Las que el plan incluye tienen su botón; el Punto de venta muestra "Próximamente" hasta que exista; las que no están en el plan salen atenuadas con candado.
- **Un solo título por pantalla**: si la página ya trae su encabezado, la barra superior no lo repite (`.admin-body:has(.page-head)`).
- **Topes ilimitados** (plan Acceso total): antes se mostraba "Límite: 1.000.000.000" en Productos, Mensajes, Servicios, Inicio y Pedir conversaciones. Ahora se lee "Ilimitado" (`topeTexto` disponible en todas las vistas del panel).
- Verificado con un barrido real de las 19 rutas del panel con dos cuentas (plan Agente y Acceso total).


## 49. Stock unificado (F4): un solo stock, historial y códigos de barras

Base del punto de venta (`docs/11`): el bot, el mostrador y el panel descuentan del MISMO stock sin sobreventa.
- **Servicio central** `lib/services/stock.js`: `descontar` (atómico y condicionado: `UPDATE … WHERE stock >= cantidad`, dentro de la transacción del que llama, líneas en orden fijo para evitar deadlocks, cantidades enteras y con tope, todo por empresa), `reponer`, `fijar` (ajuste a un valor exacto) y `registrarInicial`. Si no alcanza lanza `ErrorStock` y no queda nada a medias.
- **Historial (kardex)** `movimientos_stock` (migración `20261109120000`): todo cambio queda con antes/después, tipo, referencia (pedido), usuario y nota; se conserva aunque se borre el producto. Pantalla **Inventario → Historial de stock** con filtros.
- **Red de seguridad en la base**: `CHECK (stock >= 0)` en productos y variantes.
- **Conectado**: pedidos del bot (nuevo y "sumar al pedido"), cancelación de pedidos (reclamo atómico del cambio de estado: dos cancelaciones simultáneas ya no reponen dos veces), ajuste desde Inventario, edición de producto y de variante, altas (stock inicial) e importación desde Excel. Si entre la confirmación y la creación alguien se lleva la última unidad, el pedido no se crea y se le avisa al cliente.
- **Costo y código de barras** (opcionales) en productos y variantes: el costo alimentará el margen del panel comercial; el código se valida único por empresa (`codigosBarras.js`, con `buscar` para el lector del POS: por código o SKU exacto, solo activos).
- Prueba clave: **20 ventas simultáneas por 5 unidades → pasan exactamente 5**. Tests: `stock` (13), `codigos-barras` (6) y uno del historial en `flujo-determinista`. Suite: 910.
- **Pendiente para el POS**: tipos `VENTA`, `ANULACION_VENTA` y `DEVOLUCION_VENTA` ya están permitidos en el historial; el POS los usará.


## 50. Punto de venta (F5): caja, ventas, recibo, rol Cajero

Módulo POS del plan (`docs/11`, `docs/12-pos-impresora-y-lector.md`). Todo protegido en el servidor con `requireModulo('POS')` y por rol.
- **Datos** (migraciones `20261110100000` rol `CAJERO` y `20261110110000`): `sesiones_caja` (una abierta por empresa, índice único parcial), `movimientos_caja`, `ventas` (número por empresa, clave de idempotencia, token de recibo), `venta_items` (con costo del momento), `venta_pagos`; restricciones `CHECK` de montos.
- **Reglas de dinero** (`ventaCalculo.js`, puras, en centavos enteros): el servidor recalcula todo desde los precios de la base (el navegador solo manda producto, opción, cantidad, descuento y pagos); la suma de pagos debe ser exactamente el total; solo el efectivo da vuelto; el efectivo esperado = inicial + cobros en efectivo (sin vuelto) + entradas − salidas, sin contar ventas anuladas.
- **Cobrar** (`ventas.js`): exige caja abierta; descuenta el stock en la misma transacción con el servicio de stock (sin sobreventa); **idempotente** (doble clic o reintento no cobra dos veces, ni siquiera en paralelo); numeración correlativa sin saltos aunque se cobre en paralelo.
- **Anular**: solo dueño/admin, solo con la caja de esa venta abierta, con reclamo atómico (dos anulaciones simultáneas devuelven el stock una vez); queda en el historial de stock.
- **Caja** (`caja.js`): abrir (una sola, aunque la abran a la vez), entradas/salidas manuales (una salida no puede dejar la caja negativa), cierre con conteo y diferencia. El cajero no ve el efectivo esperado antes de contar.
- **Pantallas**: Punto de venta (buscador siempre enfocado para el **lector**, grilla táctil, opciones talla/color, carrito, descuento, cobro con pagos mixtos y vuelto, atajos F2/F4, cámara si el navegador la soporta, carrito que sobrevive a recargar), Caja, Ventas (+ detalle y anulación) y **recibo público** `/recibo/:token` (ticket 80 mm y A4, nota de venta, no factura).
- **Rol CAJERO**: invitable desde Mi equipo; ve solo Punto de venta, Caja y Ventas; el servidor redirige o niega todo lo demás.
- Verificado: 24 pruebas de caja/ventas contra Postgres (incluye 12 cobros simultáneos por 5 unidades, doble anulación, aperturas simultáneas) y una prueba de punta a punta en el navegador y por la API (lector simulado, talla, descuento, vuelto, ticket, doble clic, anulación). Suite: 953.
- **Pendiente**: probar con una impresora térmica y un lector reales; devoluciones parciales; cobrar pedidos del bot en el mostrador; cliente asociado a la venta; panel comercial (F7).


## 51. Panel comercial (F7): Resumen comercial con datos reales

Primera pieza del módulo PANEL (`/panel/resumen`, solo dueño/admin porque muestra costos y utilidad; también `/panel/resumen/ventas.xlsx`). Todo son consultas a la base, cero IA (`lib/services/resumenComercial.js`).
- **Periodos** (hoy, 7 días, 30 días, este mes) medidos en la **zona horaria del negocio**, no la del servidor; cada uno se compara con el periodo anterior de igual duración (si no hay base de comparación no se inventa un porcentaje).
- **Dos canales sumados sin doble conteo**: ventas del mostrador (completadas) y pedidos de WhatsApp (no cancelados). Un pedido ya cobrado en el mostrador (`ventas.pedidoId`) cuenta una sola vez. Las anuladas y canceladas no suman.
- **Utilidad = ingreso − costo solo de las líneas con costo** (el mostrador guarda el costo del momento; el pedido de WhatsApp usa el costo actual de la opción/producto). Si falta el costo se informa cuánto se vendió "sin costo" y, si no hay ninguno cargado, la utilidad queda en "—" en vez de inventarse.
- **Pantalla**: ventas, cantidad, ticket promedio, utilidad y margen; ventas por día apiladas por canal; por canal y por método de cobro; productos más vendidos; embudo conversaciones → pedidos → ventas; pedidos por cobrar, anuladas y stock bajo.
- **Excel**: una fila por línea vendida (fecha, canal, referencia, producto, cantidad, ingreso, costo, utilidad); los textos que empiezan con `= + - @` se neutralizan para que no se ejecuten como fórmula.
- Menú: "Resumen" encabeza el grupo Panel comercial (con candado si el plan no trae PANEL); la tarjeta del módulo en Inicio abre el resumen. Reportes e Inteligencia siguen donde estaban.
- Verificado: 11 pruebas nuevas (zona horaria, doble conteo, costo, comparación, aislamiento entre empresas, Excel) y barrido en el navegador (plan Agente 403, cajero redirigido, anónimo al login). Suite: 964.
- **Pendiente del Panel**: Auditoría (quién anuló, ajustó stock, cerró caja), reporte de utilidad por producto/categoría, alertas, y conectar la maqueta de Inteligencia a datos reales.


## 52. Auditoría (F7): quién hizo qué

Pantalla `/panel/auditoria` (módulo PANEL, solo dueño/admin) sobre la tabla nueva `auditoria` (migración `20261111100000`, aditiva).
- **Qué se registra** (`lib/services/auditoria.js`, catálogo cerrado: una acción que no está en la lista se rechaza): venta anulada (con motivo y total), caja abierta / entrada o salida / cerrada (con esperado, contado y diferencia), stock ajustado a mano (antes → después), producto eliminado, pedido cancelado, invitación al equipo (creada y revocada), persona quitada del equipo, y plan asignado / renovado / editado por Proshop.
- **Atómico donde importa**: anular venta, cancelar pedido y ajustar stock registran dentro de la misma transacción (si no se puede registrar, la acción tampoco ocurre). Caja, equipo, producto eliminado y plan son "de mejor esfuerzo": si falla el registro se anota en el log del servidor, pero no se le niega al usuario algo que ya hizo.
- **No se edita**: un trigger de la base rechaza cualquier `UPDATE`. Borrar solo ocurre por cascada al eliminar toda la empresa.
- Se guarda el nombre y rol de la persona **al momento**, para que el historial se lea aunque después salga del equipo. El detalle se recorta (textos largos, sin datos sensibles).
- Pantalla: filtros por tipo, persona y fechas (en la zona horaria del negocio), paginada de 50, lo más nuevo primero; las acciones graves se marcan en rojo.
- Verificado: 10 pruebas nuevas (atomicidad, inmutabilidad por ORM y SQL crudo, aislamiento entre empresas, caja y anulación) y barrido en el navegador (acciones hechas por la web aparecen; filtros raros no rompen ni inyectan; plan Agente 403; cajero redirigido; anónimo al login). Suite: 974.
- **Pendiente**: auditar también cambios de precio/costo, cambios de rol y devoluciones (cuando existan), y el desbloqueo de ventas; exportar la auditoría a Excel.
