# Auditoría técnica de Proshop frente a las "Directrices técnicas para agentes IA y monitoreo de costos"

**Alcance:** este proyecto (Proshop: agente de ventas por WhatsApp, multi-tenant). **Stack real:** Node.js + Express + EJS + PostgreSQL/Prisma (no Laravel/MySQL como supone el PDF). **Fecha:** nov 2026. Es la **Etapa 1 (auditoría)** del PDF: no propone reconstruir nada, solo mide qué hay y qué falta. Todo lo afirmado sale del código; lo que no se pudo comprobar está marcado.

Leyenda: ✅ implementado · 🟡 parcial · ❌ no implementado · ➖ no aplica

## 1. Matriz de capacidades (sección 2 del PDF)

| # | Componente | Estado | Evidencia en Proshop | Brecha |
|---|---|---|---|---|
| 2.1 | System prompt estructurado y versionado | 🟡 | El prompt se arma en un solo lugar (`agente.js › construirSystem / partesDelSystem`), separando lo permanente de lo variable (catálogo, memoria, carrito). Los textos que ve el cliente salen de un catálogo (`mensajesBase.js`). | No hay **versión** del prompt ni se registra con qué versión respondió cada conversación. Los cambios no pasan por una puerta de publicación. |
| 2.2 | RAG | 🟡 / ➖ | Búsqueda semántica del catálogo (`embeddings.js`, vectores como `Float[]`, coseno en JS) solo como red de seguridad del matching literal. Lo transaccional (precio, stock, pedidos) sale **siempre** del backend, nunca del modelo: cumple la regla de oro del PDF. Conocimiento de negocio = texto/FAQ configurable por agente. | No hay recuperación documental (políticas, manuales) ni registro de la fuente/versión usada. Para el volumen actual **no se justifica una base vectorial** (el PDF tampoco la exige). |
| 2.3 | Tool calling controlado | ✅ | Herramientas con contrato de entrada/salida y respuesta `TOOL_SUCCESS`/`TOOL_FAILED`; el backend valida, descuenta stock de forma atómica y condicionada, e idempotencia en pedidos, cobros, compras y cuentas. "La IA solicita, el backend decide" es el principio del proyecto. | Las llamadas a herramientas **no se persisten** (solo `console.log`): no hay historial consultable de qué herramienta se invocó en cada turno. |
| 2.4 | Seguridad y control de acceso | ✅ | Multi-tenant por `empresaId` en toda consulta; roles (dueño, admin, colaborador, cajero, profesional) con confinamiento **en el servidor**; límites de usuarios por rol por plan; credenciales cifradas (`APP_ENCRYPTION_KEY`); el modelo nunca toca la base directamente. | Sin OAuth para integraciones (Meta se conecta con tokens y, pronto, Embedded Signup). Sin permisos granulares más allá de los roles. |
| 2.5 | Guardrails / prompt injection | ✅ | `guardia.js`: filtro de **entrada** (intentos de cambiar reglas o sacar instrucciones, pedidos ajenos al negocio; sin gastar tokens) y de **salida** (no filtra instrucciones ni nombres de herramientas, ni código, ni links ajenos, ni montos inexistentes). Mensajes del cliente tratados como no confiables. | Los intentos de manipulación quedan en el log del servidor, no en una tabla de eventos de seguridad consultable. |
| 2.6 | Optimización de modelos y costos | 🟡 | Mucho **sin IA** por diseño (flujo determinista, menús, modo sin IA, citas, recordatorios: 0 tokens). Modelo configurable por plan (`modeloIa`); caché del proveedor registrada (`cachedTokens`); topes: llamadas por cliente/hora y tokens/día por empresa (`topeIA.js`); cortacircuitos de salud (`saludIA.js`). | No hay **enrutamiento por complejidad** (un modelo por plan para todo); no hay caché de respuestas; el tope por empresa es una variable de entorno **global**, no un presupuesto configurable por cliente. |
| 2.7 | Observabilidad y auditoría | 🟡 | `auditoria` persistente de acciones humanas (ventas, caja, stock, equipo, planes, pedidos, WhatsApp). Logs de etapa del agente (`logEtapa`) en consola. Mensajes y uso por conversación en la base. | Los logs del agente **no se guardan** (consola); no hay registro persistente de latencia, versión de prompt, herramientas, errores por turno ni documentos recuperados. Para reconstruir un caso hay que ir al log de Coolify. |
| 2.8 | Evaluaciones automatizadas | ✅ / 🟡 | `npm run eval` (`scripts/eval/`): conversaciones guion con la IA real o sin IA, repetición `--k`, escenarios de seguridad (`--tipo seguridad`), juez opcional, informe en `data/evals/` **con tokens y costo estimado**. 1.220 tests automáticos (DB real) para la lógica de negocio. | No corre solo antes de publicar (manual); no hay comparación automática antes/después de consumo al cambiar prompt o modelo; faltan casos con conversaciones reales anonimizadas en cantidad. |
| 2.9 | Monitoreo financiero de IA | 🟡 | Ver sección 2. |

