# Pendientes y gaps conocidos

Basado en una revisión formal contra el documento "Instrucciones definitivas para el desarrollo del Agente de Ventas" del dueño del negocio, actualizada con todo lo resuelto en `docs/03-decisiones-recientes.md`. El objetivo de este archivo es que otra sesión de IA sepa, sin adivinar, qué ya está bien y qué falta.

## ✅ Resuelto

- Bot se presenta de verdad en el primer mensaje (no un saludo genérico) — punto 1 + bug del default corregido.
- No interrogatorio (preguntas de a una, conversacional) — prompt.
- Memoria persistente estructurada del lead (categoría, presupuesto, marca, talla, color, dirección, forma de pago, atributos de categoría) — `ClienteFinal`.
- Estados de intención comercial (`EstadoConversacion`) con los mismos nombres que pedía el documento.
- El presupuesto nunca reemplaza la categoría; nunca cambia de categoría por su cuenta.
- Consulta el backend antes de decir "no tenemos".
- **Género como filtro real** — ya NO es un caso especial hardcodeado: es un atributo configurable más, vía el sistema de Categorías (ver decisión #5).
- **Atributos obligatorios/opcionales por categoría** — motor de reglas real (`Categoria`/`CategoriaAtributo`), con auto-detección desde los datos existentes.
- Producto ≠ variante, con fotos propias por variante/color; el bot manda la foto del color correcto.
- No inventa información; precio y moneda vienen siempre del backend.
- Se enfoca en el producto favorito una vez elegido; lleva la conversación hacia el cierre.
- Revalida stock/precio/variante justo antes de crear el pedido.
- Logs estructurados por etapa (`logEtapa`), similar a lo que pedía el documento.
- **Formas de pago configurables por tienda + QR estático** (decisión de alcance explícita: no pasarela de pago real, un humano cierra el cobro).
- **Nunca oculta inventario real por prolijidad** — se sacó el tope de 3 productos.
- **Nunca manda la foto de un producto no relacionado** — validación de ID contra la conversación real.
- **No describe productos con precio como texto plano** — detectado y corregido en código si el modelo lo intenta.
- Tallas con los mismos colores ya no se repiten línea por línea.

## 🟡 Decisión tomada distinta a la recomendación literal del documento

- El documento pedía mostrar 3 + "¿querés ver más?" con paginación (`offset`/`limit`). Se decidió explícitamente (con el dueño) **mostrar todas las opciones reales que apliquen** en vez de eso. Es una decisión de producto, no un olvido — documentado acá para que no se "corrija" de vuelta sin querer.

## 🔴 Todavía sin resolver

- **Avisar cuando una foto es de otro color o no hay foto del color exacto pedido.** Hoy `fotoParaMostrar` cae silenciosamente a la foto genérica del producto si el color pedido no tiene foto propia — no le aclara al cliente que esa foto podría no ser exactamente ese color (punto 22-23 del documento original).
- **Confirmación de envío (TOOL_SUCCESS) para fotos de producto en general.** Ya se aplica ese principio para el QR de pago (nunca dice "te mandé el QR" sin confirmar el envío real), pero `mostrar_productos`/`enviar_fotos_producto` todavía no verifican el resultado real de `wa.enviarImagenes` antes de que el texto de respuesta asuma que salió bien.
- **Recojo en tienda + ubicación fija del negocio.** No existe `tipo_entrega` (domicilio vs. recojo) ni una ubicación configurada por tienda para ese caso.
- **Facturación (NIT, razón social).** No hay ningún campo de facturación en `Pedido`.
- **Orden de fallback específico al buscar alternativas** (misma categoría+talla+marca+color → mismo con otro color → otra marca similar → fuera de presupuesto) y **preguntar explícitamente antes de ampliar la búsqueda** ("no encontré X, tengo estos similares, ¿los muestro?"). Hoy el relajado de filtros existe pero no sigue ese orden exacto ni pregunta antes de mostrar alternativas relajadas.
- **Suite de tests específica de 12 casos** que pedía el documento — hay 60 tests reales cubriendo buena parte de esto, pero no están armados como esos 12 casos puntuales uno por uno.

## Cómo usar este archivo

Si el próximo pedido es "segui con lo del documento del jefe" o similar, este archivo dice exactamente por dónde seguir sin tener que releer el PDF completo ni redescubrir qué ya se hizo.
