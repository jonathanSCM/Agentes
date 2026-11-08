# Plan 11 — Planes por módulos (Agente · POS · Panel comercial), rediseño del panel y bot de citas

Fecha: 2026-11-07 · Estado: **propuesta para aprobar** (no se tocó código salvo el punto 0.1).
Referencia estudiada: `D:\Trabajo\barberia` (POS en Next.js + AgendaBot unidos, con `PLAN.md`, `PLAN-UNIFICACION.md`, `AUDITORIA.md`).

---

## 0. Qué se pidió y qué se hace con cada cosa

| # | Pedido | Respuesta corta |
|---|---|---|
| 0.1 | Quitar el botón verde "Volver a WhatsApp" de la página del producto del catálogo web | **Hecho** (`views/catalogo-producto.ejs`). Se conserva "Consultar por WhatsApp" solo cuando el cliente entra sin sesión (no hay otra forma de pedirlo) |
| 0.2 | Que la **reserva de citas** también funcione con el ahorro de costos (la IA no escribe, casi no se usa) | **Hoy el bot de citas no existe todavía** (el motor de agenda y los paneles sí; el bot es la "fase 3"). Se construye con exactamente las mismas reglas: ver §7 |
| 0.3 | Rediseño del **panel lateral** "literalmente como" la barbería y **conversaciones tipo CRM** (lista a la izquierda, chat a la derecha, foto e información del contacto), con la **misma paleta de colores actual** | §6. Una limitación real: WhatsApp **no entrega la foto de perfil** del cliente (ver §6.3) |
| 0.4 | Producto **por planes y suscripciones por módulos**: solo Agente · Agente + POS · Agente + POS + Panel administrativo/comercial | §3 a §5 |
| 0.5 | "Que nada se rompa", buscar posibles fallos | §8 (28 riesgos con su solución) y §9 (cómo se protege cada fase) |

Principios que **no cambian**: el backend decide y la IA solo conversa; determinista primero; cero gasto de IA en POS y panel (son código y consultas a la base); todo multi-tenant por `empresaId`.

---

## 1. Qué es el proyecto de la barbería (y qué aprendimos)

Es la unión de dos apps: **POS** (Next.js 16 + Prisma + NextAuth, un solo negocio con sucursales) y **AgendaBot** (Express + React, multi-negocio). Se unieron con un solo login, una sola base (esquemas separados) y un solo dominio (la Agenda dentro de `/agenda`).

Lo que **sí** trae valor para Proshop:
- **Módulos separados por menú y por rol** (hub "Menú principal" → POS / Agenda / Admin), aplicado **en el servidor**, no solo ocultando botones.
- **Caja** (apertura con efectivo inicial, cierre con conteo y diferencia), **ventas** con varios métodos de pago, **recibo** público por token con QR, **anulaciones y devoluciones**, **fiado** (cuentas por cobrar con abonos), **kardex** de movimientos de stock, **proveedores/compras**, **auditoría**, **reportes** con Excel.
- **Cobrar el pedido de WhatsApp en el mostrador** sin descontar stock dos veces ("Cobrar y entregar").
- Una **auditoría de seguridad e integridad** muy valiosa (`AUDITORIA.md`): 16 hallazgos de seguridad y 11 de integridad que ya costaron arreglar una vez. Este plan los trata como lista de verificación (§8).

Lo que **no** se copia:
- **El código del POS tal cual.** Es Next.js, con un solo negocio, otra autenticación y otro despliegue. Embeberlo exigiría hacerlo multi-tenant (`empresaId` en ~25 tablas), mantener dos logins, dos despliegues y dos fuentes de stock. Ver §2.
- Lotes con vencimiento, transferencias entre almacenes, comandas de barra, comisiones (la propia barbería las quitó), sucursales (queda "dormido", igual que allá).
- Facturación fiscal (NIT/factura): **no se hace**; solo "nota de venta/recibo". Es un tema legal aparte (§10).

---

## 2. Decisión de arquitectura (la importante)

