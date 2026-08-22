# Proshop — Documento completo del sistema

Consolidado en una sola pieza para tener una foto completa y actual. Los documentos `01`-`05` siguen existiendo con más detalle puntual; este es el mapa general.

---

## 1. Qué es esto

Una plataforma **SaaS multi-tenant**: varios negocios ("empresas") contratan un plan y cada uno configura su propio **agente de ventas con IA que atiende por WhatsApp real**. Cada empresa tiene su catálogo, categorías, variantes, pedidos y panel de administración propios. No es un chatbot genérico: es un motor de ventas que se apoya siempre en datos reales de la base — el modelo de lenguaje **nunca** inventa qué existe, qué precio tiene o si hay stock.

**Principio central (no se rompe nunca):** *el backend decide y filtra, la IA solo conversa.* Todo lo que el bot puede decir sobre el catálogo (qué hay, precio, stock, fotos) lo calcula el código antes de llegar al modelo. El modelo elige palabras, no datos.

## 2. Stack

- **Backend**: Node.js + Express, vistas server-rendered con EJS (sin framework de frontend).
- **Base de datos**: PostgreSQL + Prisma ORM (`lib/db.js`, driver adapter `@prisma/adapter-pg`).
- **IA**: OpenAI o Anthropic, auto-detectado por variable de entorno (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`); sin ninguna de las dos, corre en "modo demo" con respuestas de ejemplo.
- **WhatsApp**: WhatsApp Business Cloud API (`lib/services/whatsapp.js`).
- **Tiempo real**: Socket.IO (`lib/services/realtime.js`) para el panel admin (mensajes/conversaciones en vivo mientras el staff está logueado). No hay canal en vivo para el catálogo público.
- **Despliegue**: Docker en Coolify. `CMD ["sh", "-c", "npx prisma migrate deploy && npm run seed && npm start"]` — migraciones y seed corren solos en cada deploy.
- **Testing**: `node:test` nativo, sin frameworks externos. `npm test` corre todo (234 tests a la fecha de este documento, todos deterministas salvo `test/regresion-agente.test.js`, que necesita una base real).

## 3. Modelo de datos (resumen por dominio)

Fuente de verdad real: `prisma/schema.prisma`.

**Identidad y cuentas**
- `Empresa` — el tenant. `slug` único (usado en `/catalogo/:slug`), `marca` opcional (marca blanca), `moneda` (el bot nunca elige el símbolo, siempre viene de acá).
- `Usuario` — login del panel (rol `OWNER` u otros vía `Invitacion`/`Rol`).
- `Session` — sesiones de Express del panel admin.

**Plan/suscripción/consumo**
- `Plan` (`categoria`: `PERSONAL`/`EMPRESARIAL`), `Caracteristica`+`PlanCaracteristica` (tabla comparativa pública), `PlanPrecioPais`/`PaquetePrecioPais` (override de precio por país), `Paquete`/`CompraPaquete` (conversaciones extra), `Suscripcion`, `RegistroUso` (fuente real del saldo — nunca un contador simple).

**Agente**
- `Agente` (`estado`: `BORRADOR`/`ACTIVO`/`PAUSADO`).
- `AgenteConfig` — `tono`, `instrucciones` libres, `mensajeBienvenida` (nullable a propósito), `derivarAHumano`, formas de pago habilitadas (`aceptaQr`/`aceptaEfectivo`/`aceptaTarjeta`+`qrCobroUrl`), `direccionTienda`/`tiendaLat`/`tiendaLng` (si está vacío, nunca se ofrece retiro en tienda), `preguntasIniciales` (default `["Genero"]` — lo que hay que saber antes de mostrar cualquier cosa).
- `ConexionWhatsApp` — credenciales cifradas + `phoneNumberId` (así el webhook sabe a qué empresa/agente pertenece un mensaje entrante).

**Catálogo**
- `Producto` — `categoriaId` (relación real, no texto libre), `sku`, `atributos` (Json libre: Marca, Material, Género...), `fotos[]`, `stock` (solo cuenta si NO tiene variantes), `activo`.
- `Categoria` — por empresa, **dos niveles** (`padreId` null = rubro, con valor = subcategoría). Los productos siempre cuelgan de la hoja. `CategoriaAtributo`: cada atributo tiene `nivel` (`OBLIGATORIO` bloquea mostrar nada hasta saberlo / `RECOMENDADO` se pregunta pero no bloquea / `OPCIONAL` solo filtra si el cliente lo menciona) y `esDeVariante` (Producto vs Variante).
- `Variante` — combinación vendible (ej. talla+color), `stock` propio, `precio` opcional (si no, hereda del producto), `fotos[]` propias (para que cada color tenga su foto real).

**Clientes finales y conversaciones**
- `ClienteFinal` — memoria persistente por (empresa, teléfono): `categoriaInteres`/`categoriaId`, `marca`/`talla`/`color`/`presupuesto`(+`presupuestoMin`/`Max` ya interpretados), `direccionEntrega`, `formaPago`, `tipoEntrega`, `atributosLead` (Json — Género, Uso, etc., filtran de verdad), `estadoConversacion` (`EXPLORANDO`→...→`PEDIDO_COMPLETADO`), `productosMostrados`/`productosDescartados`/`productoFavoritoId`/`varianteFavoritaId`, `contexto` (Json — carrito, fotos ya enviadas, marcas de turno, etc.).
- `Conversacion` — agrupa mensajes por ventana configurable (`CONVERSATION_WINDOW_HOURS`, default 6h); `modo` (`IA`/`HUMANO` — un asesor puede tomar control); `anuncioId`/`Titulo`/`ImagenUrl` (atribución a Click-to-WhatsApp de Meta, gratis desde el webhook).
- `Mensaje` — `rol` (`CLIENTE`/`AGENTE`/`SISTEMA`).

**Pedidos**
- `Pedido` — `formaPago`/`tipoEntrega` copiados del lead al crear, `estado` (`NUEVO`→`CONFIRMADO`→`ENTREGADO`, o `CANCELADO`). **El stock se descuenta al crear el pedido**, no al entregar; cancelar lo restaura.
- `PedidoItem` — nombre/precio denormalizados (el historial no cambia si el producto se edita después).
- `Pago` — pagos a Proshop (suscripciones/paquetes), no confundir con la forma de pago del cliente final (esa es solo informativa, el cobro lo coordina un humano).

**Notificaciones**: `Notificacion` (avisos internos: sin saldo, mensaje no atendido, etc.)

## 4. El motor del agente (`lib/services/agente.js` + `lib/services/catalogo.js`)

Separados a propósito: `catalogo.js` es puro y determinista (filtros, fallback, paginación, selección de foto — sin DB ni red, testeable solo); `agente.js` es cómo se le habla al modelo y cómo se ejecutan acciones reales.

### Flujo de un mensaje

`server.js` (`POST /webhooks/whatsapp`) → matchea por `phoneNumberId` a un `Agente`/`Empresa` → `lib/services/conversaciones.js` (`procesarMensajeEntrante`: agrupa en la misma conversación si cae dentro de la ventana configurable (default 6h), cobra 1 conversación solo si abre una nueva) → `generarRespuesta()` en `agente.js`.

`generarRespuesta()`, paso a paso:
1. Carga agente + config + catálogo activo (hasta 200 productos, con variantes y atributos de categoría).
2. Si pasaron **5 horas** sin escribir (`MINUTOS_REINICIO_INTENCION`, default 300), se olvida la intención de compra vieja (categoría, talla, color, marca, presupuesto, favorito) — nombre y dirección se conservan siempre. Si pasaron **10 minutos** (`MINUTOS_REINICIO_VISTOS`), se olvida solo lo ya *mostrado* (para volver a mandar tarjetas si vuelve).
3. Extrae filtros deterministas del mensaje **en código** (`extraerFiltros`): categoría (contra las categorías reales de la empresa — con más peso si ya hay una categoría establecida, para que una palabra suelta no la pise), talla, cantidad. Respaldo para cuando el modelo no llama a `actualizar_datos_lead`.
4. **Ruteo de modelo por costo**: si el cliente todavía no eligió categoría ni tiene favorito (turno de "orientación": saludo, ayuda genérica, menú), se usa el modelo económico del proveedor (`gpt-4o-mini` en OpenAI) sin importar el plan contratado. En cuanto se sabe la categoría o ya eligió algo, se usa el modelo del plan (`gpt-4.1-mini` en Standard, etc. — ver tabla en `lib/services/agente.js:117-130`).
5. Arma el prompt de sistema (`construirSystem`): identidad, tono, categorías reales, atributos obligatorios que faltan, formas de pago, y todo lo que ya se sabe del lead.
6. Loop de hasta 3 vueltas contra el proveedor de IA (última vuelta sin `tools`, para forzar respuesta final en texto).
7. Ejecuta las tool calls (`ejecutarFuncion`), devuelve el resultado, repite hasta que responda en texto plano sin más llamadas.

### Las tools

- **`actualizar_datos_lead`** — guarda cualquier dato nuevo (incluye `atributosCategoria`, `tipoEntrega`, `varianteFavoritaId`).
- **`mostrar_productos`** — única forma correcta de mostrar productos (tarjeta con foto + ficha real). El modelo nunca describe precio/stock en texto plano.
- **`ver_mas_productos`** — siguiente página de la misma búsqueda; el backend elige qué mostrar, nunca el modelo.
- **`enviar_fotos_producto`** — fotos de un producto puntual, con aviso si la foto es referencial (no del color pedido).
- **`agregar_al_carrito` / `ver_carrito` / `quitar_del_carrito`** — carrito de la conversación (vive en `ClienteFinal.contexto.carrito`, ver `lib/services/carrito.js`). Al agregar algo, también se sugieren hasta 3 productos reales de la misma categoría con stock (cross-sell), sin inventar nada.
- **`confirmar_pedido`** — arma el resumen real (producto, variante, cantidad, precio de la base, entrega) para leérselo al cliente. Obligatoria antes de crear.
- **`crear_pedido`** — revalida stock/precio, requiere nombre + tipo de entrega (+ dirección si es a domicilio) + forma de pago + que el cliente haya confirmado ESE pedido exacto (firma de ítems comparada contra la de `confirmar_pedido`).
- **`mostrar_categorias`** — arma el menú real (rubros, o subtipos del rubro elegido); si la tienda vende un solo rubro sin subdividir, se lo asigna directo y muestra sus productos sin preguntar. Nunca manda un link a la web (ver §7 sobre esto).
- **`derivar_a_asesor`** — deriva a un humano (mayorista, cliente molesto, negociación especial, etc.).

### Backstops en código (no confiar solo en el prompt)

Reglas críticas reforzadas en código porque depender solo de instrucciones de texto falló en la práctica:

- **Primero entender, después mostrar.** Con atributos `OBLIGATORIO` sin saber, no hay bloque de resultados y `mostrar_productos` rechaza la llamada.
- **Pocas opciones por vez, sin mentir sobre el total.** 3 por página; el prompt siempre lleva `total_matches` real.
- **Nunca se afloja un filtro en silencio.** `buscarConFallback` afloja de a uno (color→marca→presupuesto→talla), nunca categoría/atributos del lead, y avisa cuál aflojó — no se muestra hasta que el cliente acepte ver alternativas.
- **Toda acción confirma su resultado real** (`TOOL_SUCCESS`/`TOOL_FAILED`) antes de que el modelo pueda decir que la hizo.
- **La moneda la pone el backend**, nunca el modelo.
- **ID de producto siempre real y relevante** — se valida contra los candidatos de la búsqueda actual, lo ya mostrado, o el favorito.
- **4 detectores de "texto vago en vez de acción"**, corriendo en cada vuelta del loop **incluida la última** (antes solo cubrían las vueltas intermedias — bug real corregido): pedir preferencia sin mostrar, nombrar un producto sin tarjeta, listar productos en texto plano, interrogatorio (2+ preguntas juntas), o anunciar una búsqueda sin entregarla ("dame un momento"). Si dispara en la última vuelta (sin `tools` disponibles), se fuerza en código un `mostrar_productos` real en vez de mandar el texto de relleno; si no hay candidatos reales, se pregunta honestamente la única cosa que falta.
- **No repetir el menú si ya se mostró una tarjeta en el mismo turno** (refuerzo de prompt, señal `tarjetaEnviadaEnTurno`).
- **Atributos obligatorios sin bucle**: la respuesta del cliente se resuelve **en código** contra los valores reales del catálogo (no comparación literal de texto), no se pregunta un atributo si el catálogo no tiene con qué responder (un solo valor o ninguno), y a los 2 intentos sin resolverlo el bloqueo se libera igual (nunca deja al cliente encerrado).

### Selección de fotos y fichas

`fotoParaMostrar(producto, lead)` devuelve `{url, colorDeLaFoto, esDelColorPedido, coloresConFoto, coloresSinFoto}`, nunca una URL suelta. Si el color pedido no tiene foto propia, se manda la que hay pero marcada como referencial (`avisosDeFoto`) — pasar una foto de un color por otro es el error que el negocio marcó como grave. `fichaProducto` agrupa variantes por talla y colapsa colores repetidos en una sola línea si todas las tallas mostradas comparten el mismo set.

### Anti-invención transversal

`respuestaErrorTecnico()` — si falla el proveedor de IA o una consulta a la base, el bot nunca inventa disponibilidad: admite el problema técnico.

## 5. Panel de administración (`/panel/*`)

Requiere sesión (`requireCliente`). Secciones: `agente` (chat de prueba), `productos` (+variantes, con copiar-fotos entre variantes del mismo color), `categorias` (lista simple → detalle con sus atributos), `inventario`, `pedidos`, `clientes`, `conversaciones` (ver transcript, tomar/devolver control humano, reiniciar memoria del cliente, **borrar por completo** una conversación y sus datos — sin dejar rastro, los pedidos ya creados quedan sin cliente asociado pero no se borran), `configuracion`, `whatsapp` (conexión), `equipo` (invitaciones), `consumo`, `paquetes`, `compras`, `reportes`.

## 6. Panel super-admin (`/admin/*`) y páginas públicas

`/admin/*` — gestión de Proshop mismo: empresas, agentes, conexiones, planes, paquetes, características, pagos, leads registrados, mensajes.

Públicas sin login: `/` (landing), `/planes/:categoria`, `/registro`, `/ingresar`, `/invitacion/:token`, `/api/contacto`, **`/catalogo/:slug`** (catálogo web de una empresa — fotos, precio, stock agrupado por categoría, búsqueda/filtro solo client-side; tiene un botón flotante a WhatsApp). El bot **no manda este link** (ver §7).

## 7. Una decisión importante que sigue vigente (y se está reconsiderando)

Hace un tiempo el bot mandaba el link a `/catalogo/:slug` cuando el cliente pedía "ver el catálogo". Se sacó (`mostrar_categorias` reemplazó a `mostrar_catalogo`) porque el cliente salía de WhatsApp y no volvía — regla actual en el prompt: *"PROHIBIDO mandarle un link a una página: el cliente compra dentro de WhatsApp"*.

Está en discusión (documento externo "Nuevo flow.pdf") volver a un modelo híbrido chat+catálogo web con carrito compartido — el dueño decidió avanzar con esa idea; hay un plan de implementación en curso (token de sesión web firmado, filtro server-side, agregar-al-carrito desde la web reusando `lib/services/carrito.js`, y que el bot pueda mandar el link filtrado como opción — no como reemplazo de las tarjetas — cuando ya sabe qué categoría busca el cliente). Todavía no implementado al momento de este documento.

## 8. Cómo se desarrolla acá (reglas del entorno, no del negocio)

1. **Migraciones de Prisma son manuales**: no se puede correr `prisma migrate dev` interactivo en este entorno. Se escribe `prisma/migrations/<timestamp>_<nombre>/migration.sql` a mano, se aplica con un script Node temporal (se borra después), y después `npx prisma migrate resolve --applied <nombre>` + `npx prisma generate`. Nunca se edita una migración ya pusheada.
2. **`server.js` no tiene hot-reload** — hay que reiniciar el preview después de editarlo. Vistas EJS y estáticos sí se sirven frescos.
3. **Todo es multi-tenant por `empresaId`** — cualquier query nueva filtra por la empresa correcta.
4. **Cambios grandes van con plan primero**: investigar, armar un plan, pedir aprobación, implementar, verificar con tests + simulación real, recién ahí commitear (con permiso explícito).
5. **Verificación real antes de afirmar que algo funciona**: `npm test` (234 tests) + scripts temporales con `llamarInyectado` (IA falsa determinista) contra una empresa de prueba aislada creada y borrada por el propio script — nunca contra la base real de producción salvo lectura explícitamente autorizada.

## 9. Otros documentos del proyecto

- `docs/01-modelo-de-datos.md` / `docs/02-motor-del-agente.md` — el mismo contenido de arriba pero solo esas dos partes, con algo más de detalle puntual.
- `docs/03-decisiones-recientes.md` — bitácora punto por punto de decisiones y bugs reales resueltos, con el porqué de cada una.
- `docs/04-pendientes-y-gaps.md` — qué falta o quedó a medias.
- `docs/05-propuesta-personalizacion-ia.md` — propuesta (no implementada) de personalización con memoria de cliente / embeddings.
