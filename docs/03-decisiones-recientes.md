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