| Opción | Qué es | Pros | Contras |
|---|---|---|---|
| A. Embeber el POS de la barbería (Next) detrás de Proshop | Dos apps, proxy `/pos` | Ya está hecho | Un solo negocio → hay que reescribirlo multi-tenant igual; **dos stocks** (el del bot y el del POS) que se desincronizan; dos logins; dos despliegues; planes no pueden gobernarlo sin un puente |
| **B. POS nativo dentro de Proshop** *(recomendada)* | Express + EJS, mismas tablas de catálogo | **Un solo stock** (el bot y el mostrador descuentan lo mismo); un login; los planes lo gobiernan directo; multi-tenant desde el día 1; reutiliza productos, variantes, clientes, pedidos, reportes | Hay que programarlo (se copian las **reglas** y el diseño de datos de la barbería, no el código) |
| C. Solo enlazar | Botones entre sistemas | Rapidísimo | Cobro doble, clientes duplicados, no es producto |

**Recomendación: B.** El corazón de "nada se rompe" es **un solo stock y un solo cliente**; eso solo se garantiza compartiendo tablas y transacciones.

---

## 3. Planes y módulos

### 3.1 Módulos (qué incluye cada uno)

| Módulo | Incluye (menú) | Roles que lo usan |
|---|---|---|
| **AGENTE** (base, siempre) | Inicio, Conversaciones (CRM), Agente IA, WhatsApp, **Mensajes** y **Sin respuesta**, Catálogo (Productos, Categorías), Pedidos de WhatsApp, Clientes, Configuración, Consumo/Paquetes, Mi equipo | Dueño, Admin, Staff |
| **POS** | Menú principal del POS, **Punto de venta**, **Caja**, **Ventas** (historial, anular, devolver), **Fiado/Cuentas por cobrar**, Inventario con **kardex**, Proveedores y compras (fase tardía), recibos | Dueño, Admin, **Cajero** (rol nuevo) |
| **PANEL comercial** | **Panel gerencial** (ventas hoy/mes, ticket promedio, utilidad y margen, comparativa WhatsApp vs mostrador, embudo bot→pedido→venta), **Reportes** con Excel, **Inteligencia**, **Auditoría**, alertas (stock bajo, por cobrar, sin movimiento) | Dueño, Admin |

> Hoy `Reportes` e `Inteligencia` los ven **todos** los clientes. Pasarlos al módulo PANEL **les quita funciones a clientes actuales**: ver §8-R14 (se les respeta con "congelado de derechos", no se les quita nada sin avisar).

### 3.2 Planes (propuesta; precios los define el jefe)

| Plan | Módulos | Notas |
|---|---|---|
| **Agente** | AGENTE | El actual. Límites de conversaciones, productos, usuarios, mensajes propios y topes de citas **como hoy** |
| **Agente + POS** | AGENTE + POS | Suma Cajero como rol; sube `maxUsuarios` |
| **Agente + POS + Panel** | AGENTE + POS + PANEL | Todo |

Pregunta abierta para el jefe (§10-P1): los 4 planes actuales (Gratis/Standard/Pro/Premium) ¿se reemplazan por estos 3, o los módulos se combinan con los niveles de volumen? Recomendación: **3 planes de módulos**, y el volumen (conversaciones incluidas) se cubre con los **paquetes** que ya existen.

### 3.3 Cómo se implementa (sin romper lo existente)

- `planes.modulos TEXT[]` (valores `AGENTE`, `POS`, `PANEL`; default `{AGENTE}`), migración **aditiva**.
- `lib/services/modulos.js`: `modulosDe(empresaId)` (con caché corto), `tieneModulo()`, middleware `requireModulo('POS')` aplicado a **cada ruta y cada POST** (no solo al menú), respuesta 403 con pantalla "Este módulo no está en tu plan → mejorar plan".
- Menú, hub y tour muestran solo lo que el plan trae; los módulos no contratados aparecen **bloqueados con candado** (vende solo).
- **Estado de suscripción**: `PRUEBA` = todos los módulos por X días (decisión P2); `MOROSA` = hoy el agente deja de atender; el POS **sigue funcionando** (el cobro en el mostrador no puede detenerse por un atraso) y se muestra aviso fuerte; `CANCELADA` = acceso de **solo lectura/exportación** 60 días.
- **Cambio de plan**: subir = inmediato; bajar = los datos del módulo **no se borran**, queda en solo lectura; si hay una **caja abierta** no se permite bajar hasta cerrarla.
- Admin de Proshop: el formulario de planes gana el selector de módulos; la página pública de comparación (`/planes`) se actualiza con la tabla de módulos.

