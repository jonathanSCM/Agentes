# Plan de mejoras: flujo de venta y ahorro de tokens

Fecha: 2026-11-03. Datos: lectura de solo lectura de producción (`usos_ia`, `mensajes`, `pedidos`) y medición del prompt en el código. La muestra es chica (12 conversaciones con IA, 125 mensajes de clientes, 181 llamadas, 12 pedidos), así que los números orientan pero no son definitivos.

## 1. Dónde está el gasto hoy

| Dato medido | Valor |
|---|---|
| Tokens de entrada por llamada | ~7.400 (casi todos iguales: es el prompt fijo) |
| Tokens de salida por llamada | ~26 (despreciable) |
| Llamadas por mensaje del cliente | 1,45 |
| Tokens de entrada por mensaje | ~10.700 |
| Prompt fijo (sistema) | 16.400 caracteres ≈ 4.100 tokens |
| Definición de las 14 herramientas | ≈ 3.000 tokens |
| Parte variable (catálogo, lead, carrito) | ≈ 2.000 caracteres ≈ 500 tokens |
| Reintentos forzados (histórico, mayormente gpt-4o) | 110 de 231 llamadas (48 %) |
| Caché de OpenAI: gpt-4o / mini / luna | 62–79 % / 23 % / 55–71 % |

Conclusión: el costo es **casi todo prompt repetido**. La salida no cuenta. Reducir el prompt y las llamadas extra es la palanca.

Perspectiva de costo real (hay que decírsela al CEO): con `gpt-6-luna` a US$0,10 por millón de entrada, un mensaje cuesta ≈ US$0,001. Con 10.000 mensajes al mes son ≈ US$11. Ahorrar el 50 % son ≈ US$5. El ahorro de tokens pesa mucho solo si se vuelve a un modelo caro (gpt-4o cuesta ≈ 20 veces más por llamada) o si el volumen crece 100 veces. **Para el negocio, hoy rinde más mejorar el flujo (conversión) que ahorrar tokens.** Ambas listas van abajo.

## 2. Ahorro de tokens (ordenado por retorno / esfuerzo)

| # | Idea | Ahorro estimado | Esfuerzo | Riesgo |
|---|---|---|---|---|
| T1 | **Adelgazar el prompt fijo.** Hoy es un bloque de 15.400 caracteres con reglas que el código ya hace cumplir (anti-invento, detectores). Quitar lo redundante y dejar lo esencial. Meta: 8.000 caracteres. | −1.000 a −2.000 tokens por llamada (−15 a −25 %) | Medio | Medio: hay que correr los tests de regresión y el piloto, porque el modelo puede portarse distinto |
| T2 | **Herramientas según el estado.** Mientras explora el catálogo no hace falta ofrecer `confirmar_pedido`, `cambiar_cantidad_carrito`, etc. y en el cierre no hacen falta las de búsqueda. Además acortar las descripciones. | −1.000 a −1.500 tokens por llamada (−15 a −20 %) | Medio | Bajo si el estado es correcto; cuidar que el modelo no se quede sin la herramienta que necesita |
| T3 | **Menos segundas llamadas.** Hoy 1,45 por mensaje. Después de `agregar_al_carrito`, `mostrar_*` y envíos, armar la respuesta final con plantilla (ya se hace en parte) y no volver a llamar al modelo. Revisar de nuevo los reintentos con los arreglos recientes (la cifra de 48 % es histórica). | Llamadas por mensaje de 1,45 → ~1,15 (−20 %) | Medio | Bajo |
| T4 | **Caché estable.** Verificar que el prefijo (sistema + herramientas) sea idéntico byte a byte entre llamadas y que lo variable vaya al final. mini cachea solo 23 %, lo que indica un prefijo que cambia. Confirmar con OpenAI si Luna cobra menos por entrada en caché (hoy se asume el mismo precio, US$0,10). | Hasta −50 % del costo de entrada si Luna lo descuenta; si no, 0 | Bajo | Bajo |
| T5 | **Historial más corto.** Se mandan los últimos 20 mensajes. Resumir lo viejo en el "lead" y mandar 8–10. Recortar los resultados de herramientas que el modelo ya no necesita. | −300 a −800 tokens en charlas largas (casi nada en las cortas actuales) | Bajo | Bajo |
| T6 | **Más turnos sin IA** (ver F1 y F2 abajo): cada mensaje resuelto por el flujo ahorra 100 % de sus tokens. | Depende de la cobertura; hoy el flujo está activo solo en Rox y Tienda Demo | Medio | Bajo |

