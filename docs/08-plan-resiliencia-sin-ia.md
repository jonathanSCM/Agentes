# Plan: que el bot siga vendiendo aunque la IA falle o se quede sin tokens

Fecha: 2026-11-03. Complementa el [plan de flujo y tokens](07-plan-mejoras-flujo-y-tokens.md).

> **Estado (3-nov-2026):** aplicado lo decidido por el dueño: R1–R4, R5 (panel `/admin/estado-ia`), R10–R13, R15, R16 (topes), R17 parcial (reglas sin IA para preguntas frecuentes), R21, R22–R24 parcial (tests y simulación; falta el monitor externo). **Sin segundo proveedor (R6–R7) por decisión del dueño.** R14 solo en versión mínima (se anota el texto pendiente y se avisa al negocio; no se responde retroactivamente). Detalle en `docs/03-decisiones-recientes.md` #37.

## 1. Qué pasa hoy si la IA falla (revisado en el código)

| Situación | Comportamiento actual | Problema |
|---|---|---|
| Límite de velocidad (429) | Reintenta una vez con el modelo barato del mismo proveedor (`agente.js` ~3772) | Si el 429 es por **saldo agotado** (`insufficient_quota`), el modelo barato también falla |
| Caída, error 5xx o saldo agotado | Responde "No pude consultar la disponibilidad en este momento…" y termina (`respuestaErrorTecnico`) | El cliente pierde su mensaje, no se reintenta, y la frase habla de disponibilidad aunque preguntara otra cosa |
| Dos proveedores configurados | Usa OpenAI si hay clave; Anthropic solo si **no** hay clave de OpenAI (`proveedorActivo`) | No hay conmutación automática: tener las dos claves no protege |
| IA lenta o colgada | No hay timeout propio (el del SDK es largo) | Un cuelgue deja al cliente sin respuesta y ocupa el candado del cliente |
| Alerta al dueño o al admin | No hay | Nos enteramos cuando alguien se queja |
| Flujo de botones (agentes con flag) | Funciona sin IA para categorías, carrito, cierre y pedido | Cubre bien la compra guiada; no cubre texto libre ni búsqueda |
| Agentes sin flag | Todo pasa por la IA | Caída total |

Resumen: el sistema ya resuelve sin IA el recorrido de compra (con el flag), pero **cualquier texto libre depende al 100 % de la IA**, y no hay red de seguridad entre proveedores ni aviso.

## 2. Qué dice la investigación (resumen, fuentes mayormente blogs de proveedores)

- **Híbrido: reglas primero, IA solo cuando la regla no sabe.** Es el patrón que repiten los artículos sobre WhatsApp y comercio: precios, stock y selección salen de un motor determinista que consulta el catálogo, y el modelo solo conversa. Es la arquitectura que ya sigue Proshop.
- **Cada tipo de falla pide su propio camino**, no un mensaje genérico de "te paso con alguien".
- **Las fallas de un LLM pueden verse "sanas"** (responde, pero mal). Hace falta validar el contenido, no solo los errores HTTP. Proshop ya lo hace con los detectores.
- **Conmutación entre proveedores con "cortacircuitos".** Patrón común en pasarelas (LiteLLM, Cloudflare AI Gateway, etc.): si un proveedor da 429 o 5xx varias veces en pocos minutos, se "abre el circuito" y todo el tráfico va al siguiente proveedor durante un tiempo de enfriamiento. Los ejemplos de umbrales (3 errores en 5 minutos) son configuraciones de ejemplo, no estándares.
- Una fuente cita disponibilidad real de OpenAI de ~99,3 % frente al 99,9 % anunciado. No pude verificarla; tómala como orden de magnitud: unas 5 horas de caída al mes.
- No encontré ninguna fuente buena con una receta concreta para "cola de respuestas en WhatsApp durante una caída". Eso hay que diseñarlo.