## 2. Control de costos de IA (2.9): diagnóstico

Respuestas a lo que pide la auditoría del PDF:

| Pregunta | Respuesta |
|---|---|
| **¿Cómo se registra hoy el consumo?** | Tabla `usos_ia`: una fila por **llamada al modelo de chat** con `empresaId`, `conversacionId` (sin FK), `proveedor`, `modelo`, `proposito` (respuesta / reintento_forzado), `vuelta`, `promptTokens`, `cachedTokens`, `completionTokens`, fecha. |
| **¿Hay costos por cliente o proyecto?** | **Por cliente (empresa): sí.** Por proyecto: no aplica hoy (Proshop es un solo producto). Por agente: no se guarda el agente en la fila (se deduce por la empresa; hoy hay un agente por empresa). |
| **¿Se pueden relacionar solicitudes con conversaciones?** | **Sí**: `conversacionId`. Y las conversaciones con pedidos (`pedidos.conversacionId`) y con el estado del lead (`estadoLead`): **el costo por pedido y por lead es calculable**, pero hoy ninguna pantalla lo calcula. |
| **¿Qué alertas o límites existen?** | Límite de llamadas por cliente por hora y de tokens por día por empresa (global, por entorno), con caída elegante a "modo sin IA". Alertas inmediatas al admin si la IA falla o se queda sin saldo (ntfy/Telegram/webhook). **No hay** presupuesto por cliente ni umbrales 50/80/100 % ni detección de anomalías. |
| **¿Los costos coinciden con los del proveedor?** | **No se pudo comprobar** y no hay proceso de conciliación. El costo es una **estimación** calculada al mostrar (`costoIA.js`) con tarifas escritas en el código; para `gpt-6-luna` el costo cacheado es un techo declarado en el propio archivo. |
| **¿Qué falta para calcular rentabilidad?** | (a) el costo guardado/versionado, (b) servicios facturables hoy **no medidos**: transcripción de audio, análisis de imágenes y embeddings no entran en `usos_ia`, (c) cruzar con ingresos del plan (mensualidad) por empresa, (d) costo por pedido y por lead calificado (datos disponibles, falta la vista). |

**Cobertura frente a la tabla A del PDF (registro por solicitud):** Cliente ✅ · Proyecto ➖ · Agente 🟡 · Conversación ✅ · Proveedor ✅ · Modelo ✅ · Tokens de entrada/salida/caché ✅ · **Costo estimado ❌ (no se guarda)** · Fecha ✅ · **Estado (completada/fallida) ❌** · **ID de la solicitud en el proveedor ❌**. Además no se guarda la **latencia** y las llamadas **fallidas o sin consumo informado no dejan fila** (el PDF pide registrarlas sin inventar importe).

**B. Cálculo:** tarifas en una constante del código (no en tabla versionada); falta el histórico de tarifas para que un costo viejo no cambie al actualizar precios.
**C. Dashboard** (`/admin/costo-ia`, solo superadmin): costo por día (7 días), por empresa (30 días), % de reintentos. Faltan: gasto del día/mes, por modelo, por agente, costo por conversación/pedido, evolución mensual, filtros por fecha/cliente/modelo y **exportación**.
**D. Presupuestos y alertas:** no existen (solo topes de entorno). **E. Anomalías:** no hay detección (sí se mide el porcentaje de reintentos forzados). **F. Rentabilidad:** no hay reportes.

## 3. Brechas priorizadas y riesgos

Orden sugerido por el PDF (seguridad → medición → trazabilidad → dashboard → pruebas → optimización), ajustado a lo que ya está hecho:

1. **Medición completa por solicitud** (la brecha más barata y la que habilita todo lo demás).
2. **Trazabilidad persistente** de cada turno (herramientas, errores, latencia, versión de prompt).
3. **Presupuestos y alertas por cliente** (50/80/100 %) con política configurable (seguir en modo sin IA, que ya existe).
4. **Dashboard de costos y rentabilidad** (costo por conversación, pedido y lead; margen contra la mensualidad del plan; exportar).
5. **Evals en la rutina de publicación** y comparación de costo antes/después.
6. **Versionado de prompts.**
7. **Enrutamiento de modelos** y caché, una vez que la medición diga dónde está el gasto.

