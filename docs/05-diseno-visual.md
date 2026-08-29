# Diseño visual de Proshop — paleta de colores, tipografía y estilo

Este documento releva **todo el CSS real del proyecto** (no es una guía aspiracional: cada color/fuente listado abajo está tomado directo del código, con su archivo y línea). Hay dos sistemas visuales separados y no relacionados:

1. **Sitio público + Panel admin/cliente** — un solo tema fijo, morado oscuro con acento verde menta. No es configurable por el negocio.
2. **Catálogo web + página de producto** — lo que ve el cliente final. Cada negocio elige una de 4 plantillas y puede personalizar 2 colores (`colorPrimario`/`colorSecundario`) desde el panel.

---

## 1. Sitio público + Panel admin/cliente

Archivos: [`public/css/styles.css`](../public/css/styles.css) (landing, planes) y [`public/css/admin.css`](../public/css/admin.css) (panel del negocio) — el segundo reutiliza las mismas variables `:root` que define el primero, así que **es un solo sistema de diseño**, no dos.

### Paleta

| Variable CSS | Valor | Para qué se usa |
|---|---|---|
| `--bg` | `#190f28` | Fondo base (morado casi negro). Fallback sólido detrás del degradado. |
| Fondo real del `body` | `linear-gradient(160deg, #241634 0%, #190f28 55%, #110a1d 100%)` | El fondo que se ve de verdad: degradado morado oscuro de arriba-izquierda a abajo-derecha. Igual en landing y panel. |
| `--bg-2` | `rgba(0,0,0,.14)` | Bandas de sección alternas, fondos de inputs, fondo de filas de tabla (header sticky). |
| `--surface` | `rgba(255,255,255,.09)` | El "vidrio esmerilado" de casi todas las tarjetas (`.card`, `.stat-card`, `.form-card`, `.dash-card`, burbujas de chat, etc.), siempre con `backdrop-filter: blur(8-10px)`. |
| `--surface-2` | `rgba(255,255,255,.14)` | Variante un poco más clara de superficie — barra del mock del hero, paneles de notificaciones. |
| `--border` | `rgba(255,255,255,.18)` | Borde estándar de **todo**: tarjetas, tablas, inputs, separadores. |
| `--text` | `#f6f2ff` | Texto principal (blanco con un toque lila). |
| `--muted` | `#dccff5` | Texto secundario/atenuado (subtítulos, labels, texto de ayuda) — lila más apagado, no gris puro. |
| `--primary` | `#8b5cf6` | **Morado marca.** Botón primario, iconos de sección, avatares con degradado. |
| `--primary-2` | `#2fe3a6` | **Verde menta marca — el acento "activo/éxito".** Item de menú activo, links, badges "nuevo", barra de progreso, precios destacados, tags de recomendado. Es el color que más trabajo semántico hace en toda la app. |
| `--accent` | `#c084fc` | Morado claro — complementa al primario en degradados de texto (`.grad`) y hover de tarjetas. |
| `--ring` | `rgba(47,227,166,.45)` | Halo de foco/hover en botones e inputs (basado en `--primary-2`). |
| `--radius` | `16px` | Radio de borde estándar de tarjetas y contenedores grandes. |
| `--shadow` | `0 20px 45px -20px rgba(0,0,0,.7)` | Sombra estándar de tarjetas flotantes/hover. |

### Colores semánticos (fuera de las variables, usados sueltos)

| Color | Uso |
|---|---|
| `#fb7185` (rosa/rojo) | Error, peligro, "sin stock", botón destructivo (`.btn-danger`, `.badge-alerta`, `.alert-err`). |
| `#34d399` (verde) | Confirmación de formulario (`.form-note.ok`). |
| `#fda4af` / `#fde68a` (rosa claro / amarillo) | Stat de "alerta" y badge "destacado" en tablas. |
| `#ffb020` (naranja) | Barra de progreso en estado de advertencia (`.bar-alert`), a medio camino entre ok y crítico. |
| `#25d366` (verde WhatsApp oficial) | Exclusivo del botón flotante de WhatsApp — el único color de marca ajena que se usa a propósito, para que se reconozca al toque. |

### Tipografía

