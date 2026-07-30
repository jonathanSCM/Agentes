# Proshop — Sitio web

Landing profesional para **Proshop**, empresa de desarrollo de software a medida
(web apps, apps móviles y paneles administrativos). Construida con **Node.js + Express + EJS**.

## Requisitos
- Node.js 18 o superior (probado con Node 24)

## Instalación
```bash
npm install
```

## Configuración
Copia `.env.example` a `.env` y ajusta tus datos (WhatsApp, email, teléfono):
```bash
cp .env.example .env
```
Valores editables: `PORT`, `WHATSAPP_NUMBER`, `CONTACT_EMAIL`, `CONTACT_PHONE`, `CONTACT_LOCATION`.

> El número de WhatsApp va en formato internacional **sin** el signo `+` (ej: `51999888777`).

## Ejecutar
```bash
npm start        # modo normal
npm run dev      # recarga automática al guardar cambios (node --watch)
```
Luego abre http://localhost:3000

## Estructura
```
├─ server.js              # Servidor Express + API de contacto
├─ views/                 # Plantillas EJS
│  ├─ index.ejs           # Página principal (landing)
│  ├─ 404.ejs
│  └─ partials/           # head, header, footer reutilizables
├─ public/                # Archivos estáticos
│  ├─ css/styles.css      # Diseño / tema
│  ├─ js/main.js          # Interacciones del front
│  └─ img/                # Íconos y assets
├─ data/leads.json        # Se genera solo: mensajes del formulario
└─ .env                   # Configuración (no se sube al repo)
```

## Formulario de contacto
Los mensajes enviados desde la web se guardan en `data/leads.json` y, al enviarse,
se abre un enlace de WhatsApp prellenado para continuar la conversación.

## Panel de administración
Accede en **http://localhost:3000/admin** (o el enlace "Panel" del footer).

- **Usuario/contraseña por defecto:** `admin` / `proshop123` — **cámbialos** en `.env`
  (`ADMIN_USER`, `ADMIN_PASSWORD`) antes de publicar el sitio.
- Desde el panel puedes: ver todos los mensajes, marcarlos como *atendido*,
  eliminarlos, y responder rápido por WhatsApp o email.
- La sesión dura 8 horas. Define un `SESSION_SECRET` propio en `.env`.

## Próximos pasos (opcional)
- Notificación por email al recibir un lead (nodemailer).
- Secciones de testimonios y preguntas frecuentes.
- Integración de pagos en línea (Mercado Pago / Stripe).
- Base de datos (PostgreSQL / MongoDB) en lugar del archivo JSON.
- Envío de notificaciones por email al recibir un lead.