---

## 4. Datos nuevos (todo con `empresaId`, migraciones aditivas, nada se borra)

| Tabla | Para qué | Nota clave |
|---|---|---|
| `ventas`, `venta_items`, `venta_pagos` | Ventas del mostrador | `codigo` único por empresa; estados `BORRADOR/COMPLETADA/ANULADA`; **clave de idempotencia** única (doble clic/doble envío no duplica) |
| `sesiones_caja`, `movimientos_caja` | Apertura/cierre de caja | **Una sola caja abierta por empresa** (índice único parcial) |
| `movimientos_stock` | **Kardex**: todo cambio de stock (venta, pedido del bot, devolución, ajuste, compra) con stock antes/después | Hoy **no existe**: es la base para auditar y para evitar el doble descuento |
| `devoluciones`, `devolucion_items` | Devolver parcial o total | Reponen stock y caja una sola vez (bloqueo `FOR UPDATE`) |
| `abonos_cliente` + `clientes_finales.saldo` | Fiado (cuentas por cobrar) | Solo a clientes identificados; sin crédito para ventas anónimas |
| `proveedores`, `compras`, `compra_items`, `pagos_proveedor` | Compras (fase tardía) | Recepción con reclamo atómico (no se recibe dos veces) |
| `auditoria` | Quién hizo qué (anulaciones, ajustes, cierres, cambios de plan) | Solo lectura |
| `productos.costo`, `variantes.costo`, `productos.codigo_barras` | Margen y lector de códigos | Opcionales; sin costo el panel muestra "sin costo" en vez de inventar utilidad |
| `pedidos.venta_id` (único) | Cobrar un pedido de WhatsApp en el mostrador | Cobrar **no** vuelve a descontar stock |
| `conversaciones.leido_hasta` por usuario | "No leídas" reales del CRM | Hoy no existe |
| `usuarios.rol` + valor `CAJERO` | Rol del mostrador | El `enum Rol` hoy es PROSHOP_ADMIN/OWNER/ADMIN/STAFF |

Red de seguridad de la barbería que se copia: **restricciones `CHECK` en la base** (stock ≥ 0, cantidades > 0, totales ≥ 0, estados válidos). Si un camino de código falla, la base igual rechaza el dato imposible.

Reglas de dinero (copiadas): montos en `Decimal(10,2)`; **el servidor recalcula todos los totales** (nunca confía en lo que manda el navegador); cantidad finita, > 0 y con tope; suma de pagos = total; propina fuera del ingreso (si se usa); monedas con la regla "`Bs 150.00` / `$150.00`" ya usada en el bot.

---

## 5. Alcance funcional por fases (POS y Panel)

**POS — P1 (mínimo vendible)**: abrir caja → vender (buscar por nombre/SKU/código de barras, elegir variante, cantidad, descuento por línea y total) → cobrar (efectivo con vuelto, QR, tarjeta, transferencia) → recibo imprimible (80 mm y A4) y por link/WhatsApp → historial → anular (con motivo, solo Admin) → cerrar caja con conteo. Tests de concurrencia desde el primer día.

**POS — P2**: devoluciones, fiado con abonos, **cobrar pedidos de WhatsApp**, venta ligada a cliente, ventas "en espera".

**POS — P3** (más adelante, a pedido): proveedores y compras con recepción, kardex avanzado, productos sin movimiento, alertas de reposición.

**Panel comercial**: tarjetas del día/mes (ventas, ticket promedio, productos más vendidos, stock bajo, por cobrar), **canal**: WhatsApp vs mostrador, **embudo** conversaciones → pedidos → ventas (los datos ya existen en gran parte: `Conversacion`, `Pedido`, `usos_ia`), utilidad y margen (con costo), reportes filtrables y Excel, auditoría. Una pantalla **barata**: consultas con índices y caché de 60 s; cero IA.

---

## 6. Rediseño visual del panel

