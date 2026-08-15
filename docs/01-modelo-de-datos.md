# Modelo de datos

Fuente de verdad real: `prisma/schema.prisma`. Este documento es un mapa de orientación, no un sustituto — si hay duda sobre un campo puntual, leer el schema directamente.

## Identidad y cuentas

- **`Empresa`** — el tenant. Todo lo demás cuelga de un `empresaId`. Tiene `slug` (usado en URLs públicas como `/catalogo/:slug`) y `marca` opcional (nombre de marca blanca).
- **`Usuario`** — login del panel cliente, con `rol` (`OWNER` u otros vía `Invitacion`/`Rol`).
- **`Session`** — sesiones de Express (connect-pg-simple o similar).

## Planes, suscripciones y consumo (la parte "SaaS" del negocio)

- **`Plan`** — lo que Proshop vende (Gratis/Estándar/Pro/Premium). Tiene `categoria` (`PlanCategoria`: `PERSONAL` | `EMPRESARIAL` — dos tablas comparativas separadas en la landing, nunca mezcladas). `convIncluidas` = cuántas conversaciones trae el plan.
- **`Caracteristica` + `PlanCaracteristica`** — catálogo compartido de filas para la tabla comparativa pública (`/planes/personal`, `/planes/empresarial`). `PlanCaracteristica.incluida` (boolean) marca si ese plan la tiene.
- **`PlanPrecioPais` / `PaquetePrecioPais`** — overrides de precio por país (si no hay override, cae a un default en USD, y si tampoco hay eso, al precio histórico en bolivianos). Ver `lib/services/precios.js`.
- **`Paquete` / `CompraPaquete`** — paquetes de conversaciones extra que una empresa compra cuando se le acaban las incluidas del plan.
- **`Suscripcion`** — la suscripción activa de una empresa a un plan, con `periodoInicio`/`periodoFin`.
- **`RegistroUso`** — cada conversación consumida queda registrada acá (`tipo: CONSUMIDA`, `origen: INCLUIDA` o `EXTRA`). Es la fuente real para calcular saldo disponible — nunca se resta un contador simple, se recalcula agregando este registro (ver `lib/services/suscripciones.js:consumirConversacion`).

## El agente y su configuración

- **`Agente`** — un bot de ventas de una empresa (por ahora normalmente uno por empresa). `estado`: `BORRADOR` / `ACTIVO` / `PAUSADO`.
- **`AgenteConfig`** — configuración editable desde `/panel/configuracion`: `tono`, `instrucciones` libres, `mensajeBienvenida` (⚠️ nullable a propósito — ver `docs/03-decisiones-recientes.md`, hubo un bug real con esto), `derivarAHumano`, y las formas de pago habilitadas (`aceptaQr`/`aceptaEfectivo`/`aceptaTarjeta` + `qrCobroUrl` con la imagen del QR de cobro).
- **`ConexionWhatsApp`** — credenciales de WhatsApp Business Cloud API (token cifrado, `phoneNumberId`).

## Catálogo

- **`Producto`** — `categoriaId` (relación real a `Categoria`, **ya no es texto libre** — ver más abajo), `atributos` (Json libre, clave:valor — Marca, Material, Género, lo que le sirva a cada rubro), `fotos` (array de URLs), `stock` (solo se usa si el producto NO tiene variantes).
- **`Categoria`** (por empresa) **+ `CategoriaAtributo`** — cada categoría tiene una lista configurable de atributos, cada uno marcado `obligatorio` (el bot lo pregunta antes de recomendar) y `esDeVariante` (vive en `Producto.atributos` si es `false`, en `Variante.atributos` si es `true` — ej: Género es de producto, Talla es de variante). Los obligatorios de nivel producto **se validan de verdad** al guardar un producto (rechaza el guardado si falta uno). Los de nivel variante son guía, no bloqueo. Panel: `/panel/categorias` (lista simple) → `/panel/categorias/:id` (detalle con sus atributos, patrón "producto → variantes").
- **`Variante`** — una combinación vendible de un producto (ej: talla 42 + negro), con su propio `stock`, `precio` opcional (si no, usa el del producto), y **`fotos` propias** (para que cada color tenga su propia foto real, no la genérica del producto — ver `docs/03-decisiones-recientes.md`).

## Clientes finales y conversaciones

- **`ClienteFinal`** — el "lead" del bot: memoria persistente por (empresa, teléfono). Campos clave: `categoriaInteres` (texto literal que dijo el cliente) + `categoriaId` (a qué `Categoria` real se resolvió — usado para saber qué atributos preguntar), `marca`/`talla`/`color`/`presupuesto`/`direccionEntrega`, `formaPago` (`FormaPago`: `QR`/`EFECTIVO`/`TARJETA`), `atributosLead` (Json libre — atributos de categoría que no son ya un campo propio, ej. Género, Uso), `estadoConversacion` (`EstadoConversacion`: `EXPLORANDO` → `BUSCANDO_PRODUCTO` → `COMPARANDO` → `INTERESADO` → `INTENCION_DE_COMPRA` → `LISTO_PARA_COMPRAR`), `productosMostrados`/`productosDescartados`/`productoFavoritoId`.
- **`Conversacion`** — una sesión de chat (agrupa mensajes dentro de una ventana de 24h, ver `docs/02-motor-del-agente.md`). `anuncioId`/`anuncioTitulo`/`anuncioImagenUrl` — atribución a anuncios de Meta (Click to WhatsApp), capturados gratis del webhook cuando existen. `modo` (`IA` o `HUMANO` — un asesor puede tomar control del chat).
- **`Mensaje`** — cada mensaje individual, con `rol` (`CLIENTE`/`AGENTE`/`SISTEMA`).

## Pedidos y pagos

- **`Pedido`** — `conversacionId` (de qué conversación salió, útil para atribución a anuncios), `formaPago` (copiado del `ClienteFinal` al crear), `direccionEntrega`/`entregaLat`/`entregaLng`, `estado` (`EstadoPedido`: `NUEVO` → `CONFIRMADO` → `ENTREGADO`, o `CANCELADO`). **El stock se descuenta al CREAR el pedido**, no en la entrega — cancelar un pedido restaura el stock.
- **`PedidoItem`** — línea del pedido, con nombre/precio **denormalizados** (si el producto cambia después, el historial del pedido no se altera).
- **`Pago`** — pagos de la propia Proshop (suscripciones/paquetes), no confundir con `Pedido.formaPago` (que es solo el método que eligió el cliente final, informativo — el cobro en sí lo coordina un humano por fuera del bot).

## Notificaciones

- **`Notificacion`** — avisos internos (ej: sin saldo, mensaje no atendido).
