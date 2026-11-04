# Plan: modelo de negocio configurable (productos / citas) y mejoras tomadas de AgendaBot

Fecha: 4-nov-2026. Estado: **plan aprobado el 4-nov-2026 (con las decisiones de la sección 6). Fase 0 en curso.**
Origen: revisión de `D:\Trabajo\Habitad Mejorado\Bots-whatsapp\AgendaBot` (README, COEXISTENCIA.md, agente, motor/intérprete/redactora, guardia, evals, recordatorios, mensajería, motor de agenda, esquema SQL, panel React y sus estilos). No se leyó `.env`, `whatsappWeb.js` ni los tests.

## 0. Decisiones del dueño (ya tomadas)

1. Se aplica **todo** lo propuesto, **excepto el armado de flujo por bloques** (editor de flujo): no se hace.
2. El **modelo de negocio es configurable** por empresa: **Productos** (queda exactamente igual que hoy) o **Citas**.
3. El modelo **Citas** sigue la lógica de AgendaBot, pero con **listas y botones reales** de WhatsApp (no menús numerados).
4. Se copian los **estilos** del panel de AgendaBot (componentes y apariencia, adaptados a EJS).
5. Sin segundo proveedor de IA y sin WhatsApp Web/Baileys (decisiones anteriores y riesgo de baneo).

## 1. Qué cambia y qué NO cambia

| | Modelo **Productos** | Modelo **Citas** |
|---|---|---|
| Qué se atiende | catálogo, carrito, pedidos | servicios, profesionales/recursos, horarios, citas |
| Bot | el actual (flujo de botones + IA + modo sin IA) | máquina de estados con listas y botones; IA opcional |
| Menú del panel | Vender / Mi catálogo / Mi agente / Resultados | Agenda / Conversaciones / Contactos / Pipeline / Servicios / Equipo de atención / Mi agente |
| Cobro del plan | conversaciones (igual) | conversaciones (igual) |
| Riesgo para lo que ya funciona | **ninguno**: todo detrás de `modeloNegocio = PRODUCTOS` (default) | módulo nuevo y aislado |

Una empresa tiene **un** modelo. Un modelo "mixto" (vende y agenda) queda fuera de este plan, pero las tablas se diseñan para permitirlo después (por ejemplo, "probarte el producto en tienda").

## 2. Lo que se toma de AgendaBot, y lo que se descarta

**Se toma:** motor de agenda (disponibilidad, capacidad, buffers, bloqueos, feriados); intérprete en dos capas (código primero, IA con formato fijo después); redactora con revisor anti-invento y plantilla de respaldo; guardia de entrada y salida sin IA; evals con guion; mensajes pendientes recuperables; recordatorios con textos que varían, horario de silencio y topes; FAQ y horario de atención; referencias a lo mostrado ("la más barata"); CRM (pipeline por etapas, notas, resumen IA, sugerencia de respuesta); coexistencia con la app WhatsApp Business; estilos del panel.

**Se descarta:** editor de flujo por bloques y sus plantillas; menús numerados (Proshop ya tiene listas y botones reales); WhatsApp Web/Baileys; el panel React (Proshop sigue en EJS).

Dato útil: los reportes de evals de AgendaBot sin IA aprueban 9 de 13 escenarios (5 de 5 de seguridad). Los 4 que fallan son los que necesitan entender texto libre. Eso es exactamente lo que la IA aporta y lo que el resto del sistema ya cubre sin ella.

## 3. Modelo de datos nuevo (migraciones manuales, una por fase)

Todo con `empresaId` (multi-tenant), siguiendo el proceso de migraciones de CLAUDE.md.

**Fase 2 (base):**
- `Empresa.modeloNegocio` (`PRODUCTOS` | `CITAS`, default `PRODUCTOS`), `Empresa.zonaHoraria` (default `America/La_Paz`), `Empresa.pais` (para feriados), `Empresa.rubro` (clínica, salón, restaurante, inmobiliaria, otro: solo vocabulario y datos de arranque), vocabulario (`cita`/`turno`/`reserva`/`visita`).
- `Servicio` (nombre, descripción, duración, buffer, precio, usa personas, máx. personas, color, orden, activo).
- `Recurso` (persona o recurso físico: nombre, especialidad, capacidad, color, activo) y `RecursoServicio` (qué atiende cada uno).
- `HorarioAtencion` (recurso o general, día, inicio, fin; varios tramos por día) y `BloqueoAgenda` (vacaciones, almuerzos, feriados).
- `Cita` (cliente, servicio, recurso, inicio, fin, buffer, personas, carga, estado `pendiente|confirmada|completada|no_show|cancelada`, origen, notas, recordatorios enviados).
- Índices por `(empresaId, inicio)` y restricción de no solapamiento controlada en transacción (ver riesgos).