### 6.1 Principios
- **Misma paleta de hoy**: fondo morado oscuro (`#190f28`), morado marca `#8b5cf6`, menta `#2fe3a6` como acento activo, superficies translúcidas. No se cambia ningún color; se reorganiza la estructura.
- Se mantiene **EJS + JavaScript simple** (no se reescribe a React: sería meses y riesgo innecesario). La barbería usa React/Next, pero la **estructura y el CSS** se copian, no la tecnología.
- Un solo archivo de estilos del shell (`public/css/panel-shell.css`) con las clases de la barbería (`lateral`, `marca-negocio`, `nav-grupo`, `nav-titulo`, `contador`, `usuario`, `lateral-toggle`) enlazadas a las variables actuales.

### 6.2 Panel lateral (copiado de la barbería)
Bloque de marca arriba (logo + **tarjeta del negocio**), navegación en **grupos con título en mayúsculas**, iconos de línea, ítem activo con fondo suave y color de acento, **contadores** (conversaciones sin leer, pedidos nuevos), **usuario abajo** con rol y cerrar sesión, **plegable a solo iconos** (se recuerda en el dispositivo), cajón deslizable en celular. Más un **Menú principal (hub)** con una tarjeta por módulo contratado (Agente, POS, Panel) y las no contratadas con candado.

Grupos propuestos:
- **Agente**: Conversaciones · Pedidos · Clientes · Agente IA · Mensajes · Sin respuesta · WhatsApp
- **Catálogo**: Productos · Categorías (· Inventario si no hay POS)
- **POS** (si el plan lo trae): Punto de venta · Caja · Ventas · Fiado · Inventario/Kardex
- **Panel comercial** (si el plan lo trae): Resumen · Reportes · Inteligencia · Auditoría
- **Mi cuenta**: Equipo · Consumo · Paquetes · Configuración

### 6.3 Conversaciones tipo CRM
Tres zonas, como `Conversaciones.jsx` de la barbería: **lista** (avatar, nombre, último mensaje con ícono de tipo, hora, contador de no leídas, etiqueta "Atiende una persona") con filtros *Todas / No leídas / Esperan persona* y buscador · **chat** estilo WhatsApp (burbujas con hora, separadores "Hoy/Ayer", imágenes y notas de voz, compositor con emojis, **Tomar la conversación / Devolver al bot**) · **ficha del contacto** a la derecha (nombre, teléfono, datos del lead, pedidos, carrito, etiquetas, origen del anuncio).

Notas honestas:
- **Foto de perfil**: la API oficial de WhatsApp **no entrega la foto del cliente** (solo el nombre de perfil, que ya guardamos como `nombrePerfil`). Se usa **avatar con iniciales y color** (como la barbería). Si el negocio quiere foto, se podrá subir manualmente en la ficha.
- **Tiempo real**: Proshop no tiene websockets. Se usa **SSE** (como la barbería) con *polling* de respaldo. Los eventos se filtran por rol y por empresa (en la barbería se filtró contenido de mensajes a roles que no debían verlo: hallazgo S-05).
- Lo que ya existe y se reutiliza: tomar/liberar conversación, enviar mensaje manual, adjuntos de imagen y audio, mensajes pendientes recuperables.

### 6.4 Cómo se hace sin romper (ver también §9)
Se cambia **solo el cascarón** (`partials/inicio.ejs` / `fin.ejs` + CSS del shell); el interior de cada pantalla se restyla **una por una** en orden de uso. El tour guiado (`tour.ejs`) apunta a elementos del menú actual: se actualiza junto con el shell. Para verificar visualmente cada pantalla se crea un **tenant demo local** (`scripts/demo-panel.js`, solo desarrollo) con datos y un usuario de prueba.

---

## 7. Bot de citas con el mismo ahorro de costos

Estado real: existe el modelo de datos, el motor de agenda (horarios libres, capacidad, buffers, feriados, transacción anti doble reserva), los paneles de servicios/equipo/horarios y los topes del plan. **Falta el bot de WhatsApp.**