Fuentes: [Robylon: LLM y bots de WhatsApp](https://www.robylon.ai/blog/llm-whatsapp-bot), [Rework: flujos de respaldo de agentes](https://resources.rework.com/guides/chat-funnel-setup/ai-agent-fallback-flows), [Towards AI: fallas en un pipeline de WhatsApp](https://pub.towardsai.net/intent-classification-isnt-enough-failure-modes-in-a-whatsapp-llm-pipeline-that-had-to-ask-before-2131e1df13ef), [DEV: motor determinista para tiendas](https://dev.to/michaelfabien/why-shopify-stores-need-a-deterministic-engine-not-an-llm-chatbot-50l8), [CometAPI: estrategias de respaldo de modelos](https://www.cometapi.com/id/how-to-build-robust-llm-model-fallback-strategies/), [DEV: pasarelas con failover](https://dev.to/volkov24/10-best-ai-gateways-with-automatic-provider-failover-3fn5), [Designing Resilient LLM Gateways](https://tkmxai.it.com/designing-resilient-llm-gateways), [DEV: LiteLLM](https://dev.to/deneesh_narayanasamy/litellm-proxy-the-open-source-alternative-for-multi-provider-llm-failover-and-load-balancing-54fn).

## 3. Lluvia de ideas, con veredicto

Escala de esfuerzo: B = horas, M = días, A = semanas.

### Capa 1 — Que la falla no sea silenciosa ni borre el mensaje

| # | Idea | Esfuerzo | Veredicto |
|---|---|---|---|
| R1 | **Timeout propio de 20–25 s** por llamada y 1 reintento corto con espera. | B | Aplicar ya |
| R2 | **Clasificar el error**: saldo agotado, límite de velocidad, caída (5xx), tiempo agotado, clave inválida. Cada uno con su camino. El modelo barato solo sirve para límite de velocidad. | B | Aplicar ya |
| R3 | **Alerta inmediata al admin** (WhatsApp o correo) cuando hay saldo agotado, clave inválida o más de N errores en pocos minutos; máximo un aviso cada 30 min. | B–M | Aplicar ya |
| R4 | **Mensaje de error honesto y genérico**: "Tuve un problema técnico, ya te respondo" (sin hablar de disponibilidad), con botones "Ver categorías" y "Hablar con un asesor". | B | Aplicar ya |
| R5 | **Panel de estado de la IA** en `/admin` (último error, proveedor activo, circuito abierto o cerrado, saldo restante si el proveedor lo permite). | M | Aplicar en la fase 2 |

### Capa 2 — Segundo proveedor automático

| # | Idea | Esfuerzo | Veredicto |
|---|---|---|---|
| R6 | **Failover OpenAI ↔ Anthropic** dentro de `agente.js` (ya existen ambos clientes y el formato interno de mensajes es común). Se prueba el segundo proveedor cuando el primero da saldo agotado, 5xx o timeout. | M | Aplicar. Requiere tener saldo cargado en el segundo proveedor |
| R7 | **Cortacircuitos en memoria**: tras 3 fallas en 5 minutos, el proveedor queda "abierto" 2–5 min y se va directo al siguiente, sin hacer esperar al cliente. | M | Aplicar junto con R6 |
| R8 | **Usar una pasarela externa (LiteLLM u otra).** | A | **No por ahora.** Agrega otro servicio que mantener y también puede caerse; el failover propio son pocas líneas |
| R9 | **Modelo local pequeño** como último recurso. | A | **No.** Exige servidor con GPU o memoria; la calidad en español para ventas no compensa. Se revisa si algún día hace falta |

### Capa 3 — Que el negocio funcione sin IA (modo degradado)

| # | Idea | Esfuerzo | Veredicto |
|---|---|---|---|
| R10 | **Modo degradado por reglas**: si todos los proveedores están caídos, el flujo determinista toma el control con menú de categorías, búsqueda por palabras, carrito, cierre y pedido. Mensaje al inicio: "Ahora atiendo con menú; escribe 'asesor' si prefieres una persona". | M | Aplicar. Es la pieza que da el "100 %" |
| R11 | **Activar el flujo determinista en todos los agentes** (hoy solo Rox y Tienda Demo), porque R10 depende de él. | B | Aplicar tras el piloto |
| R12 | **Búsqueda sin IA por palabras clave** sobre nombre, categoría, color y talla (ya existe `buscarConFallback` y un buscador por embeddings): "zapatillas negras 42" → resultados con tarjeta, sin modelo. | M | Aplicar. Sirve también para ahorrar tokens |
| R13 | **Preguntas frecuentes por reglas** (horario, envíos, pagos, ubicación) desde la configuración del negocio. | B | Aplicar. Ahorra tokens también |
| R14 | **Cola de mensajes pendientes**: si la IA no puede responder un texto libre, guardarlo; al volver, responder o avisar al asesor ("te escribió mientras había un problema"). Con tope de 24 h por la ventana de WhatsApp. | M | Aplicar tras R10 |
| R15 | **Traspaso a humano visible**: el cliente escribe "asesor" o el bot lo ofrece; el dueño recibe aviso y responde desde el panel. | M | Aplicar |
| R16 | **Presupuesto y tope de gasto por empresa** con aviso al 80 % y paso a modo degradado al 100 %, para que una empresa no agote la cuenta de todas. | M | Aplicar. Protege el saldo compartido |

### Capa 4 — Depender menos de la IA en el día a día (ahorra tokens)

| # | Idea | Esfuerzo | Veredicto |
|---|---|---|---|
| R17 | **Clasificador de intención con reglas y palabras** antes de llamar al modelo (saludo, gracias, precio de X, ¿tienen X?, estado del pedido). Solo lo ambiguo va a la IA. Patrón "regla primero, IA si hay baja confianza". | M | Aplicar de forma gradual |
| R18 | **Caché de respuestas** para preguntas idénticas por empresa (con versión del catálogo para invalidar). | M | Aplicar solo a preguntas sin datos del cliente |
| R19 | **Agrupar lo que escribe el cliente en ráfagas** (ya existe el debounce de 5 s). | — | Ya hecho |
| R20 | **Pedir al modelo solo lo que no sabe el código**: que no genere listas ni tarjetas, solo frases cortas. | — | Ya es el principio del proyecto |
| R21 | **Cada nueva función nace "determinista primero"**: documentarlo en CLAUDE.md como regla del proyecto. | B | Aplicar |

### Capa 5 — Pruebas y operación

| # | Idea | Esfuerzo | Veredicto |
|---|---|---|---|
| R22 | **Prueba de caos**: una variable (`SIMULAR_CAIDA_IA=429|500|timeout`) para recorrer en local y en piloto todos los caminos de falla. | B | Aplicar. Sin esto no podemos asegurar el 100 % |
| R23 | **Tests automáticos** de cada camino: saldo agotado, 5xx, timeout, ambos proveedores caídos, recuperación. La IA falsa ya se inyecta (`llamarInyectado`). | M | Aplicar |
| R24 | **Monitor externo gratuito** (UptimeRobot o similar) sobre `/salud` y alerta si el bot no responde. | B | Aplicar |
| R25 | **Respaldo de la base** diario y prueba de restauración. | B–M | Verificar que exista; no es parte de la IA, pero también es "todo al 100" |

## 4. Orden propuesto

**Fase 1 (2–3 días) — Que nada falle en silencio.** R1, R2, R3, R4, R22, R23 (los tests de estos). Resultado: cada falla se detecta, se clasifica, avisa al admin y le da al cliente una salida útil.

**Fase 2 (1 semana) — Segundo proveedor.** R6, R7, R5, R24. Resultado: si OpenAI cae o se queda sin saldo, Anthropic atiende sin que el cliente note nada.

**Fase 3 (1–2 semanas) — Modo sin IA.** R10, R11, R12, R13, R15, R14. Resultado: aun con ambos proveedores caídos, el cliente puede ver el catálogo, armar el carrito y cerrar el pedido.

**Fase 4 — Menos dependencia y menos gasto.** R16, R17, R18, y las ideas de tokens del plan 07 (adelgazar el prompt, herramientas por estado).

## 5. Qué es "100 %" y cómo lo comprobamos

- Con la IA caída (simulada), un cliente completa **una compra de punta a punta** y el dueño recibe el pedido.
- Con saldo agotado en un proveedor, el cliente no nota la diferencia (failover) y el admin recibe alerta en menos de 1 minuto.
- Ningún mensaje del cliente se pierde sin respuesta o sin quedar en cola para un asesor.
- Todos estos caminos tienen test automático y una prueba manual de caos antes del piloto.
- Límite honesto: el texto libre complejo ("¿me sirve para correr 10 km si tengo pie plano?") **sí** necesita IA; en modo degradado se ofrece el menú o un asesor. Nada se inventa.

## 6. Qué necesitamos de ti

1. Cargar saldo en el **segundo proveedor** (hoy solo OpenAI está en uso) y dejar ambas claves en Coolify.
2. A qué contacto avisar de las alertas (WhatsApp del admin o correo).
3. Confirmar el piloto del flujo de botones, porque el modo degradado se apoya en él.
