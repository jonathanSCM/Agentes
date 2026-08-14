// Proshop - servidor web (Express)
// Sirve la landing, la API de contacto (leads) y el panel de administracion.
const path = require('path');
const fs = require('fs');

// Ruta absoluta al .env: si el proceso se arranca desde otro directorio de
// trabajo (ej. un launcher externo), dotenv no debe depender del cwd.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const multer = require('multer');
const sharp = require('sharp');

const leads = require('./lib/leads');
const { prisma } = require('./lib/db');
const {
  obtenerEstadoConsumo,
  obtenerResumenEmpresa,
  registrarCompraPaquete,
} = require('./lib/services/suscripciones');
const { registrarCliente, autenticar } = require('./lib/services/auth');
const { procesarMensajeEntrante, atenderMensaje, generarYRegistrarRespuesta } = require('./lib/services/conversaciones');
const { encolarRespuesta } = require('./lib/services/bufferMensajes');
const wa = require('./lib/services/whatsapp');
const { analizarImagenProducto, transcribirAudio } = require('./lib/services/agente');
const { iniciarJobFacturacion } = require('./lib/jobs/facturacion');
const { initSocket, emitMensaje, emitConversacion } = require('./lib/services/realtime');
const { detectarPais } = require('./lib/services/geo');
const { precioPlanParaPais, precioPaqueteParaPais, simboloMoneda } = require('./lib/services/precios');
const { transicionValida, requiereRestock, dentroDeVentana24h } = require('./lib/services/pedidos');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'proshop' });
});

// ---- Configuracion del negocio (editable por variables de entorno) ----
const site = {
  name: 'Proshop',
  tagline: 'Software a medida que impulsa tu negocio',
  // Numero de WhatsApp en formato internacional SIN el signo +, ej: 51999888777
  whatsapp: process.env.WHATSAPP_NUMBER || '51999888777',
  whatsappUrl: process.env.WHATSAPP_URL || `https://wa.me/${process.env.WHATSAPP_NUMBER || '51999888777'}`,
  email: process.env.CONTACT_EMAIL || 'contacto@proshop.com',
  phone: process.env.CONTACT_PHONE || '+51 999 888 777',
  location: process.env.CONTACT_LOCATION || 'Lima, Peru',
  year: new Date().getFullYear(),
};

// ---- Credenciales del panel admin (cambiar en .env) ----
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'proshop123';

// ---- Subida de fotos de producto ----
// Se guardan en public/uploads (servidas como archivos estaticos publicos:
// el agente las manda por WhatsApp con su URL, asi que deben ser accesibles
// sin sesion). Toda foto se convierte a JPEG porque WhatsApp Cloud API no
// entrega imagenes WEBP en el chat.
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

async function convertirFotosAJpg(files) {
  const nombres = [];
  for (const file of files || []) {
    const nombreJpg = `${path.parse(file.filename).name}.jpg`;
    const rutaJpg = path.join(UPLOADS_DIR, nombreJpg);
    await sharp(file.path).rotate().jpeg({ quality: 85 }).toFile(rutaJpg);
    if (file.path !== rutaJpg) fs.unlinkSync(file.path);
    nombres.push(nombreJpg);
  }
  return nombres;
}

// ---- Middlewares ----
// Confia en el primer hop del proxy (Coolify) para que req.ip sea la IP real
// del visitante y no la IP interna del proxy - lo necesita la deteccion de
// pais por IP (lib/services/geo.js). Asume que solo el proxy propio de
// Coolify puede hablarle directo a esta app; si el setup de red cambiara,
// revisar este valor.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sesiones guardadas en Postgres (tabla "session", se crea sola la primera
// vez): antes vivian solo en memoria del proceso, asi que un reinicio del
// servidor (deploy, crash, redeploy) desconectaba a TODOS los usuarios sin
// aviso. Ahora sobreviven a un reinicio. El secreto de firma tambien debe
// ser fijo (ver SESSION_SECRET en .env): si no, cambia en cada arranque y
// invalida igual todas las cookies aunque la sesion siga guardada.
if (!process.env.SESSION_SECRET) {
  console.warn('ADVERTENCIA: falta SESSION_SECRET en el .env. Usando uno aleatorio (los usuarios se desconectaran en cada reinicio del servidor).');
}
const sessionStore = new pgSession({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  tableName: 'session',
  createTableIfMissing: true,
});

// Duracion de la cookie: mas larga si el usuario marco "Recordarme" en el
// login (ver rutas /ingresar y /admin/login), 8 horas por defecto.
const SESION_CORTA_MS = 1000 * 60 * 60 * 8; // 8 h
const SESION_LARGA_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias

// Guardada en su propia variable para poder compartirla con Socket.IO (el
// inbox en tiempo real solo debe aceptar conexiones de gente ya logueada).
const sessionMiddleware = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true, // cada visita renueva el vencimiento mientras este activo
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESION_CORTA_MS },
});
app.use(sessionMiddleware);

// Hace disponible "site" en todas las vistas
app.use((req, res, next) => {
  res.locals.site = site;
  next();
});

// Comparacion de credenciales resistente a timing
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Protege las rutas del panel
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/admin/login');
}

// ============================ SITIO PUBLICO ============================
app.get('/', async (req, res, next) => {
  try {
    const [planesDb, paquetesDb] = await Promise.all([
      prisma.plan.findMany({ where: { activo: true }, orderBy: { orden: 'asc' }, include: { preciosPais: true } }),
      prisma.paquete.findMany({ where: { activo: true }, orderBy: { cantidad: 'asc' }, include: { preciosPais: true } }),
    ]);
    const pais = detectarPais(req.ip);
    const planes = planesDb.map((p) => ({ ...p, precio: precioPlanParaPais(p, pais, p.preciosPais) }));
    const paquetes = paquetesDb.map((p) => ({ ...p, precio: precioPaqueteParaPais(p, pais, p.preciosPais) }));
    res.render('index', { title: `${site.name} - ${site.tagline}`, planes, paquetes, pais, simboloMoneda });
  } catch (err) { next(err); }
});

// Catalogo publico de una empresa (sin login): el agente manda este link
// cuando el cliente pide "el catálogo" en general, en vez de un producto
// puntual. Reutiliza el slug de la empresa (el mismo que ya usa cada tenant).
app.get('/catalogo/:slug', async (req, res, next) => {
  try {
    const empresa = await prisma.empresa.findUnique({
      where: { slug: req.params.slug },
      include: { agentes: { take: 1 } },
    });
    if (!empresa) return res.status(404).render('404', { title: 'Página no encontrada' });

    const productosDb = await prisma.producto.findMany({
      where: { empresaId: empresa.id, activo: true },
      orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }],
      include: { variantes: { where: { activa: true }, select: { stock: true } } },
    });
    // Si el producto tiene variantes, el stock real es la suma de sus
    // variantes (Producto.stock queda en 0 a proposito en ese caso) - mismo
    // criterio que /panel/productos, si no el catalogo publico muestra
    // "Agotado" en productos que si tienen stock real.
    const productos = productosDb.map((p) => ({
      ...p,
      stockMostrado: p.variantes.length ? p.variantes.reduce((suma, v) => suma + v.stock, 0) : p.stock,
    }));
    const agente = empresa.agentes[0];

    // Agrupa por categoria (orden alfabetico, "Otros" al final para
    // productos sin categoria) para que el catalogo se pueda navegar por
    // secciones en vez de una sola lista larga.
    const grupos = new Map();
    for (const p of productos) {
      const cat = p.categoria || 'Otros';
      if (!grupos.has(cat)) grupos.set(cat, []);
      grupos.get(cat).push(p);
    }
    const categorias = [...grupos.entries()]
      .sort(([a], [b]) => (a === 'Otros' ? 1 : b === 'Otros' ? -1 : a.localeCompare(b, 'es')))
      .map(([nombre, items]) => ({ nombre, productos: items }));

    res.render('catalogo', {
      title: `Catálogo · ${empresa.marca || empresa.nombre}`,
      empresa, productos, categorias,
      numeroWhatsapp: agente ? agente.numeroWhatsapp : null,
    });
  } catch (err) { next(err); }
});

// Recepcion de leads del formulario de contacto
app.post('/api/contacto', (req, res) => {
  const { nombre, email, telefono, servicio, mensaje } = req.body || {};

  if (!nombre || !email || !mensaje) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan campos obligatorios: nombre, email y mensaje.',
    });
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) {
    return res.status(400).json({ ok: false, error: 'El email no es valido.' });
  }

  let lead;
  try {
    lead = leads.addLead({
      nombre: String(nombre).trim().slice(0, 120),
      email: String(email).trim().slice(0, 160),
      telefono: telefono ? String(telefono).trim().slice(0, 40) : '',
      servicio: servicio ? String(servicio).trim().slice(0, 80) : '',
      mensaje: String(mensaje).trim().slice(0, 2000),
      ip: req.ip,
    });
  } catch (err) {
    console.error('Error guardando lead:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo registrar tu mensaje. Intenta de nuevo.' });
  }

  // Arma un enlace de WhatsApp listo para continuar la conversacion
  const texto = encodeURIComponent(
    `Hola ${site.name}, soy ${lead.nombre}.` +
      (lead.servicio ? ` Me interesa: ${lead.servicio}.` : '') +
      ` ${lead.mensaje}`
  );
  const whatsappUrl = `https://wa.me/${site.whatsapp}?text=${texto}`;

  return res.json({ ok: true, mensaje: 'Gracias, te contactaremos pronto.', whatsappUrl });
});

// ==================== REGISTRO E INGRESO DE CLIENTES ====================
async function planesConPrecio(pais) {
  const planesDb = await prisma.plan.findMany({ where: { activo: true }, orderBy: { orden: 'asc' }, include: { preciosPais: true } });
  return planesDb.map((p) => ({ ...p, precio: precioPlanParaPais(p, pais, p.preciosPais) }));
}

app.get('/registro', async (req, res, next) => {
  try {
    if (req.session && req.session.clienteId) return res.redirect('/panel');
    const pais = detectarPais(req.ip);
    const planes = await planesConPrecio(pais);
    res.render('registro', {
      title: 'Crear cuenta - Proshop', planes, error: null, simboloMoneda,
      datos: { planId: req.query.plan || '' }, // plan preseleccionado desde la web
    });
  } catch (err) { next(err); }
});

app.post('/registro', async (req, res, next) => {
  const { empresa, nombre, email, password, planId } = req.body || {};
  const pais = detectarPais(req.ip);
  try {
    const planes = await planesConPrecio(pais);
    const volverConError = (msg) =>
      res.status(400).render('registro', {
        title: 'Crear cuenta - Proshop', planes, error: msg, simboloMoneda,
        datos: { empresa, nombre, email, planId },
      });

    if (!empresa || !nombre || !email || !password || !planId) {
      return volverConError('Completa todos los campos obligatorios.');
    }
    if (String(password).length < 8) {
      return volverConError('La contraseña debe tener al menos 8 caracteres.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return volverConError('El correo no es válido.');
    }

    const { usuario } = await registrarCliente({ empresa, nombre, email, password, planId, pais });

    // Inicia sesion automaticamente
    req.session.clienteId = usuario.id;
    req.session.empresaId = usuario.empresaId;
    req.session.clienteNombre = usuario.nombre;
    req.session.clienteRol = usuario.rol;
    res.redirect('/panel?ok=' + encodeURIComponent('¡Bienvenido! Tu cuenta fue creada.'));
  } catch (err) {
    if (err.codigo === 'EMAIL_DUPLICADO' || err.codigo === 'PLAN_INVALIDO') {
      const planes = await prisma.plan.findMany({ where: { activo: true }, orderBy: { orden: 'asc' } });
      return res.status(400).render('registro', {
        title: 'Crear cuenta - Proshop', planes, error: err.message,
        datos: { empresa, nombre, email, planId },
      });
    }
    next(err);
  }
});

app.get('/ingresar', (req, res) => {
  if (req.session && req.session.clienteId) return res.redirect('/panel');
  res.render('ingresar', { title: 'Ingresar - Proshop', error: null, aviso: req.query.ok || null });
});

app.post('/ingresar', async (req, res, next) => {
  const { email, password, recordar } = req.body || {};
  try {
    const usuario = await autenticar(email || '', password || '');
    if (!usuario) {
      return res.status(401).render('ingresar', {
        title: 'Ingresar - Proshop', error: 'Correo o contraseña incorrectos.', aviso: null,
      });
    }
    req.session.clienteId = usuario.id;
    req.session.empresaId = usuario.empresaId;
    req.session.clienteNombre = usuario.nombre;
    req.session.clienteRol = usuario.rol;
    if (recordar === '1') req.session.cookie.maxAge = SESION_LARGA_MS;
    res.redirect('/panel');
  } catch (err) { next(err); }
});

app.post('/panel/salir', (req, res) => {
  req.session.destroy(() => res.redirect('/ingresar?ok=' + encodeURIComponent('Sesión cerrada.')));
});

// ==================== PANEL DEL CLIENTE ====================
function requireCliente(req, res, next) {
  if (req.session && req.session.clienteId) return next();
  return res.redirect('/ingresar');
}

// Solo el dueño (OWNER) administra el equipo y la facturación. ADMIN/STAFF
// pueden operar el dia a dia (conversaciones, pedidos, productos) pero no
// invitar/quitar gente ni tocar planes y pagos.
function requireRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (req.session && rolesPermitidos.includes(req.session.clienteRol)) return next();
    return res.status(403).render('403', { title: 'Sin permiso - Proshop' });
  };
}