Diseño (idéntico en espíritu a productos):
1. **Máquina de estados determinista** con **listas y botones reales**: servicio → profesional (si hay) → día (próximos 7 con cupos) → hora (listas con paginación) → nombre → confirmar → cita creada → recordatorio. **0 llamadas a la IA** en todo ese recorrido.
2. **Textos del catálogo de mensajes** (clave + descripción + variables), editables por el negocio; vocabulario por rubro (cita/turno/reserva).
3. **La IA solo para texto libre** ("quiero corte y barba mañana por la tarde"), y **solo elige** una acción y datos de listas cerradas (servicio_id, día, franja); el backend consulta disponibilidad real y ofrece las horas. Mismas validaciones de afirmaciones: no dice "agendada" si el backend no confirmó.
4. **Mismas defensas**: guardia de entrada/salida, FAQ/horarios sin IA, tope de IA, circuito de salud, modo sin IA (el menú de reservas funciona aunque se caiga la IA), mensajes pendientes recuperables.
5. **Criterio de aceptación medible**: escenarios de evals de citas (reservar, cambiar, cancelar, sin cupo, fuera de horario, feriado, manipulación) y **meta de consumo ≤ 1 llamada y ≤ 3 mil tokens** por turno con IA, 0 en turnos de menú — verificado con `npm run eval`.
6. **Cobrar cita en el POS** (como la barbería): cita completada → venta; una cita = una venta (índice único).

---

## 8. Riesgos y fallos posibles (con solución)

