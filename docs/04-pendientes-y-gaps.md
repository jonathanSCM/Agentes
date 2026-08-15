# Pendientes y gaps conocidos

Basado en una revisión formal contra el documento "Instrucciones definitivas para el desarrollo del Agente de Ventas" del dueño del negocio (50 puntos), actualizada con todo lo resuelto en `docs/03-decisiones-recientes.md`. El objetivo de este archivo es que otra sesión de IA sepa, sin adivinar, qué ya está bien y qué falta.

## ✅ Resuelto

Los 50 puntos del documento están aplicados, salvo lo omitido a propósito (ver más abajo). Resumen de los que se cerraron en la última pasada:

- **Primero entender, después mostrar** (2, 8, 13, 42) — gate real en código: sin los atributos `OBLIGATORIO` de la categoría, el modelo no recibe ningún producto y `mostrar_productos` lo rechaza.
- **Género como filtro principal** (3) — `atributosLead` filtra la búsqueda de verdad y nunca se afloja.
- **Atributos con 3 niveles** (44) — `OBLIGATORIO` / `RECOMENDADO` / `OPCIONAL`.
- **Orden de alternativas + preguntar antes de ampliar** (11, 12) — color → marca → presupuesto → talla, avisando cuál se aflojó y pidiendo permiso antes de mostrar.
- **`total_matches` + paginación de 3** (15, 16, 17) — tool `ver_mas_productos`, con la página siguiente elegida por el backend.
- **Fotos: color exacto, referencial o inexistente** (21-25) — `fotoParaMostrar` devuelve si la foto es del color pedido, y qué colores tienen o no tienen foto.
- **TOOL_SUCCESS / TOOL_FAILED en todos los envíos** (26, 41) — el bot no puede afirmar que mandó algo que no se envió.
- **Moneda del backend** (29) — `Empresa.moneda`, precios siempre con símbolo real.
- **No inventar datos ni justificaciones de precio** (27, 28, 30).
- **Resumen de confirmación antes de crear el pedido** (39) — `confirmar_pedido`, con firma de ítems verificada en `crear_pedido`.
- **Tipo de entrega + retiro en tienda con ubicación real** (34, 37, 38).
- **Cambio de opinión sin reiniciar la conversación** (46).
- **Memoria estructurada con presupuesto numérico y variante elegida** (6), **estados de cierre** (7), **SKU** (19).
- **Logs con `total_matches`, `results_returned`, `missing_attributes`, `tool_result`** (48).
- **Los 12 tests de regresión** (47) — `test/documento-12-casos.test.js`.
- Y lo que ya estaba de antes: presentación real del bot (1), no interrogatorio (4), memoria persistente (5), presupuesto que no reemplaza categoría (9), no cambiar de categoría solo (10), no saturar con datos innecesarios (14), consultar antes de decir "no tenemos" (18), producto ≠ variante con `variant_id` en el pedido (20), foco en el favorito (32), llevar hasta el cierre (33), revalidar antes de crear (40), preguntas adaptadas a la categoría (43), no repreguntar (45), orden de responsabilidades (49).

## ⚪ Omitido a pedido explícito del dueño

Todo lo de **pago y dinero**:

- **Punto 35 (formas de pago)** y **36 (pago por QR)** — quedaron implementados de antes igual: formas de pago configurables por tienda y QR estático con confirmación real de envío.
- **La parte de facturación del punto 34** (factura sí/no, NIT, razón social) — no existe ningún campo de facturación en `Pedido` y no se agregó.

Si algún día se retoma: el lugar natural es `Pedido` (campos de facturación) y `AgenteConfig` (si la tienda factura o no).

## ⚠️ Acción pendiente del dueño después de aplicar la migración

Los atributos que hoy están marcados obligatorio pasan a **RECOMENDADO** (el bot los pregunta pero no bloquea). Para que funcione el punto 1 del documento ("no mostrar antes de preguntar género/talla"), hay que entrar a `/panel/categorias/:id` y **promover a Obligatorio los 1-2 atributos que de verdad importan** en cada categoría — normalmente Género y Talla. Mientras nadie lo haga, el bot se comporta como antes en ese punto: muestra apenas sabe la categoría.