// Datos comunes de las vistas del panel del cliente
const notif = require('./lib/services/notificaciones');

app.use('/panel', async (req, res, next) => {
  if (!req.session || !req.session.clienteId) return next();
  try {
    const empresa = await prisma.empresa.findUnique({ where: { id: req.session.empresaId } });
    res.locals.usuarioNombre = req.session.clienteNombre;
    res.locals.usuarioRol = req.session.clienteRol;
    res.locals.empresaNombre = empresa ? empresa.nombre : '';
    // Notificaciones para la campanita
    const [notificaciones, notifCount] = await Promise.all([
      notif.listar(req.session.empresaId),
      notif.contarNoLeidas(req.session.empresaId),
    ]);
    res.locals.notificaciones = notificaciones;
    res.locals.notifCount = notifCount;
    next();
  } catch (err) { next(err); }
});

// Marcar una / todas como leidas
app.post('/panel/notificaciones/:id/leida', requireCliente, async (req, res, next) => {
  try {
    await notif.marcarLeida(req.session.empresaId, Number(req.params.id));
    res.redirect(req.get('referer') || '/panel');
  } catch (err) { next(err); }
});

app.post('/panel/notificaciones/leer-todas', requireCliente, async (req, res, next) => {
  try {
    await notif.marcarTodasLeidas(req.session.empresaId);
    res.redirect(req.get('referer') || '/panel');
  } catch (err) { next(err); }
});

// Helpers para el panel del cliente
function inicioDeHoy() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
async function agenteIdsDe(empresaId) {
  const ags = await prisma.agente.findMany({ where: { empresaId }, select: { id: true } });
  return ags.map((a) => a.id);
}

// ===== INICIO (dashboard operativo) =====
app.get('/panel', requireCliente, async (req, res, next) => {
  try {
    const empresaId = req.session.empresaId;
    const resumen = await obtenerResumenEmpresa(empresaId);
    if (!resumen) return res.redirect('/ingresar');

    const agenteIds = await agenteIdsDe(empresaId);
    const hoy = inicioDeHoy();

    const [clientesHoy, pedidosHoy, ventasAgg, convTotal, convConIA, atencion, stockBajo] = await Promise.all([
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds }, createdAt: { gte: hoy } } }),
      prisma.pedido.count({ where: { empresaId, createdAt: { gte: hoy } } }),
      prisma.pedido.aggregate({ where: { empresaId, estado: { not: 'CANCELADO' }, createdAt: { gte: hoy } }, _sum: { total: true } }),
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds } } }),
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds }, mensajes: { some: { rol: 'AGENTE' } } } }),
      // Conversaciones SIN respuesta del agente = necesitan atencion humana
      prisma.conversacion.findMany({
        where: { agenteId: { in: agenteIds }, mensajes: { none: { rol: 'AGENTE' } } },
        orderBy: { ultimoMensajeAt: 'desc' }, take: 5,
      }),
      // El stock de un producto con variantes vive en las variantes, no en
      // el producto (que queda en 0 a proposito) - no se puede filtrar por
      // stock a nivel de base de datos sin contarlas.
      prisma.producto.findMany({
        where: { empresaId, activo: true },
        include: { variantes: { where: { activa: true }, select: { stock: true } } },
      }),
    ]);
    const stockBajoConVariantes = stockBajo
      .map((p) => ({ ...p, stockMostrado: p.variantes.length ? p.variantes.reduce((s, v) => s + v.stock, 0) : p.stock }))
      .filter((p) => p.stockMostrado <= 5)
      .sort((a, b) => a.stockMostrado - b.stockMostrado)
      .slice(0, 5);

    const resueltasIA = convTotal > 0 ? Math.round((convConIA / convTotal) * 100) : 0;
    const avisoSaldo = resumen.consumo.totalDisponible === 0
      ? 'Te quedaste sin conversaciones: tu agente dejó de atender.'
      : (resumen.consumo.porcentajeUsado >= 80 && resumen.consumo.extraDisponible === 0
        ? 'Ya usaste el ' + resumen.consumo.porcentajeUsado + '% de tu plan.' : null);

    res.render('cliente/inicio', {
      title: 'Inicio - Proshop', tituloPagina: 'Inicio', activo: 'inicio',
      consumo: resumen.consumo,
      avisoSaldo,
      kpi: {
        clientesHoy, pedidosHoy,
        ventasHoy: Number(ventasAgg._sum.total || 0),
        resueltasIA,
      },
      atencion, stockBajo: stockBajoConVariantes,
    });
  } catch (err) { next(err); }
});

// ===== Mi consumo (movido a Plan y facturación) =====
app.get('/panel/consumo', requireCliente, async (req, res, next) => {
  try {
    const resumen = await obtenerResumenEmpresa(req.session.empresaId);
    if (!resumen) return res.redirect('/ingresar');
    res.render('cliente/consumo', {
      title: 'Mi consumo - Proshop', tituloPagina: 'Mi consumo', activo: 'consumo',
      plan: resumen.plan, suscripcion: resumen.suscripcion, consumo: resumen.consumo,
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

// ===== Conversaciones =====
app.get('/panel/conversaciones', requireCliente, async (req, res, next) => {
  try {
    const agenteIds = await agenteIdsDe(req.session.empresaId);
    const hoy = inicioDeHoy();
    const [conversaciones, total, hoyCount, mensajes] = await Promise.all([
      prisma.conversacion.findMany({
        where: { agenteId: { in: agenteIds } },
        include: { _count: { select: { mensajes: true } } },
        orderBy: { ultimoMensajeAt: 'desc' }, take: 100,
      }),
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds } } }),
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds }, createdAt: { gte: hoy } } }),
      prisma.mensaje.count({ where: { conversacion: { agenteId: { in: agenteIds } } } }),
    ]);
    res.render('cliente/conversaciones', {
      title: 'Conversaciones - Proshop', tituloPagina: 'Conversaciones', activo: 'conversaciones',
      conversaciones, stats: { total, hoy: hoyCount, mensajes },
    });
  } catch (err) { next(err); }
});

// Detalle de una conversacion: el transcript completo, para que puedas leer
// que le dijo el cliente y como respondio el agente.
async function cargarConversacion(req) {
  const agenteIds = await agenteIdsDe(req.session.empresaId);
  return prisma.conversacion.findFirst({
    where: { id: Number(req.params.id), agenteId: { in: agenteIds } },
    include: {
      mensajes: { orderBy: { createdAt: 'asc' }, include: { usuario: true } },
      agente: { include: { conexion: true } },
      tomadaPor: true,
    },
  });
}