**Fase 1 (ambos modelos):** `Mensaje.meta` (JSON: `hasta`, `fallo`, tarjeta, etc.), `AgenteConfig.faq` (JSON), `AgenteConfig.horarioAtencion` (JSON), `AgenteConfig.conocimiento` (texto).

**Fase 4 (CRM):** `NotaCliente` (texto, categoría, fijada, para asistente), etapa del pipeline en `ClienteFinal`, `ActividadCliente` (línea de tiempo).

## 4. Fases

Estimaciones en semanas de trabajo de una persona; son rangos, no promesas. Cada fase termina con tests en verde, verificación en el navegador cuando haya pantalla, y commit en su propia rama.

### Fase 0 — Cimientos (3–5 días)
- **Evals de Proshop** (`npm run eval`): escenarios con guion, `--k N` (aprueba solo si pasa N veces), `--sin-ia`, `--juez`, informe en `data/evals/`, base aislada. Primero para **productos** (los casos del piloto: conversación #145, cantidad, cancelar, "algo para mi novia", reintentos) y de **seguridad** (pedir el prompt, manipular, links ajenos, datos de otros clientes). Mide tokens y llamadas por escenario: esa es la línea base para todo lo demás.
- **Aislamiento de tests:** estudiar PGlite en memoria con Prisma; si no encaja, un esquema de Postgres por corrida. Meta: que los tests no ensucien ni dependan de la base local.
- `Mensaje.meta` y base de FAQ/horario en la configuración.

### Fase 1 — Robustez y ahorro para el modelo Productos (1 semana)
1. **Mensajes pendientes recuperables:** cada respuesta guarda hasta qué mensaje del cliente leyó; si la IA falla, el mensaje queda pendiente y se contesta con el botón "Que el bot responda" o solo cuando se cierra el circuito (si la ventana de 24 h sigue abierta).
2. **Guardia sin IA:** manipulación y pedidos ajenos al negocio se responden por código; la intención de manipular queda en la ficha del cliente. Auditoría de la respuesta: fuga de instrucciones, código, links no permitidos.
3. **Revisor anti-invento genérico** para la respuesta de la IA (montos que no están en catálogo/carrito/mensaje, "pedido creado" sin pedido), con plantilla de respaldo.
4. **FAQ y horario de atención** editables en el panel; el motor de reglas responde por coincidencia de palabras (0 tokens).
5. **Referencias a lo mostrado sin IA:** "la más barata", "la negra", "la de 650"; si hay empate, pregunta cuál.
Todo medido con los evals de la fase 0 (tokens antes y después).

### Fase 2 — Modelo de negocio configurable + base de Citas (1,5–2 semanas)
- Pantalla **"Mi negocio"** en Configuración (y paso inicial del registro): elegir Productos o Citas, rubro, vocabulario, zona horaria, país. Cambiar de modelo pide confirmación y no borra datos.
- Menú lateral y Primeros pasos **según el modelo**.
- Datos de arranque por rubro (servicios, equipo, horario de ejemplo) como punto de partida editable, tomados de `verticales/index.js`.
- Motor de agenda portado a Prisma (`lib/services/agenda.js`): horarios libres, verificación, crear/reprogramar/cancelar, capacidad y buffer, bloqueos, feriados, `luxon` para zonas horarias. Se portan sus tests de agenda y de paridad.
- Pantallas CRUD: Servicios, Equipo de atención (profesionales o recursos), Horarios y feriados.
- **Topes por plan:** `Plan.maxServicios` y `Plan.maxCitasMes` (migración + panel de administración de planes + tabla comparativa), con aviso al acercarse y bloqueo amable al pasarse.

### Fase 3 — Bot de Citas con listas y botones (2 semanas)
**Recorrido** (todo por plantillas; 0 llamadas a la IA cuando el cliente toca):
1. Menú inicial (botones): *Agendar* · *Mi cita* · *Ubicación y horarios*.
2. Servicio (lista) → profesional (lista, solo si hay varios y el negocio lo permite) → día (lista de los próximos días con cantidad de horarios libres) → hora (lista agrupada Mañana/Tarde, con "Ver más ▸") → personas (botones, solo restaurante) → nombre (texto, validado con el mismo criterio estricto del flujo de productos) → **resumen con botones Confirmar / Cambiar** → cita creada + ubicación de la tienda.
3. **Mi cita** (botones): Reprogramar · Cancelar (con confirmación) · Cómo llegar.
4. Derivar a una persona en cualquier momento ("asesor"), grupos fuera de rango, horario sin cupo (ofrece los siguientes).
5. Respetando límites de WhatsApp: listas de hasta 10 filas, 3 botones, títulos de hasta 24 caracteres.

**IA opcional** (`saludIA.proteger` + modo sin IA): intérprete con formato fijo para texto libre ("quiero cita mañana a la tarde con la doctora"): el código resuelve primero (números, fechas relativas, horas), la IA completa y el backend valida cada valor. Sin IA, el cliente sigue por listas y botones. Preguntas libres: FAQ por reglas, luego IA redactora con revisor y plantilla de respaldo.

**Recordatorios** (24 h y 2 h) y pedido de reseña: dentro de las 24 h con botones reales Confirmar / Reprogramar / Cancelar; fuera de la ventana con **plantilla aprobada** (ver sección 7). Las respuestas se resuelven por código con el ID del botón.

**Página pública de reservas** `/reservar/:slug` (EJS, sin login, con límite por IP), el mismo lugar para poner en Instagram o Google Maps. Confirmación por WhatsApp al reservar.

**Evals de citas:** reserva simple, cambio de día, sin cupo → siguiente día, reprogramar, cancelar, grupo grande → persona, dos clientes reservando el mismo horario a la vez, fuera de horario, feriado, manipulación, y **IA caída**: la reserva completa se hace sin IA.

### Fase 4 — Panel de Citas y estilos (1,5–2 semanas)
- **Agenda** semanal y diaria (rejilla de horas, carriles para citas que se pisan, línea de "ahora", arrastrar para reprogramar con aviso al cliente, clic en un hueco para crear). En JS sin framework.
- **Inicio** con indicadores de citas: hoy, próximas, agendadas por el bot, inasistencia, ingresos; agenda del día; citas por día; origen de las citas; banner de "conversaciones que esperan a una persona".
- **Contactos/Pipeline** (kanban por etapa), notas por cliente (con "para el asistente"), línea de tiempo, resumen IA y sugerencia de respuesta **a pedido** (con tope y protección de la IA). Se ofrece también al modelo Productos.
- **Estilos:** traer los componentes de AgendaBot (tarjetas, indicadores, pastillas de estado, banner de atención, listas de agenda, barras, columnas del pipeline, burbujas del chat) a `admin.css`, respetando el diseño ya existente. Ver decisión sobre el color de acento en la sección 6.

### Fase 5 — Mensajes proactivos y post-venta (1 semana)
- Un solo job (`jobs/proactivos.js`) con: textos que varían, horario de silencio (21:00 a 08:00), topes por hora y por día, y registro de lo ya enviado para no repetir.
- **Citas:** recordatorios y reseña.
- **Productos:** carrito abandonado (dentro de la ventana de 24 h, con botones), comprobante de pago pendiente, aviso de pedido en camino, reseña posterior a la entrega.
- Panel: activar/desactivar cada mensaje y ver cuántos se enviaron.
- **Plantillas opcionales:** al activar los recordatorios, una ventana explica qué son las plantillas y por qué hacen falta para avisar fuera de las 24 h, con ejemplos; la plantilla se crea y se envía a Meta desde el panel, y se muestra su estado. Sin plantilla, solo se avisa dentro de las 24 h.

### Fase 6 — Motor estructurado para Productos, medido (1 semana + medición)
Prototipo detrás de un interruptor por agente (`motorEstructurado`): intérprete con formato fijo → motor de reglas → redactora con revisor. Se compara con el motor actual con los evals de la fase 0 (tokens, llamadas, aprobación). **Solo se adopta si no empeora la calidad.** Aquí también se prueba el adelgazamiento del prompt fijo con A/B real.

### Fase 7 — Coexistencia y alta con Facebook (1–2 semanas + trámites con Meta)
Embedded Signup ("Conectar con Facebook") y coexistencia con la app WhatsApp Business: webhooks `smb_message_echoes` (el bot se pausa si el dueño responde desde el celular), `history` (importar historial sin responder), `smb_app_state_sync` (contactos), `account_update`. Plazo de 24 h para sincronizar el historial. Depende de requisitos del lado de Meta (sección 7).

## 5. Verificación y calidad

- Tests por módulo (unitarios con IA falsa, como hoy) + evals con guion + prueba en el navegador de cada pantalla (escritorio y móvil).
- Cada fase se deja detrás de `modeloNegocio` o de un interruptor: se activa en una empresa de prueba antes que en el resto.
- Resultado esperado de cada fase documentado en `docs/03-decisiones-recientes.md`, como se viene haciendo.

## 6. Decisiones tomadas (4-nov-2026)

1. **Color de acento: menta** (`#22e3a6`) para todo el panel (también el de Productos). Se aplica en la fase 4, verificando cada pantalla en el navegador, con los tokens de AgendaBot (superficie `#2d1747`, borde `#45296a`, texto `#f4f1fb`).
2. **Topes por plan para Citas:** además de las conversaciones, cada plan limita **servicios** y **citas por mes** (campos nuevos `Plan.maxServicios` y `Plan.maxCitasMes`, con aviso al acercarse al tope y bloqueo amable al pasarse; se agregan a la tabla comparativa de planes). Entra en la fase 2.
3. **Rubros de arranque: totalmente editables.** Los datos de ejemplo (servicios, equipo, horario) se cargan como registros comunes que el negocio puede cambiar, borrar o ignorar; nada queda fijo en código.
4. **Plantillas de WhatsApp opcionales.** Sin plantillas, los recordatorios se mandan solo dentro de la ventana de 24 h (cuando el cliente escribió hace poco); fuera de ella no se envían y queda registrado. Al **activar los recordatorios** aparece una ventana que explica: qué es una plantilla, por qué hace falta para avisar fuera de las 24 h, ejemplos de texto listos para usar y el estado de aprobación. **Si se puede crear desde la web, se crea desde la web:** como Tech Provider se envían a Meta desde el panel (`POST /{WABA_ID}/message_templates`, permiso `whatsapp_business_management`) y el panel muestra el estado (pendiente, aprobada, rechazada con el motivo) con el webhook `message_template_status_update`. Entra en la fase 5.
5. **Ya somos Tech Provider.** Falta solo crear la configuración de Embedded Signup (`META_APP_ID`, `META_ES_CONFIG_ID`) y confirmar el acceso avanzado a `whatsapp_business_management` y `whatsapp_business_messaging` en modo Live.
6. **Orden:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 (la fase 7 se puede adelantar si Meta ya está listo).
7. **Un modelo por empresa** (productos o citas); el modelo mixto queda para después.

## 7. Lo que necesito del lado de Meta y del negocio

- **Plantillas (opcionales):** recordatorio 24 h (con botones Confirmar / Reprogramar / Cancelar), recordatorio 2 h, pedido de reseña y, para productos, "tu carrito te espera". Los textos vienen redactados en el panel y se envían a Meta desde ahí; Meta las aprueba (suele tardar minutos u horas).
- Para la fase 7 (ya somos Tech Provider): confirmar el acceso avanzado en modo Live y crear la configuración de Embedded Signup (`META_APP_ID`, `META_ES_CONFIG_ID`). Los campos de webhook a suscribir están en `COEXISTENCIA.md` de AgendaBot.
- Un número de WhatsApp de prueba en la app WhatsApp Business para probar coexistencia.

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Doble reserva del mismo horario (dos clientes a la vez) | verificación y creación en una sola transacción con bloqueo; test de concurrencia |
| Zonas horarias y cambios de hora | `luxon`, hora local del negocio guardada en la empresa, tests de bordes |
| Tocar el bot de productos y romper el piloto | todo nuevo detrás de `modeloNegocio` e interruptores por agente; los 651 tests actuales deben seguir en verde |
| La IA del intérprete interpreta mal una fecha | el backend valida (fecha futura, dentro del máximo, hora válida) y el código manda sobre la IA |
| Fase 6 no mejora nada | se mide antes de adoptar; si no mejora, se descarta |
| Alcance grande | fases independientes, cada una entrega valor sola |

## 9. Fuera de este plan

Editor de flujo por bloques · WhatsApp Web/Baileys · segundo proveedor de IA · modelo mixto productos+citas · panel en React · menús numerados.