- **Texto general (`--font`)**: `'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` — toda la interfaz, párrafos, botones, tablas.
- **Títulos/números destacados (`--display`)**: `'Sora', var(--font)` — se usa en `h1-h4`, precios grandes, números de estadísticas, logo de marca. Sora es más geométrica/ancha que Inter: le da peso a los títulos sin que la interfaz deje de sentirse liviana.
- Ambas se cargan juntas desde Google Fonts en [`views/partials/head.ejs:15`](../views/partials/head.ejs): `Inter:wght@400;500;600;700;800` + `Sora:wght@600;700;800` (Sora nunca se usa en peso regular/liviano, siempre semibold para arriba).

### Estilo general

- **Glassmorphism oscuro**: casi todo elemento-tarjeta es `background: var(--surface)` + `backdrop-filter: blur()` + `border: 1px solid var(--border)` — nunca colores sólidos planos para las tarjetas.
- **Botones**: `.btn-primary` es un degradado diagonal `--primary → --accent`; `.btn-ghost` es transparente con borde; `.btn-danger` es rosa/rojo translúcido que se vuelve sólido en hover.
- **Border-radius generoso** (`12-18px`) en casi todo — nada de esquinas rectas.
- **Iconos de sidebar activo**: fondo verde menta translúcido + barra lateral sólida (`box-shadow: inset 3px 0 0 var(--primary-2)`).

---

## 2. Catálogo web (lo que ve el cliente final)

4 plantillas intercambiables (`config.plantillaCatalogo`), elegidas por el negocio desde el panel. Todas comparten la misma estructura de datos, pero cada una tiene **su propia paleta base, tipografía y densidad visual**. En las 4, `colorPrimario`/`colorSecundario` son configurables por el negocio — si no los configura, cada plantilla cae a su color por defecto propio (no comparten default entre sí).

### 2.1 — Clásica (`views/catalogo-clasica.ejs`) — default si no se elige nada

| Token | Valor | Uso |
|---|---|---|
| `--fondo` | `#0f1117` | Fondo general, casi negro azulado. |
| `--panel` | `#181b24` | Fondo de tarjetas de producto. |
| `--panel-2` | `#1f2330` | Fondo secundario (barra del filtro activo). |
| `--tinta` | `#eef0f6` | Texto principal. |
| `--tenue` | `#9aa1b5` | Texto secundario (marca, stock, contador). |
| `--acento` / `--acento-2` | `#22c58b` (verde) por defecto, ambos configurables | Precio, hover de tarjetas — mismo color para los dos por defecto. |
| `--borde` | `#262b38` | Bordes de tarjetas. |
| Stock bajo | `#ffc36b` sobre `rgba(255,180,60,.16)` | "Últimas unidades". |
| Stock agotado | `#ff9a9a` sobre `rgba(255,90,90,.16)` | "Agotado". |

**Fuente**: Inter, pesos 400-800. **Estilo**: grid simple 4:3, tarjetas rectas, sin adornos — la más neutra de las 4, pensada como base segura.

### 2.2 — Banner (`views/catalogo-banner.ejs`)

Misma lógica de tokens que Clásica pero **más oscura y con un hero decorativo arriba**:

| Token | Valor |
|---|---|
| `--fondo` | `#0b0c10` |
| `--panel` | `#15171f` |
| `--acento` (default) | `#22c58b` (verde) |
| `--acento-2` (default) | `#7c3aed` (violeta) — a diferencia de Clásica, acá los dos colores por defecto son distintos entre sí. |

**Estilo distintivo**: un `.hero` con degradado radial doble (verde arriba-izquierda, violeta arriba-derecha) detrás del logo/nombre, y las tarjetas de producto son **cuadradas (1:1)**, no 4:3. **Fuente**: Inter, hasta peso 900 (más grueso que las demás, para el hero).

### 2.3 — Revista (`views/catalogo-revista.ejs`)

La única con identidad editorial fuerte:

| Token | Valor |
|---|---|
| `--fondo` | `#faf8f4` (crema, **tema claro** — la única plantilla clara de las 4) |
| `--panel` | `#ffffff` |
| `--tinta` | `#211f1c` (casi negro cálido) |
| `--tenue` | `#8a8375` |
| `--acento` (default) | `#8a4b32` (terracota) |
| `--acento-2` (default) | `#211f1c` |
| `--borde` | `#e8e2d6` |