**Riesgos hoy:** (1) un cliente puede consumir mucho sin que nadie lo vea hasta fin de mes: no hay presupuesto ni alerta; (2) audio, imágenes y embeddings gastan y **no se miden**, así que el costo real es mayor al que muestra el panel; (3) tarifas en código: un cambio de precios del proveedor reescribe la historia; (4) investigar un error depende de logs de consola que se rotan; (5) estimación sin conciliar con la factura.

## 4. Propuesta de implementación (backlog con estimaciones)

Estimaciones en días de desarrollo con pruebas, para una persona. Todo compatible con el stack actual (sin base vectorial, sin MCP, sin plataforma nueva).

| Historia | Criterios de aceptación | Dependencias | Estim. |
|---|---|---|---|
| **A. Registro completo por solicitud** | `usos_ia` guarda: agente, costo estimado (USD) con la tarifa vigente, estado (completada/fallida/cancelada), ID de solicitud del proveedor, latencia y tarifa usada; las fallidas dejan fila sin inventar importe; tests. | Migración aditiva | 2 |
| **B. Tabla de tarifas versionada** | `tarifas_ia` (proveedor, modelo, entrada, salida, caché, vigente desde/hasta); el costo usa la tarifa vigente **a la fecha de la solicitud**; pantalla del superadmin para cargarlas; sale del código. | A | 1,5 |
| **C. Medir servicios adicionales** | Audio, imágenes y embeddings registran su consumo (tipo de servicio, unidades, costo). | A, B | 1,5 |
| **D. Trazabilidad de turnos** | Tabla de eventos del agente (turno, herramienta, resultado, error, versión de prompt, latencia); retención configurable; visible en el panel del superadmin por conversación. | A | 3 |
| **E. Presupuestos y alertas** | Presupuesto mensual en USD por cliente (configurable por plan y por cliente); avisos al 50/80/100 % (seguimiento / alerta / crítica) al dueño y al admin; al 100 % política configurada (modo sin IA, ya existente); contempla solicitudes simultáneas; tests de concurrencia. | A, B | 3 |
| **F. Detección de consumos anormales** | Evento cuando el gasto/tokens del día de un cliente supera N veces su promedio, hay conversaciones excesivamente largas, bucles de herramientas o reintentos altos; lista de eventos investigable. | A, D | 2 |
| **G. Dashboard de costos y rentabilidad** | Gasto del día y del mes, por cliente/agente/modelo, evolución diaria y mensual, consumo vs presupuesto, **costo por conversación, por pedido y por lead calificado**, margen contra la mensualidad; filtros y exportación a Excel. | A, B, E | 4 |
| **H. Conciliación** | Carga mensual del reporte del proveedor (CSV) y comparación con lo estimado, con diferencia por modelo. | A, B | 1,5 |
| **I. Versionado de prompts** | Cada cambio de prompt tiene versión; cada turno guarda la versión usada; `npm run eval` obligatorio y con comparación de costo antes/después antes de publicar un cambio. | D | 2,5 |
| **J. Enrutamiento por complejidad (opcional)** | Solo si G muestra que lo justifica: modelo más económico para turnos simples; evals de calidad que lo respalden. | G, I | 3 |

**Total A–I: ≈ 21 días**; A+B+C+E (lo que más reduce el riesgo económico) ≈ 8 días.

## 5. Cumplimiento de los criterios obligatorios para nuevos agentes (sección 6)

1 qué responde ✅ (catálogo, pedidos, citas; guardia) · 2 fuentes ✅ (base de datos del negocio) · 3 operaciones ✅ (herramientas) · 4 permisos ✅ · 5 acciones con confirmación ✅ (resumen y botón Confirmar antes de crear pedido) · 6 datos sensibles ✅ (cifrado, aislamiento por empresa) · 7 errores y operaciones 🟡 · 8 calidad ✅ (evals) · 9 costo por solicitud 🟡 · 10 presupuesto y alertas ❌ · 11 pruebas previas ✅ (tests + evals manuales) · 12 costos por operación y cliente ❌.

## 6. Lo que NO se pudo verificar

- La conciliación con la factura real de OpenAI/Anthropic (no hay acceso ni proceso).
- Si las tarifas del código siguen vigentes (son las de la fecha en que se escribieron).
- El costo real de audio, imágenes y embeddings (no se miden).