| # | Riesgo | Qué pasaría | Solución |
|---|---|---|---|
| R1 | **Sobreventa por carrera** (bot y mostrador venden el último producto a la vez) | Stock negativo, cliente con pedido imposible | Descuento atómico condicionado (`UPDATE … SET stock = stock - n WHERE stock >= n`); si afecta 0 filas, se rechaza. Hoy los descuentos de Proshop son `decrement` sin esa condición → se corrige **antes** de abrir el POS. Restricción `CHECK (stock >= 0)` |
| R2 | **Doble descuento al cobrar un pedido del bot** (el bot ya descontó al crear el pedido) | Stock bajo dos veces | `pedidos.venta_id` único; "cobrar pedido" crea la venta **sin** tocar stock y registra el movimiento como "pedido→venta" |
| R3 | Cancelar/anular repone dos veces | Stock inflado | Anulación "reclamada" atómicamente (`estado: COMPLETADA→ANULADA`), devoluciones bajo `FOR UPDATE`; el kardex permite auditar |
| R4 | **Doble clic / reintento** al cobrar | Dos ventas iguales | Clave de idempotencia por envío (única) y botón que se bloquea; respuesta idempotente |
| R5 | Cantidades negativas, `NaN`, enormes | Stock sube o ventas negativas (hallazgo I-02 de la barbería) | Validación estricta en servidor + `CHECK` en la base |
| R6 | El navegador manda precios/cajero | Fraude | El servidor recalcula todo desde la base; el cajero es siempre el de la sesión |
| R7 | **Aislamiento entre empresas** (una consulta sin `empresaId`) | Una tienda ve datos de otra | Toda tabla nueva con `empresaId`; helper único `deEmpresa(req)`; **pruebas automáticas cruzadas** (empresa A pide recursos de B → 404) por cada ruta nueva |
| R8 | Control solo en el menú | Cualquiera entra por URL | `requireModulo` + `requireRol` **en cada ruta y POST**; prueba que recorre todas las rutas con cada rol y plan (la barbería hizo 145 comprobaciones así) |
| R9 | Sesión con rol viejo | Seguir entrando tras bajarle el rol (S-03) | Rol y "activo" se leen de la base en cada petición (o caché de 30 s), no del token de sesión |
| R10 | Eventos en vivo filtran datos | Cajero ve contenido de chats (S-05) | SSE filtrado por empresa **y** por rol/módulo |
| R11 | **Dos cajas abiertas** o cierre sin contar | Descuadre | Índice único parcial (1 sesión abierta por empresa); cierre exige conteo; el sistema calcula esperado y diferencia; si bajan de plan con caja abierta, se bloquea |
| R12 | Caja mal calculada (devoluciones, fiado, propinas) | Descuadre | Reglas escritas y probadas: efectivo esperado = inicial + cobros en efectivo − devoluciones en efectivo ± movimientos manuales; fiado no entra a caja |
| R13 | Redondeos | Centavos que no cuadran | `Decimal` en todo, redondeo único por línea, prueba de invariantes (suma de pagos = total) |
| R14 | **Quitarle funciones a clientes actuales** al mover Reportes/Inteligencia al módulo PANEL | Clientes enojados | "Congelado de derechos": los clientes actuales conservan lo que ya veían hasta que se les migre con aviso; el backfill es explícito y reversible |
| R15 | Cambio de plan a mitad de periodo | Accesos inconsistentes, cobros | Sube = inmediato; baja = solo lectura (datos intactos); reglas de periodo definidas en una sola función `estadoDeAcceso(empresa)` con pruebas |
| R16 | Suscripción morosa corta el POS | Tienda sin poder cobrar | MOROSA: el agente se pausa (como hoy) pero el POS sigue con aviso; CANCELADA: solo lectura |
| R17 | Migraciones en producción | Caída en el deploy | Todas **aditivas** (tablas/columnas nuevas con default), nunca editar migraciones viejas, probadas en la base de pruebas; despliegue aplica `migrate deploy` solo |
| R18 | Rol `CAJERO` en el `enum` | Migración de enum delicada en Postgres | Agregar el valor con `ALTER TYPE … ADD VALUE` en migración propia (sin transacción) y probar |
| R19 | Búsqueda lenta en el POS con catálogos grandes | Mostrador lento | Índices por nombre/SKU/código de barras, búsqueda con debounce, tope de resultados; atajo de lector de códigos (el escáner USB escribe como teclado) |
| R20 | Variantes (talla/color) en el POS | Vender sin elegir variante | El selector de variante es obligatorio si el producto las tiene; el stock se descuenta de la variante |
| R21 | Impresión de recibos (térmica 80 mm) | Cada navegador imprime distinto | CSS de impresión específico + vista de recibo por token (como la barbería); sin dependencias de drivers; probar en una impresora real antes de vender el módulo |
| R22 | Caché del catálogo público desactualizada | Vende lo agotado | Invalidar la caché en **cada** cambio de stock (ya existe `catalogoCache.invalidarEmpresa`; se llama desde el POS) |
| R23 | Rediseño rompe pantallas o el **tour guiado** | Menú que no responde, tour sin anclas | Cambiar solo el shell; revisar las ~25 pantallas con un barrido automatizado (carga sin errores de consola por rol) y capturas; actualizar `tour.ejs` junto con el menú |
| R24 | Móvil | Menú inutilizable | Cajón deslizable, tablas con scroll horizontal, pruebas a 375 px (el POS en tablet es caso de uso real) |
| R25 | Foto de perfil prometida | Expectativa que la API no cumple | Avatar con iniciales + foto manual opcional; se avisa de entrada |
| R26 | Tiempo real sin websockets | Chat que no se actualiza | SSE con reconexión y polling de respaldo; el envío de mensajes ya existe |
| R27 | Zona horaria y "hoy" | Ventas del día cortadas a las 8 pm | Una función única de "día de negocio" con `zonaHoraria` de la empresa (ya existe en el modelo de citas); SQL crudo con `AT TIME ZONE` (bug real de la barbería, Fase 5) |
| R28 | Datos fiscales | Exigencia legal de factura | Fuera de alcance: solo "recibo / nota de venta" con aviso en pantalla; si el cliente requiere factura electrónica se integra con un proveedor aparte |

Seguridad heredada de la auditoría (lista de verificación para cada fase): cabeceras de seguridad, límites de subida (25 MB), secretos largos en producción, manejo global de promesas rechazadas, 401 JSON en la API, contraseñas ≥ 8, **sin credenciales de ejemplo conocidas**, `npm audit` limpio.

---

## 9. Fases, orden y cómo se protege cada una

Orden recomendado (cada fase termina verde y se puede detener ahí):

