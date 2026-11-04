# Plan: la IA no escribe, solo elige (mensajes prefabricados con datos añadibles)

Fecha: 4-nov-2026. Estado: **plan aprobado. M0 terminado (ver `docs/03-decisiones-recientes.md` #40).** Siguen la fase 2 del plan 09 y después M1/M2.
Pedido del dueño: que la IA **no escriba texto libre**. Que elija entre mensajes prefabricados guardados en la base de datos, cada uno con una descripción de lo que dice y con datos que se completan, **igual que las plantillas de WhatsApp**. Todo lo que pueda resolver el backend, lo resuelve el backend. Así la IA gasta menos tokens y no puede inventar ni decir cosas raras.

## 1. Por qué esto es lo correcto (con los números de hoy)

La IA hoy tiene dos trabajos: **(1)** decidir qué hacer (llamar herramientas: agregar al carrito, mostrar productos...) y **(2)** escribir lo que se le dice al cliente. El trabajo 2 es el que causa casi todos los problemas y gastos:

| Dato (medido en el código y en los evals) | Valor |
|---|---|
| Prompt fijo que le dice **cómo escribir** (reglas de tono, formato, "no inventes", "una pregunta por mensaje"...) | 16.400 caracteres ≈ 4.100 tokens, en **cada** llamada |
| Detectores que revisan si la IA escribió algo mal (`afirmaQueMostroAlgoSinTarjeta`, `mencionaModeloInventado`, `pareceInterrogatorio`...) | 16 |
| Correcciones forzadas ("RECORDATORIO DEL SISTEMA: reescribí tu respuesta") que disparan **llamadas extra** | 16 |
| Herramientas que **le dictan** qué escribir ("Tu texto ahora: UNA línea corta y natural...") | 8 |
| Turnos de texto libre en los evals | **3 llamadas y 19–21 mil tokens cada uno** (el máximo de vueltas) |
| Reintentos forzados en producción (histórico, gpt-4o) | 48 % de las llamadas |

Si la IA no escribe, **nada de eso hace falta**: no hay texto que revisar, no hay reintentos por texto malo y el prompt deja de explicar cómo escribir. El texto sale de mensajes que el negocio ya revisó, con precios, nombres y stock que pone el backend.

Estimación (a confirmar con los evals): de ~7.400 tokens y 1,45 a 3 llamadas por mensaje, a ~3.000–4.000 tokens y ~1 llamada. Es decir, **alrededor de un 60 % menos de tokens por mensaje**, y respuestas que siempre dicen lo que el negocio escribió.

## 2. Cómo funciona

### 2.1 El catálogo de mensajes
Cada mensaje es como una plantilla de WhatsApp:

```
clave:        agregado_al_carrito
categoria:    Carrito
descripcion:  "Confirma que un producto quedó en el carrito y pregunta si quiere ver algo más."   ← esto lo lee la IA
texto:        "¡Listo! Agregué {{producto}} ({{variante}}) a tu carrito 🛒 Llevás {{cantidad_total}} · {{total}}. ¿Querés ver algo más?"
variables:    producto (producto), variante (texto, del sistema), cantidad_total (número), total (monto)
botones:      Seguir comprando · Finalizar · Ver carrito
variantes:    2–4 redacciones por tono (cordial, amigable, formal, divertido), para que no suene siempre igual
```

**Quién completa cada variable** (la IA nunca escribe palabras):

| Tipo de variable | Quién la pone | Ejemplo |
|---|---|---|
| `del sistema` | el backend, siempre | precio, total, stock, nombre del producto, horario, dirección |
| `elegida por la IA` (identificador o número) | la IA **elige** de una lista cerrada que le da el backend | `producto` ∈ los 3 productos mostrados; `categoria`; `cantidad`; `atributo` ∈ los del producto |
| `del cliente` | el backend la extrae del mensaje del cliente y la valida | nombre, ubicación |
| `dato del negocio` | el negocio la cargó en el panel | garantía, costo de envío, política de cambios |

Una variable **jamás** es un texto libre escrito por la IA. Es lo que garantiza que no hay nada para inventar.

### 2.2 Los "datos añadibles" del negocio
Una tabla de datos con nombre que el negocio carga en el panel y que cualquier mensaje puede usar con `{{dato.garantia}}`:
garantía, costo y tiempos de envío que **sí** cumple, política de cambios, formas de pago, dirección, horario, links propios (con lista blanca para el revisor de salida).
Las **preguntas frecuentes de la fase 1 pasan a ser mensajes**: la pregunta (con sus sinónimos) como descripción y la respuesta como texto. La IA elige la FAQ correcta por significado (mucho mejor que la coincidencia por palabras de hoy).

### 2.3 El turno de la IA
1. El backend prepara el turno como hoy (extrae filtros, resuelve referencias, fija la categoría...).
2. Resuelve todo lo determinista sin llamar a la IA (como ya hace: botones, carrito, cierre, FAQ, guardia).
3. Si queda algo que requiere entender lenguaje, **una sola llamada**: la IA recibe un estado corto (cliente, carrito, candidatos) y el **catálogo reducido** de mensajes que tienen sentido en ese estado (por ejemplo, en el cierre solo los de cierre y los de información; ~20 mensajes, no los 60).
4. La IA responde con **formato fijo** (salida estructurada): las acciones que quiere ejecutar y el `mensaje` elegido con sus variables elegidas. El texto libre que devuelva se **descarta**.
5. El backend ejecuta las acciones, valida todo (la clave existe y está permitida en ese estado, los ids son de la lista, las variables obligatorias están) y **renderiza** el mensaje.
6. Si una acción tiene un resultado conocido (agregó, no hay stock, falta la talla), el mensaje lo decide **el backend**, sin esperar a la IA (hoy ya pasa en parte con `respuesta_por_plantilla`). Por eso la IA casi nunca necesita una segunda llamada.
7. Si la IA no encuentra ningún mensaje que calce: usa `no_entendi` (menú + opción de asesor) y el caso queda anotado.

### 2.4 Qué pasa con las preguntas "abiertas"
- **Dato de un producto** ("¿es impermeable?", "¿de qué material es?"): mensaje `dato_de_producto` con `producto` y `atributo` elegidos; el texto sale de los datos reales del producto. Si el dato no existe: `dato_no_disponible` + ofrece un asesor (hoy ya es la regla, pero dependía de que la IA la obedezca).
- **Recomendaciones** ("algo para correr"): el backend busca y puntúa; el mensaje usa `{{destaca}}` calculado por el backend ("cumple: talla 42, color negro").
- **Empatía y cortesías** ("¡buena elección!"): frases cortas prefabricadas, elegibles de una lista cerrada (`apertura` ∈ felicitar, agradecer, disculparse...).
- **Fuera de alcance**: ya lo resuelve la guardia (fase 1); sin IA.

La contrapartida, dicha con claridad: **la IA ya no puede improvisar**. Lo que el catálogo de mensajes no cubre, no se contesta bien. Por eso el plan incluye el panel de cobertura (sección 4) y empezar en un solo agente.

## 3. Modelo de datos

Los mensajes **de fábrica viven en el código** (versionados, mejoran con cada despliegue). La base guarda lo que el negocio cambia o agrega.

- **`MensajeAgente`**: `empresaId`, `clave`, `categoria`, `descripcion`, `variantes` (JSON: tono → textos), `variables` (JSON: nombre, tipo, obligatoria), `botones` (JSON), `activo`, `origen` (`PERSONALIZADO` = cambió uno de fábrica · `PROPIO` = lo creó el negocio), `version`. Único por `(empresaId, clave)`.
- **`DatoNegocio`**: `empresaId`, `clave`, `etiqueta`, `valor`, `visible`.
- **`AgenteConfig.registro`**: `vos` | `tu` | `usted` (hoy los textos fijos usan "vos": "Querés", "Tocá"; el negocio elige cómo habla su agente) y `AgenteConfig.mensajesPrefabricados` (interruptor por agente, para el despliegue gradual).
- Cada respuesta del bot guarda la `clave` usada (en `Mensaje.meta`): sirve para medir cobertura y para los evals.

Resolución de un mensaje: **negocio (si lo personalizó o creó) → fábrica**; luego la variante por tono/registro, sin repetir la última usada en esa conversación.

## 4. Panel (para quien no es técnico)

- **"Mensajes del agente"**: lista por categoría (Bienvenida, Catálogo, Carrito, Cierre, Pagos, Información, Avisos). Cada mensaje muestra **qué dice y cuándo se usa**, se edita con las variables como "chips" que se insertan, y tiene **vista previa con datos de ejemplo**, activar/desactivar y **"Restaurar el original"**. El negocio puede **crear mensajes propios** (hasta 40), con descripción obligatoria (es lo que lee la IA para elegirlos).
- **"Datos de mi negocio"**: la tabla de datos añadibles. Reemplaza y amplía la pestaña "Preguntas y horario" de la fase 1.
- **"Lo que el agente no supo contestar"**: lista de mensajes de clientes donde se usó `no_entendi`, con un botón **"Crear una respuesta"** (convierte la pregunta en un mensaje propio). Es el circuito de mejora: cada hueco que aparece se tapa una vez y no vuelve a costar.
- Misma tecnología que ya usaremos para los **mensajes proactivos y las plantillas de Meta** (fase 5): un mensaje marcado "para WhatsApp" se puede enviar a Meta para aprobación desde el panel (la "plantilla opcional" que pediste). Un solo catálogo, dos usos.

## 5. Fases

| # | Qué entrega | Tiempo estimado |
|---|---|---|
| **M0** | **Base del sistema de mensajes.** Tablas, catálogo de fábrica (~55 mensajes para Productos, con variantes de tono), motor que elige la variante y renderiza con validación estricta, tests de "galería" (cada mensaje se renderiza sin variables sueltas ni textos largos). Todos los textos fijos de hoy (flujo de botones, modo sin IA, guardia, pendientes, reglas, revisor) pasan a salir de acá. **La IA todavía no cambia.** | ~1 semana |
| **M1** | **La IA elige.** Herramienta final `responder(mensaje, variables)` con formato fijo y catálogo reducido por estado, detrás de un interruptor por agente. Los resultados de las herramientas pasan de "instrucciones largas" a **datos compactos**. El backend decide el mensaje cuando el resultado es conocido. Evals antes/después (tokens, llamadas, calidad). | ~1,5–2 semanas |
| **M2** | **Panel**: "Mensajes del agente", "Datos de mi negocio", "Lo que el agente no supo contestar", elección de registro (vos/tú/usted). Las preguntas frecuentes de la fase 1 se migran. | ~1 semana |
| **M3** | **Limpieza**, cuando los agentes ya corren con M1: se borran el prompt de "cómo escribir", los 16 detectores, las 16 correcciones forzadas y los 8 dictados de texto. Menos código, menos riesgos. | ~3–4 días |
| *(en otras fases)* | El bot de **Citas** (fase 3) nace con mensajes prefabricados; los **proactivos y plantillas de Meta** (fase 5) usan el mismo catálogo. | — |

**Esto reemplaza la fase 6 del plan 09** (motor estructurado medido): hace lo mismo con una idea más fuerte (la IA no escribe).

Total aproximado: **4–5 semanas** de trabajo de una persona.

## 6. Orden recomendado

1. **M0** primero (1 semana): es la base, no cambia lo que ve el cliente y deja listo el catálogo con el **vocabulario de Citas** (`{{vocab.cita}}` = cita / turno / reserva / visita) que necesita la fase 2.
2. **Fase 2** (modelo de negocio configurable, base de Citas, topes por plan).
3. **M1 y M2** (la IA elige + panel), antes de construir el bot de Citas.
4. **Fase 3** (bot de Citas) ya con mensajes prefabricados desde el primer día.
5. M3 (limpieza), fase 4 en adelante.

Alternativa: hacer la fase 2 antes que M0. Se puede (la fase 2 es datos, motor de agenda y pantallas de configuración, sin mensajes del bot), pero después habría que reabrir los textos de vocabulario.

## 7. Cómo se mide que funciona

- **Evals nuevos:** cada mensaje que sale lleva su `clave`; el eval **falla si algún mensaje no viene del catálogo** (en agentes con el interruptor) y mide **tokens y llamadas por turno**. Meta: los turnos de texto libre bajan de ~20.000 a ≤ 4.000 tokens, y de 3 a ~1 llamada.
- **Cobertura:** % de mensajes de clientes que terminan en `no_entendi`. Meta antes de generalizar: menos del 5 % en el piloto.
- **Conversión:** pedidos por conversación y abandono no deben empeorar contra el motor actual (se compara en el mismo agente).
- **Rollback:** el interruptor por agente vuelve al motor actual sin tocar código.

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Suena robótico | 2–4 variantes por mensaje y por tono, sin repetir la última; el negocio edita los textos con su estilo |
| Hay preguntas sin mensaje que las cubra | `no_entendi` + asesor; panel de cobertura que convierte cada hueco en un mensaje nuevo; empezar en un solo agente |
| La IA elige mal el mensaje | catálogo reducido por estado (pocas opciones, descripciones claras), validación de variables contra listas cerradas, evals con k repeticiones; ante duda, el backend usa un mensaje seguro |
| Migrar los textos fijos rompe el piloto | M0 no cambia comportamiento: los tests actuales (712) deben seguir en verde, con los mismos textos en el catálogo |
| Los textos del negocio traen links o promesas raras | el revisor de la fase 1 sigue activo sobre el texto final; los links propios entran a la lista blanca |
| Alcance | cada fase se entrega sola; M0 no depende de nada |

## 9. Decisiones (respondidas el 4-nov-2026)

1. **Registro de habla:** se mantiene "vos" en los agentes existentes (el campo `registro` queda en `vos` por defecto; el negocio podrá elegir "tú" en M2).
2. **Mensajes propios:** sí, con tope de 30 o el que defina el plan (`planes.maxMensajesPropios`).
3. **Tema que la IA no conoce:** pasa con un asesor (mensaje `no_entendi_derivar`), anotando el caso.
4. **Orden:** M0 → fase 2 → M1/M2 → fase 3.

### Preguntas originales


1. **Registro de habla por defecto**: hoy los textos usan "vos" ("Querés", "Tocá"). ¿Se queda el vos para los agentes que ya existen y los nuevos eligen (vos / tú / usted)? Propongo eso.
2. **¿Los negocios pueden crear mensajes propios**, o solo editar los de fábrica? Propongo ambos, con tope de 40 propios.
3. **Cuando la IA no encuentra mensaje**: ¿menú + opción de asesor y anotar el hueco (propuesto), o pasar directo a una persona?
4. **Orden**: ¿M0 → fase 2 → M1/M2 → fase 3 (recomendado), o fase 2 primero?
