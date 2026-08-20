# Propuesta: que el agente "aprenda" de clientes y catálogo

Documento de análisis, no un plan aprobado todavía. Responde a la pregunta: en vez de entrenar una red neuronal propia (no práctico — ver `docs/00`/conversación, ya usamos redes neuronales gigantes ya entrenadas vía API de OpenAI/Anthropic), ¿qué opciones reales y baratas logran el objetivo de que el bot se sienta cada vez más inteligente con cada cliente y cada catálogo?

## Por qué NO entrenar un modelo propio

Una red neuronal entrenada desde cero necesita muchísimos más datos de los que un negocio (o incluso todos los negocios de Proshop juntos) genera en años de conversaciones. Además hay que armar infraestructura de entrenamiento, versionado de modelos, y el resultado, con datos tan chicos, rendiría peor que GPT-4o-mini/Claude ya entrenados con billones de ejemplos. Las opciones de abajo usan la IA que ya tenemos (vía API) de forma más inteligente, no reemplazan al modelo.

---

## Opción A — Memoria de clientes más profunda (personalización real)

### Qué ya existe hoy
`ClienteFinal` ya guarda, por (empresa, teléfono): `categoriaInteres`/`categoriaId`, `marca`, `talla`, `color`, `presupuesto`, `atributosLead` (Género, Uso, etc. por categoría), `productoFavoritoId`, `productosMostrados`/`productosDescartados`, `estadoConversacion`. Esto ya es una forma de "aprendizaje" ligero: el bot no repite preguntas ya respondidas **dentro de la misma conversación/ventana de 24h**.

### La brecha real
Esa memoria vive por conversación — cuando el cliente vuelve semanas después, `productosMostrados`/`productosDescartados`/`contexto` se resetean (a propósito, ver comentario en `lib/services/conversaciones.js`), y la relación `ClienteFinal.pedidos` (que ya existe en el schema) **nunca se consulta** para nada. O sea: el bot no sabe si este cliente ya compró antes, qué compró, ni cuándo.

### Qué se podría construir
1. **"Ya nos compraste antes"**: al iniciar conversación con un cliente que tiene `Pedido`s previos, inyectar en el prompt un resumen corto (últimas 1-3 compras, categorías que le interesaron) para que el bot pueda decir con naturalidad "la última vez te llevaste X, ¿querés ver algo parecido o reponerlo?" — dato real de la base, no inventado.
2. **Preferencia acumulada, no solo de la sesión actual**: hoy `marca`/`color`/`talla` se pisan con lo último que dijo el cliente. Se podría guardar un pequeño historial (ej. `Json` con las últimas 5 categorías/marcas de interés con fecha) para que, si vuelve después de mucho tiempo, el bot tenga contexto de qué tipo de cliente es sin tener que volver a preguntar todo de cero.
3. **Segmentación simple para el dueño del negocio**: con los mismos datos, un reporte de "clientes frecuentes", "en riesgo de abandono" (no escribe hace X días), "alto valor" (suma de `Pedido.total`) — esto es SQL/agregación pura, no requiere IA.

### Esfuerzo y riesgo
Bajo-medio. Todo con datos que YA están en la base (`Pedido`, `PedidoItem`, `ClienteFinal`) — no hace falta ningún servicio externo nuevo ni costo adicional de IA. El riesgo principal es de diseño: decidir qué tan atrás mirar y cómo resumirlo sin inflar demasiado el prompt (cuesta más tokens = más caro por conversación).

---

## Opción B — Búsqueda semántica del catálogo (embeddings)

### El problema concreto que resuelve
Hoy la búsqueda de productos (`buscarProductosFiltrados`, `coincideTexto`, `palabrasClave` en `lib/services/agente.js`) es **matching literal de palabras** — compara si las palabras clave del pedido del cliente aparecen (o son substring) de las palabras del producto. Esto falla con sinónimos ("polera" vs "remera" vs "playera"), errores de tipeo, o formas indirectas de pedir algo ("algo para hacer ejercicio" no matchea con "Ropa Deportiva" si no comparten ninguna palabra literal).

### Qué es un embedding (explicación corta)
Un embedding es un vector de números que representa el *significado* de un texto — dos frases con sentido parecido (aunque usen palabras distintas) generan vectores cercanos entre sí. Se genera con una llamada barata a la API (ej. `text-embedding-3-small` de OpenAI, fracciones de centavo por producto). Comparando el embedding de lo que pidió el cliente contra el embedding de cada producto (similitud coseno), se puede rankear por parecido semántico real, no por coincidencia de palabras.

### Cómo se implementaría en este proyecto
1. Extensión `pgvector` en Postgres (soportada por la mayoría de hosts, incluido lo que ya usamos) + una columna `embedding vector(1536)` en `Producto` (y quizás `Categoria`).
2. Al crear/editar un producto, generar su embedding (texto = nombre + descripción + atributos + características) y guardarlo. Para los 150 productos existentes, un script batch una sola vez.
3. En `buscarProductosFiltrados`/`productosCandidatosAMostrar`: en vez de (o además de) el matching por texto actual, calcular el embedding del mensaje del cliente y ordenar por similitud contra los embeddings de productos ya filtrados por categoría/stock/presupuesto (los filtros duros de negocio se mantienen igual — el embedding solo mejora el *ranking* dentro de lo que ya es válido, nunca reemplaza las reglas de negocio existentes).

### Esfuerzo y riesgo
Medio. Es la opción con más partes nuevas (extensión de Postgres, migración, script de generación batch, mantener embeddings actualizados cuando se edita un producto). El costo de la API de embeddings es bajo, pero es costo nuevo recurrente (aunque marginal). El riesgo mayor es de calidad: hay que probar bien que el ranking semántico mejore resultados reales y no introduzca falsos positivos raros (ej. que "buscar algo para regalar a mi hermana" recomiende algo totalmente fuera de lugar por parecido vectorial engañoso) — por eso se recomienda combinarlo con los filtros duros existentes, nunca dejarlo solo.

---

## Opción C (bonus) — "También te puede interesar" sin IA (el quick win más barato)

No es lo que preguntaste directamente, pero vale mencionarlo porque logra parte del mismo objetivo con el menor esfuerzo de las tres: mirar `PedidoItem` para detectar qué productos se compran juntos seguido (co-ocurrencia simple, una query SQL de agregación) y que el bot pueda sugerir "clientes que compraron esto también llevaron X" — cero costo de IA, cero infraestructura nueva, se arma en un par de horas.

---

## Comparación rápida

| Opción | Resuelve | Esfuerzo | Costo recurrente | Requiere infraestructura nueva |
|---|---|---|---|---|
| A — Memoria más profunda | Personalización entre visitas | Bajo-medio | Ninguno (más tokens de prompt, marginal) | No |
| B — Embeddings/búsqueda semántica | Encontrar productos aunque el cliente no use las palabras exactas | Medio | Bajo (API de embeddings) | Sí (pgvector) |
| C — Co-compra simple | Sugerencias tipo "también te puede interesar" | Muy bajo | Ninguno | No |

## Recomendación

Empezar por **A** (usa datos que ya tenemos, cero costo nuevo, impacto directo en que el bot se sienta "más inteligente" con clientes que repiten) y **C** como acompañamiento rápido. Dejar **B** para después — es la mejora de más impacto en la calidad de búsqueda, pero también la más grande de construir bien; tiene más sentido una vez que haya más productos/catálogos donde el matching literal empiece a quedarse corto de verdad.