| Fase | Contenido | Riesgo | Esfuerzo orientativo | Se considera "hecha" cuando… |
|---|---|---|---|---|
| **F0** | Aprobar decisiones (§10); línea base (828 tests, evals); `scripts/demo-panel.js` (tenant demo local) | Nulo | 0,5–1 d | Línea base registrada y demo cargable |
| **F1** | **Shell nuevo**: panel lateral, hub, plegable, móvil, contadores; tour actualizado | Bajo (solo presentación) | 2–3 d | Las ~25 pantallas cargan sin errores de consola por cada rol; capturas aprobadas |
| **F2** | **Conversaciones CRM**: lista + chat + ficha, no leídas reales, SSE, filtros, búsqueda | Medio | 4–6 d | Un cliente escribe y se ve en vivo; tomar/devolver al bot sigue funcionando; pruebas de filtrado por rol/empresa |
| **F3** | **Módulos y planes**: `planes.modulos`, `requireModulo`, hub con candados, admin de planes, backfill "congelado de derechos", página `/planes` | Medio | 3–4 d | Prueba que recorre todas las rutas × planes × roles; ningún cliente actual pierde acceso |
| **F4** | **Stock unificado**: descuento atómico, `movimientos_stock` (kardex), `CHECK`, `costo`, `codigo_barras`; el bot y el panel ya lo usan | **Alto (toca el dinero y el stock)** | 3–4 d | Pruebas de concurrencia (50 ventas simultáneas del último producto → solo 1 pasa); suite y evals sin regresión |
| **F5** | **POS P1**: caja, venta, pagos, recibo, historial, anular | Alto | 6–8 d | Prueba de punta a punta: abrir caja → vender → cobrar → recibo → cerrar con diferencia 0 |
| **F6** | **POS P2**: devoluciones, fiado, cobrar pedidos del bot, clientes | Alto | 5–7 d | Invariantes de caja/stock/saldos con pruebas por cada flujo |
| **F7** | **Panel comercial**: resumen, canal, embudo, utilidad, reportes, auditoría | Medio | 4–6 d | Cifras del panel coinciden con la suma de ventas/pedidos de la base (prueba cruzada) |
| **F8** | **Bot de citas** + cobrar cita | Medio | 6–9 d | Evals de citas en verde con la meta de tokens; 0 llamadas en el menú |

Total orientativo: **34–48 días de trabajo efectivo** (con ayuda de IA; no son compromisos). F1–F3 ya dan un producto con planes por módulos y un panel renovado; F4–F6 dan el POS vendible.

Cómo se evita romper cosas en **todas** las fases:
1. **Rama por fase**, un commit por paso, suite completa (`npm test`) verde antes de cada commit; evals antes/después en lo que toque al bot.
2. **Interruptores por empresa/módulo**: nada se activa a clientes actuales hasta decidirlo.
3. **Migraciones aditivas** y probadas sobre la base de pruebas (`npm run test:preparar`).
4. **Pruebas de concurrencia** y de aislamiento entre empresas por cada flujo con dinero o stock.
5. **Barrido de acceso** (rol × módulo × ruta) automático en cada fase, como el `smoke.cjs` de la barbería.
6. Verificación en el navegador con el tenant demo antes de pedir tu aprobación visual.
7. Despliegue en pasos: primero F1–F3 (sin dinero), luego F4 (stock) con revisión, y recién después el POS.

---

## 10. Decisiones que necesito del jefe / del dueño del producto

- **P1.** ¿Los 4 planes actuales se reemplazan por los 3 planes de módulos, o se combinan módulos × niveles de volumen? (recomendado: 3 planes + paquetes de conversaciones)
- **P2.** ¿La prueba gratuita incluye **todos** los módulos por unos días? (recomendado: sí, para vender el upgrade)
- **P3.** Clientes actuales: ¿se les **congela** lo que ya ven (Reportes, Inteligencia) o se migran a un plan nuevo con aviso? (recomendado: congelar)
- **P4.** ¿Cuántos locales/sucursales debe soportar el POS al inicio? (recomendado: **uno**, como la barbería; sucursales después)
- **P5.** Hardware: ¿impresora térmica de 80 mm y lector de códigos de barras desde el día 1? (afecta pruebas y diseño de recibo)
- **P6.** ¿Facturación fiscal (factura/NIT)? (recomendado: fuera de alcance; solo recibo)
- **P7.** Métodos de pago del mostrador: efectivo, QR, tarjeta, transferencia, ¿crédito/fiado desde P1 o P2? (recomendado: fiado en P2)
- **P8.** ¿Orden de las fases como está en §9, o se adelanta el bot de citas?