app.get('/panel/conversaciones/:id', requireCliente, async (req, res, next) => {
  try {
    const conversacion = await cargarConversacion(req);
    if (!conversacion) return res.redirect('/panel/conversaciones');

    const cliente = await prisma.clienteFinal.findFirst({
      where: { empresaId: req.session.empresaId, telefono: conversacion.telefonoCliente },
    });

    res.render('cliente/conversacion-detalle', {
      title: 'Conversación - Proshop', tituloPagina: 'Conversación', activo: 'conversaciones',
      conversacion, cliente, mensaje: req.query.ok || null, error: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// Tomar el control: la IA deja de responder este chat puntual hasta que
// alguien del equipo lo devuelva manualmente.
app.post('/panel/conversaciones/:id/control', requireCliente, async (req, res, next) => {
  try {
    const conversacion = await cargarConversacion(req);
    if (!conversacion) return res.redirect('/panel/conversaciones');
    await prisma.conversacion.update({
      where: { id: conversacion.id },
      data: { modo: 'HUMANO', tomadaPorId: req.session.clienteId },
    });
    emitConversacion(req.session.empresaId, { conversacionId: conversacion.id, modo: 'HUMANO', tomadaPorNombre: req.session.clienteNombre });
    res.redirect(`/panel/conversaciones/${conversacion.id}?ok=` + encodeURIComponent('Tomaste el control. La IA no responderá este chat hasta que lo devuelvas.'));
  } catch (err) { next(err); }
});

app.post('/panel/conversaciones/:id/liberar', requireCliente, async (req, res, next) => {
  try {
    const conversacion = await cargarConversacion(req);
    if (!conversacion) return res.redirect('/panel/conversaciones');
    await prisma.conversacion.update({
      where: { id: conversacion.id },
      data: { modo: 'IA', tomadaPorId: null },
    });
    emitConversacion(req.session.empresaId, { conversacionId: conversacion.id, modo: 'IA', tomadaPorNombre: null });
    res.redirect(`/panel/conversaciones/${conversacion.id}?ok=` + encodeURIComponent('Devuelto al agente de IA.'));
  } catch (err) { next(err); }
});

// Reiniciar la memoria del cliente (categoria, presupuesto, favorito,
// productos ya mostrados, etc.), sin tocar el consumo/facturacion ni borrar
// el historial de mensajes. Util para pruebas, o cuando un cliente quiere
// arrancar de cero una busqueda distinta.
app.post('/panel/conversaciones/:id/reiniciar', requireCliente, async (req, res, next) => {
  try {
    const conversacion = await cargarConversacion(req);
    if (!conversacion) return res.redirect('/panel/conversaciones');

    await prisma.clienteFinal.updateMany({
      where: { empresaId: req.session.empresaId, telefono: conversacion.telefonoCliente },
      data: {
        categoriaInteres: null,
        presupuesto: null,
        cantidad: null,
        marca: null,
        talla: null,
        color: null,
        observaciones: null,
        productoFavoritoId: null,
        productosDescartados: [],
        productosMostrados: [],
        estadoConversacion: 'EXPLORANDO',
        estadoLead: 'NUEVO',
        nivelInteres: 'FRIO',
        contexto: {},
      },
    });
    await prisma.conversacion.update({
      where: { id: conversacion.id },
      data: { modo: 'IA', tomadaPorId: null },
    });
    emitConversacion(req.session.empresaId, { conversacionId: conversacion.id, modo: 'IA', tomadaPorNombre: null });
    res.redirect(`/panel/conversaciones/${conversacion.id}?ok=` + encodeURIComponent('Se reinició la memoria del cliente: el agente lo tratará como una charla nueva desde el próximo mensaje.'));
  } catch (err) { next(err); }
});

// Mandar un mensaje real por WhatsApp como humano (solo si ya se tomo el
// control de este chat).
app.post('/panel/conversaciones/:id/mensaje', requireCliente, async (req, res, next) => {
  try {
    const conversacion = await cargarConversacion(req);
    if (!conversacion) return res.redirect('/panel/conversaciones');
    if (conversacion.modo !== 'HUMANO') {
      return res.redirect(`/panel/conversaciones/${conversacion.id}?err=` + encodeURIComponent('Primero tenés que tomar el control de este chat.'));
    }
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.redirect(`/panel/conversaciones/${conversacion.id}`);

    const conexion = conversacion.agente.conexion;
    if (conexion && conexion.estado === 'CONECTADO') {
      await wa.enviarTexto(conexion, conversacion.telefonoCliente, texto);
    }
    await prisma.$transaction([
      prisma.mensaje.create({
        data: { conversacionId: conversacion.id, rol: 'AGENTE', contenido: texto, usuarioId: req.session.clienteId },
      }),
      prisma.conversacion.update({ where: { id: conversacion.id }, data: { ultimoMensajeAt: new Date() } }),
    ]);
    emitMensaje(req.session.empresaId, {
      conversacionId: conversacion.id, rol: 'AGENTE', contenido: texto, createdAt: new Date(),
      usuarioNombre: req.session.clienteNombre,
    });

    res.redirect(`/panel/conversaciones/${conversacion.id}`);
  } catch (err) { next(err); }
});

// ===== Pedidos =====
app.get('/panel/pedidos', requireCliente, async (req, res, next) => {
  try {
    const empresaId = req.session.empresaId;
    const [pedidos, total, nuevos, agg] = await Promise.all([
      prisma.pedido.findMany({ where: { empresaId }, include: { cliente: true, items: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.pedido.count({ where: { empresaId } }),
      prisma.pedido.count({ where: { empresaId, estado: 'NUEVO' } }),
      prisma.pedido.aggregate({ where: { empresaId, estado: { not: 'CANCELADO' } }, _sum: { total: true } }),
    ]);
    res.render('cliente/pedidos', {
      title: 'Pedidos - Proshop', tituloPagina: 'Pedidos', activo: 'pedidos',
      pedidos, stats: { total, nuevos, total_bs: Number(agg._sum.total || 0) },
      mensaje: req.query.ok || null, errorEstado: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// Avisa por WhatsApp que el pedido fue confirmado, SOLO si el cliente
// escribio hace menos de 24hs (fuera de esa ventana, Meta no deja mandar
// texto libre, solo plantillas aprobadas - eso no esta implementado aca).
// Si algo falla (sin conexion, fuera de ventana, error de red) simplemente
// no se notifica - el cambio de estado ya se guardo igual, esto es un extra.
async function notificarConfirmacionPedido(empresaId, pedido) {
  try {
    if (!pedido.clienteId) return false;
    const cliente = await prisma.clienteFinal.findUnique({ where: { id: pedido.clienteId } });
    if (!cliente) return false;

    const agente = await prisma.agente.findFirst({ where: { empresaId }, include: { conexion: true } });
    if (!agente || !agente.conexion || agente.conexion.estado !== 'CONECTADO') return false;

    const conversacion = await prisma.conversacion.findFirst({
      where: { agenteId: agente.id, telefonoCliente: cliente.telefono },
      orderBy: { ultimoMensajeAt: 'desc' },
    });
    if (!conversacion || !dentroDeVentana24h(conversacion.ultimoMensajeAt)) return false;

    const texto = '¡Tu pedido fue confirmado! ✅ Ya lo estamos preparando y coordinando la entrega. Cualquier duda, escribinos por acá.';
    await wa.enviarTexto(agente.conexion, cliente.telefono, texto);

    const mensajeGuardado = await prisma.mensaje.create({
      data: { conversacionId: conversacion.id, rol: 'SISTEMA', contenido: texto },
    });
    emitMensaje(empresaId, {
      conversacionId: conversacion.id, rol: 'SISTEMA', contenido: texto, mediaUrl: null, mediaTipo: null, createdAt: mensajeGuardado.createdAt,
    });
    return true;
  } catch (err) {
    console.error('No se pudo notificar la confirmacion del pedido por WhatsApp:', err);
    return false;
  }
}

// Cambia el estado de un pedido (Confirmar / Marcar entregado / Cancelar).
// Al cancelar se devuelve el stock que se habia descontado al crear el
// pedido (ver crear_pedido en lib/services/agente.js) - confirmar/entregar
// NO tocan el stock, ya se reservo al crearse.
app.post('/panel/pedidos/:id/estado', requireCliente, async (req, res, next) => {
  try {
    const empresaId = req.session.empresaId;
    const pedido = await prisma.pedido.findFirst({
      where: { id: Number(req.params.id), empresaId },
      include: { items: true },
    });
    if (!pedido) return res.redirect('/panel/pedidos');

    const estadoNuevo = String(req.body.estado || '').toUpperCase();
    if (!transicionValida(pedido.estado, estadoNuevo)) {
      return res.redirect('/panel/pedidos?err=' + encodeURIComponent('Ese cambio de estado no es válido.'));
    }

    await prisma.$transaction(async (tx) => {
      if (requiereRestock(pedido.estado, estadoNuevo)) {
        for (const item of pedido.items) {
          if (item.varianteId) {
            await tx.variante.update({ where: { id: item.varianteId }, data: { stock: { increment: item.cantidad } } });
          } else if (item.productoId) {
            await tx.producto.update({ where: { id: item.productoId }, data: { stock: { increment: item.cantidad } } });
          }
        }
      }
      await tx.pedido.update({ where: { id: pedido.id }, data: { estado: estadoNuevo } });
    });

    let mensajeOk = 'Pedido actualizado.';
    if (estadoNuevo === 'CONFIRMADO') {
      const notificado = await notificarConfirmacionPedido(empresaId, pedido);
      mensajeOk = notificado ? 'Pedido confirmado y cliente avisado por WhatsApp.' : 'Pedido confirmado (no se pudo avisar por WhatsApp: sin conexión o fuera de la ventana de 24hs).';
    }

    res.redirect('/panel/pedidos?ok=' + encodeURIComponent(mensajeOk));
  } catch (err) { next(err); }
});

// ===== Clientes =====
app.get('/panel/clientes', requireCliente, async (req, res, next) => {
  try {
    const empresaId = req.session.empresaId;
    const hoy = inicioDeHoy();
    const [clientes, total, nuevosHoy] = await Promise.all([
      prisma.clienteFinal.findMany({ where: { empresaId }, include: { _count: { select: { pedidos: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.clienteFinal.count({ where: { empresaId } }),
      prisma.clienteFinal.count({ where: { empresaId, createdAt: { gte: hoy } } }),
    ]);
    res.render('cliente/clientes', {
      title: 'Clientes - Proshop', tituloPagina: 'Clientes', activo: 'clientes',
      clientes, stats: { total, nuevosHoy },
    });
  } catch (err) { next(err); }
});

// ===== Inventario =====
app.get('/panel/inventario', requireCliente, async (req, res, next) => {
  try {
    const empresaId = req.session.empresaId;
    const productosDb = await prisma.producto.findMany({
      where: { empresaId },
      include: { variantes: { where: { activa: true }, select: { stock: true } } },
    });
    // Si el producto tiene variantes, el stock real es la suma de sus
    // variantes (el stock del producto en si queda en 0 a proposito) - ver
    // la misma logica en /panel/productos.
    const productos = productosDb
      .map((p) => ({
        ...p,
        stockMostrado: p.variantes.length ? p.variantes.reduce((suma, v) => suma + v.stock, 0) : p.stock,
        tieneVariantes: p.variantes.length > 0,
      }))
      .sort((a, b) => a.stockMostrado - b.stockMostrado);

    res.render('cliente/inventario', {
      title: 'Inventario - Proshop', tituloPagina: 'Inventario', activo: 'inventario',
      productos,
      stats: {
        total: productos.length,
        bajo: productos.filter((p) => p.stockMostrado > 0 && p.stockMostrado <= 5).length,
        agotados: productos.filter((p) => p.stockMostrado === 0).length,
      },
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

app.post('/panel/inventario/:id', requireCliente, async (req, res, next) => {
  try {
    const producto = await prisma.producto.findFirst({
      where: { id: Number(req.params.id), empresaId: req.session.empresaId },
      include: { variantes: { where: { activa: true }, select: { id: true } } },
    });
    if (!producto) return res.redirect('/panel/inventario');
    if (producto.variantes.length) {
      // El stock de un producto con variantes se edita por combinacion, no
      // como un solo numero: se redirige a donde si se puede ajustar.
      return res.redirect(`/panel/productos/${producto.id}/editar?err=` + encodeURIComponent('Este producto tiene variantes: ajusta el stock de cada combinación ahí abajo, no un número único.'));
    }
    const stock = Math.max(0, parseInt(req.body.stock, 10) || 0);
    await prisma.producto.update({ where: { id: producto.id }, data: { stock } });
    res.redirect('/panel/inventario?ok=' + encodeURIComponent('Stock actualizado.'));
  } catch (err) { next(err); }
});

// ===== Reportes =====
app.get('/panel/reportes', requireCliente, async (req, res, next) => {
  try {
    const empresaId = req.session.empresaId;
    const agenteIds = await agenteIdsDe(empresaId);
    const hace7 = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    hace7.setHours(0, 0, 0, 0);

    const [conversaciones, conv7, convConIA, clientes, pedidos, convRecientes] = await Promise.all([
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds } } }),
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds }, createdAt: { gte: hace7 } } }),
      prisma.conversacion.count({ where: { agenteId: { in: agenteIds }, mensajes: { some: { rol: 'AGENTE' } } } }),
      prisma.clienteFinal.count({ where: { empresaId } }),
      prisma.pedido.count({ where: { empresaId } }),
      prisma.conversacion.findMany({ where: { agenteId: { in: agenteIds }, createdAt: { gte: hace7 } }, select: { createdAt: true } }),
    ]);

    // Serie de los últimos 7 días
    const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
    const serie = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const fin = new Date(d); fin.setDate(fin.getDate() + 1);
      const total = convRecientes.filter((c) => c.createdAt >= d && c.createdAt < fin).length;
      serie.push({ etiqueta: dias[d.getDay()], total });
    }

    res.render('cliente/reportes', {
      title: 'Reportes - Proshop', tituloPagina: 'Reportes', activo: 'reportes',
      r: {
        conversaciones, conversaciones7: conv7, clientes, pedidos, serie,
        resueltasIA: conversaciones > 0 ? Math.round((convConIA / conversaciones) * 100) : 0,
      },
    });
  } catch (err) { next(err); }
});

app.get('/panel/paquetes', requireCliente, async (req, res, next) => {
  try {
    const [resumen, paquetesDb] = await Promise.all([
      obtenerResumenEmpresa(req.session.empresaId),
      prisma.paquete.findMany({ where: { activo: true }, orderBy: { cantidad: 'asc' }, include: { preciosPais: true } }),
    ]);
    const pais = detectarPais(req.ip);
    const paquetes = paquetesDb.map((p) => ({ ...p, precio: precioPaqueteParaPais(p, pais, p.preciosPais) }));
    res.render('cliente/paquetes', {
      title: 'Comprar paquete - Proshop', tituloPagina: 'Comprar paquete', activo: 'paquetes',
      paquetes, consumo: resumen.consumo, simboloMoneda,
    });
  } catch (err) { next(err); }
});

// Compra de un paquete: registra la compra + el pago, y acredita el saldo.
app.post('/panel/paquetes/:id/comprar', requireCliente, async (req, res, next) => {
  try {
    const paquete = await prisma.paquete.findUnique({ where: { id: Number(req.params.id) }, include: { preciosPais: true } });
    if (!paquete || !paquete.activo) {
      return res.redirect('/panel/paquetes');
    }

    // Mismo precio que se le mostro en pantalla (se detecta la IP de esta
    // misma request, no se confia en nada que haya mandado el cliente): si
    // no, se corre el riesgo de mostrar un precio y cobrar otro.
    const pais = detectarPais(req.ip);
    const precio = precioPaqueteParaPais(paquete, pais, paquete.preciosPais);

    const empresaId = req.session.empresaId;
    // PENDIENTE: todavia NO da saldo usable. Se activa recien cuando Proshop
    // confirma el pago en /admin/pagos (antes esto se acreditaba de
    // inmediato, sin ninguna relacion real con si se pago o no).
    const compra = await registrarCompraPaquete({
      empresaId,
      paqueteId: paquete.id,
      cantidad: paquete.cantidad,
      // precioUsd del registro de compra queda como referencia interna en
      // USD (para reportes/comparaciones consistentes), independiente de en
      // que moneda se le cobro realmente al cliente (ver Pago abajo).
      precioUsd: Number(paquete.precioUsd),
      nota: 'Comprado desde el panel del cliente',
      estado: 'PENDIENTE',
    });

    // Queda registrado el pago (pendiente de confirmar por Proshop), en la
    // moneda/monto real que se le mostro y se le va a cobrar.
    await prisma.pago.create({
      data: {
        empresaId,
        tipo: 'PAQUETE',
        monto: precio.precio,
        moneda: precio.moneda,
        estado: 'PENDIENTE',
        referencia: `Paquete de ${paquete.cantidad} conversaciones`,
        paqueteId: paquete.id,
        compraPaqueteId: compra.id,
      },
    });

    res.redirect('/panel/compras?ok=' + encodeURIComponent(
      `Compra registrada: quedara disponible apenas confirmemos tu pago de ${paquete.cantidad.toLocaleString('es-BO')} conversaciones.`
    ));
  } catch (err) { next(err); }
});

app.get('/panel/compras', requireCliente, async (req, res, next) => {
  try {
    const compras = await prisma.compraPaquete.findMany({
      where: { empresaId: req.session.empresaId },
      orderBy: { fechaCompra: 'desc' },
    });
    res.render('cliente/compras', {
      title: 'Mis compras - Proshop', tituloPagina: 'Mis compras', activo: 'compras',
      compras, mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

// -------- Catalogo de productos del cliente (CRUD) --------
async function planDeEmpresa(empresaId) {
  const sub = await prisma.suscripcion.findUnique({
    where: { empresaId }, include: { plan: true },
  });
  return sub ? sub.plan : null;
}

app.get('/panel/productos', requireCliente, async (req, res, next) => {
  try {
    const [productosDb, plan] = await Promise.all([
      prisma.producto.findMany({
        where: { empresaId: req.session.empresaId },
        orderBy: { createdAt: 'desc' },
        include: { variantes: { where: { activa: true }, select: { stock: true } } },
      }),
      planDeEmpresa(req.session.empresaId),
    ]);
    // Si el producto tiene variantes, el stock real es la suma de sus
    // variantes (el stock del producto en si queda en 0 a proposito). Se
    // calcula aca para que la lista no muestre "0" enganosamente.
    const productos = productosDb.map((p) => ({
      ...p,
      stockMostrado: p.variantes.length ? p.variantes.reduce((suma, v) => suma + v.stock, 0) : p.stock,
      tieneVariantes: p.variantes.length > 0,
    }));
    res.render('cliente/productos', {
      title: 'Mis productos - Proshop', tituloPagina: 'Mis productos', activo: 'productos',
      productos, maxProductos: plan ? plan.maxProductos : 10, mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

// Categorias ya usadas por la tienda, para sugerirlas en el formulario
// (datalist) sin obligar a elegir de una lista cerrada.
async function categoriasExistentes(empresaId) {
  const filas = await prisma.producto.findMany({
    where: { empresaId, categoria: { not: null } },
    distinct: ['categoria'],
    select: { categoria: true },
  });
  return filas.map((f) => f.categoria).filter(Boolean);
}

app.get('/panel/productos/nuevo', requireCliente, async (req, res, next) => {
  try {
    res.render('cliente/producto-form', {
      title: 'Agregar producto - Proshop', tituloPagina: 'Agregar producto', activo: 'productos',
      producto: null, error: null, categoriasExistentes: await categoriasExistentes(req.session.empresaId),
    });
  } catch (err) { next(err); }
});

// Arma el objeto {clave: valor} a partir de las filas dinamicas del
// formulario (atributoClave[] / atributoValor[], una fila por atributo:
// Marca, Voltaje, Material, lo que cargue cada negocio segun su rubro).
function atributosDesdeForm(body) {
  const claves = [].concat(body.atributoClave || []);
  const valores = [].concat(body.atributoValor || []);
  const atributos = {};
  claves.forEach((clave, i) => {
    const k = String(clave || '').trim().slice(0, 60);
    const v = String(valores[i] ?? '').trim().slice(0, 120);
    if (k && v) atributos[k] = v;
  });
  return atributos;
}

// Convierte los campos de texto libre del formulario (categoria,
// caracteristicas por coma, atributos por filas) a los tipos que espera Prisma.
function datosCatalogoDesdeForm(body) {
  const caracteristicas = (body.caracteristicas || '').split(',').map((c) => c.trim()).filter(Boolean);
  return {
    categoria: body.categoria ? String(body.categoria).trim().slice(0, 120) : null,
    caracteristicas,
    atributos: atributosDesdeForm(body),
  };
}

function urlPublicaDeArchivo(req, filename) {
  return `${req.protocol}://${req.get('host')}/uploads/${filename}`;
}

app.post('/panel/productos', requireCliente, upload.array('fotos', 8), async (req, res, next) => {
  const { nombre, descripcion, precio, stock, activo } = req.body || {};
  try {
    const plan = await planDeEmpresa(req.session.empresaId);
    const total = await prisma.producto.count({ where: { empresaId: req.session.empresaId } });
    if (plan && total >= plan.maxProductos) {
      return res.redirect('/panel/productos?ok=' + encodeURIComponent('Alcanzaste el límite de productos de tu plan.'));
    }
    if (!nombre || precio === undefined || precio === '') {
      return res.status(400).render('cliente/producto-form', {
        title: 'Agregar producto - Proshop', tituloPagina: 'Agregar producto', activo: 'productos',
        producto: null, error: 'El nombre y el precio son obligatorios.',
      });
    }
    const nombresArchivos = await convertirFotosAJpg(req.files);
    const fotos = nombresArchivos.map((n) => urlPublicaDeArchivo(req, n));
    await prisma.producto.create({
      data: {
        empresaId: req.session.empresaId,
        nombre: String(nombre).trim().slice(0, 120),
        descripcion: descripcion ? String(descripcion).trim().slice(0, 200) : null,
        precio: Number(precio) || 0,
        stock: parseInt(stock, 10) || 0,
        activo: activo === '1',
        fotos,
        ...datosCatalogoDesdeForm(req.body || {}),
      },
    });
    res.redirect('/panel/productos?ok=' + encodeURIComponent('Producto agregado.'));
  } catch (err) { next(err); }
});

app.get('/panel/productos/:id/editar', requireCliente, async (req, res, next) => {
  try {
    const producto = await prisma.producto.findFirst({
      where: { id: Number(req.params.id), empresaId: req.session.empresaId },
      include: { variantes: { orderBy: { id: 'asc' } } },
    });
    if (!producto) return res.redirect('/panel/productos');
    res.render('cliente/producto-form', {
      title: 'Editar producto - Proshop', tituloPagina: 'Editar producto', activo: 'productos',
      producto, error: null, mensaje: req.query.ok || null, errorVariante: req.query.err || null,
      categoriasExistentes: await categoriasExistentes(req.session.empresaId),
    });
  } catch (err) { next(err); }
});

app.post('/panel/productos/:id/variantes', requireCliente, async (req, res, next) => {
  try {
    const producto = await prisma.producto.findFirst({ where: { id: Number(req.params.id), empresaId: req.session.empresaId } });
    if (!producto) return res.redirect('/panel/productos');

    const atributos = atributosDesdeForm(req.body || {});
    if (Object.keys(atributos).length === 0) {
      return res.redirect(`/panel/productos/${producto.id}/editar?err=` + encodeURIComponent('Cargá al menos un atributo de la variante, ej: Talla = 42.'));
    }
    await prisma.variante.create({
      data: {
        productoId: producto.id,
        atributos,
        precio: req.body.precio ? Number(req.body.precio) : null,
        stock: parseInt(req.body.stock, 10) || 0,
      },
    });
    res.redirect(`/panel/productos/${producto.id}/editar?ok=` + encodeURIComponent('Variante agregada.'));
  } catch (err) { next(err); }
});

app.post('/panel/productos/:id/variantes/:varianteId', requireCliente, async (req, res, next) => {
  try {
    const producto = await prisma.producto.findFirst({ where: { id: Number(req.params.id), empresaId: req.session.empresaId } });
    if (!producto) return res.redirect('/panel/productos');
    await prisma.variante.updateMany({
      where: { id: Number(req.params.varianteId), productoId: producto.id },
      data: {
        atributos: atributosDesdeForm(req.body || {}),
        precio: req.body.precio ? Number(req.body.precio) : null,
        stock: parseInt(req.body.stock, 10) || 0,
      },
    });
    res.redirect(`/panel/productos/${producto.id}/editar?ok=` + encodeURIComponent('Variante actualizada.'));
  } catch (err) { next(err); }
});

app.post('/panel/productos/:id/variantes/:varianteId/eliminar', requireCliente, async (req, res, next) => {
  try {
    const producto = await prisma.producto.findFirst({ where: { id: Number(req.params.id), empresaId: req.session.empresaId } });
    if (!producto) return res.redirect('/panel/productos');
    await prisma.variante.deleteMany({ where: { id: Number(req.params.varianteId), productoId: producto.id } });
    res.redirect(`/panel/productos/${producto.id}/editar?ok=` + encodeURIComponent('Variante eliminada.'));
  } catch (err) { next(err); }
});

app.post('/panel/productos/:id', requireCliente, upload.array('fotos', 8), async (req, res, next) => {
  const { nombre, descripcion, precio, stock, activo } = req.body || {};
  try {
    const producto = await prisma.producto.findFirst({
      where: { id: Number(req.params.id), empresaId: req.session.empresaId },
    });
    if (!producto) return res.redirect('/panel/productos');

    const nombresArchivos = await convertirFotosAJpg(req.files);
    const fotosNuevas = nombresArchivos.map((n) => urlPublicaDeArchivo(req, n));
    const fotosExistentes = req.body.quitarFotos === '1'
      ? []
      : (req.body.fotosExistentes ? JSON.parse(req.body.fotosExistentes) : producto.fotos);
    const fotos = [...fotosExistentes, ...fotosNuevas];

    // updateMany con empresaId evita editar productos de otra empresa
    await prisma.producto.updateMany({
      where: { id: Number(req.params.id), empresaId: req.session.empresaId },
      data: {
        nombre: String(nombre).trim().slice(0, 120),
        descripcion: descripcion ? String(descripcion).trim().slice(0, 200) : null,
        precio: Number(precio) || 0,
        stock: parseInt(stock, 10) || 0,
        activo: activo === '1',
        fotos,
        ...datosCatalogoDesdeForm(req.body || {}),
      },
    });
    res.redirect('/panel/productos?ok=' + encodeURIComponent('Producto actualizado.'));
  } catch (err) { next(err); }
});

app.post('/panel/productos/:id/eliminar', requireCliente, async (req, res, next) => {
  try {
    await prisma.producto.deleteMany({
      where: { id: Number(req.params.id), empresaId: req.session.empresaId },
    });
    res.redirect('/panel/productos?ok=' + encodeURIComponent('Producto eliminado.'));
  } catch (err) { next(err); }
});

// -------- Configuracion del agente (nombre, numero de WhatsApp, tono...) --------
// Devuelve el agente de la empresa, creandolo si no existe.
async function obtenerAgente(empresaId) {
  let agente = await prisma.agente.findFirst({
    where: { empresaId },
    include: { config: true },
  });
  if (!agente) {
    agente = await prisma.agente.create({
      data: {
        empresaId,
        nombre: 'Mi agente',
        config: { create: {} },
      },
      include: { config: true },
    });
  } else if (!agente.config) {
    await prisma.agenteConfig.create({ data: { agenteId: agente.id } });
    agente = await prisma.agente.findUnique({ where: { id: agente.id }, include: { config: true } });
  }
  return agente;
}

app.get('/panel/configuracion', requireCliente, async (req, res, next) => {
  try {
    const agente = await obtenerAgente(req.session.empresaId);
    res.render('cliente/configuracion', {
      title: 'Configuración del agente - Proshop', tituloPagina: 'Configuración', activo: 'configuracion',
      agente, config: agente.config || {}, mensaje: req.query.ok || null, error: null,
    });
  } catch (err) { next(err); }
});

app.post('/panel/configuracion', requireCliente, async (req, res, next) => {
  const { nombre, numeroWhatsapp, mensajeBienvenida, tono, estado, instrucciones, derivarAHumano } = req.body || {};
  try {
    const agente = await obtenerAgente(req.session.empresaId);

    // El numero: solo digitos (quita +, espacios, guiones)
    const numero = numeroWhatsapp ? String(numeroWhatsapp).replace(/\D/g, '').slice(0, 20) : null;
    if (numero && numero.length < 8) {
      return res.status(400).render('cliente/configuracion', {
        title: 'Configuración del agente - Proshop', tituloPagina: 'Configuración', activo: 'configuracion',
        agente, config: agente.config || {},
        error: 'El número de WhatsApp parece incompleto. Usa el formato internacional (ej: 59171234567).',
        mensaje: null,
      });
    }

    await prisma.agente.update({
      where: { id: agente.id },
      data: {
        nombre: nombre ? String(nombre).trim().slice(0, 60) : agente.nombre,
        numeroWhatsapp: numero,
        estado: ['ACTIVO', 'PAUSADO', 'BORRADOR'].includes(estado) ? estado : agente.estado,
      },
    });

    await prisma.agenteConfig.update({
      where: { agenteId: agente.id },
      data: {
        mensajeBienvenida: mensajeBienvenida ? String(mensajeBienvenida).trim().slice(0, 200) : undefined,
        tono: tono ? String(tono).slice(0, 60) : undefined,
        instrucciones: instrucciones ? String(instrucciones).trim().slice(0, 200) : null,
        derivarAHumano: derivarAHumano === '1',
      },
    });

    res.redirect('/panel/configuracion?ok=' + encodeURIComponent('Configuración guardada.'));
  } catch (err) { next(err); }
});

// -------- Mi equipo (invitar colaboradores, solo el dueño) --------
const { crearInvitacion, obtenerInvitacionPorToken, aceptarInvitacion } = require('./lib/services/auth');

app.get('/panel/equipo', requireCliente, requireRol('OWNER'), async (req, res, next) => {
  try {
    const [usuarios, invitaciones] = await Promise.all([
      prisma.usuario.findMany({ where: { empresaId: req.session.empresaId }, orderBy: { createdAt: 'asc' } }),
      prisma.invitacion.findMany({ where: { empresaId: req.session.empresaId, aceptada: false }, orderBy: { createdAt: 'desc' } }),
    ]);
    res.render('cliente/equipo', {
      title: 'Mi equipo - Proshop', tituloPagina: 'Mi equipo', activo: 'equipo',
      usuarios, invitaciones, mensaje: req.query.ok || null, error: req.query.err || null,
      linkInvitacion: req.query.link || null, usuarioActualId: req.session.clienteId,
    });
  } catch (err) { next(err); }
});

app.post('/panel/equipo/invitar', requireCliente, requireRol('OWNER'), async (req, res, next) => {
  const { email, rol } = req.body || {};
  try {
    if (!email || !String(email).trim()) {
      return res.redirect('/panel/equipo?err=' + encodeURIComponent('Ingresa un correo.'));
    }
    const invitacion = await crearInvitacion({ empresaId: req.session.empresaId, email, rol });
    const link = `${req.protocol}://${req.get('host')}/invitacion/${invitacion.token}`;
    res.redirect('/panel/equipo?ok=' + encodeURIComponent('Invitación creada. Compártele este link a la persona:') + '&link=' + encodeURIComponent(link));
  } catch (err) {
    if (err.codigo === 'EMAIL_DUPLICADO') {
      return res.redirect('/panel/equipo?err=' + encodeURIComponent(err.message));
    }
    next(err);
  }
});

app.post('/panel/equipo/invitaciones/:id/revocar', requireCliente, requireRol('OWNER'), async (req, res, next) => {
  try {
    await prisma.invitacion.deleteMany({ where: { id: Number(req.params.id), empresaId: req.session.empresaId } });
    res.redirect('/panel/equipo?ok=' + encodeURIComponent('Invitación revocada.'));
  } catch (err) { next(err); }
});

app.post('/panel/equipo/:id/eliminar', requireCliente, requireRol('OWNER'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.session.clienteId) {
      return res.redirect('/panel/equipo?err=' + encodeURIComponent('No puedes quitarte a ti mismo del equipo.'));
    }
    await prisma.usuario.deleteMany({ where: { id, empresaId: req.session.empresaId, rol: { not: 'OWNER' } } });
    res.redirect('/panel/equipo?ok=' + encodeURIComponent('Se quitó a la persona del equipo.'));
  } catch (err) { next(err); }
});

// Aceptar invitacion (publico, sin sesion): la persona invitada define su
// nombre y contraseña, y queda logueada directo.
app.get('/invitacion/:token', async (req, res, next) => {
  try {
    const invitacion = await obtenerInvitacionPorToken(req.params.token);
    if (!invitacion) {
      return res.status(400).render('invitacion', { title: 'Invitación - Proshop', invitacion: null, error: 'Esta invitación ya no es válida (venció o ya fue usada).' });
    }
    res.render('invitacion', { title: 'Invitación - Proshop', invitacion, error: null });
  } catch (err) { next(err); }
});

app.post('/invitacion/:token', async (req, res, next) => {
  const { nombre, password } = req.body || {};
  try {
    const invitacion = await obtenerInvitacionPorToken(req.params.token);
    if (!invitacion) {
      return res.status(400).render('invitacion', { title: 'Invitación - Proshop', invitacion: null, error: 'Esta invitación ya no es válida (venció o ya fue usada).' });
    }
    if (!nombre || !password || String(password).length < 8) {
      return res.status(400).render('invitacion', { title: 'Invitación - Proshop', invitacion, error: 'Completa tu nombre y una contraseña de al menos 8 caracteres.' });
    }

    const usuario = await aceptarInvitacion(req.params.token, { nombre, password });
    req.session.clienteId = usuario.id;
    req.session.empresaId = usuario.empresaId;
    req.session.clienteNombre = usuario.nombre;
    req.session.clienteRol = usuario.rol;
    res.redirect('/panel?ok=' + encodeURIComponent('¡Bienvenido al equipo!'));
  } catch (err) {
    if (err.codigo === 'INVITACION_INVALIDA' || err.codigo === 'EMAIL_DUPLICADO') {
      return res.status(400).render('invitacion', { title: 'Invitación - Proshop', invitacion: null, error: err.message });
    }
    next(err);
  }
});

// -------- Conectar WhatsApp (datos de Meta que registra el cliente) --------
const cripto = require('./lib/crypto');

function datosWebhook(req) {
  const host = req.get('host');
  const proto = req.protocol; // en produccion (detras de proxy) sera https
  return {
    callbackUrl: `${proto}://${host}/webhooks/whatsapp`,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'proshop-verify-token',
  };
}

app.get('/panel/whatsapp', requireCliente, async (req, res, next) => {
  try {
    const agente = await obtenerAgente(req.session.empresaId);
    const conexion = await prisma.conexionWhatsApp.findUnique({ where: { agenteId: agente.id } });
    const wh = datosWebhook(req);
    res.render('cliente/whatsapp', {
      title: 'Conectar WhatsApp - Proshop', tituloPagina: 'Conectar WhatsApp', activo: 'whatsapp',
      conexion,
      tokenEnmascarado: conexion ? cripto.enmascarar(cripto.descifrar(conexion.tokenCifrado)) : '',
      callbackUrl: wh.callbackUrl, verifyToken: wh.verifyToken,
      mensaje: req.query.ok || null, error: req.query.err || null,
    });
  } catch (err) { next(err); }
});

// Solicitar conexion (modelo manual: Proshop la completa despues)
app.post('/panel/whatsapp/solicitar', requireCliente, async (req, res, next) => {
  const { numeroVisible } = req.body || {};
  try {
    if (!numeroVisible || !String(numeroVisible).trim()) {
      return res.redirect('/panel/whatsapp?err=' + encodeURIComponent('Ingresa tu número de WhatsApp.'));
    }
    const agente = await obtenerAgente(req.session.empresaId);
    const numero = String(numeroVisible).trim().slice(0, 20);
    const existente = await prisma.conexionWhatsApp.findUnique({ where: { agenteId: agente.id } });
    if (existente) {
      await prisma.conexionWhatsApp.update({
        where: { agenteId: agente.id },
        data: { numeroVisible: numero, estado: 'EN_PROCESO' },
      });
    } else {
      await prisma.conexionWhatsApp.create({
        data: { agenteId: agente.id, numeroVisible: numero, estado: 'EN_PROCESO' },
      });
    }
    res.redirect('/panel/whatsapp?ok=' + encodeURIComponent('¡Solicitud recibida! Estamos conectando tu número. Puede tardar unas horas.'));
  } catch (err) { next(err); }
});

// Guardar credenciales manualmente (config avanzada / self-service)
app.post('/panel/whatsapp', requireCliente, async (req, res, next) => {
  const { phoneNumberId, wabaId, token } = req.body || {};
  try {
    const agente = await obtenerAgente(req.session.empresaId);
    const existente = await prisma.conexionWhatsApp.findUnique({ where: { agenteId: agente.id } });

    const phone = phoneNumberId ? String(phoneNumberId).trim().slice(0, 60) : null;
    if (phone) {
      const chocA = await prisma.conexionWhatsApp.findUnique({ where: { phoneNumberId: phone } });
      if (chocA && chocA.agenteId !== agente.id) {
        return res.redirect('/panel/whatsapp?err=' + encodeURIComponent('Ese Phone Number ID ya está registrado por otra cuenta.'));
      }
    }

    const datos = {
      phoneNumberId: phone,
      wabaId: wabaId ? String(wabaId).trim().slice(0, 60) : null,
    };
    if (token && String(token).trim()) {
      datos.tokenCifrado = cripto.cifrar(String(token).trim());
    }
    // Si tiene credenciales completas, se considera conectado
    const tieneToken = (token && String(token).trim()) || (existente && existente.tokenCifrado);
    datos.estado = phone && tieneToken ? 'CONECTADO' : (existente ? existente.estado : 'EN_PROCESO');

    if (existente) {
      await prisma.conexionWhatsApp.update({ where: { agenteId: agente.id }, data: datos });
    } else {
      await prisma.conexionWhatsApp.create({ data: { agenteId: agente.id, ...datos } });
    }
    res.redirect('/panel/whatsapp?ok=' + encodeURIComponent('Credenciales guardadas.'));
  } catch (err) { next(err); }
});

// Enviar mensaje de prueba (usa la API real de WhatsApp)
app.post('/panel/whatsapp/prueba', requireCliente, async (req, res, next) => {
  try {
    const agente = await obtenerAgente(req.session.empresaId);
    const conexion = await prisma.conexionWhatsApp.findUnique({ where: { agenteId: agente.id } });
    if (!conexion || conexion.estado !== 'CONECTADO') {
      return res.redirect('/panel/whatsapp?err=' + encodeURIComponent('Tu WhatsApp aún no está conectado.'));
    }
    const wa = require('./lib/services/whatsapp');
    const destino = (conexion.numeroVisible || '').replace(/\D/g, '');
    const r = await wa.enviarTexto(conexion, destino, 'Mensaje de prueba de tu agente Proshop. ¡La conexión funciona! ✅');
    if (r.ok) {
      res.redirect('/panel/whatsapp?ok=' + encodeURIComponent('Mensaje de prueba enviado a ' + conexion.numeroVisible + '.'));
    } else {
      res.redirect('/panel/whatsapp?err=' + encodeURIComponent('No se pudo enviar: ' + r.error));
    }
  } catch (err) { next(err); }
});

// Probar conexion (consulta la Graph API)
app.post('/panel/whatsapp/probar', requireCliente, async (req, res, next) => {
  try {
    const agente = await obtenerAgente(req.session.empresaId);
    const conexion = await prisma.conexionWhatsApp.findUnique({ where: { agenteId: agente.id } });
    const wa = require('./lib/services/whatsapp');
    const r = await wa.verificarConexion(conexion);
    if (r.ok) {
      res.redirect('/panel/whatsapp?ok=' + encodeURIComponent('Conexión OK. Número verificado: ' + (r.numero || '')));
    } else {
      res.redirect('/panel/whatsapp?err=' + encodeURIComponent('La prueba falló: ' + r.error));
    }
  } catch (err) { next(err); }
});

app.post('/panel/whatsapp/eliminar', requireCliente, async (req, res, next) => {
  try {
    const agente = await obtenerAgente(req.session.empresaId);
    await prisma.conexionWhatsApp.deleteMany({ where: { agenteId: agente.id } });
    res.redirect('/panel/whatsapp?ok=' + encodeURIComponent('Número desconectado.'));
  } catch (err) { next(err); }
});

// -------- Probar el agente (chat de prueba) --------
app.get('/panel/agente', requireCliente, async (req, res, next) => {
  try {
    const productos = await prisma.producto.count({
      where: { empresaId: req.session.empresaId, activo: true },
    });
    const { proveedorActivo } = require('./lib/services/agente');
    res.render('cliente/agente', {
      title: 'Probar mi agente - Proshop', tituloPagina: 'Probar mi agente', activo: 'agente',
      productos, iaActiva: proveedorActivo() !== 'demo',
    });
  } catch (err) { next(err); }
});

app.post('/panel/agente/mensaje', requireCliente, async (req, res, next) => {
  const { telefono, mensaje } = req.body || {};
  try {
    if (!mensaje || !String(mensaje).trim()) {
      return res.status(400).json({ ok: false, error: 'Mensaje vacío.' });
    }
    // Toma (o crea/activa) un agente de la empresa
    let agente = await prisma.agente.findFirst({ where: { empresaId: req.session.empresaId } });
    if (!agente) {
      agente = await prisma.agente.create({
        data: { empresaId: req.session.empresaId, nombre: 'Mi agente', estado: 'ACTIVO' },
      });
    } else if (agente.estado !== 'ACTIVO') {
      agente = await prisma.agente.update({ where: { id: agente.id }, data: { estado: 'ACTIVO' } });
    }

    const r = await atenderMensaje({
      agenteId: agente.id,
      telefonoCliente: String(telefono || 'demo').slice(0, 40),
      contenido: String(mensaje).slice(0, 1000),
    });

    // Revisa si hay que avisar (plan por acabar / sin saldo). No bloquea la respuesta.
    notif.verificarAvisos(req.session.empresaId).catch((e) => console.error('verificarAvisos:', e.message));

    if (!r.ok) {
      const motivos = {
        SIN_SALDO: 'Te quedaste sin conversaciones. Compra un paquete para seguir probando.',
        PERIODO_VENCIDO: 'Tu suscripción venció.',
        SUSCRIPCION_INACTIVA: 'Tu suscripción no está activa.',
      };
      return res.json({ ok: false, error: motivos[r.motivo] || 'No se pudo atender el mensaje.' });
    }
    res.json({ ok: true, respuesta: r.respuesta, cobrada: r.cobrada, demo: r.demo, fotos: r.fotos || [] });
  } catch (err) { next(err); }
});

// ==================== WEBHOOK DE WHATSAPP (mensajes reales) ====================
// Un solo endpoint recibe los mensajes de TODOS los agentes (multi-tenant):
// cada evento trae el phone_number_id de Meta, que se busca en
// ConexionWhatsApp para saber a que agente/empresa pertenece. Asi cada
// cliente de Proshop puede tener su propio numero sin webhooks separados.

// Verificacion del webhook (requerida por Meta al configurar la app).
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'proshop-verify-token';

  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Convierte CUALQUIER tipo de mensaje entrante de WhatsApp (texto, foto,
// audio, ubicacion, o una opcion elegida de un menu interactivo) a un texto
// natural en español. Ese texto es lo unico que ve el motor de ventas: asi
// el reconocimiento de fotos, la transcripcion de audio y la ubicacion NO
// duplican el flujo de conversacion, solo alimentan la misma puerta de
// entrada que un mensaje escrito a mano.
async function interpretarMensajeEntrante(mensaje, conexion, telefonoCliente) {
  if (mensaje.text?.body?.trim()) return mensaje.text.body.trim();
  if (mensaje.interactive?.list_reply?.id) return mensaje.interactive.list_reply.id;
  if (mensaje.interactive?.button_reply?.id) return mensaje.interactive.button_reply.id;

  if (mensaje.type === 'image' && mensaje.image?.id) {
    const media = await wa.obtenerMedia(conexion, mensaje.image.id);
    if (!media) return mensaje.image.caption?.trim() || '(el cliente envio una foto que no se pudo descargar)';

    const productos = await prisma.producto.findMany({
      where: { empresaId: conexion.agente.empresaId, activo: true },
      take: 200,
    });
    const descripcion = await analizarImagenProducto(media.buffer, media.mimeType, productos);
    const caption = mensaje.image.caption?.trim();
    const partes = [];
    if (caption) partes.push(caption);
    partes.push(descripcion ? `[Foto enviada por el cliente. Lo que se ve: ${descripcion}]` : '[El cliente envio una foto, pero no se pudo analizar su contenido]');
    return partes.join('\n');
  }

  if (mensaje.type === 'audio' && mensaje.audio?.id) {
    const media = await wa.obtenerMedia(conexion, mensaje.audio.id);
    if (!media) return '(el cliente envio un audio que no se pudo descargar; pidele amablemente que lo escriba)';

    const transcripcion = await transcribirAudio(media.buffer, media.mimeType);
    return transcripcion || '(el cliente envio un audio que no se pudo transcribir; pidele amablemente que lo escriba en texto)';
  }

  if (mensaje.type === 'location' && mensaje.location) {
    const { latitude, longitude, name, address } = mensaje.location;
    const direccionTexto = [name, address].filter(Boolean).join(' - ') || `https://www.google.com/maps?q=${latitude},${longitude}`;

    // Se guarda directo en la BD (dato estructurado real), sin depender de
    // que el modelo "entienda" coordenadas: mas confiable que un texto libre.
    await prisma.clienteFinal.upsert({
      where: { empresaId_telefono: { empresaId: conexion.agente.empresaId, telefono: telefonoCliente } },
      update: { direccionEntrega: direccionTexto, ubicacionLat: latitude, ubicacionLng: longitude },
      create: { empresaId: conexion.agente.empresaId, telefono: telefonoCliente, direccionEntrega: direccionTexto, ubicacionLat: latitude, ubicacionLng: longitude },
    });

    return `[El cliente compartio su ubicacion de entrega: ${direccionTexto}]`;
  }

  return null; // sticker, video, documento, etc.: no soportado por ahora
}

app.post('/webhooks/whatsapp', (req, res) => {
  res.sendStatus(200); // responder rapido a Meta, procesar despues

  (async () => {
    try {
      const entry = req.body.entry?.[0];
      const cambio = entry?.changes?.[0]?.value;
      const mensaje = cambio?.messages?.[0];
      if (!mensaje) return; // eventos de status (entregado/leido), ignorar

      const phoneNumberId = cambio?.metadata?.phone_number_id;
      if (!phoneNumberId) return;

      const conexion = await prisma.conexionWhatsApp.findUnique({
        where: { phoneNumberId },
        include: { agente: true },
      });
      if (!conexion || !conexion.agente) {
        console.log(`--- webhook: no hay ningun agente conectado al phone_number_id ${phoneNumberId}`);
        return;
      }
      if (conexion.agente.estado !== 'ACTIVO') return;

      const telefonoCliente = mensaje.from;
      await prisma.conexionWhatsApp.update({ where: { id: conexion.id }, data: { ultimoMensajeAt: new Date() } });

      const texto = await interpretarMensajeEntrante(mensaje, conexion, telefonoCliente);
      if (!texto) return; // tipo de mensaje no soportado (sticker, video, documento...) o vacio

      // Se cobra y se guarda el mensaje YA (nunca se demora la parte contable).
      // Solo se demora GENERAR la respuesta, por si el cliente manda mas
      // mensajes seguidos sobre la misma idea (ver bufferMensajes.js).
      const entrada = await procesarMensajeEntrante({ agenteId: conexion.agente.id, telefonoCliente, contenido: texto });

      if (!entrada.ok) {
        console.log(`--- webhook: mensaje no atendido (${entrada.motivo}) para agente ${conexion.agente.id}`);
        notif.avisarMensajeNoAtendido(conexion.agente.empresaId, entrada.motivo).catch((e) => console.error('avisarMensajeNoAtendido:', e.message));
        return;
      }

      // Empuja el mensaje del cliente al panel en vivo, sin esperar a que la
      // IA responda (asi el equipo lo ve entrar al instante).
      emitMensaje(conexion.agente.empresaId, {
        conversacionId: entrada.conversacionId, rol: 'CLIENTE', contenido: texto, createdAt: new Date(),
      });

      // Un humano del equipo tiene tomado el control de este chat: la IA no
      // contesta (el mensaje ya quedo guardado arriba, solo se salta la
      // generacion de respuesta automatica).
      if (entrada.modo === 'HUMANO') return;

      encolarRespuesta(`${conexion.agente.id}:${telefonoCliente}`, async () => {
        const salida = await generarYRegistrarRespuesta(conexion.agente.id, telefonoCliente, entrada.conversacionId, texto);
        if (salida.ok && salida.respuesta) {
          const envio = await wa.enviarTexto(conexion, telefonoCliente, salida.respuesta);
          if (!envio.ok) {
            console.error(`--- webhook: fallo el envio por WhatsApp a ${telefonoCliente} (agente ${conexion.agente.id}): ${envio.error}`);
          }
          emitMensaje(conexion.agente.empresaId, {
            conversacionId: entrada.conversacionId, rol: 'AGENTE', contenido: salida.respuesta, createdAt: new Date(),
          });
        }
        notif.verificarAvisos(conexion.agente.empresaId).catch((e) => console.error('verificarAvisos:', e.message));
      });
    } catch (err) {
      console.error('Error procesando webhook de WhatsApp:', err);
    }
  })();
});

// ============================ PANEL ADMIN ============================
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/admin');
  res.render('admin/login', { title: 'Ingreso - Panel Proshop', error: null });
});

app.post('/admin/login', (req, res) => {
  const { usuario, password, recordar } = req.body || {};
  const ok = safeEqual(usuario || '', ADMIN_USER) && safeEqual(password || '', ADMIN_PASSWORD);
  if (!ok) {
    return res
      .status(401)
      .render('admin/login', { title: 'Ingreso - Panel Proshop', error: 'Usuario o contraseña incorrectos.' });
  }
  req.session.authed = true;
  req.session.usuario = ADMIN_USER;
  if (recordar === '1') req.session.cookie.maxAge = SESION_LARGA_MS;
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Datos comunes a todas las vistas del panel (usuario y contador del menu)
app.use('/admin', (req, res, next) => {
  if (req.session && req.session.authed) {
    res.locals.usuario = req.session.usuario;
    res.locals.badgeMensajes = leads.stats().nuevos;
  }
  next();
});

// --- Resumen ---
app.get('/admin', requireAuth, async (req, res, next) => {
  try {
    const [empresas, agentes, conversaciones, planes, paquetes, suscripciones, pagos] =
      await Promise.all([
        prisma.empresa.count(),
        prisma.agente.count(),
        prisma.conversacion.count(),
        prisma.plan.count({ where: { activo: true } }),
        prisma.paquete.count(),
        prisma.suscripcion.count(),
        prisma.pago.count(),
      ]);

    res.render('admin/resumen', {
      title: 'Panel Proshop - Resumen',
      tituloPagina: 'Resumen',
      activo: 'resumen',
      stats: {
        empresas, agentes, conversaciones, planes, paquetes, suscripciones, pagos,
        mensajesNuevos: leads.stats().nuevos,
      },
    });
  } catch (err) { next(err); }
});

// --- Mensajes de contacto (leads del sitio) ---
app.get('/admin/mensajes', requireAuth, (req, res) => {
  const lista = leads.readLeads().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  res.render('admin/mensajes', {
    title: 'Panel Proshop - Mensajes',
    tituloPagina: 'Mensajes',
    activo: 'mensajes',
    leads: lista,
    stats: leads.stats(),
  });
});

// ---------- Utilidades ----------
function slugify(texto) {
  return String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'empresa';
}
function fechaInput(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : '';
}
// Agrega el consumo calculado a una lista de empresas
async function conConsumo(lista) {
  return Promise.all(
    lista.map(async (e) => ({
      ...e,
      consumo: e.suscripcion ? await obtenerEstadoConsumo(e.suscripcion.id) : null,
    }))
  );
}

// ============ REGISTRADOS (empresas cliente) - CRUD ============
app.get('/admin/registrados', requireAuth, async (req, res, next) => {
  try {
    const lista = await prisma.empresa.findMany({
      include: { suscripcion: { include: { plan: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const empresas = await conConsumo(lista);
    const activos = empresas.filter(
      (e) => e.suscripcion && ['ACTIVA', 'PRUEBA'].includes(e.suscripcion.estado)
    ).length;

    res.render('admin/registrados', {
      title: 'Panel Proshop - Registrados',
      tituloPagina: 'Registrados',
      activo: 'registrados',
      empresas,
      stats: { total: empresas.length, activos, inactivos: empresas.length - activos },
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

app.get('/admin/registrados/nuevo', requireAuth, async (req, res, next) => {
  try {
    const planes = await prisma.plan.findMany({ where: { activo: true }, orderBy: { orden: 'asc' } });
    res.render('admin/registrado-form', {
      title: 'Agregar empresa', tituloPagina: 'Agregar empresa', activo: 'registrados',
      empresa: null, planes, error: null,
      periodoFinValor: fechaInput(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  } catch (err) { next(err); }
});

app.post('/admin/registrados', requireAuth, async (req, res, next) => {
  const { nombre, planId, estado, marca, periodoFin } = req.body || {};
  try {
    const planes = await prisma.plan.findMany({ where: { activo: true }, orderBy: { orden: 'asc' } });
    if (!nombre || !planId) {
      return res.status(400).render('admin/registrado-form', {
        title: 'Agregar empresa', tituloPagina: 'Agregar empresa', activo: 'registrados',
        empresa: null, planes, error: 'El nombre y el plan son obligatorios.',
        periodoFinValor: periodoFin || '',
      });
    }

    // Slug unico
    let slug = slugify(nombre);
    if (await prisma.empresa.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36)}`;

    const fin = periodoFin ? new Date(periodoFin) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.empresa.create({
      data: {
        nombre: String(nombre).trim().slice(0, 120),
        slug,
        marca: marca ? String(marca).trim().slice(0, 120) : null,
        suscripcion: {
          create: {
            planId: Number(planId),
            estado: ['PRUEBA', 'ACTIVA', 'MOROSA', 'CANCELADA'].includes(estado) ? estado : 'PRUEBA',
            periodoFin: fin,
          },
        },
      },
    });
    res.redirect('/admin/registrados?ok=' + encodeURIComponent('Empresa creada correctamente.'));
  } catch (err) { next(err); }
});

app.get('/admin/registrados/:id/editar', requireAuth, async (req, res, next) => {
  try {
    const empresa = await prisma.empresa.findUnique({
      where: { id: Number(req.params.id) },
      include: { suscripcion: true },
    });
    if (!empresa) return res.redirect('/admin/registrados');
    const planes = await prisma.plan.findMany({ where: { activo: true }, orderBy: { orden: 'asc' } });
    res.render('admin/registrado-form', {
      title: 'Editar empresa', tituloPagina: 'Editar empresa', activo: 'registrados',
      empresa, planes, error: null,
      periodoFinValor: fechaInput(empresa.suscripcion && empresa.suscripcion.periodoFin),
    });
  } catch (err) { next(err); }
});

app.post('/admin/registrados/:id', requireAuth, async (req, res, next) => {
  const id = Number(req.params.id);
  const { nombre, planId, estado, marca, periodoFin } = req.body || {};
  try {
    await prisma.empresa.update({
      where: { id },
      data: {
        nombre: String(nombre).trim().slice(0, 120),
        marca: marca ? String(marca).trim().slice(0, 120) : null,
      },
    });
    const sub = await prisma.suscripcion.findUnique({ where: { empresaId: id } });
    const datosSub = {
      planId: Number(planId),
      estado: ['PRUEBA', 'ACTIVA', 'MOROSA', 'CANCELADA'].includes(estado) ? estado : 'PRUEBA',
      periodoFin: periodoFin ? new Date(periodoFin) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
    if (sub) await prisma.suscripcion.update({ where: { empresaId: id }, data: datosSub });
    else await prisma.suscripcion.create({ data: { empresaId: id, ...datosSub } });

    res.redirect('/admin/registrados?ok=' + encodeURIComponent('Cambios guardados.'));
  } catch (err) { next(err); }
});

// Simula conversaciones entrantes para verificar el consumo desde el panel.
app.post('/admin/registrados/:id/simular', requireAuth, async (req, res, next) => {
  try {
    const empresaId = Number(req.params.id);
    const cantidad = Math.min(Math.max(parseInt(req.body.cantidad, 10) || 1, 1), 500);

    const empresa = await prisma.empresa.findUnique({
      where: { id: empresaId },
      include: { agentes: true, suscripcion: true },
    });
    if (!empresa || !empresa.suscripcion) {
      return res.redirect('/admin/registrados?ok=' +
        encodeURIComponent('Esa empresa no tiene suscripción.'));
    }

    // Asegura que exista un agente ACTIVO que pueda atender
    let agente = empresa.agentes[0];
    if (!agente) {
      agente = await prisma.agente.create({
        data: { empresaId, nombre: `Agente de ${empresa.nombre}`, estado: 'ACTIVO' },
      });
    } else if (agente.estado !== 'ACTIVO') {
      agente = await prisma.agente.update({ where: { id: agente.id }, data: { estado: 'ACTIVO' } });
    }

    const marca = Date.now().toString().slice(-6);
    let plan = 0, extra = 0, bloqueadas = 0;

    for (let i = 1; i <= cantidad; i++) {
      const r = await procesarMensajeEntrante({
        agenteId: agente.id,
        telefonoCliente: `5917${marca}${String(i).padStart(3, '0')}`,
        contenido: 'Mensaje de prueba (simulación)',
      });
      if (!r.ok) bloqueadas++;
      else if (r.origen === 'EXTRA') extra++;
      else plan++;
    }

    const detalle = [];
    if (plan) detalle.push(`${plan} del plan`);
    if (extra) detalle.push(`${extra} de paquetes`);
    if (bloqueadas) detalle.push(`${bloqueadas} bloqueadas por falta de saldo`);
    const msg = `Simuladas ${cantidad} conversaciones: ${detalle.join(' · ')}`;

    res.redirect('/admin/registrados?ok=' + encodeURIComponent(msg));
  } catch (err) { next(err); }
});

app.post('/admin/registrados/:id/eliminar', requireAuth, async (req, res, next) => {
  try {
    await prisma.empresa.delete({ where: { id: Number(req.params.id) } });
    res.redirect('/admin/registrados?ok=' + encodeURIComponent('Empresa eliminada.'));
  } catch (err) { next(err); }
});

// ============ ACTIVOS ============
app.get('/admin/activos', requireAuth, async (req, res, next) => {
  try {
    const lista = await prisma.empresa.findMany({
      where: { suscripcion: { estado: { in: ['ACTIVA', 'PRUEBA'] } } },
      include: { suscripcion: { include: { plan: true } } },
      orderBy: { nombre: 'asc' },
    });
    const empresas = await conConsumo(lista);
    res.render('admin/activos', {
      title: 'Panel Proshop - Activos', tituloPagina: 'Activos', activo: 'activos',
      empresas,
      stats: {
        activos: empresas.length,
        convDisponibles: empresas.reduce((s, e) => s + (e.consumo ? e.consumo.totalDisponible : 0), 0),
        alLimite: empresas.filter((e) => e.consumo && e.consumo.porcentajeUsado >= 80).length,
      },
    });
  } catch (err) { next(err); }
});

// ============ REGISTRO DE PAQUETES (compras) - CRUD ============
app.get('/admin/compras', requireAuth, async (req, res, next) => {
  try {
    const [compras, empresas] = await Promise.all([
      prisma.compraPaquete.findMany({
        include: { empresa: true, paquete: true },
        orderBy: { fechaCompra: 'desc' },
      }),
      prisma.empresa.findMany({ orderBy: { nombre: 'asc' } }),
    ]);
    const en7dias = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    res.render('admin/compras', {
      title: 'Panel Proshop - Registro de paquetes',
      tituloPagina: 'Registro de paquetes', activo: 'compras',
      compras, empresas,
      stats: {
        total: compras.length,
        saldoTotal: compras
          .filter((c) => c.estado === 'ACTIVA')
          .reduce((s, c) => s + (c.cantidad - c.consumidas), 0),
        porVencer: compras.filter(
          (c) => c.estado === 'ACTIVA' && c.fechaRenovacion <= en7dias
        ).length,
      },
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

// Enviar un aviso manual (notificacion con campanita) a un cliente
app.post('/admin/notificaciones', requireAuth, async (req, res, next) => {
  const { empresaId, titulo, mensaje, conBotones } = req.body || {};
  try {
    if (!empresaId || !mensaje) {
      return res.redirect('/admin/compras?ok=' + encodeURIComponent('Falta el cliente o el mensaje.'));
    }
    await notif.crear(Number(empresaId), {
      titulo: titulo ? String(titulo).slice(0, 120) : 'Aviso de Proshop',
      mensaje: String(mensaje).slice(0, 500),
      tipo: 'MANUAL',
      conBotones: conBotones === '1',
    });
    res.redirect('/admin/compras?ok=' + encodeURIComponent('Aviso enviado al cliente. Le aparecerá en su campanita.'));
  } catch (err) { next(err); }
});

app.get('/admin/compras/nueva', requireAuth, async (req, res, next) => {
  try {
    const [empresas, paquetes] = await Promise.all([
      prisma.empresa.findMany({ orderBy: { nombre: 'asc' } }),
      prisma.paquete.findMany({ where: { activo: true }, orderBy: { cantidad: 'asc' } }),
    ]);
    res.render('admin/compra-form', {
      title: 'Registrar compra', tituloPagina: 'Registrar compra', activo: 'compras',
      compra: null, empresas, paquetes, error: null,
      fechaRenovacionValor: fechaInput(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  } catch (err) { next(err); }
});

app.post('/admin/compras', requireAuth, async (req, res, next) => {
  const { empresaId, paqueteId, cantidad, precioUsd, fechaRenovacion, nota } = req.body || {};
  try {
    const cant = parseInt(cantidad, 10);
    if (!empresaId || !Number.isInteger(cant) || cant <= 0) {
      const [empresas, paquetes] = await Promise.all([
        prisma.empresa.findMany({ orderBy: { nombre: 'asc' } }),
        prisma.paquete.findMany({ where: { activo: true }, orderBy: { cantidad: 'asc' } }),
      ]);
      return res.status(400).render('admin/compra-form', {
        title: 'Registrar compra', tituloPagina: 'Registrar compra', activo: 'compras',
        compra: null, empresas, paquetes,
        error: 'Selecciona un cliente e indica una cantidad válida de conversaciones.',
        fechaRenovacionValor: fechaRenovacion || '',
      });
    }

    await registrarCompraPaquete({
      empresaId: Number(empresaId),
      paqueteId: paqueteId ? Number(paqueteId) : undefined,
      cantidad: cant,
      precioUsd: precioUsd ? Number(precioUsd) : 0,
      fechaRenovacion: fechaRenovacion ? new Date(fechaRenovacion) : undefined,
      nota: nota ? String(nota).slice(0, 200) : undefined,
    });
    res.redirect('/admin/compras?ok=' + encodeURIComponent('Compra registrada correctamente.'));
  } catch (err) { next(err); }
});

app.get('/admin/compras/:id/editar', requireAuth, async (req, res, next) => {
  try {
    const compra = await prisma.compraPaquete.findUnique({ where: { id: Number(req.params.id) } });
    if (!compra) return res.redirect('/admin/compras');
    const [empresas, paquetes] = await Promise.all([
      prisma.empresa.findMany({ orderBy: { nombre: 'asc' } }),
      prisma.paquete.findMany({ where: { activo: true }, orderBy: { cantidad: 'asc' } }),
    ]);
    res.render('admin/compra-form', {
      title: 'Editar compra', tituloPagina: 'Editar compra', activo: 'compras',
      compra, empresas, paquetes, error: null,
      fechaRenovacionValor: fechaInput(compra.fechaRenovacion),
    });
  } catch (err) { next(err); }
});

app.post('/admin/compras/:id', requireAuth, async (req, res, next) => {
  const { empresaId, paqueteId, cantidad, precioUsd, fechaRenovacion, nota, consumidas } = req.body || {};
  try {
    const cant = parseInt(cantidad, 10);
    const usadas = Math.max(0, Math.min(parseInt(consumidas, 10) || 0, cant));
    await prisma.compraPaquete.update({
      where: { id: Number(req.params.id) },
      data: {
        empresaId: Number(empresaId),
        paqueteId: paqueteId ? Number(paqueteId) : null,
        cantidad: cant,
        consumidas: usadas,
        precioUsd: precioUsd ? Number(precioUsd) : 0,
        fechaRenovacion: new Date(fechaRenovacion),
        nota: nota ? String(nota).slice(0, 200) : null,
        estado: usadas >= cant ? 'AGOTADA' : 'ACTIVA',
      },
    });
    res.redirect('/admin/compras?ok=' + encodeURIComponent('Compra actualizada.'));
  } catch (err) { next(err); }
});

app.post('/admin/compras/:id/eliminar', requireAuth, async (req, res, next) => {
  try {
    await prisma.compraPaquete.delete({ where: { id: Number(req.params.id) } });
    res.redirect('/admin/compras?ok=' + encodeURIComponent('Registro eliminado.'));
  } catch (err) { next(err); }
});

// --- Conexiones de WhatsApp (Proshop las conecta manualmente) ---
app.get('/admin/conexiones', requireAuth, async (req, res, next) => {
  try {
    const conexiones = await prisma.conexionWhatsApp.findMany({
      include: { agente: { include: { empresa: true } } },
      orderBy: [{ estado: 'asc' }, { createdAt: 'desc' }],
    });
    res.render('admin/conexiones', {
      title: 'Panel Proshop - Conexiones', tituloPagina: 'Conexiones WhatsApp', activo: 'conexiones',
      conexiones,
      stats: {
        total: conexiones.length,
        enProceso: conexiones.filter((c) => c.estado !== 'CONECTADO').length,
        conectadas: conexiones.filter((c) => c.estado === 'CONECTADO').length,
      },
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

app.post('/admin/conexiones/:id', requireAuth, async (req, res, next) => {
  const { numeroVisible, phoneNumberId, wabaId, token, conectado } = req.body || {};
  try {
    const id = Number(req.params.id);
    const actual = await prisma.conexionWhatsApp.findUnique({ where: { id } });
    if (!actual) return res.redirect('/admin/conexiones');

    const datos = {
      numeroVisible: numeroVisible ? String(numeroVisible).trim().slice(0, 20) : null,
      phoneNumberId: phoneNumberId ? String(phoneNumberId).trim().slice(0, 60) : null,
      wabaId: wabaId ? String(wabaId).trim().slice(0, 60) : null,
      estado: conectado === '1' ? 'CONECTADO' : 'EN_PROCESO',
      verificado: conectado === '1',
    };
    if (token && String(token).trim()) {
      datos.tokenCifrado = cripto.cifrar(String(token).trim());
    }
    await prisma.conexionWhatsApp.update({ where: { id }, data: datos });
    res.redirect('/admin/conexiones?ok=' + encodeURIComponent('Conexión actualizada.'));
  } catch (err) { next(err); }
});

app.post('/admin/conexiones/:id/eliminar', requireAuth, async (req, res, next) => {
  try {
    await prisma.conexionWhatsApp.delete({ where: { id: Number(req.params.id) } });
    res.redirect('/admin/conexiones?ok=' + encodeURIComponent('Conexión eliminada.'));
  } catch (err) { next(err); }
});

// --- Usuarios y planes ---
app.get('/admin/usuarios', requireAuth, async (req, res, next) => {
  try {
    const usuarios = await prisma.usuario.findMany({
      where: { rol: { not: 'PROSHOP_ADMIN' } },
      include: { empresa: { include: { suscripcion: { include: { plan: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    const conPlan = usuarios.filter((u) => u.empresa && u.empresa.suscripcion).length;
    const dePago = usuarios.filter(
      (u) => u.empresa && u.empresa.suscripcion && Number(u.empresa.suscripcion.plan.mensualidadBs) > 0
    ).length;
    res.render('admin/usuarios', {
      title: 'Panel Proshop - Usuarios', tituloPagina: 'Usuarios', activo: 'usuarios',
      usuarios, stats: { total: usuarios.length, conPlan, dePago },
    });
  } catch (err) { next(err); }
});

// --- Seguimiento de mensajes (conversaciones restantes por cliente) ---
app.get('/admin/seguimiento', requireAuth, async (req, res, next) => {
  try {
    const empresas = await prisma.empresa.findMany({
      where: { suscripcion: { isNot: null } },
      include: {
        suscripcion: { include: { plan: true } },
        comprasPaquete: { orderBy: { fechaCompra: 'desc' } },
      },
      orderBy: { nombre: 'asc' },
    });

    const filas = await Promise.all(
      empresas.map(async (e) => ({
        empresa: e,
        plan: e.suscripcion.plan,
        suscripcion: e.suscripcion,
        consumo: await obtenerEstadoConsumo(e.suscripcion.id),
        paquetes: e.comprasPaquete.filter((c) => c.estado !== 'VENCIDA'),
      }))
    );

    res.render('admin/seguimiento', {
      title: 'Panel Proshop - Seguimiento', tituloPagina: 'Seguimiento de mensajes', activo: 'seguimiento',
      filas,
      stats: {
        clientes: filas.length,
        totalDisponible: filas.reduce((s, f) => s + f.consumo.totalDisponible, 0),
        sinSaldo: filas.filter((f) => f.consumo.totalDisponible === 0).length,
      },
    });
  } catch (err) { next(err); }
});

// --- Empresas cliente ---
app.get('/admin/empresas', requireAuth, async (req, res, next) => {
  try {
    const lista = await prisma.empresa.findMany({
      include: { suscripcion: { include: { plan: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // Calcula el consumo de cada empresa que tenga suscripcion
    const empresas = await Promise.all(
      lista.map(async (e) => ({
        ...e,
        consumo: e.suscripcion ? await obtenerEstadoConsumo(e.suscripcion.id) : null,
      }))
    );
    res.render('admin/empresas', {
      title: 'Panel Proshop - Empresas',
      tituloPagina: 'Empresas',
      activo: 'empresas',
      empresas,
    });
  } catch (err) { next(err); }
});

// --- Agentes ---
app.get('/admin/agentes', requireAuth, async (req, res, next) => {
  try {
    const agentes = await prisma.agente.findMany({
      include: { empresa: true, conexion: true, _count: { select: { conversaciones: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.render('admin/agentes', {
      title: 'Panel Proshop - Agentes',
      tituloPagina: 'Agentes',
      activo: 'agentes',
      agentes,
    });
  } catch (err) { next(err); }
});

// --- Planes ---
// Muestra TODOS los planes (activos e inactivos): esta es la pantalla de
// gestion, no la vitrina publica (esa sigue filtrando por activo en "/").
app.get('/admin/planes', requireAuth, async (req, res, next) => {
  try {
    const planes = await prisma.plan.findMany({ orderBy: { orden: 'asc' } });
    res.render('admin/planes', {
      title: 'Panel Proshop - Planes',
      tituloPagina: 'Planes',
      activo: 'planes',
      planes,
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

app.get('/admin/planes/nuevo', requireAuth, (req, res) => {
  res.render('admin/plan-form', {
    title: 'Nuevo plan - Proshop', tituloPagina: 'Nuevo plan', activo: 'planes',
    plan: null, error: null,
  });
});

function datosPlanDesdeForm(body) {
  // Los *Usd son opcionales (default para paises "extra" sin precio propio):
  // si el campo viene vacio, se guarda null, NO 0 (0 se mostraria como
  // "gratis" a cualquier pais sin configurar, que no es lo que se quiere).
  const usdOpcional = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v));
  return {
    codigo: String(body.codigo || '').trim().toUpperCase().slice(0, 30),
    nombre: String(body.nombre || '').trim().slice(0, 80),
    mensualidadBs: Number(body.mensualidadBs) || 0,
    implementacionBs: Number(body.implementacionBs) || 0,
    primerPagoBs: Number(body.primerPagoBs) || 0,
    mensualidadUsd: usdOpcional(body.mensualidadUsd),
    implementacionUsd: usdOpcional(body.implementacionUsd),
    primerPagoUsd: usdOpcional(body.primerPagoUsd),
    convIncluidas: parseInt(body.convIncluidas, 10) || 0,
    maxProductos: parseInt(body.maxProductos, 10) || 0,
    maxUsuarios: parseInt(body.maxUsuarios, 10) || 1,
    modeloIa: String(body.modeloIa || 'claude-haiku-4-5').trim().slice(0, 60),
    marcaBlanca: body.marcaBlanca === '1',
    recomendado: body.recomendado === '1',
    orden: parseInt(body.orden, 10) || 0,
    features: (body.features || '').split('\n').map((f) => f.trim()).filter(Boolean),
  };
}

app.post('/admin/planes', requireAuth, async (req, res, next) => {
  try {
    const datos = datosPlanDesdeForm(req.body || {});
    if (!datos.codigo || !datos.nombre) {
      return res.status(400).render('admin/plan-form', {
        title: 'Nuevo plan - Proshop', tituloPagina: 'Nuevo plan', activo: 'planes',
        plan: req.body, error: 'El código y el nombre son obligatorios.',
      });
    }
    await prisma.plan.create({ data: datos });
    res.redirect('/admin/planes?ok=' + encodeURIComponent('Plan creado.'));
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).render('admin/plan-form', {
        title: 'Nuevo plan - Proshop', tituloPagina: 'Nuevo plan', activo: 'planes',
        plan: req.body, error: 'Ya existe un plan con ese código.',
      });
    }
    next(err);
  }
});

app.get('/admin/planes/:id/editar', requireAuth, async (req, res, next) => {
  try {
    const plan = await prisma.plan.findUnique({
      where: { id: Number(req.params.id) },
      include: { preciosPais: { orderBy: { pais: 'asc' } } },
    });
    if (!plan) return res.redirect('/admin/planes');
    res.render('admin/plan-form', {
      title: 'Editar plan - Proshop', tituloPagina: 'Editar plan', activo: 'planes',
      plan, error: null, mensaje: req.query.ok || null, errorPrecioPais: req.query.err || null,
    });
  } catch (err) { next(err); }
});

app.post('/admin/planes/:id', requireAuth, async (req, res, next) => {
  try {
    await prisma.plan.update({ where: { id: Number(req.params.id) }, data: datosPlanDesdeForm(req.body || {}) });
    res.redirect('/admin/planes?ok=' + encodeURIComponent('Plan actualizado.'));
  } catch (err) { next(err); }
});

// Precio propio de un pais para este plan (crea si no existe, actualiza si
// ya existe - mismo pais+plan es unico en el schema).
app.post('/admin/planes/:id/precios-pais', requireAuth, async (req, res, next) => {
  try {
    const planId = Number(req.params.id);
    const pais = String(req.body.pais || '').trim().toUpperCase().slice(0, 2);
    const moneda = String(req.body.moneda || '').trim().toUpperCase().slice(0, 3);
    const mensualidad = Number(req.body.mensualidad) || 0;
    const implementacion = Number(req.body.implementacion) || 0;
    const primerPago = Number(req.body.primerPago) || 0;
    if (!pais || !moneda) {
      return res.redirect(`/admin/planes/${planId}/editar?err=` + encodeURIComponent('País y moneda son obligatorios.'));
    }
    await prisma.planPrecioPais.upsert({
      where: { planId_pais: { planId, pais } },
      create: { planId, pais, moneda, mensualidad, implementacion, primerPago },
      update: { moneda, mensualidad, implementacion, primerPago },
    });
    res.redirect(`/admin/planes/${planId}/editar?ok=` + encodeURIComponent(`Precio para ${pais} guardado.`));
  } catch (err) { next(err); }
});

app.post('/admin/planes/:id/precios-pais/:precioPaisId/eliminar', requireAuth, async (req, res, next) => {
  try {
    await prisma.planPrecioPais.deleteMany({ where: { id: Number(req.params.precioPaisId), planId: Number(req.params.id) } });
    res.redirect(`/admin/planes/${req.params.id}/editar?ok=` + encodeURIComponent('Precio eliminado.'));
  } catch (err) { next(err); }
});

// Los planes no se borran (quedan referenciados por suscripciones existentes):
// se activan/desactivan. Un plan inactivo desaparece de la vitrina publica
// del sitio pero las empresas que ya lo tienen contratado no se ven afectadas.
app.post('/admin/planes/:id/activo', requireAuth, async (req, res, next) => {
  try {
    const plan = await prisma.plan.findUnique({ where: { id: Number(req.params.id) } });
    if (!plan) return res.redirect('/admin/planes');
    await prisma.plan.update({ where: { id: plan.id }, data: { activo: !plan.activo } });
    res.redirect('/admin/planes?ok=' + encodeURIComponent(plan.activo ? 'Plan desactivado.' : 'Plan activado.'));
  } catch (err) { next(err); }
});

// --- Paquetes ---
app.get('/admin/paquetes', requireAuth, async (req, res, next) => {
  try {
    const paquetes = await prisma.paquete.findMany({ orderBy: { cantidad: 'asc' } });
    res.render('admin/paquetes', {
      title: 'Panel Proshop - Paquetes',
      tituloPagina: 'Paquetes',
      activo: 'paquetes',
      paquetes,
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

app.get('/admin/paquetes/nuevo', requireAuth, (req, res) => {
  res.render('admin/paquete-form', {
    title: 'Nuevo paquete - Proshop', tituloPagina: 'Nuevo paquete', activo: 'paquetes',
    paquete: null, error: null,
  });
});

function datosPaqueteDesdeForm(body) {
  return {
    cantidad: parseInt(body.cantidad, 10) || 0,
    precioUsd: Number(body.precioUsd) || 0,
    costoUnitarioUsd: Number(body.costoUnitarioUsd) || 0,
  };
}

app.post('/admin/paquetes', requireAuth, async (req, res, next) => {
  try {
    const datos = datosPaqueteDesdeForm(req.body || {});
    if (datos.cantidad <= 0 || datos.precioUsd <= 0) {
      return res.status(400).render('admin/paquete-form', {
        title: 'Nuevo paquete - Proshop', tituloPagina: 'Nuevo paquete', activo: 'paquetes',
        paquete: req.body, error: 'La cantidad y el precio deben ser mayores a cero.',
      });
    }
    await prisma.paquete.create({ data: datos });
    res.redirect('/admin/paquetes?ok=' + encodeURIComponent('Paquete creado.'));
  } catch (err) { next(err); }
});

app.get('/admin/paquetes/:id/editar', requireAuth, async (req, res, next) => {
  try {
    const paquete = await prisma.paquete.findUnique({
      where: { id: Number(req.params.id) },
      include: { preciosPais: { orderBy: { pais: 'asc' } } },
    });
    if (!paquete) return res.redirect('/admin/paquetes');
    res.render('admin/paquete-form', {
      title: 'Editar paquete - Proshop', tituloPagina: 'Editar paquete', activo: 'paquetes',
      paquete, error: null, mensaje: req.query.ok || null, errorPrecioPais: req.query.err || null,
    });
  } catch (err) { next(err); }
});

app.post('/admin/paquetes/:id', requireAuth, async (req, res, next) => {
  try {
    await prisma.paquete.update({ where: { id: Number(req.params.id) }, data: datosPaqueteDesdeForm(req.body || {}) });
    res.redirect('/admin/paquetes?ok=' + encodeURIComponent('Paquete actualizado.'));
  } catch (err) { next(err); }
});

// Precio propio de un pais para este paquete (crea si no existe, actualiza si ya existe).
app.post('/admin/paquetes/:id/precios-pais', requireAuth, async (req, res, next) => {
  try {
    const paqueteId = Number(req.params.id);
    const pais = String(req.body.pais || '').trim().toUpperCase().slice(0, 2);
    const moneda = String(req.body.moneda || '').trim().toUpperCase().slice(0, 3);
    const precio = Number(req.body.precio) || 0;
    const costoUnitario = Number(req.body.costoUnitario) || 0;
    if (!pais || !moneda) {
      return res.redirect(`/admin/paquetes/${paqueteId}/editar?err=` + encodeURIComponent('País y moneda son obligatorios.'));
    }
    await prisma.paquetePrecioPais.upsert({
      where: { paqueteId_pais: { paqueteId, pais } },
      create: { paqueteId, pais, moneda, precio, costoUnitario },
      update: { moneda, precio, costoUnitario },
    });
    res.redirect(`/admin/paquetes/${paqueteId}/editar?ok=` + encodeURIComponent(`Precio para ${pais} guardado.`));
  } catch (err) { next(err); }
});

app.post('/admin/paquetes/:id/precios-pais/:precioPaisId/eliminar', requireAuth, async (req, res, next) => {
  try {
    await prisma.paquetePrecioPais.deleteMany({ where: { id: Number(req.params.precioPaisId), paqueteId: Number(req.params.id) } });
    res.redirect(`/admin/paquetes/${req.params.id}/editar?ok=` + encodeURIComponent('Precio eliminado.'));
  } catch (err) { next(err); }
});

// Los paquetes tampoco se borran (compras existentes los referencian): se
// activan/desactivan. Inactivo = deja de ofrecerse en "Comprar paquete".
app.post('/admin/paquetes/:id/activo', requireAuth, async (req, res, next) => {
  try {
    const paquete = await prisma.paquete.findUnique({ where: { id: Number(req.params.id) } });
    if (!paquete) return res.redirect('/admin/paquetes');
    await prisma.paquete.update({ where: { id: paquete.id }, data: { activo: !paquete.activo } });
    res.redirect('/admin/paquetes?ok=' + encodeURIComponent(paquete.activo ? 'Paquete desactivado.' : 'Paquete activado.'));
  } catch (err) { next(err); }
});

// --- Pagos ---
app.get('/admin/pagos', requireAuth, async (req, res, next) => {
  try {
    const pagos = await prisma.pago.findMany({
      include: { empresa: true },
      orderBy: { fecha: 'desc' },
      take: 100,
    });
    res.render('admin/pagos', {
      title: 'Panel Proshop - Pagos',
      tituloPagina: 'Pagos',
      activo: 'pagos',
      pagos,
      mensaje: req.query.ok || null,
    });
  } catch (err) { next(err); }
});

// Confirmar un pago pendiente: activa lo que corresponda segun el tipo.
// Antes esta pantalla era solo de lectura, un pago quedaba "PENDIENTE" para
// siempre y jamas pasaba nada (los paquetes ya se acreditaban solos al
// comprar, sin relacion real con si se pagaba o no).
app.post('/admin/pagos/:id/confirmar', requireAuth, async (req, res, next) => {
  try {
    const pago = await prisma.pago.findUnique({ where: { id: Number(req.params.id) } });
    if (!pago || pago.estado !== 'PENDIENTE') return res.redirect('/admin/pagos');

    await prisma.pago.update({ where: { id: pago.id }, data: { estado: 'CONFIRMADO' } });

    if (pago.tipo === 'PRIMER_PAGO' || pago.tipo === 'MENSUALIDAD') {
      const suscripcion = await prisma.suscripcion.findUnique({ where: { empresaId: pago.empresaId } });
      if (suscripcion) {
        await prisma.suscripcion.update({
          where: { id: suscripcion.id },
          data: {
            estado: 'ACTIVA',
            periodoInicio: new Date(),
            periodoFin: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
      }
      await notif.crear(pago.empresaId, {
        titulo: 'Tu pago fue confirmado',
        mensaje: 'Confirmamos tu pago: tu plan ya está activo por 30 días más.',
        tipo: 'PAGO_CONFIRMADO',
      });
    } else if (pago.tipo === 'PAQUETE' && pago.compraPaqueteId) {
      await prisma.compraPaquete.update({ where: { id: pago.compraPaqueteId }, data: { estado: 'ACTIVA' } });
      await notif.crear(pago.empresaId, {
        titulo: 'Tu paquete ya está disponible',
        mensaje: 'Confirmamos tu pago: las conversaciones del paquete ya se sumaron a tu saldo.',
        tipo: 'PAGO_CONFIRMADO',
      });
    }

    res.redirect('/admin/pagos?ok=' + encodeURIComponent('Pago confirmado.'));
  } catch (err) { next(err); }
});

// Rechazar un pago pendiente: si era de un paquete, revoca esa compra (nunca
// llego a dar saldo real gracias a que se crea en PENDIENTE).
app.post('/admin/pagos/:id/rechazar', requireAuth, async (req, res, next) => {
  try {
    const pago = await prisma.pago.findUnique({ where: { id: Number(req.params.id) } });
    if (!pago || pago.estado !== 'PENDIENTE') return res.redirect('/admin/pagos');

    await prisma.pago.update({ where: { id: pago.id }, data: { estado: 'FALLIDO' } });

    if (pago.tipo === 'PAQUETE' && pago.compraPaqueteId) {
      await prisma.compraPaquete.update({ where: { id: pago.compraPaqueteId }, data: { estado: 'RECHAZADA' } });
    }

    await notif.crear(pago.empresaId, {
      titulo: 'No pudimos confirmar tu pago',
      mensaje: 'Tu pago no pudo confirmarse. Contáctanos para resolverlo y activar tu servicio.',
      tipo: 'PAGO_RECHAZADO',
    });

    res.redirect('/admin/pagos?ok=' + encodeURIComponent('Pago marcado como fallido.'));
  } catch (err) { next(err); }
});

app.post('/admin/leads/:id/estado', requireAuth, (req, res) => {
  const nuevoEstado = req.body.estado === 'atendido' ? 'atendido' : 'nuevo';
  leads.updateLead(req.params.id, { estado: nuevoEstado });
  res.redirect('/admin/mensajes');
});

app.post('/admin/leads/:id/eliminar', requireAuth, (req, res) => {
  leads.deleteLead(req.params.id);
  res.redirect('/admin/mensajes');
});

// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Pagina no encontrada' });
});

// Servidor HTTP explicito (en vez de app.listen) para poder colgarle
// Socket.IO encima y que comparta el mismo puerto.
const http = require('http');
const httpServer = http.createServer(app);
initSocket(httpServer, sessionMiddleware);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ${site.name} corriendo en http://0.0.0.0:${PORT}`);
  console.log(`  Panel admin: http://0.0.0.0:${PORT}/admin`);
  console.log(`  [DIAGNOSTICO] OPENAI_API_KEY presente: ${Boolean(process.env.OPENAI_API_KEY)} (largo: ${(process.env.OPENAI_API_KEY || '').length})`);
  console.log(`  [DIAGNOSTICO] ANTHROPIC_API_KEY presente: ${Boolean(process.env.ANTHROPIC_API_KEY)}\n`);
  iniciarJobFacturacion();
});