**Efecto combinado de T1 + T2 + T3 + T5** (estimación): de ≈ 10.700 a ≈ 5.000 tokens por mensaje (−50 %). Es una estimación sin medir; se confirma con la misma consulta a `usos_ia` antes y después.

## 3. Mejoras de flujo (ventas)

| # | Idea | Qué logra | Esfuerzo |
|---|---|---|---|
| F1 | **Preguntas frecuentes sin IA.** Horario, dirección, envíos, formas de pago, tiempos: responder con texto de la configuración del negocio. Hoy cada una cuesta una llamada de 7.000 tokens. | Respuesta instantánea y tokens en cero | Bajo |
| F2 | **Activar el flujo de botones en todos los agentes** (hoy solo Rox y Tienda Demo) y llevar las frases nuevas (cantidad, cancelar, reiniciar) también a los agentes sin flag. | Menos errores como los de la conversación #145 | Bajo, depende del piloto |
| F3 | **Recordatorio de carrito abandonado.** El carrito dura 24 horas y el cliente tiene la ventana de 24 h abierta: un mensaje a las 2–3 h con botones "Finalizar" / "Seguir viendo" no requiere plantilla paga. | Conversión: recupera pedidos que hoy se pierden | Medio |
| F4 | **Aviso de pedido nuevo al dueño** por WhatsApp o correo, con botón para tomar la conversación (traspaso a humano). | El negocio no depende de mirar el panel | Medio |
| F5 | **Comprobante de pago por estados.** Hoy la imagen del comprobante pasa por visión (cuesta más). Guiar con botones "Ya pagué" y pedir la foto solo en ese paso. | Menos costo de visión y menos confusiones | Medio |
| F6 | **Cliente recurrente.** "¿Repetimos tu último pedido?" con botones; ya se guardan nombre, dirección y pedidos previos. | Pedidos más rápidos, mayor recompra | Bajo |
| F7 | **Botones rápidos tras cada tarjeta de producto**: "Me lo llevo", "Ver otro", "Más fotos". | Menos escritura, menos malentendidos | Bajo |
| F8 | **Lista de espera por talla/producto agotado**: "Avísame cuando llegue", con aviso automático al reponer (dentro de la ventana o con plantilla aprobada). | Ventas que hoy se pierden por stock | Medio |
| F9 | **Tablero de embudo para el CEO**: conversaciones → carrito → pedido, costo por pedido, % de turnos sin IA, reintentos, abandono por paso. | Decisiones con datos; hoy hay que consultar la base a mano | Medio |

## 4. Orden recomendado

**Sprint 1 (1–2 semanas) — medir y ganar rápido**
1. F9 versión mínima (consulta fija + página en `/admin`) para tener la línea base.
2. T4 (verificar caché) y T3 (revisar reintentos con los arreglos nuevos).
3. F1 (preguntas frecuentes) y F7 (botones tras la tarjeta).
4. Cerrar el piloto con WhatsApp real de lo ya hecho (cta_url, aviso por web, frases nuevas).

**Sprint 2 (2–3 semanas) — adelgazar**
5. T1 y T2 con tests de regresión; activar primero en Rox y comparar contra la línea base.
6. F2 (activar el flujo en el resto de agentes) si el piloto sale bien.

**Sprint 3 — vender más**
7. F3 (carrito abandonado), F4 (aviso al dueño), F6 (recompra).
8. F5 y F8 según lo que muestre el tablero.

## 5. Cómo medimos el éxito

- Tokens de entrada por mensaje: de ≈ 10.700 a ≤ 6.000.
- Llamadas por mensaje: de 1,45 a ≤ 1,2.
- Porcentaje de mensajes resueltos sin IA: medir hoy y subir.
- Pedidos por conversación y abandono del carrito: no deben empeorar con T1/T2 (es la condición para seguir).
- Rollback de T1/T2: un flag por agente, igual que el flujo determinista.

## 6. Decisiones pendientes

La resiliencia ante caídas de la IA (que el bot siga vendiendo sin ella) está en [08-plan-resiliencia-sin-ia.md](08-plan-resiliencia-sin-ia.md) y va **antes** que casi todo lo de este documento.

1. ¿Priorizamos conversión (F3, F4, F6, F8) o ahorro (T1, T2)? Con Luna el ahorro absoluto es pequeño.
2. ¿Se mantiene Luna como modelo por defecto? Falta el precio oficial de entrada en caché.
3. ¿Quién da el visto bueno del piloto con clientes reales y en qué agente?
4. Seguridad pendiente: cambiar la contraseña de la base de producción y restringir la IP, rotar la clave del panel y `SESSION_SECRET`.