**Fuentes** (única plantilla con 2 familias): `Fraunces` (serif con detalle, pesos 500-700, incluye variante óptica) para el nombre de marca (mayúsculas, `letter-spacing`), títulos de categoría y precio; `Inter` para el resto del texto. **Estilo**: tarjetas en formato retrato (4:5, como una revista de moda), sin bordes en las tarjetas — solo la foto y el texto flotando.

### 2.4 — Grid denso (`views/catalogo-grid-denso.ejs`)

Pensada para catálogos grandes, prioriza cantidad de productos visibles:

| Token | Valor |
|---|---|
| `--fondo` | `#f4f5f7` (gris muy claro, **tema claro**) |
| `--panel` | `#ffffff` |
| `--tinta` | `#14161c` |
| `--tenue` | `#6b7280` |
| `--acento` (default) | `#e11d48` (rojo/rosa fuerte) — el default más saturado de las 4 |
| `--acento-2` (default) | `#14161c` (casi negro) — usado como fondo sólido del header |
| `--borde` | `#e5e7eb` |
| Stock disponible | `#16a34a` (verde) — la única plantilla que usa un verde de sistema para "disponible" en vez de heredarlo del acento |
| Stock bajo | `#d97706` |
| Stock agotado | `#dc2626` |

**Estilo**: header sólido (no transparente) con la marca en mayúsculas, tarjetas mínimas (`radius: 6px`, gap de 8px), grilla de columnas angostas (mínimo 150px) — la más compacta, para catálogos de muchos ítems donde el cliente escanea rápido.

### 2.5 — Página de detalle de producto (`views/catalogo-producto.ejs`)

Es una plantilla **separada e independiente** de las 4 de arriba — se usa para el detalle sin importar qué plantilla de listado eligió el negocio. Tiene su propio switch de tema, configurable aparte (`config.temaProducto`):

**Tema oscuro (default)**

| Token | Valor |
|---|---|
| `--fondo` | `#0f1117` |
| `--panel` / `--panel-2` | `#181b24` / `#1f2330` |
| `--tinta` | `#eef0f6` |
| `--tenue` | `#9aa1b5` |
| `--acento` | `#22c58b` (verde, configurable) |

**Tema claro** (clase `body.tema-claro`, mismas variables redefinidas)

| Token | Valor |
|---|---|
| `--fondo` | `#f5f6f8` |
| `--panel` | `#ffffff` |
| `--tinta` | `#181a20` |
| `--tenue` | `#68707d` |

**Fuente**: Inter, 400-800. **Estilo**: layout a dos columnas (galería + info), fondo de foto con "backdrop" claro con relieve (radial-gradient `#f6f6f8 → #e3e4e8`) para que fotos de estudio con fondo blanco no se vean "recortadas" contra el tema oscuro — la única plantilla con ese tratamiento especial de imagen. Selector de color por swatches circulares (con foto real de cada color) y talla por pills, en vez de un `<select>`.

---

## Resumen rápido — "¿qué color es esto?"

| Si ves... | Es... |
|---|---|
| Morado oscuro degradado + verde menta brillante | Panel admin/cliente o landing pública |
| Fondo casi negro azulado (`#0f1117`) + acento verde | Catálogo Clásica (default) o página de producto (tema oscuro) |
| Hero con degradado verde+violeta arriba | Catálogo Banner |
| Fondo crema, tipografía serif en el nombre | Catálogo Revista |
| Fondo blanco/gris muy claro, header sólido, grilla muy apretada | Catálogo Grid denso |
| Verde `#25d366` en un botón circular flotante | Botón de WhatsApp (en cualquier plantilla) |

**Nota importante**: en las 4 plantillas de catálogo y en el detalle de producto, `--acento`/`--acento-2` (o `--primary`/`--primary-2` según la vista) **son configurables por cada negocio** desde el panel (`colorPrimario`/`colorSecundario`). Los valores de esta tabla son los *defaults* que salen del código si el negocio no eligió nada — el color real que ve un cliente puede ser distinto si Proshop lo personalizó.