El motivo de no hacerlo automático está en `docs/03-decisiones-recientes.md`: las 18 categorías tienen 8 atributos marcados, y activarlos todos como bloqueantes convertiría la conversación en un interrogatorio.

## 🟡 Cosas a tener en cuenta, no son gaps

- **Mostrar 3 + paginación reemplazó la decisión anterior de "mostrar todas".** Está explicado en `docs/03-decisiones-recientes.md` punto 8. No "corregirlo" de vuelta sin hablarlo: el riesgo que motivaba mostrar todas (esconder inventario) hoy está cubierto por `total_matches`.
- **Los atributos del lead filtran solo si el producto los tiene cargados.** Un producto sin `Genero` cargado igual le aparece a un cliente que pidió ropa de hombre. Es deliberado (no hay dato que lo contradiga y excluirlo escondería inventario mal etiquetado), pero significa que **la calidad del filtrado por género depende de que el catálogo esté bien etiquetado**. La auto-detección de atributos por categoría ayuda, pero no inventa datos que no existen.

## 🔴 Infraestructura

Detectado al analizar el proyecto, no está en los 50 puntos del documento pero era más grave que varios de ellos.

### ✅ Resuelto

- **El seed ya no borra datos en cada deploy.** `prisma/seed.js` hacía `paquete.deleteMany({})` + reset de la secuencia, y como el `CMD` del Dockerfile corre `npm run seed` en cada arranque, cada despliegue borraba en cascada los `PaquetePrecioPais` configurados desde `/admin` y dejaba en `NULL` el `paqueteId` de compras y pagos históricos. Ahora siembra por `cantidad` (clave natural) y solo crea lo que falta. El upsert de planes pasó a `update: {}`: la fuente de verdad de un plan que ya existe es el panel, no el seed. Verificado contra la base real: un precio por país y una edición de plan sobreviven a dos corridas seguidas.
- **Las fotos ya no se pierden al redesplegar** (a medias): el `Dockerfile` declara `VOLUME ["/app/public/uploads"]`. **Falta el paso manual en Coolify**: Storages → Add → Volume Mount apuntando a `/app/public/uploads`. Sin ese mapeo, la declaración sola no alcanza.
- **No se puede arrancar en producción con credenciales por defecto.** Si falta `ADMIN_PASSWORD` (o está en `proshop123`), `APP_ENCRYPTION_KEY` o `SESSION_SECRET`, el proceso sale con un error claro en vez de levantar el panel abierto. `lib/crypto.js` además tira error si falta la clave de cifrado: con la de desarrollo, los tokens de WhatsApp de todos los clientes serían descifrables.
- **`npm ci` en vez de `npm install`** en el Dockerfile: dos deploys del mismo commit instalan las mismas versiones.
- **Credenciales fuera del repo**: `temp_db_export.js` y `temp_demo_export.js` salieron del control de versiones y `scripts/export-demo-data.js` lee `DATABASE_URL` del `.env`.

### 🔴 Todavía sin resolver

- **El webhook de WhatsApp no valida la firma de Meta** (`X-Hub-Signature-256`). Cualquiera que conozca un `phoneNumberId` puede inyectar mensajes falsos: consume conversaciones pagas y dispara envíos a números arbitrarios. La solución son ~20 líneas (HMAC-SHA256 del body crudo con el App Secret), pero **necesita el App Secret de la app de Meta**, que hay que sacar del panel de Meta y cargar como `WHATSAPP_APP_SECRET`.
- **Todo asume un solo proceso.** Los timers de debounce (`bufferMensajes.js`), el mutex por cliente (`conversaciones.js`) y el job de facturación viven en memoria. Con dos réplicas habría cobros y notificaciones duplicados. Hoy no es un problema real con una sola instancia; la solución de fondo (Redis o locks en Postgres) es trabajo grande. **Decisión: no escalar a más de una réplica hasta que haga falta.**

## Cómo usar este archivo

Si el próximo pedido es "seguí con lo del documento del jefe", ya no queda nada del documento salvo lo omitido por ser de pago. Lo que sigue en prioridad es la lista de infraestructura de arriba.
