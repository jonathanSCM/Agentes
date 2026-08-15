# Proshop — Agente de ventas por WhatsApp (SaaS multi-tenant)

Este archivo es el punto de entrada para cualquier IA (u otra sesión de Claude Code) que retome este proyecto. Da el contexto mínimo para orientarse rápido; el detalle completo está en `docs/`.

## Qué es esto, en una frase

Una plataforma **multi-tenant** donde varios negocios (empresas) configuran un **agente de ventas con IA que atiende por WhatsApp real**, con catálogo propio, categorías, variantes, pedidos, pagos y panel de administración — no es un chatbot genérico, es un motor de ventas que se apoya en datos reales de la base, nunca en lo que "recuerda" el modelo de lenguaje.

## Stack

- Node.js + Express + EJS (server-rendered, sin frontend framework)
- PostgreSQL + Prisma ORM (`lib/db.js`, driver adapter `@prisma/adapter-pg`)
- OpenAI / Anthropic como proveedor de IA (auto-detectado por variable de entorno, con modo demo sin claves)
- WhatsApp Business Cloud API (`lib/services/whatsapp.js`)
- Despliegue: Docker, `CMD ["sh", "-c", "npx prisma migrate deploy && npm run seed && npm start"]` — las migraciones se aplican solas en cada deploy, sin pasos manuales.

## Principio arquitectónico central (no romper esto)

> El backend decide y filtra. La IA solo conversa.

El modelo de lenguaje **nunca** decide qué productos existen, cuáles mostrar, ni inventa datos (precio, stock, disponibilidad, moneda, fotos). Todo eso lo calcula el código en `lib/services/agente.js` (`buscarProductosFiltrados`, `productosCandidatosAMostrar`, etc.) y se le entrega al modelo ya resuelto. Esto está reforzado con validaciones en código (no solo instrucciones de texto) — ver `docs/03-decisiones-recientes.md` para ejemplos de bugs reales que pasaron cuando esto no se cumplía.

## Documentación completa

- **`docs/01-modelo-de-datos.md`** — todos los modelos de Prisma, agrupados por dominio, y cómo se relacionan.
- **`docs/02-motor-del-agente.md`** — cómo funciona `lib/services/agente.js`: prompt, tools, memoria del lead, categorías con atributos, selección de fotos, anti-invención.
- **`docs/03-decisiones-recientes.md`** — bitácora punto por punto de los cambios más recientes: qué problema había, qué se decidió, por qué, y qué archivos tocó. Empezar por acá si el pedido es "segui donde quedamos".
- **`docs/04-pendientes-y-gaps.md`** — qué falta o quedó a medias, basado en una revisión formal contra un documento de instrucciones del dueño del negocio.

## Cosas que hay que saber SÍ o SÍ antes de tocar código

1. **Migraciones de Prisma son manuales en este entorno** (no se puede correr `prisma migrate dev` interactivo). El flujo: escribir `prisma/migrations/<timestamp>_<nombre>/migration.sql` a mano, aplicarlo con un script Node temporal (`pg.Pool`, se borra después de usarlo), después `npx prisma migrate resolve --applied <nombre>` y `npx prisma generate`. Nunca editar una migración ya pusheada — si hace falta corregir algo, se agrega una migración nueva.
2. **`server.js` no tiene hot-reload.** Después de editarlo hay que `preview_stop` + `preview_start` el servidor de preview para que los cambios apliquen. Las vistas EJS y los estáticos (CSS/JS) sí se sirven frescos sin reiniciar.
3. **Todo es multi-tenant por `empresaId`.** Cualquier query nueva sobre `Producto`, `Categoria`, `ClienteFinal`, `Pedido`, etc. tiene que filtrar por la empresa correcta — nunca asumir que hay una sola.
4. **Cambios grandes van con plan primero.** El patrón establecido en este proyecto: investigar con `Explore`/lectura de código, armar un plan file, pedir aprobación (`ExitPlanMode`), implementar, verificar con tests + simulación real antes de commitear.
5. **Verificar antes de afirmar que algo funciona.** Los tests (`npm test`, 60 tests con `node:test`) y simulaciones con `llamarInyectado` (inyectar una IA falsa determinista) son el patrón para probar el motor del agente sin depender de una API real. Ver ejemplos en `test/regresion-agente.test.js` y `test/motor-busqueda.test.js`.
