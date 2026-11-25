# Bot de citas por WhatsApp: lógica y flujo completos

Documento generado a partir del código del repositorio (rama `main`). Todo el código citado es el real, sin simplificar.
Archivos principales: `lib/services/botCitas.js` (el bot), `lib/services/agenda.js` (motor de agenda), `lib/services/configAgenda.js` (reglas del negocio), `lib/services/recordatorios.js` (recordatorios), `lib/services/citasPanel.js` (estados desde el panel), `lib/services/opiniones.js` (pedido de comentarios), `lib/services/conversaciones.js` (punto de entrada).

---

## 1. Idea general

- **El backend decide y la IA no interviene.** Los horarios libres, los cupos y la creación de la cita salen del motor de agenda (`agenda.js`). Nada de lo que ve el cliente lo escribe una IA.
- **Determinista primero.** El recorrido completo (servicio → profesional → día → hora → nombre → resumen → confirmar) se hace con **listas y botones de WhatsApp**. Cuesta **0 llamadas a la IA**; sin IA el bot atiende exactamente igual.
- **Los textos salen del catálogo de mensajes** (claves `citas_*` en `lib/services/mensajesBase.js`), que el negocio puede editar. Los textos admiten voseo/tuteo con `{r:querés|quieres}` y el vocabulario del rubro con `{{vocab.cita}}`, `{{vocab.servicio}}`, `{{vocab.profesional}}`.
- **Estado casi nulo en el servidor.** Cada botón o fila lleva en su ID **toda la selección hecha hasta ese momento**, así un botón viejo nunca queda con datos equivocados. Lo único con estado es "esperando el nombre" y las opciones del último mensaje (para contestar con un número). Ambos viven 30 minutos en `ClienteFinal.contexto.citas`.
- **Un cliente a la vez.** Dos toques seguidos (o simultáneos) del mismo botón no pueden crear dos citas: hay un bloqueo por cliente.

## 2. Cómo llega un mensaje al bot

1. Meta llama al webhook de WhatsApp; el mensaje se registra y se cobra (créditos / conversaciones) de inmediato.
2. `generarYRegistrarRespuesta` (en `conversaciones.js`) mira si el negocio es de modelo `CITAS`. Si lo es, responde `botCitas.responderCitas`; si no, el motor de ventas con IA.
3. La respuesta (texto, lista o botones) se guarda como mensaje del agente y se envía.

```js
// lib/services/conversaciones.js (fragmento)
const agenteDeCitas = await agenteSiEsDeCitas(agenteId);
const atender = async () => {
  const s = await (agenteDeCitas
    ? require('./botCitas').responderCitas({ empresa: agenteDeCitas.empresa, config: agenteDeCitas.config, telefonoCliente, texto: contenido, idBoton: extra.idBoton || null })
    : generarRespuesta(agenteId, telefonoCliente, historial, contenido, conversacionId, { baseUrl, modoPrueba, ...extra }));
  // Creditos: un turno que uso la IA cuesta (en modo sombra solo se anota). Nunca rompe la respuesta.
  await require('./creditosConsumo').cobrarTurnoIA({ empresaId: empresaTraza, modoPrueba });
  return s;
};
```

## 3. Orden de decisión dentro del bot (`atender`)

Para cada mensaje, en este orden:

1. **Toque de botón o lista** (o el número / nombre de una opción mostrada, si WhatsApp mandó la lista como texto). Los IDs empiezan con `ct:`.
2. **Esperando el nombre** para cerrar la cita (paso `nombre`).
3. **Texto libre**, resuelto por código:
   1. Guardia contra manipulación (`guardia.evaluarEntrada`) → mensaje `citas_alcance`.
   2. Preguntas frecuentes del negocio (`faq.coincideFaq`).
   3. Intención por palabras: asesor, información, mi cita / cancelar / reprogramar, agendar, saludo.
   4. Fecha, hora, servicio y profesional que el cliente nombró ("mañana a las 4 corte con Marta").
   5. Si no se entiende nada → `citas_menu_aclarar` y vuelve al menú.

Un error inesperado se captura y se responde con el mensaje `error_tecnico`.

## 4. Diagrama del flujo

```
Mensaje del cliente
   |
   |-- ¿botón/lista "ct:..."? --> porId(): ejecuta la acción del botón
   |
   |-- ¿esperando nombre? -----> recibirNombre(): guarda nombre --> resumen
   |
   '-- texto libre --> guardia --> FAQ --> intención
                          |
        +-----------------+-------------------------------+
      asesor         info / mi cita                 agendar / servicio / fecha
     derivar()     info() / miCita()                        |
                                          elegirServicio --> (personas) --> elegirProfesional
                                                                                  |
                                                                        elegirDia (14 días)
                                                                                  |
                                                                        elegirHora (mañana / tarde)
                                                                                  |
                                                    resumen(): verifica el horario --> ¿nombre válido?
                                                          | no: pide el nombre --> recibirNombre --+
                                                          | sí  <------------------------------------+
                                                    [Confirmar] --> confirmar() --> agenda.crearCita
                                                                                  |
                                                                  "¡Listo, queda agendado!"
```

## 5. Formato de los IDs de botón

`ct:<acción>:<servicio>:<recurso>:<personas>:<cita que se mueve>:<a>:<b>`

Ejemplo: `ct:hr:3:7:1:0:2026-11-24:1030` = acción "hora elegida", servicio 3, profesional 7, 1 persona, no es reprogramación, fecha 2026-11-24, hora 10:30.

| Acción | Qué hace |
|---|---|
| `menu` | Vuelve al menú inicial y limpia el estado |
| `agendar` | Empieza el recorrido (elige servicio) |
| `svmas` | "Ver más" de la lista de servicios (a = desde dónde) |
| `sv` | Servicio elegido |
| `pe` | Cantidad de personas elegida |
| `pr` | Profesional elegido (`rec=0` = cualquiera disponible) |
| `dias` | "Ver más días" (a = fecha desde la que mostrar) |
| `dia` | Día elegido (a = fecha) |
| `hmas` | "Ver más horarios" (b = desde qué posición) |
| `hr` | Hora elegida (a = fecha, b = HHMM) → resumen |
| `ok` | Confirmar la cita (a = fecha, b = HHMM) |
| `micita` | Muestra las citas próximas del cliente |
| `ver` | Ver una cita concreta (a = id de cita) |
| `rep` | Cambiar horario de una cita (a = id) |
| `can` / `can2` | Pedir cancelación / confirmar cancelación (a = id) |
| `rok` | "Confirmo" tocado en un recordatorio (a = id) |
| `info` / `loc` | Ubicación y horarios / cómo llegar |

Código de IDs, paginación y utilidades:

```js
const TTL_ESTADO_MS = 30 * 60 * 1000;
const DIAS_A_OFRECER = 14;
const MAX_PERSONAS_LISTA = 8;
const PREFIJO = 'ct';

// ------------------------------------------------------------------ utilidades

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ:/\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const recortar = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** ID de un botón/fila: lleva toda la selección. */
function packId(accion, p = {}) {
  return [PREFIJO, accion, p.sv || 0, p.rec || 0, p.n || 1, p.rp || 0, p.a ?? '', p.b ?? ''].join(':');
}
function leerId(texto) {
  const x = String(texto || '').split(':');
  if (x[0] !== PREFIJO || !x[1]) return null;
  return { accion: x[1], sv: Number(x[2]) || 0, rec: Number(x[3]) || 0, n: Number(x[4]) || 1, rp: Number(x[5]) || 0, a: x[6] || null, b: x[7] || null };
}
const conservar = (p, extra = {}) => ({ sv: p.sv, rec: p.rec, n: p.n, rp: p.rp, ...extra });

const hhmmDeId = (b) => (b && /^\d{4}$/.test(b) ? `${b.slice(0, 2)}:${b.slice(2)}` : null);
const idDeHora = (hora) => hora.replace(':', '');

/** Pagina una lista de WhatsApp (máx. 10 filas): si sobran, la última fila es "Ver más". */
function paginar(items, inicio, tamano = 10) {
  const resto = items.slice(inicio);
  if (resto.length <= tamano) return { visibles: resto, hayMas: false, siguiente: inicio + resto.length };
  return { visibles: resto.slice(0, tamano - 1), hayMas: true, siguiente: inicio + tamano - 1 };
}
```

## 6. Interpretación de texto libre (sin IA)

El bot entiende fechas, horas, servicios y profesionales por palabras. Es una búsqueda por reglas: no entiende sinónimos raros, pero lo que no entiende vuelve al menú y la reserva se completa tocando opciones.

- **Fechas:** "hoy", "mañana", "pasado mañana", "el viernes", "15/11". "de la mañana" se entiende como hora del día, no como día siguiente.
- **Horas:** "a las 4", "16:30", "10 de la mañana", "3pm". Sin aclaración, de 1 a 7 se entiende de la tarde.
- **Servicio / profesional:** gana el de mayor cobertura de palabras; si hay empate no adivina.
- **Intenciones:** asesor, cancelar, reprogramar, mi cita, información, agendar, saludo.
- **Saludo solo** ("Hola, buen día", "Buenas tardes, ¿cómo están?") abre el menú en vez de caer en "no entendí".

```js
const SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

/** "hoy", "mañana", "pasado mañana", "el viernes", "15/11" → 'YYYY-MM-DD' (o null). */
function interpretarFecha(texto, hoy) {
  const t = norm(texto);
  if (/\bpasado manana\b/.test(t)) return T.sumarDias(hoy, 2);
  // "de la mañana" es una hora del día, no el día siguiente.
  if (/\bmanana\b/.test(t) && !/\b(de|por|en|a) la manana\b/.test(t)) return T.sumarDias(hoy, 1);
  if (/\bhoy\b/.test(t)) return hoy;
  for (const [nombre, dow] of Object.entries(SEMANA)) {
    if (new RegExp(`\\b${nombre}s?\\b`).test(t)) {
      let f = T.sumarDias(hoy, 1);
      for (let i = 0; i < 7; i++) { if (T.diaSemanaDe(f) === dow) return f; f = T.sumarDias(f, 1); }
    }
  }
  const m = t.match(/\b(\d{1,2})[/-](\d{1,2})\b/);
  if (m) {
    const dia = Number(m[1]); const mes = Number(m[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      let anio = Number(hoy.slice(0, 4));
      let f = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      if (!T.esFecha(f)) return null;
      if (f < hoy) { anio += 1; f = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`; }
      return T.esFecha(f) ? f : null;
    }
  }
  return null;
}

/** "a las 4", "16:30", "10 de la mañana", "3pm" → 'HH:MM' (o null). Sin aclaración, de 1 a 7 se entiende de la tarde. */
function interpretarHora(texto) {
  const t = norm(texto);
  let m = t.match(/\b(?:a las|a la|las|la)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|hs|h|horas)?\b/) || t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/) || t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (!m) return null;
  let hora = Number(m[1]);
  const min = /^\d{2}$/.test(m[2] || '') ? Number(m[2]) : 0;
  const sufijo = [m[2], m[3]].find((x) => x === 'am' || x === 'pm') || null;
  if (hora > 23 || min > 59) return null;
  const tarde = sufijo === 'pm' || /\bde la (tarde|noche)\b/.test(t);
  const manana = sufijo === 'am' || /\bde la manana\b/.test(t);
  if (tarde && hora < 12) hora += 12;
  else if (!tarde && !manana && !sufijo && hora >= 1 && hora <= 7) hora += 12;
  return `${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const PALABRAS_VACIAS = new Set(['para', 'por', 'con', 'una', 'uno', 'del', 'los', 'las', 'que', 'quiero', 'cita', 'turno', 'reserva', 'visita', 'agendar', 'reservar']);
const palabrasClave = (texto) => norm(texto).split(' ').filter((w) => w.length >= 3 && !PALABRAS_VACIAS.has(w));

/** El servicio (o recurso) que el cliente nombró: el de mayor cobertura; si hay empate no adivina. */
function buscarPorNombre(texto, candidatos, campo = 'nombre') {
  const t = ` ${norm(texto)} `;
  const puntuados = candidatos.map((c) => {
    const claves = palabrasClave(c[campo]);
    const aciertos = claves.filter((w) => t.includes(` ${w} `) || t.includes(` ${w.replace(/s$/, '')} `)).length;
    return { c, aciertos, cobertura: claves.length ? aciertos / claves.length : 0 };
  }).filter((x) => x.aciertos > 0).sort((a, b) => b.cobertura - a.cobertura || b.aciertos - a.aciertos);
  if (!puntuados.length) return null;
  if (puntuados.length > 1 && puntuados[0].cobertura === puntuados[1].cobertura && puntuados[0].aciertos === puntuados[1].aciertos) return null;
  return puntuados[0].c;
}

/** Qué quiere el cliente (por palabras). */
function intencionDe(texto) {
  const t = ` ${norm(texto)} `;
  if (/ (asesor|asesora|persona|humano|operador|operadora) /.test(t) || / hablar con alguien /.test(t)) return 'asesor';
  if (/ (cancel\w*|anul\w*) /.test(t)) return 'cancelar';
  if (/ (reprogram\w*|reagend\w*) /.test(t) || /( cambiar| mover| pasar| posponer) .*(cita|turno|reserva|visita|hora|dia)/.test(t)) return 'reprogramar';
  if (/ (mi|mis) (cita|citas|turno|turnos|reserva|reservas|visita|visitas) /.test(t) || / cuando (es|tengo|era) /.test(t)) return 'micita';
  if (/ (donde|ubicacion|direccion|mapa) /.test(t) || / como (llego|llegar) /.test(t)) return 'info';
  // "¿Qué horarios tiene libre?" o "quiero una cita, ¿en qué horario?" es agendar, no preguntar el horario de atención.
  if (/ (agendar|agendo|agendame|reservar|reservo|cita|turno|disponib\w*|libre|libres) /.test(t)) return 'agendar';
  if (/ (horario|horarios|abren|cierran|atienden|atencion) /.test(t)) return 'info';
  if (/ (agendar|agendo|reservar|reserva|cita|turno|disponib\w*|libre|libres|lugar|espacio) /.test(t)) return 'agendar';
  if (/^ (hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|menu|inicio|empezar|ayuda) $/.test(t) || esSaludo(t)) return 'menu';
  return null;
}

// Un mensaje que es SOLO un saludo ("Hola, buen día", "Buenas tardes, ¿cómo están?", "Hola 👋") abre el menú, no cae en "no entendí".
// Se exige al menos una palabra de saludo y que todo lo demás sean palabras de cortesía: cualquier otra palabra ya es otra intención.
const PALABRAS_SALUDO = new Set(['hola', 'holi', 'holaa', 'ola', 'hey', 'ey', 'hello', 'hi', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'saludos', 'saludo']);
const PALABRAS_CORTESIA = new Set(['que', 'tal', 'como', 'estas', 'estan', 'esta', 'andas', 'andan', 'va', 'les', 'te', 'a', 'todos', 'todas', 'ustedes', 'un', 'para', 'muy', 'y', 'vos', 'usted', 'bien', 'gracias']);
function esSaludo(t) {
  const palabras = String(t).trim().split(/\s+/).filter(Boolean);
  if (!palabras.length || palabras.length > 8) return false;
  return palabras.some((w) => PALABRAS_SALUDO.has(w)) && palabras.every((w) => PALABRAS_SALUDO.has(w) || PALABRAS_CORTESIA.has(w));
}
```

## 7. Estado, salida y menú

`salir()` arma la respuesta y recuerda las opciones mostradas (para que el cliente conteste "2" o el nombre de la opción). El estado caduca a los 30 minutos.

```js
// ------------------------------------------------------------------ estado (30 min)

const estadoDe = (cliente) => {
  const e = cliente.contexto && cliente.contexto.citas;
  return e && Date.now() - (e.ts || 0) < TTL_ESTADO_MS ? e : null;
};
async function guardarEstado(ctx, estado) {
  const contexto = { ...(ctx.cliente.contexto || {}) };
  if (estado) contexto.citas = { ...estado, ts: Date.now() }; else delete contexto.citas;
  ctx.cliente.contexto = contexto;
  await prisma.clienteFinal.update({ where: { id: ctx.cliente.id }, data: { contexto } });
}

// ------------------------------------------------------------------ salida

const rotulo = (r) => (r === 'lista' ? 'Ver opciones' : '');

/** Arma la respuesta y recuerda las opciones mostradas (para contestar con el número o el nombre). */
async function salir(ctx, texto, { lista = null, botones = null, estado = undefined } = {}) {
  const opciones = lista ? lista.secciones.flatMap((s) => s.filas).map((f) => ({ id: f.id, titulo: f.titulo })) : (botones || []).map((b) => ({ id: b.id, titulo: b.titulo }));
  const base = estado === undefined ? (estadoDe(ctx.cliente) || {}) : (estado || {});
  const { paso: _p, ...sinPaso } = base;
  await guardarEstado(ctx, { ...(estado === undefined ? sinPaso : base), ultimas: opciones });
  return responder(texto, { ...(lista ? { lista } : {}), ...(botones ? { botones } : {}), modelo: 'citas', proveedor: 'sistema' });
}

const asesorTexto = (ctx) => ctx.m.t('ofrecer_asesor');
const vocabDe = (ctx) => ctx.vocab;

// ------------------------------------------------------------------ menú y datos del negocio

async function menu(ctx) {
  const v = vocabDe(ctx);
  return salir(ctx, ctx.m.t('citas_bienvenida'), {
    botones: [
      { id: packId('agendar'), titulo: recortar(`Agendar ${v.cita}`, 20) },
      { id: packId('micita'), titulo: recortar(`Mi ${v.cita}`, 20) },
      { id: packId('info'), titulo: 'Ubicación y horarios' },
    ],
  });
}
const botonMenu = () => [{ id: packId('menu'), titulo: 'Volver al menú' }];

function horarioTexto(horarios) {
  const porDia = new Map();
  for (const h of horarios.filter((x) => x.recursoId === null)) {
    const d = porDia.get(h.diaSemana) || { dia: h.diaSemana, abre: h.horaInicio, cierra: h.horaFin };
    if (h.horaInicio < d.abre) d.abre = h.horaInicio;
    if (h.horaFin > d.cierra) d.cierra = h.horaFin;
    porDia.set(h.diaSemana, d);
  }
  return faq.formatearHorario({ dias: [...porDia.values()] });
}

async function info(ctx) {
  const horarios = await prisma.horarioAtencion.findMany({ where: { empresaId: ctx.empresa.id } });
  const delNegocio = faq.formatearHorario(ctx.config && ctx.config.horarioAtencion);
  const horario = delNegocio || horarioTexto(horarios);
  const direccion = ctx.config && ctx.config.direccionTienda;
  const partes = [
    direccion ? ctx.m.t('direccion_tienda', { direccion }) : ctx.m.t('direccion_sin_datos', { asesor: asesorTexto(ctx) }),
    horario ? ctx.m.t('horario_info', { horario }) : ctx.m.t('horario_sin_datos', { asesor: asesorTexto(ctx) }),
  ];
  return salir(ctx, partes.join('\n'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${vocabDe(ctx).cita}`, 20) }, ...botonMenu()] });
}

async function derivar(ctx) {
  await prisma.clienteFinal.update({ where: { id: ctx.cliente.id }, data: { estadoLead: 'DERIVADO_A_ASESOR' } });
  await prisma.notificacion.create({
    data: { empresaId: ctx.empresa.id, titulo: 'Pidió hablar con una persona', mensaje: `El cliente ${ctx.cliente.nombre || ctx.telefono} necesita atención de una persona.`, tipo: 'MANUAL' },
  }).catch(() => {});
  return salir(ctx, ctx.m.t('derivar_confirmacion'), { botones: botonMenu() });
}
```

## 8. Recorrido de agendar, paso a paso

1. **Servicio:** lista de servicios activos (con duración y precio). Si hay uno solo, lo salta.
2. **Personas:** solo si el servicio usa personas (salones, mesas, clases).
3. **Profesional:** solo si el negocio permite elegir y hay más de uno. Incluye "Cualquiera disponible".
4. **Día:** los próximos 14 días que tengan lugar, con cuántos horarios libres hay en cada uno. "Ver más días" pagina.
5. **Hora:** horarios libres del día, separados en mañana y tarde.
6. **Resumen:** se vuelve a **verificar** que el horario siga libre; si el cliente no tiene un nombre plausible, se lo pide primero.
7. **Confirmar:** crea la cita (o la mueve si es reprogramación) y avisa al negocio con una notificación. Si el botón se toca dos veces, la segunda devuelve "Eso ya quedó registrado" sin duplicar.

```js
// ------------------------------------------------------------------ recorrido de agendar

const cargarServicios = (ctx) => prisma.servicio.findMany({ where: { empresaId: ctx.empresa.id, activo: true }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] });
const descripcionServicio = (ctx, s) => [`${s.duracionMin} min`, s.precio !== null && s.precio !== undefined ? `${simboloMoneda(ctx.empresa.moneda)} ${Number(s.precio).toFixed(2)}` : null].filter(Boolean).join(' · ');

async function elegirServicio(ctx, p, inicio = 0) {
  const servicios = await cargarServicios(ctx);
  if (!servicios.length) return salir(ctx, ctx.m.t('citas_sin_servicios', { asesor: asesorTexto(ctx) }), { botones: botonMenu() });
  if (servicios.length === 1) return siguientePasoTrasServicio(ctx, conservar(p, { sv: servicios[0].id }), servicios[0]);
  const { visibles, hayMas, siguiente } = paginar(servicios, inicio);
  const filas = visibles.map((s) => ({ id: packId('sv', conservar(p, { sv: s.id })), titulo: recortar(s.nombre, 24), descripcion: descripcionServicio(ctx, s) }));
  if (hayMas) filas.push({ id: packId('svmas', conservar(p, { a: siguiente })), titulo: 'Ver más ▸' });
  return salir(ctx, ctx.m.t('citas_elegir_servicio'), { lista: { boton: 'Ver opciones', secciones: [{ titulo: cap(ctx.vocab.servicios), filas }] } });
}

async function siguientePasoTrasServicio(ctx, p, servicio) {
  if (servicio.usaPersonas) return elegirPersonas(ctx, p, servicio);
  return elegirProfesional(ctx, p, servicio);
}

async function elegirPersonas(ctx, p, servicio) {
  const tope = Math.min(servicio.maxPersonas || MAX_PERSONAS_LISTA, MAX_PERSONAS_LISTA);
  const filas = Array.from({ length: tope }, (_, i) => ({ id: packId('pe', conservar(p, { n: i + 1 })), titulo: `${i + 1} ${i === 0 ? 'persona' : 'personas'}` }));
  return salir(ctx, ctx.m.t('citas_elegir_personas'), { lista: { boton: 'Ver opciones', secciones: [{ titulo: 'Personas', filas }] } });
}

async function elegirProfesional(ctx, p, servicio) {
  const recursos = ctx.cfg.permiteElegirRecurso ? await agenda.recursosPara(ctx.empresa.id, servicio.id, null) : [];
  if (recursos.length <= 1) return elegirDia(ctx, conservar(p, { rec: recursos.length === 1 ? recursos[0].id : 0 }), servicio, hoyDe(ctx));
  const filas = [
    { id: packId('pr', conservar(p, { rec: 0 })), titulo: 'Cualquiera disponible', descripcion: 'El primero con lugar' },
    ...recursos.slice(0, 9).map((r) => ({ id: packId('pr', conservar(p, { rec: r.id })), titulo: recortar(r.nombre, 24), ...(r.especialidad ? { descripcion: recortar(r.especialidad, 72) } : {}) })),
  ];
  return salir(ctx, ctx.m.t('citas_elegir_profesional', { servicio: servicio.nombre }), { lista: { boton: 'Ver opciones', secciones: [{ titulo: cap(ctx.vocab.profesionales), filas }] } });
}

const hoyDe = (ctx) => T.hoy(ctx.empresa.zonaHoraria);
const cortoDia = (fecha, zona) => {
  const { DateTime } = require('luxon');
  return DateTime.fromISO(fecha, { zone: zona }).setLocale('es').toFormat('ccc d LLL');
};

async function libres(ctx, p, desde, dias) {
  return agenda.horariosLibres(ctx.empresa, { servicioId: p.sv, recursoId: p.rec || undefined, desde, dias, personas: p.n });
}

/** Lista de los próximos días con lugar (con cuántos horarios hay en cada uno). */
async function elegirDia(ctx, p, servicio, desde, { texto = null } = {}) {
  const slots = await libres(ctx, p, desde, DIAS_A_OFRECER);
  const porDia = new Map();
  for (const s of slots) porDia.set(s.fecha, (porDia.get(s.fecha) || 0) + 1);
  const dias = [...porDia.entries()];
  if (!dias.length) {
    const nada = ctx.m.t('citas_sin_horarios', { servicio: servicio.nombre, asesor: asesorTexto(ctx) });
    return salir(ctx, nada, { botones: botonMenu() });
  }
  const { visibles, hayMas } = paginar(dias, 0);
  const filas = visibles.map(([fecha, n]) => ({ id: packId('dia', conservar(p, { a: fecha })), titulo: cortoDia(fecha, ctx.empresa.zonaHoraria), descripcion: `${n} ${n === 1 ? 'horario libre' : 'horarios libres'}` }));
  if (hayMas) filas.push({ id: packId('dias', conservar(p, { a: T.sumarDias(visibles[visibles.length - 1][0], 1) })), titulo: 'Ver más días ▸' });
  const intro = texto || (p.rp ? ctx.m.t('citas_reprogramar', { servicio: servicio.nombre }) : ctx.m.t('citas_elegir_dia', { servicio: servicio.nombre }));
  return salir(ctx, intro, { lista: { boton: 'Ver días', secciones: [{ titulo: 'Días con lugar', filas }] } });
}

/** Lista de horarios libres de un día (mañana / tarde). */
async function elegirHora(ctx, p, servicio, fecha, inicio = 0, { texto = null } = {}) {
  const slots = (await libres(ctx, p, fecha, 1)).filter((s) => s.fecha === fecha);
  if (!slots.length) {
    return elegirDia(ctx, p, servicio, hoyDe(ctx), { texto: ctx.m.t('citas_dia_sin_horarios', { dia: T.diaLegible(fecha, ctx.empresa.zonaHoraria) }) });
  }
  const { visibles, hayMas, siguiente } = paginar(slots, inicio);
  const fila = (s) => ({ id: packId('hr', conservar(p, { a: fecha, b: idDeHora(s.hora) })), titulo: s.hora });
  const manana = visibles.filter((s) => s.hora < '12:00').map(fila);
  const tarde = visibles.filter((s) => s.hora >= '12:00').map(fila);
  const secciones = [];
  if (manana.length) secciones.push({ titulo: 'Por la mañana', filas: manana });
  if (tarde.length) secciones.push({ titulo: 'Por la tarde', filas: tarde });
  if (hayMas) secciones.push({ titulo: 'Más horarios', filas: [{ id: packId('hmas', conservar(p, { a: fecha, b: String(siguiente) })), titulo: 'Ver más ▸' }] });
  return salir(ctx, texto || ctx.m.t('citas_elegir_hora', { dia: T.diaLegible(fecha, ctx.empresa.zonaHoraria) }), { lista: { boton: 'Ver horarios', secciones } });
}

const detalleDe = (ctx, { servicio, recurso, fecha, hora, personas, nombre, mostrarProfesional }) => {
  const filas = [`• ${servicio.nombre}`];
  if (recurso && mostrarProfesional) filas.push(`• ${cap(ctx.vocab.profesional)}: ${recurso.nombre}`);
  filas.push(`• ${T.diaLegible(fecha, ctx.empresa.zonaHoraria)}, ${hora}`);
  if (servicio.usaPersonas) filas.push(`• ${personas} ${personas === 1 ? 'persona' : 'personas'}`);
  if (nombre) filas.push(`• A nombre de: ${nombre}`);
  if (servicio.precio !== null && servicio.precio !== undefined) filas.push(`• Precio: ${simboloMoneda(ctx.empresa.moneda)} ${Number(servicio.precio).toFixed(2)}`);
  return filas.join('\n');
};

/** Verifica el horario y arma el resumen (o pide el nombre primero). */
async function resumen(ctx, p, servicio, fecha, hora) {
  const chequeo = await agenda.verificarHorario(ctx.empresa, { servicioId: servicio.id, recursoId: p.rec || undefined, fecha, hora, personas: p.n });
  if (!chequeo.ok) return elegirHora(ctx, p, servicio, fecha, 0, { texto: ctx.m.t('citas_horario_ocupado') });
  if (!nombrePlausible(ctx.cliente.nombre)) {
    await guardarEstado(ctx, { paso: 'nombre', pendiente: { ...conservar(p), fecha, hora }, intentos: 0 });
    return responderNombre(ctx, 'citas_pedir_nombre');
  }
  const recurso = chequeo.recurso ? await prisma.recurso.findFirst({ where: { id: chequeo.recurso.id, empresaId: ctx.empresa.id } }) : null;
  const total = await prisma.recurso.count({ where: { empresaId: ctx.empresa.id, activo: true } });
  const detalle = detalleDe(ctx, { servicio, recurso, fecha, hora, personas: p.n, nombre: ctx.cliente.nombre, mostrarProfesional: total > 1 });
  return salir(ctx, ctx.m.t('citas_resumen', { resumen: detalle }), {
    botones: [
      { id: packId('ok', conservar(p, { a: fecha, b: idDeHora(hora) })), titulo: 'Confirmar' },
      { id: packId('dias', conservar(p, { a: hoyDe(ctx) })), titulo: 'Cambiar horario' },
      { id: packId('menu'), titulo: 'Cancelar' },
    ],
  });
}

async function responderNombre(ctx, clave) {
  return responder(ctx.m.t(clave), { modelo: 'citas', proveedor: 'sistema' });
}

/** Confirma: crea la cita (o mueve la existente). Nunca duplica si el botón se toca dos veces. */
async function confirmar(ctx, p, fecha, hora) {
  const servicio = await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } });
  if (!servicio) return yaNoDisponible(ctx);
  if (!nombrePlausible(ctx.cliente.nombre)) return resumen(ctx, p, servicio, fecha, hora);
  const inicio = T.aInstante(fecha, hora, ctx.empresa.zonaHoraria);
  const yaTiene = inicio && await prisma.cita.findFirst({
    where: { empresaId: ctx.empresa.id, clienteId: ctx.cliente.id, servicioId: servicio.id, inicio, estado: { in: ['PENDIENTE', 'CONFIRMADA'] } },
    include: { servicio: true, recurso: true },
  });
  if (yaTiene) return citaYaAgendada(ctx, yaTiene);

  let cita;
  try {
    cita = p.rp
      ? await agenda.reprogramarCita(ctx.empresa, p.rp, { fecha, hora, recursoId: p.rec || undefined, origen: 'whatsapp' })
      : await agenda.crearCita(ctx.empresa, { clienteId: ctx.cliente.id, servicioId: servicio.id, recursoId: p.rec || undefined, fecha, hora, personas: p.n, origen: 'whatsapp' });
  } catch (err) {
    if (!(err instanceof agenda.ErrorAgenda)) throw err;
    if (err.codigo === 'HORARIO_OCUPADO') return elegirHora(ctx, p, servicio, fecha, 0, { texto: ctx.m.t('citas_horario_ocupado') });
    if (err.codigo === 'CLIENTE_OCUPADO') return elegirHora(ctx, p, servicio, fecha, 0, { texto: ctx.m.t('citas_cliente_ocupado') });
    if (err.codigo === 'TOPE_CITAS') return salir(ctx, ctx.m.t('citas_tope', { asesor: asesorTexto(ctx) }), { botones: botonMenu() });
    return yaNoDisponible(ctx);
  }
  const completa = await prisma.cita.findUnique({ where: { id: cita.id }, include: { servicio: true, recurso: true } });
  const total = await prisma.recurso.count({ where: { empresaId: ctx.empresa.id, activo: true } });
  const detalle = detalleDe(ctx, { servicio, recurso: completa.recurso, fecha, hora, personas: p.n, mostrarProfesional: total > 1 });
  await prisma.notificacion.create({
    data: {
      empresaId: ctx.empresa.id, titulo: p.rp ? `${cap(ctx.vocab.cita)} · cambio de horario` : `${cap(ctx.vocab.cita)} · nueva por WhatsApp`,
      mensaje: `${ctx.cliente.nombre || ctx.telefono}: ${servicio.nombre}, ${T.legible(inicio, ctx.empresa.zonaHoraria)}.`, tipo: 'MANUAL',
    },
  }).catch(() => {});
  const direccion = ctx.config && ctx.config.direccionTienda;
  const botones = [{ id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, ...(direccion ? [{ id: packId('loc'), titulo: 'Cómo llegar' }] : []), ...botonMenu()].slice(0, 3);
  return salir(ctx, p.rp ? ctx.m.t('citas_reprogramada', { detalle }) : ctx.m.t('citas_creada', { detalle, ...(direccion ? { direccion } : {}) }), { botones, estado: null });
}

async function citaYaAgendada(ctx, cita) {
  const detalle = detalleDe(ctx, { servicio: cita.servicio, recurso: cita.recurso, fecha: fechaDe(ctx, cita.inicio), hora: horaDe(ctx, cita.inicio), personas: cita.personas, mostrarProfesional: false });
  return salir(ctx, ctx.m.t('citas_ya_agendada', { detalle }), { botones: [{ id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, ...botonMenu()] });
}

const yaNoDisponible = (ctx) => salir(ctx, ctx.m.t('citas_ya_no_disponible'), {
  botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, { id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, { id: packId('info'), titulo: 'Ubicación y horarios' }],
});
```

## 9. Mi cita: ver, cambiar, cancelar y confirmar asistencia

- **Ver:** una cita → detalle con botones Cambiar horario / Cancelar / Cómo llegar. Varias → lista.
- **Cambiar horario:** vuelve a la lista de días con la misma configuración y, al confirmar, crea la nueva y **cancela la original** en la misma transacción.
- **Cancelar:** pide confirmación ("Sí, cancelar" / "No, mantener") y avisa al negocio.
- **Confirmo** (botón del recordatorio): queda anotado y una cita pendiente pasa a confirmada.

```js
// ------------------------------------------------------------------ mi cita (ver, cambiar, cancelar)

const fechaDe = (ctx, inicio) => require('luxon').DateTime.fromJSDate(new Date(inicio), { zone: ctx.empresa.zonaHoraria }).toFormat('yyyy-MM-dd');
const horaDe = (ctx, inicio) => require('luxon').DateTime.fromJSDate(new Date(inicio), { zone: ctx.empresa.zonaHoraria }).toFormat('HH:mm');
const detalleCita = (ctx, c) => detalleDe(ctx, { servicio: c.servicio, recurso: c.recurso, fecha: fechaDe(ctx, c.inicio), hora: horaDe(ctx, c.inicio), personas: c.personas, mostrarProfesional: Boolean(c.recurso) });

async function citasDelCliente(ctx) {
  return agenda.citasProximasDeCliente(ctx.empresa.id, ctx.cliente.id);
}
async function citaPropia(ctx, citaId) {
  const c = await prisma.cita.findFirst({ where: { id: citaId, empresaId: ctx.empresa.id, clienteId: ctx.cliente.id, estado: { in: ['PENDIENTE', 'CONFIRMADA'] }, inicio: { gt: new Date() } }, include: { servicio: true, recurso: true } });
  return c;
}

async function miCita(ctx) {
  const citas = await citasDelCliente(ctx);
  if (!citas.length) return salir(ctx, ctx.m.t('citas_sin_citas'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, ...botonMenu()] });
  if (citas.length === 1) return verCita(ctx, citas[0]);
  const filas = citas.slice(0, 10).map((c) => ({ id: packId('ver', { a: String(c.id) }), titulo: recortar(`${cortoDia(fechaDe(ctx, c.inicio), ctx.empresa.zonaHoraria)} ${horaDe(ctx, c.inicio)}`, 24), descripcion: recortar(c.servicio ? c.servicio.nombre : '', 72) }));
  return salir(ctx, ctx.m.t('citas_elegir_cita'), { lista: { boton: 'Ver opciones', secciones: [{ titulo: cap(ctx.vocab.citas), filas }] } });
}

async function verCita(ctx, cita) {
  return salir(ctx, ctx.m.t('citas_mi_cita', { detalle: detalleCita(ctx, cita) }), {
    botones: [
      { id: packId('rep', { a: String(cita.id) }), titulo: 'Cambiar horario' },
      { id: packId('can', { a: String(cita.id) }), titulo: `Cancelar ${ctx.vocab.cita}`.slice(0, 20) },
      ...(ctx.config && ctx.config.direccionTienda ? [{ id: packId('loc'), titulo: 'Cómo llegar' }] : botonMenu()),
    ],
  });
}

/** El cliente tocó "Confirmo" en el recordatorio: queda anotado en la cita (y una cita por confirmar pasa a confirmada). */
async function confirmoAsistencia(ctx, citaId) {
  const cita = await citaPropia(ctx, citaId);
  if (!cita) return yaNoDisponible(ctx);
  await prisma.$executeRaw`UPDATE "citas" SET "recordatorios" = COALESCE("recordatorios", '{}'::jsonb) || jsonb_build_object('confirmada', ${new Date().toISOString()}::text), "estado" = CASE WHEN "estado" = 'PENDIENTE' THEN 'CONFIRMADA'::"EstadoCita" ELSE "estado" END WHERE "id" = ${cita.id} AND "empresaId" = ${ctx.empresa.id}`;
  const nombre = String(ctx.cliente.nombre || ctx.cliente.nombrePerfil || '').trim().split(/\s+/)[0] || 'cliente';
  return salir(ctx, ctx.m.t('citas_confirmo_gracias', { nombre }), { botones: [{ id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, ...botonMenu()].slice(0, 3) });
}

async function reprogramar(ctx, citaId) {
  const cita = await citaPropia(ctx, citaId);
  if (!cita || !cita.servicio) return yaNoDisponible(ctx);
  const p = { sv: cita.servicioId, rec: cita.recursoId || 0, n: cita.personas, rp: cita.id };
  return elegirDia(ctx, p, cita.servicio, hoyDe(ctx));
}

async function cancelar(ctx, citaId, confirmado) {
  const cita = await citaPropia(ctx, citaId);
  if (!cita) return yaNoDisponible(ctx);
  if (!confirmado) {
    return salir(ctx, ctx.m.t('citas_confirmar_cancelar', { detalle: detalleCita(ctx, cita) }), {
      botones: [{ id: packId('can2', { a: String(cita.id) }), titulo: 'Sí, cancelar' }, { id: packId('micita'), titulo: 'No, mantener' }],
    });
  }
  await agenda.cancelarCita(ctx.empresa, cita.id);
  await prisma.notificacion.create({
    data: { empresaId: ctx.empresa.id, titulo: `${cap(ctx.vocab.cita)} · cancelación del cliente`, mensaje: `${ctx.cliente.nombre || ctx.telefono}: ${cita.servicio ? cita.servicio.nombre : ''}, ${T.legible(cita.inicio, ctx.empresa.zonaHoraria)}.`, tipo: 'MANUAL' },
  }).catch(() => {});
  return salir(ctx, ctx.m.t('citas_cancelada', { cuando: T.legible(cita.inicio, ctx.empresa.zonaHoraria) }), {
    botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, ...botonMenu()], estado: null,
  });
}

async function comoLlegar(ctx) {
  const direccion = ctx.config && ctx.config.direccionTienda;
  const texto = direccion ? ctx.m.t('direccion_tienda', { direccion }) : ctx.m.t('direccion_sin_datos', { asesor: asesorTexto(ctx) });
  return salir(ctx, texto, { botones: botonMenu() });
}
```

## 10. Router de botones y listas

```js
// ------------------------------------------------------------------ botones y listas

async function porId(ctx, id) {
  const p = leerId(id);
  if (!p) return null;
  const nuevo = () => ({ sv: p.sv, rec: p.rec, n: p.n, rp: p.rp });
  switch (p.accion) {
    case 'menu': await guardarEstado(ctx, null); return menu(ctx);
    case 'agendar': await guardarEstado(ctx, null); return elegirServicio(ctx, { sv: 0, rec: 0, n: 1, rp: 0 });
    case 'svmas': return elegirServicio(ctx, { sv: 0, rec: 0, n: 1, rp: 0 }, Number(p.a) || 0);
    case 'micita': return miCita(ctx);
    case 'info': return info(ctx);
    case 'loc': return comoLlegar(ctx);
    case 'ver': { const c = await citaPropia(ctx, Number(p.a)); return c ? verCita(ctx, c) : yaNoDisponible(ctx); }
    case 'rok': return confirmoAsistencia(ctx, Number(p.a));
    case 'rep': return reprogramar(ctx, Number(p.a));
    case 'can': return cancelar(ctx, Number(p.a), false);
    case 'can2': return cancelar(ctx, Number(p.a), true);
    default: break;
  }
  // Los pasos que siguen necesitan el servicio.
  const servicio = p.sv ? await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } }) : null;
  if (!servicio) return yaNoDisponible(ctx);
  switch (p.accion) {
    case 'sv': return siguientePasoTrasServicio(ctx, nuevo(), servicio);
    case 'pe': return elegirProfesional(ctx, nuevo(), servicio);
    case 'pr': return elegirDia(ctx, nuevo(), servicio, hoyDe(ctx));
    case 'dias': return elegirDia(ctx, nuevo(), servicio, T.esFecha(p.a) ? p.a : hoyDe(ctx));
    case 'dia': return T.esFecha(p.a) ? elegirHora(ctx, nuevo(), servicio, p.a) : yaNoDisponible(ctx);
    case 'hmas': return T.esFecha(p.a) ? elegirHora(ctx, nuevo(), servicio, p.a, Number(p.b) || 0) : yaNoDisponible(ctx);
    case 'hr': { const hora = hhmmDeId(p.b); return T.esFecha(p.a) && hora ? resumen(ctx, nuevo(), servicio, p.a, hora) : yaNoDisponible(ctx); }
    case 'ok': { const hora = hhmmDeId(p.b); return T.esFecha(p.a) && hora ? confirmar(ctx, nuevo(), p.a, hora) : yaNoDisponible(ctx); }
    default: return null;
  }
}

/** Número ("2") o nombre de una opción mostrada → el ID de esa opción (por si WhatsApp mandó la lista como texto). */
function idPorTexto(ctx, texto) {
  const e = estadoDe(ctx.cliente);
  const ultimas = (e && e.ultimas) || [];
  if (!ultimas.length) return null;
  const t = String(texto || '').trim();
  if (/^\d{1,2}$/.test(t)) { const op = ultimas[Number(t) - 1]; return op ? op.id : null; }
  const coincide = ultimas.filter((o) => norm(o.titulo) === norm(t));
  return coincide.length === 1 ? coincide[0].id : null;
}

// ------------------------------------------------------------------ texto libre
```

## 11. Texto libre y entrada principal

```js
/** Lo que dijo el cliente con sus propias palabras: se resuelve por código, sin IA. */
async function textoLibre(ctx, texto) {
  const guardado = guardia.evaluarEntrada(texto);
  if (guardado) return salir(ctx, ctx.m.t('citas_alcance'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, { id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, { id: packId('info'), titulo: 'Ubicación y horarios' }] });

  const respuestaFaq = faq.coincideFaq(texto, ctx.config && ctx.config.faq);
  if (respuestaFaq) return salir(ctx, respuestaFaq.respuesta, { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, ...botonMenu()] });

  let intencion = intencionDe(texto);
  if (intencion === 'asesor') return derivar(ctx);
  // Si pregunta por "horarios" pero nombra a un profesional o un servicio ("¿qué horarios tiene Diego mañana?"), quiere agendar.
  const profesionales = await prisma.recurso.findMany({ where: { empresaId: ctx.empresa.id, activo: true } });
  const nombrado = ctx.cfg.permiteElegirRecurso ? buscarPorNombre(texto, profesionales) : null;
  if (intencion === 'info' && /\bhorarios?\b/.test(norm(texto)) && (nombrado || buscarPorNombre(texto, await cargarServicios(ctx)))) intencion = 'agendar';
  if (intencion === 'info') return info(ctx);
  if (intencion === 'micita' || intencion === 'cancelar' || intencion === 'reprogramar') return miCita(ctx);

  const hoy = hoyDe(ctx);
  const fecha = interpretarFecha(texto, hoy);
  const hora = fecha || /\b(a las|a la|las)\b/.test(norm(texto)) ? interpretarHora(texto) : null;
  const servicios = await cargarServicios(ctx);
  const servicio = buscarPorNombre(texto, servicios) || (servicios.length === 1 && (intencion === 'agendar' || fecha) ? servicios[0] : null);
  if (intencion === 'agendar' || servicio || fecha) {
    if (!servicios.length) return salir(ctx, ctx.m.t('citas_sin_servicios', { asesor: asesorTexto(ctx) }), { botones: botonMenu() });
    if (!servicio) {
      // Se acuerda de lo que ya dijo (día, hora y con quién) para usarlo cuando elija el servicio.
      await guardarEstado(ctx, { preferencia: { fecha: fecha || null, hora: hora || null, recurso: nombrado ? nombrado.id : null } });
      return elegirServicio(ctx, { sv: 0, rec: 0, n: 1, rp: 0 });
    }
    return desdeServicioNombrado(ctx, servicio, texto, { fecha, hora });
  }
  if (intencion === 'menu' || !intencion) return intencion === 'menu' ? menu(ctx) : salir(ctx, ctx.m.t('citas_menu_aclarar'), { botones: [{ id: packId('agendar'), titulo: recortar(`Agendar ${ctx.vocab.cita}`, 20) }, { id: packId('micita'), titulo: recortar(`Mi ${ctx.vocab.cita}`, 20) }, { id: packId('info'), titulo: 'Ubicación y horarios' }] });
  return menu(ctx);
}

async function desdeServicioNombrado(ctx, servicio, texto, { fecha, hora }) {
  let p = { sv: servicio.id, rec: 0, n: 1, rp: 0 };
  if (servicio.usaPersonas) {
    const m = norm(texto).match(/\b(?:para|somos|de)\s+(\d{1,2})\b/);
    const personas = m ? Number(m[1]) : 0;
    if (!personas) return elegirPersonas(ctx, p, servicio);
    if (servicio.maxPersonas && personas > servicio.maxPersonas) return salir(ctx, ctx.m.t('citas_grupo_grande', { max: servicio.maxPersonas, asesor: asesorTexto(ctx) }), { botones: botonMenu() });
    p = { ...p, n: personas };
  }
  const recursos = ctx.cfg.permiteElegirRecurso ? await agenda.recursosPara(ctx.empresa.id, servicio.id, null) : [];
  const recurso = recursos.length > 1 ? buscarPorNombre(texto, recursos) : (recursos.length === 1 ? recursos[0] : null);
  if (recurso) p = { ...p, rec: recurso.id };
  else if (recursos.length > 1 && !fecha) return elegirProfesional(ctx, p, servicio);
  if (fecha && hora) return resumen(ctx, p, servicio, fecha, hora);
  if (fecha) return elegirHora(ctx, p, servicio, fecha);
  return elegirDia(ctx, p, servicio, hoyDe(ctx));
}

// ------------------------------------------------------------------ entrada

/**
 * Responde un mensaje del cliente en un negocio de CITAS.
 * @param {{ agente, empresa, config, telefonoCliente, texto, idBoton }} entrada
 */
async function responderCitas(entrada) {
  // Un cliente a la vez: dos toques seguidos (o simultaneos) del mismo boton no pueden crear dos citas.
  return require('./conversaciones').conBloqueoDeCliente(`citas:${entrada.empresa.id}:${entrada.telefonoCliente}`, () => atender(entrada));
}

async function atender({ empresa, config, telefonoCliente, texto, idBoton = null }) {
  const cliente = await prisma.clienteFinal.upsert({
    where: { empresaId_telefono: { empresaId: empresa.id, telefono: telefonoCliente } },
    update: {}, create: { empresaId: empresa.id, telefono: telefonoCliente },
  });
  const vocab = rubros.vocabularioDe(empresa);
  const m = await mensajesSrv.cargarContexto({ empresa, config, vocab });
  const ctx = { empresa, config, cfg: agendaDe(empresa), m, vocab, cliente, telefono: telefonoCliente };

  try {
    const estado = estadoDe(cliente);
    // 1) Toque de botón/lista (o número / nombre de una opción mostrada).
    const id = idBoton || (!(estado && estado.paso) ? idPorTexto(ctx, texto) : null);
    if (id && String(id).startsWith(`${PREFIJO}:`)) {
      const preferencia = estado && estado.preferencia;
      const r = await porIdConPreferencia(ctx, id, preferencia);
      if (r) return r;
      return yaNoDisponible(ctx);
    }
    // 2) Esperando el nombre para cerrar la cita.
    if (estado && estado.paso === 'nombre' && estado.pendiente) return recibirNombre(ctx, estado, texto);
    // 3) Texto libre.
    return await textoLibre(ctx, texto);
  } catch (err) {
    console.error(`[botCitas] error atendiendo a ${telefonoCliente}:`, err);
    return responder(m.t('error_tecnico'), { modelo: 'citas', proveedor: 'sistema', error: true });
  }
}

/** Si el cliente ya dijo un día/hora ("mañana a las 4") y ahora elige el servicio, se usa. */
async function porIdConPreferencia(ctx, id, preferencia) {
  const p = leerId(id);
  if (preferencia && p && p.accion === 'sv') {
    await guardarEstado(ctx, null); // la preferencia se usa una sola vez
    const servicio = await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } });
    if (servicio && !servicio.usaPersonas && (preferencia.fecha || preferencia.recurso)) {
      const recursos = ctx.cfg.permiteElegirRecurso ? await agenda.recursosPara(ctx.empresa.id, servicio.id, null) : [];
      // La persona que pidió, solo si hace ese servicio; si no, se le muestra la lista como siempre.
      const pedido = recursos.find((r) => r.id === preferencia.recurso);
      if (pedido || recursos.length <= 1) {
        const rec = pedido ? pedido.id : (recursos.length === 1 ? recursos[0].id : 0);
        const pp = { sv: servicio.id, rec, n: 1, rp: 0 };
        if (!preferencia.fecha) return elegirDia(ctx, pp, servicio, hoyDe(ctx));
        if (preferencia.hora) return resumen(ctx, pp, servicio, preferencia.fecha, preferencia.hora);
        return elegirHora(ctx, pp, servicio, preferencia.fecha);
      }
    }
  }
  return porId(ctx, id);
}

async function recibirNombre(ctx, estado, texto) {
  const intencion = intencionDe(texto);
  if (intencion === 'asesor') return derivar(ctx);
  if (!nombrePlausible(texto)) {
    const intentos = (estado.intentos || 0) + 1;
    if (intentos >= 3) { await guardarEstado(ctx, null); return derivar(ctx); }
    await guardarEstado(ctx, { ...estado, intentos });
    return responderNombre(ctx, 'citas_nombre_ejemplo');
  }
  const nombre = String(texto).replace(/\s+/g, ' ').trim();
  await prisma.clienteFinal.update({ where: { id: ctx.cliente.id }, data: { nombre } });
  ctx.cliente.nombre = nombre;
  const { fecha, hora, ...p } = estado.pendiente;
  const servicio = await prisma.servicio.findFirst({ where: { id: p.sv, empresaId: ctx.empresa.id, activo: true } });
  if (!servicio) return yaNoDisponible(ctx);
  await guardarEstado(ctx, null);
  return resumen(ctx, p, servicio, fecha, hora);
}
```

## 12. Motor de agenda (`agenda.js`)

**La IA nunca decide si un horario está libre: siempre pasa por aquí.**

Modelo de capacidad: cada recurso (profesional, mesa, sala) tiene `capacidad`; cada cita consume `carga` (1, o la cantidad de personas si el servicio usa personas). Un horario está libre si *suma de cargas solapadas + la nueva ≤ capacidad*. Así el mismo motor sirve para un doctor (capacidad 1) y un salón (40 lugares).

Qué descarta un horario:

- Fuera de las ventanas de atención (las del recurso o, si no tiene, las generales del negocio).
- Feriados cerrados (si el negocio no trabaja ese día).
- Bloqueos de agenda (vacaciones, descansos) generales o del recurso.
- Antes del tiempo mínimo de anticipación.
- Solapes con otras citas del recurso, **contando el tiempo de preparación (buffer) de cada cita**.
- Más días de los permitidos (`diasMaximos`).

**Garantías contra dobles reservas** (en `crearCita`, dentro de una transacción):

1. Bloquea la fila del recurso con `FOR UPDATE`: dos clientes pidiendo el último lugar a la vez no pueden duplicarse.
2. Bloquea la fila del cliente y rechaza si ya tiene **otra cita que se cruza en el tiempo** (aunque sea con otro servicio o profesional): código `CLIENTE_OCUPADO`.
3. Recalcula el cupo usado del recurso dentro de la transacción: si se llenó, `HORARIO_OCUPADO`.
4. Antes, revisa el tope de citas del plan (`TOPE_CITAS`).
5. En una reprogramación, la nueva se crea y la vieja se cancela en la misma transacción.

Archivo completo:

```js
'use strict';
// lib/services/agenda.js
//
// Motor de agenda del modelo de CITAS (portado de AgendaBot): calcula horarios
// libres y crea/mueve/cancela citas. LA IA NUNCA DECIDE SI UN HORARIO ESTA LIBRE:
// siempre pasa por aca (principio del proyecto: el backend decide).
//
// Modelo de capacidad: cada recurso tiene `capacidad`; cada cita consume `carga`
// (1, o la cantidad de personas si el servicio usa personas). Un horario esta
// libre si la suma de cargas solapadas + la nueva <= capacidad. Asi el mismo
// motor sirve para un doctor (capacidad 1) y un salon (40 lugares).
//
// Todo es multi-tenant: cada consulta filtra por empresa.

const { prisma } = require('../db');
const T = require('./tiempo');
const { agendaDe } = require('./configAgenda');
const { fechasCerradas } = require('./feriados');
const limites = require('./limitesCitas');

class ErrorAgenda extends Error {
  constructor(mensaje, codigo = 'AGENDA') {
    super(mensaje);
    this.codigo = codigo;
  }
}

const INACTIVAS = ['CANCELADA', 'NO_ASISTIO'];
const ESTADOS = ['PENDIENTE', 'CONFIRMADA', 'COMPLETADA', 'NO_ASISTIO', 'CANCELADA'];

async function recursosPara(empresaId, servicioId, recursoId) {
  return prisma.recurso.findMany({
    where: {
      empresaId,
      activo: true,
      ...(recursoId ? { id: recursoId } : {}),
      // Un recurso sin servicios asignados atiende todos.
      OR: [{ servicios: { none: {} } }, { servicios: { some: { servicioId } } }],
    },
    orderBy: { id: 'asc' },
  });
}

const cargaDe = (servicio, personas) => (servicio.usaPersonas ? Math.max(1, Number(personas) || 1) : 1);
const solapa = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

/**
 * Horarios libres para un servicio.
 * @returns [{ fecha, hora, inicio: Date, recursos: [{id, nombre}] }] ordenado
 */
async function horariosLibres(empresa, { servicioId, recursoId, desde, dias = 7, personas = 1, excluirCitaId = null, horaExacta = null }) {
  const zona = empresa.zonaHoraria;
  const cfg = agendaDe(empresa);
  const servicio = await prisma.servicio.findFirst({ where: { id: servicioId, empresaId: empresa.id, activo: true } });
  if (!servicio) throw new ErrorAgenda('Servicio inexistente o inactivo.');
  if (servicio.usaPersonas && servicio.maxPersonas && personas > servicio.maxPersonas) {
    throw new ErrorAgenda(`El maximo por reserva es ${servicio.maxPersonas} personas.`);
  }

  const recursos = await recursosPara(empresa.id, servicio.id, recursoId);
  if (!recursos.length) return [];

  const hoyLocal = T.hoy(zona);
  const inicioRango = !desde || desde < hoyLocal ? hoyLocal : desde;
  const maxFecha = T.sumarDias(hoyLocal, cfg.diasMaximos);
  const finRango = [T.sumarDias(inicioRango, dias - 1), maxFecha].sort()[0];
  if (inicioRango > finRango) return [];

  const rangoIni = T.aInstante(inicioRango, '00:00', zona);
  const rangoFin = T.aInstante(T.sumarDias(finRango, 1), '00:00', zona);
  const ids = recursos.map((r) => r.id);

  const [horarios, bloqueos, citas] = await Promise.all([
    prisma.horarioAtencion.findMany({ where: { empresaId: empresa.id } }),
    prisma.bloqueoAgenda.findMany({ where: { empresaId: empresa.id, inicio: { lt: rangoFin }, fin: { gt: rangoIni } } }),
    // El buffer de cada cita alarga su ocupacion: se trae un margen de 1 dia y se afina en memoria.
    prisma.cita.findMany({
      where: {
        empresaId: empresa.id,
        recursoId: { in: ids },
        estado: { notIn: INACTIVAS },
        inicio: { lt: rangoFin },
        fin: { gt: new Date(rangoIni.getTime() - 24 * 60 * 60 * 1000) },
        ...(excluirCitaId ? { id: { not: excluirCitaId } } : {}),
      },
      select: { recursoId: true, inicio: true, fin: true, bufferMin: true, carga: true },
    }),
  ]);
  const ocupadas = citas.filter((c) => c.fin.getTime() + c.bufferMin * 60000 > rangoIni.getTime());

  const feriados = await fechasCerradas(empresa, inicioRango, finRango);
  const generales = horarios.filter((h) => h.recursoId === null);
  const minimoInicio = Date.now() + cfg.anticipacionMin * 60000;
  const carga = cargaDe(servicio, personas);
  const ocupacionMs = (servicio.duracionMin + servicio.bufferMin) * 60000;
  const porHora = new Map();

  for (let fecha = inicioRango; fecha <= finRango; fecha = T.sumarDias(fecha, 1)) {
    if (feriados.has(fecha)) continue;
    const dow = T.diaSemanaDe(fecha);
    for (const r of recursos) {
      const propios = horarios.filter((h) => h.recursoId === r.id);
      const ventanas = (propios.length ? propios : generales).filter((h) => h.diaSemana === dow);
      for (const v of ventanas) {
        const inicioVentana = T.minutos(v.horaInicio);
        const fin = T.minutos(v.horaFin);
        // Con horaExacta se evalua solo ese minuto (el cliente puede pedir 16:15
        // aunque la grilla sea de 30 min: vale si entra en el horario).
        const candidatos = [];
        if (horaExacta) candidatos.push(T.minutos(horaExacta));
        else for (let m = inicioVentana; m + servicio.duracionMin <= fin; m += cfg.intervaloMin) candidatos.push(m);
        for (const m of candidatos) {
          if (m < inicioVentana || m + servicio.duracionMin > fin) continue;
          const hora = T.hhmm(m);
          const ini = T.aInstante(fecha, hora, zona);
          if (!ini || ini.getTime() < minimoInicio) continue;
          const finMs = ini.getTime() + ocupacionMs;

          const bloqueado = bloqueos.some((b) => (b.recursoId === null || b.recursoId === r.id) && solapa(ini.getTime(), finMs, b.inicio.getTime(), b.fin.getTime()));
          if (bloqueado) continue;

          const usada = ocupadas
            .filter((c) => c.recursoId === r.id)
            .filter((c) => solapa(ini.getTime(), finMs, c.inicio.getTime(), c.fin.getTime() + c.bufferMin * 60000))
            .reduce((s, c) => s + c.carga, 0);
          if (usada + carga > r.capacidad) continue;

          const clave = `${fecha} ${hora}`;
          if (!porHora.has(clave)) porHora.set(clave, { fecha, hora, inicio: ini, recursos: [] });
          porHora.get(clave).recursos.push({ id: r.id, nombre: r.nombre });
        }
      }
    }
  }
  return [...porHora.values()].sort((a, b) => a.inicio - b.inicio);
}

/** ¿Ese horario exacto esta libre? Si no, devuelve alternativas del mismo dia. */
async function verificarHorario(empresa, { servicioId, recursoId, fecha, hora, personas, excluirCitaId }) {
  if (!T.esFecha(fecha) || !T.esHora(hora)) return { ok: false, motivo: 'Fecha u hora con formato invalido (usar YYYY-MM-DD y HH:MM).', alternativas: [] };
  const exacto = await horariosLibres(empresa, { servicioId, recursoId, desde: fecha, dias: 1, personas, excluirCitaId, horaExacta: hora });
  const slot = exacto.find((s) => s.fecha === fecha && s.hora === hora);
  if (slot) return { ok: true, recurso: slot.recursos[0] };
  const libres = await horariosLibres(empresa, { servicioId, recursoId, desde: fecha, dias: 1, personas, excluirCitaId });
  const alternativas = libres.slice(0, 4).map((s) => s.hora);
  return {
    ok: false,
    alternativas,
    motivo: alternativas.length ? `Ese horario no esta libre. Ese dia quedan: ${alternativas.join(', ')}.` : 'Ese dia no hay horarios libres para ese servicio.',
  };
}

/**
 * Crea la cita dentro de una transaccion que BLOQUEA la fila del recurso: dos
 * clientes pidiendo el mismo ultimo lugar a la vez no pueden duplicarse.
 * Con excluirCitaId es una reprogramacion: la original se cancela y no gasta cupo del plan.
 */
async function crearCita(empresa, { clienteId, servicioId, recursoId, fecha, hora, personas = 1, origen = 'whatsapp', notas = null, excluirCitaId = null }) {
  if (!excluirCitaId) {
    const tope = await limites.puedeCrearCita(empresa.id);
    if (!tope.ok) throw new ErrorAgenda(`Se alcanzo el tope de citas del plan (${tope.usados} de ${tope.tope} este periodo).`, 'TOPE_CITAS');
  }
  const chequeo = await verificarHorario(empresa, { servicioId, recursoId, fecha, hora, personas, excluirCitaId });
  if (!chequeo.ok) throw new ErrorAgenda(chequeo.motivo, 'HORARIO_OCUPADO');
  const recursoElegido = chequeo.recurso.id;
  const servicio = await prisma.servicio.findFirst({ where: { id: servicioId, empresaId: empresa.id } });
  const inicio = T.aInstante(fecha, hora, empresa.zonaHoraria);
  const fin = new Date(inicio.getTime() + servicio.duracionMin * 60000);
  const finConBuffer = new Date(fin.getTime() + servicio.bufferMin * 60000);
  const carga = cargaDe(servicio, personas);

  const cita = await prisma.$transaction(async (tx) => {
    const [recurso] = await tx.$queryRaw`SELECT "capacidad" FROM "recursos" WHERE "id" = ${recursoElegido} AND "empresaId" = ${empresa.id} FOR UPDATE`;
    if (!recurso) throw new ErrorAgenda('El recurso ya no existe.');
    // Un cliente no puede estar en dos citas a la vez (aunque sean con personas o servicios distintos). Se bloquea su fila para que dos pedidos
    // simultaneos suyos no se crucen. Orden de bloqueos siempre igual (recurso y despues cliente): no hay interbloqueo.
    await tx.$queryRaw`SELECT "id" FROM "clientes_finales" WHERE "id" = ${clienteId} AND "empresaId" = ${empresa.id} FOR UPDATE`;
    const [{ propias }] = await tx.$queryRaw`
      SELECT COUNT(*)::int AS propias FROM "citas"
      WHERE "empresaId" = ${empresa.id} AND "clienteId" = ${clienteId} AND "estado"::text NOT IN ('CANCELADA', 'NO_ASISTIO')
        AND (${excluirCitaId}::int IS NULL OR "id" <> ${excluirCitaId}::int)
        AND "inicio" < ${fin}::timestamp AND "fin" > ${inicio}::timestamp`;
    if (propias > 0) throw new ErrorAgenda('Ya tenes otra cita en ese horario.', 'CLIENTE_OCUPADO');
    const [{ usada }] = await tx.$queryRaw`
      SELECT COALESCE(SUM("carga"), 0)::int AS usada FROM "citas"
      WHERE "recursoId" = ${recursoElegido} AND "estado"::text NOT IN ('CANCELADA', 'NO_ASISTIO')
        AND (${excluirCitaId}::int IS NULL OR "id" <> ${excluirCitaId}::int)
        AND "inicio" < ${finConBuffer}::timestamp AND ("fin" + make_interval(mins => "bufferMin")) > ${inicio}::timestamp`;
    if (usada + carga > recurso.capacidad) throw new ErrorAgenda('Ese horario se acaba de ocupar. Elige otro.', 'HORARIO_OCUPADO');

    const nueva = await tx.cita.create({
      data: { empresaId: empresa.id, clienteId, servicioId, recursoId: recursoElegido, inicio, fin, bufferMin: servicio.bufferMin, personas, carga, estado: 'CONFIRMADA', origen, notas },
    });
    if (excluirCitaId) {
      const vieja = await tx.cita.findUnique({ where: { id: excluirCitaId } });
      await tx.cita.update({ where: { id: excluirCitaId }, data: { estado: 'CANCELADA', notas: `${(vieja && vieja.notas) || ''} [reprogramada a cita #${nueva.id}]`.trim() } });
    }
    return nueva;
  });
  if (!excluirCitaId) limites.revisarAvisos(empresa.id, 'citas');
  return cita;
}

async function reprogramarCita(empresa, citaId, { fecha, hora, recursoId, origen }) {
  const actual = await prisma.cita.findFirst({ where: { id: citaId, empresaId: empresa.id } });
  if (!actual || ['CANCELADA', 'COMPLETADA', 'NO_ASISTIO'].includes(actual.estado)) throw new ErrorAgenda('Esa cita no existe o ya no esta activa.');
  return crearCita(empresa, {
    clienteId: actual.clienteId,
    servicioId: actual.servicioId,
    recursoId: recursoId === undefined ? actual.recursoId : recursoId,
    fecha, hora, personas: actual.personas, origen: origen || actual.origen, notas: actual.notas, excluirCitaId: actual.id,
  });
}

async function cambiarEstadoCita(empresa, citaId, estado) {
  if (!ESTADOS.includes(estado)) throw new ErrorAgenda('Estado invalido.');
  const r = await prisma.cita.updateMany({ where: { id: citaId, empresaId: empresa.id }, data: { estado } });
  if (!r.count) throw new ErrorAgenda('Cita inexistente.');
  return prisma.cita.findUnique({ where: { id: citaId } });
}

const cancelarCita = (empresa, citaId) => cambiarEstadoCita(empresa, citaId, 'CANCELADA');

async function citasProximasDeCliente(empresaId, clienteId) {
  return prisma.cita.findMany({
    where: { empresaId, clienteId, estado: { in: ['PENDIENTE', 'CONFIRMADA'] }, inicio: { gt: new Date() } },
    include: { servicio: true, recurso: true },
    orderBy: { inicio: 'asc' },
  });
}

module.exports = { recursosPara, horariosLibres, verificarHorario, crearCita, reprogramarCita, cambiarEstadoCita, cancelarCita, citasProximasDeCliente, ErrorAgenda, ESTADOS };
```

## 13. Reglas del negocio (`configAgenda.js`)

Se guardan en `Empresa.configAgenda`. Todo lo que falte o venga mal se completa con el valor por defecto.

```js
const POR_DEFECTO = {
  intervaloMin: 30, // cada cuantos minutos arranca un horario ofrecido
  anticipacionMin: 60, // no se agenda con menos de esto de anticipacion
  diasMaximos: 60, // hasta cuantos dias adelante se puede agendar
  permiteElegirRecurso: true, // el cliente puede elegir con quien
  cerrarFeriados: true, // se cierra en los feriados nacionales
  feriadosAbiertos: [], // fechas de feriado en que SI se trabaja
  reservaPublica: true, // pagina publica /reservar/:slug (cualquiera reserva sin login)
  // Recordatorios por WhatsApp: APAGADOS hasta que el negocio los active (son mensajes salientes a sus clientes).
  recordatorios: { activo: false, h24: true, h2: true },
};

const entero = (v, min, max, defecto) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : defecto;
};

/** Reglas completas y validas de un negocio (lo que falte o venga mal se completa con el valor por defecto). */
function agendaDe(empresa) {
  const c = (empresa && empresa.configAgenda) || {};
  return {
    intervaloMin: entero(c.intervaloMin, 5, 240, POR_DEFECTO.intervaloMin),
    anticipacionMin: entero(c.anticipacionMin, 0, 60 * 24 * 14, POR_DEFECTO.anticipacionMin),
    diasMaximos: entero(c.diasMaximos, 1, 365, POR_DEFECTO.diasMaximos),
    permiteElegirRecurso: c.permiteElegirRecurso !== false,
    cerrarFeriados: c.cerrarFeriados !== false,
    reservaPublica: c.reservaPublica !== false,
    recordatorios: { activo: Boolean(c.recordatorios && c.recordatorios.activo), h24: !(c.recordatorios && c.recordatorios.h24 === false), h2: !(c.recordatorios && c.recordatorios.h2 === false) },
    feriadosAbiertos: Array.isArray(c.feriadosAbiertos) ? c.feriadosAbiertos.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)) : [],
  };
}
```

## 14. Recordatorios por WhatsApp

- **Apagados hasta que el negocio los activa** (son mensajes salientes a sus clientes).
- Dos tipos: **24 h antes** y **2 h antes**, con botones *Confirmo / Cambiar horario / Cancelar* que resuelve el mismo bot por código.
- **Horas de silencio:** nada entre las 21:00 y las 08:00 (hora del negocio); se envía al abrir el horario si todavía tiene sentido.
- Una cita recién reservada no recibe un recordatorio inútil: el de 24 h solo si se agendó con más de 24 h de anticipación; el de 2 h solo si se agendó con más de 3 h. Si se juntan los dos, se manda solo el más cercano.
- **Regla de Meta:** dentro de las 24 h del último mensaje del cliente se manda texto con botones. **Fuera** de esa ventana solo se puede mandar una **plantilla aprobada por Meta**; sin plantilla aprobada no se manda y queda anotado.
- **Nunca se manda dos veces:** cada recordatorio se reclama de forma atómica (jsonb) antes de enviarse; un fallo se reintenta hasta 3 veces.
- Un job corre cada 5 minutos (`lib/jobs/recordatorios.js`).
- Si el **negocio** cancela una cita desde el panel, se avisa al cliente (solo si escribió en las últimas 24 h).

```js
const HORA_MS = 3600000;
const SILENCIO = { desde: 21, hasta: 8 };
const MAX_FALLOS = 3;
const ACTIVAS = ['PENDIENTE', 'CONFIRMADA'];

// ------------------------------------------------------------------ la plantilla (texto fijo aprobado por Meta)

const PLANTILLA = Object.freeze({
  nombre: 'recordatorio_cita',
  idioma: 'es',
  categoria: 'UTILITY',
  cuerpo: 'Hola {{1}}, te recordamos tu {{2}} de {{3}}: {{4}}. ¿Nos confirmás que venís?',
  ejemplo: ['Ana', 'cita', 'Corte de pelo', 'jueves 12 de noviembre, 10:30'],
  botones: ['Confirmo', 'Cambiar horario', 'Cancelar'],
});

/** Lo que se le manda a Meta para crear la plantilla. */
function definicionPlantilla() {
  return {
    name: PLANTILLA.nombre, language: PLANTILLA.idioma, category: PLANTILLA.categoria,
    components: [
      { type: 'BODY', text: PLANTILLA.cuerpo, example: { body_text: [PLANTILLA.ejemplo] } },
      { type: 'BUTTONS', buttons: PLANTILLA.botones.map((text) => ({ type: 'QUICK_REPLY', text })) },
    ],
  };
}

// ------------------------------------------------------------------ cuándo toca (reglas puras)

/** ¿Es hora de silencio (21:00 a 08:00) en la zona del negocio? */
function enSilencio(ahora, zona) {
  const hora = Number(T.aLocal(ahora, zona).hora.slice(0, 2));
  return hora >= SILENCIO.desde || hora < SILENCIO.hasta;
}

/**
 * Qué recordatorio corresponde mandar ahora para una cita (o null), y cuál se da por superado.
 * @returns {{ enviar: '24h'|'2h'|null, superados: string[] }}
 */
function queToca(cita, cfg, ahora) {
  const rec = cita.recordatorios || {};
  const restante = cita.inicio.getTime() - ahora.getTime();
  const anticipacion = cita.inicio.getTime() - cita.createdAt.getTime();
  const r = cfg.recordatorios;
  const quiere2 = r.h2 && !rec['2h'] && restante <= 2 * HORA_MS && restante > 10 * 60000 && anticipacion > 3 * HORA_MS;
  const quiere24 = r.h24 && !rec['24h'] && restante <= 24 * HORA_MS && restante > 4 * HORA_MS && anticipacion > 24 * HORA_MS;
  if (quiere2) return { enviar: '2h', superados: r.h24 && !rec['24h'] ? ['24h'] : [] };
  if (quiere24) return { enviar: '24h', superados: [] };
  return { enviar: null, superados: [] };
}
```

Envío de un recordatorio y barrido periódico:

```js
// ------------------------------------------------------------------ envío de uno

const primerNombre = (cliente) => String(cliente.nombre || cliente.nombrePerfil || '').trim().split(/\s+/)[0] || 'cliente';
const cuandoLegible = (cita, zona, clave) => (clave === '2h' ? `hoy a las ${T.legible(cita.inicio, zona).split(', ')[1]}` : T.legible(cita.inicio, zona));

async function conexionDe(empresaId) {
  return prisma.conexionWhatsApp.findFirst({ where: { estado: 'CONECTADO', agente: { empresaId } }, include: { agente: { include: { config: true } } } });
}

/**
 * Manda UN recordatorio ya reclamado. Devuelve { estado: 'enviado'|'omitido'|'fallo', via?, motivo? }.
 * `deps.wa` permite probar sin red.
 */
async function enviarUno(cita, clave, { ahora = new Date(), deps = {} } = {}) {
  const wa = deps.wa || waDefecto;
  const empresa = cita.empresa;
  const zona = empresa.zonaHoraria;
  const conexion = await conexionDe(empresa.id);
  if (!conexion) return { estado: 'omitido', motivo: 'sin_conexion' };
  const telefono = cita.cliente.telefono;

  const ultimo = await prisma.mensaje.findFirst({
    where: { rol: 'CLIENTE', conversacion: { telefonoCliente: telefono, agente: { empresaId: empresa.id } } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true, conversacionId: true },
  });
  const dentro = Boolean(ultimo && dentroDeVentana24h(ultimo.createdAt, ahora));
  const vocab = rubros.vocabularioDe(empresa);
  const nombre = primerNombre(cita.cliente);
  const servicio = cita.servicio ? cita.servicio.nombre : vocab.servicio;
  const cuando = cuandoLegible(cita, zona, clave);
  const botonesId = { rok: `ct:rok:0:0:1:0:${cita.id}:`, rep: `ct:rep:0:0:1:0:${cita.id}:`, can: `ct:can:0:0:1:0:${cita.id}:` };

  if (dentro) {
    const m = await mensajesSrv.cargarContexto({ empresa, config: conexion.agente.config, vocab });
    const direccion = conexion.agente.config && conexion.agente.config.direccionTienda;
    const texto = clave === '2h'
      ? m.t('citas_recordatorio_2h', { nombre, servicio, hora: T.legible(cita.inicio, zona).split(', ')[1], ...(direccion ? { direccion } : {}) })
      : m.t('citas_recordatorio_24h', { nombre, servicio, cuando });
    const botones = [{ id: botonesId.rok, titulo: 'Confirmo' }, { id: botonesId.rep, titulo: 'Cambiar horario' }, { id: botonesId.can, titulo: 'Cancelar' }];
    let r = await wa.enviarBotones(conexion, telefono, texto, botones);
    if (!(r && r.ok)) r = await wa.enviarTexto(conexion, telefono, `${texto}\n${botones.map((b) => `• ${b.titulo}`).join('\n')}`);
    if (!(r && r.ok)) return { estado: 'fallo', motivo: r && r.error };
    const registro = `${texto}\n${botones.map((b) => `• ${b.titulo}`).join('\n')}`;
    await prisma.mensaje.create({ data: { conversacionId: ultimo.conversacionId, rol: 'AGENTE', contenido: registro } }).catch(() => {});
    try { require('./realtime').emitMensaje(empresa.id, { conversacionId: ultimo.conversacionId, rol: 'AGENTE', contenido: registro, createdAt: new Date() }); } catch (_) { /* el panel se actualiza solo despues */ }
    return { estado: 'enviado', via: 'ventana' };
  }

  // Fuera de las 24 h: solo una plantilla aprobada por Meta.
  const plantilla = (empresa.configAgenda && empresa.configAgenda.plantilla) || null;
  if (!plantilla || plantilla.estado !== 'APPROVED') return { estado: 'omitido', motivo: 'sin_plantilla' };
  // Creditos: una plantilla cuesta; sin saldo (modo ACTIVO) no se envia. Si el envio falla, se devuelve lo cobrado.
  const refCobro = `cita${cita.id}-${clave}`;
  const cobro = await require('./creditosConsumo').cobrarPlantilla({ empresaId: empresa.id, referencia: refCobro });
  if (!cobro.permitido) return { estado: 'omitido', motivo: 'sin_creditos' };
  const r = await wa.enviarPlantilla(conexion, telefono, {
    nombre: plantilla.nombre || PLANTILLA.nombre, idioma: PLANTILLA.idioma, variables: [nombre, vocab.cita, servicio, cuando], botones: [botonesId.rok, botonesId.rep, botonesId.can],
  });
  if (!(r && r.ok)) { await require('./creditosConsumo').devolverPlantilla({ empresaId: empresa.id, referencia: refCobro }); return { estado: 'fallo', motivo: r && r.error }; }
  return { estado: 'enviado', via: 'plantilla' };
}

// ------------------------------------------------------------------ el barrido

let corriendo = false;

/**
 * Revisa las citas próximas y manda los recordatorios que toquen. Se llama cada pocos minutos desde el job.
 * @returns {{ revisadas, enviadas, omitidas, fallos }}
 */
async function procesar({ ahora = new Date(), deps = {} } = {}) {
  const res = { revisadas: 0, enviadas: 0, omitidas: 0, fallos: 0 };
  if (corriendo) return { ...res, ocupado: true };
  corriendo = true;
  try {
    const citas = await prisma.cita.findMany({
      where: { estado: { in: ACTIVAS }, inicio: { gt: ahora, lte: new Date(ahora.getTime() + 25 * HORA_MS) } },
      include: { cliente: true, servicio: true, empresa: true }, orderBy: { inicio: 'asc' }, take: 500,
    });
    for (const cita of citas) {
      const cfg = agendaDe(cita.empresa);
      if (!cfg.recordatorios.activo) continue;
      res.revisadas += 1;
      const { enviar, superados } = queToca(cita, cfg, ahora);
      if (!enviar) continue;
      if (enSilencio(ahora, cita.empresa.zonaHoraria)) continue; // se manda al abrir el horario
      for (const s of superados) await fijar(cita.id, s, { estado: 'omitido', motivo: 'superado', at: ahora.toISOString() });
      if (!(await reclamar(cita.id, enviar, ahora))) continue; // otro proceso lo tomó
      let r;
      try { r = await enviarUno(cita, enviar, { ahora, deps }); } catch (err) { r = { estado: 'fallo', motivo: err.message }; }
      if (r.estado === 'fallo') { await registrarFallo(cita, enviar, r.motivo, ahora); res.fallos += 1; console.error(`--- recordatorios: fallo con la cita #${cita.id} (${enviar}): ${r.motivo}`); } else {
        await fijar(cita.id, enviar, { estado: r.estado, at: ahora.toISOString(), ...(r.via ? { via: r.via } : {}), ...(r.motivo ? { motivo: r.motivo } : {}) });
        if (r.estado === 'enviado') res.enviadas += 1; else res.omitidas += 1;
      }
    }
  } finally { corriendo = false; }
  return res;
}
```

## 15. Estados de la cita desde el panel (`citasPanel.js`)

Estados: `PENDIENTE`, `CONFIRMADA`, `COMPLETADA`, `NO_ASISTIO`, `CANCELADA`. Las citas creadas por el bot nacen `CONFIRMADA`.

- `CONFIRMADA` → `COMPLETADA` | `NO_ASISTIO` | `CANCELADA`.
- `COMPLETADA`, `NO_ASISTIO` y `CANCELADA` son **finales** (reabrir podría pisar el cupo de otra cita).
- `COMPLETADA` y `NO_ASISTIO` solo se pueden marcar cuando la cita ya empezó.
- Al marcar `COMPLETADA` se programa el **pedido de comentarios** (sección 16).

```js
/** Cambia el estado de una cita respetando las reglas de arriba. */
async function cambiarEstado(empresa, citaId, estado, usuario = null) {
  const cita = await prisma.cita.findFirst({ where: { id: Number(citaId), empresaId: empresa.id }, include: { servicio: { select: { nombre: true } }, cliente: { select: { nombre: true, telefono: true } } } });
  if (!cita) throw new ErrorCitaPanel('Esa cita no existe.');
  const permitidos = TRANSICIONES[cita.estado] || [];
  if (!permitidos.includes(estado)) throw new ErrorCitaPanel(permitidos.length ? 'Ese cambio no corresponde para esta cita.' : 'Esa cita ya está cerrada: no se puede cambiar.');
  if (SOLO_SI_YA_EMPEZO.includes(estado) && cita.inicio.getTime() > Date.now()) throw new ErrorCitaPanel('Todavía no llegó la hora de esa cita.');
  const reclamo = await prisma.cita.updateMany({ where: { id: cita.id, empresaId: empresa.id, estado: cita.estado }, data: { estado } });
  if (reclamo.count === 0) throw new ErrorCitaPanel('Esa cita acaba de cambiar. Actualizá la página.');
  if (estado === 'CANCELADA') {
    await auditoria.registrarSinRiesgo({
      empresaId: empresa.id, actor: usuario || { nombre: 'Sistema' }, accion: 'CITA_CANCELADA', entidad: 'Cita', entidadId: cita.id,
      detalle: { cliente: cita.cliente.nombre || cita.cliente.telefono, servicio: cita.servicio ? cita.servicio.nombre : '', fecha: formato(cita.inicio, empresa.zonaHoraria, 'yyyy-MM-dd HH:mm') },
    });
  }
  // Cita completada: se le pide un comentario al cliente (si el negocio lo activo). Nunca rompe el cambio de estado.
  if (estado === 'COMPLETADA') require('./opiniones').programar({ empresaId: empresa.id, clienteId: cita.clienteId, tipo: 'CITA', refId: cita.id }).catch(() => {});
  return prisma.cita.findUnique({ where: { id: cita.id } });
}
```

## 16. Pedido de comentarios después de la cita

Si el negocio lo activó (Inteligencia, Buscador de comentarios), al completarse una cita el sistema le escribe al cliente una hora después para pedirle su opinión.

- Se pide en la **1.ª, 2.ª y 3.ª vez** del cliente (suma pedidos entregados y citas completadas). En la 2.ª y la 3.ª el mensaje cambia ("es la segunda vez que nos elegís…").
- Nunca más de un pedido por semana al mismo cliente, y nunca de noche.
- Solo si el cliente escribió en las últimas 24 h; si no, queda "omitida" y el panel explica el motivo.
- Una sola vez por cita (la base lo garantiza con una restricción única).
- La respuesta del cliente llega como un mensaje normal, así que el buscador de comentarios ya la encuentra.

```js
const HORA_MS = 3600000;
const DIA_MS = 24 * HORA_MS;
const ESPERA_MS = HORA_MS;           // se pide una hora después de cerrar el servicio
const SERVICIOS_QUE_SE_PIDEN = 3;    // 1.ª, 2.ª y 3.ª vez
const SEPARACION_MIN_MS = 7 * DIA_MS; // entre un pedido y otro al mismo cliente
const VENCE_MS = 24 * HORA_MS;       // si pasó un día sin poder enviarse, ya no tiene sentido pedirlo
const ORDINALES = { 2: 'segunda', 3: 'tercera' };

/** Pura: ¿corresponde pedir comentario en este servicio? `numero` = cuántos servicios completos lleva el cliente (contando este). */
function correspondePedir({ numero, ultimaSolicitudAt, ahora = new Date() }) {
  if (!(numero >= 1) || numero > SERVICIOS_QUE_SE_PIDEN) return { pedir: false, motivo: 'YA_NO_SE_PIDE' };
  if (ultimaSolicitudAt && ahora.getTime() - ultimaSolicitudAt.getTime() < SEPARACION_MIN_MS) return { pedir: false, motivo: 'PEDIDO_RECIENTE' };
  return { pedir: true };
}
```

```js
/**
 * Anota (si corresponde) que hay que pedirle un comentario a este cliente. No manda nada: lo manda el barrido.
 * Nunca rompe el flujo que la llama. @returns {{programada:boolean, motivo?:string}}
 */
async function programar({ empresaId, clienteId, tipo, refId, ahora = new Date() }) {
  try {
    if (!clienteId || !['PEDIDO', 'CITA'].includes(tipo)) return { programada: false, motivo: 'SIN_CLIENTE' };
    const empresa = await prisma.empresa.findUnique({ where: { id: empresaId }, select: { pedirOpiniones: true } });
    if (!empresa || !empresa.pedirOpiniones) return { programada: false, motivo: 'APAGADO' };
    const numero = await serviciosDelCliente(empresaId, clienteId);
    const ultima = await prisma.solicitudOpinion.findFirst({
      where: { empresaId, clienteId, estado: { in: ['PROGRAMADA', 'ENVIANDO', 'ENVIADA'] } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    const dec = correspondePedir({ numero, ultimaSolicitudAt: ultima && ultima.createdAt, ahora });
    if (!dec.pedir) return { programada: false, motivo: dec.motivo };
    const r = await prisma.solicitudOpinion.createMany({
      data: [{ empresaId, clienteId, tipo, refId, numeroServicio: numero, programadaPara: new Date(ahora.getTime() + ESPERA_MS) }], skipDuplicates: true,
    });
    return { programada: r.count === 1, ...(r.count === 1 ? {} : { motivo: 'YA_EXISTIA' }) };
  } catch (err) {
    console.error('No se pudo programar el pedido de comentario:', err.message);
    return { programada: false, motivo: 'ERROR' };
  }
}
```

## 17. Catálogo de mensajes del bot de citas

Todos los textos que ve el cliente viven en `lib/services/mensajesBase.js` y el negocio puede editarlos. Claves:

- `citas_bienvenida`: Saludo del bot de citas con el menu inicial (viene con los botones Agendar / Mi cita / Ubicacion y horarios).
- `citas_elegir_servicio`: Pregunta que servicio quiere agendar (viene con la lista de servicios).
- `citas_elegir_profesional`: Pregunta con quien quiere la cita (viene con la lista de profesionales o recursos).
- `citas_elegir_personas`: Pregunta para cuantas personas es la reserva (viene con la lista de cantidades).
- `citas_elegir_dia`: Ofrece los proximos dias con lugar (viene con la lista de dias y cuantos horarios hay en cada uno).
- `citas_elegir_hora`: Ofrece los horarios libres de un dia (viene con la lista de horarios, por la mañana y por la tarde).
- `citas_sin_horarios`: No hay horarios libres en los proximos dias para ese servicio.
- `citas_dia_sin_horarios`: El dia que pidio el cliente no tiene horarios libres: se le ofrecen otros dias.
- `citas_pedir_nombre`: Pide el nombre para la cita.
- `citas_nombre_ejemplo`: No se entendio el nombre: se pide de nuevo con un ejemplo.
- `citas_resumen`: Resumen de la cita para confirmar (viene con los botones Confirmar / Cambiar).
- `citas_creada`: La cita quedo confirmada.
- `citas_horario_ocupado`: El horario elegido se acaba de ocupar: se ofrecen los que siguen libres ese dia.
- `citas_cliente_ocupado`: El cliente ya tiene otra cita a esa hora (con otra persona o servicio): se le pide elegir otro horario.
- `citas_sin_citas`: El cliente no tiene citas proximas.
- `citas_elegir_cita`: El cliente tiene varias citas: pregunta cual (viene con la lista).
- `citas_mi_cita`: Muestra la proxima cita del cliente (viene con los botones Cambiar / Cancelar).
- `citas_confirmar_cancelar`: Pide confirmacion antes de cancelar (viene con los botones Si / No).
- `citas_cancelada`: La cita se cancelo.
- `citas_reprogramar`: Empieza a mover una cita: pide el nuevo dia (viene con la lista de dias).
- `citas_reprogramada`: La cita se movio al nuevo horario.
- `citas_ya_agendada`: El cliente toco dos veces Confirmar: la cita ya estaba agendada, no se duplica.
- `citas_ya_no_disponible`: Una cita o un boton ya no sirve (vencio, se cancelo, se uso): se vuelve al menu.
- `citas_tope`: El negocio alcanzo el tope de citas de su plan: se ofrece un asesor.
- `citas_grupo_grande`: Piden mas personas de las que permite el servicio: lo coordina una persona.
- `citas_sin_servicios`: El negocio todavia no cargo servicios para agendar.
- `citas_alcance`: El cliente se fue del tema o intento manipular al bot de citas.
- `citas_recordatorio_24h`: Recordatorio un dia antes de la cita (viene con los botones Confirmo / Cambiar horario / Cancelar). Solo dentro de las 24 h del ultimo mensaje del cliente; fuera de eso se usa la plantilla aprobada por Meta.
- `citas_recordatorio_2h`: Recordatorio un par de horas antes de la cita (viene con los botones Confirmo / Cambiar horario / Cancelar).
- `citas_confirmo_gracias`: El cliente confirmo que va a ir (tocó Confirmo en el recordatorio).
- `citas_cancelada_por_negocio`: Aviso al cliente cuando el NEGOCIO cancela su cita desde el panel (solo si el cliente escribio en las ultimas 24 h).
- `opinion_pedido`: Se le pide un comentario al cliente despues de que su pedido se marca como entregado (solo si el negocio lo activo y el cliente escribio en las ultimas 24 h).
- `opinion_cita`: Se le pide un comentario al cliente despues de una cita completada.
- `opinion_recurrente`: Comentario que se le pide a un cliente que ya vino o compro por segunda o tercera vez.
- `citas_menu_aclarar`: No se entendio el texto libre: se vuelve a mostrar el menu (la reserva se hace tocando las opciones).

Textos por defecto (tal como están en el código):

```js
  M('citas_bienvenida', 'Citas', 'Saludo del bot de citas con el menu inicial (viene con los botones Agendar / Mi cita / Ubicacion y horarios).',
    '¡Hola! 👋 Bienvenido a {{negocio}}. ¿Qué {r:querés|quieres} hacer?'),
  M('citas_elegir_servicio', 'Citas', 'Pregunta que servicio quiere agendar (viene con la lista de servicios).',
    '¿Qué {{vocab.servicio}} {r:querés|quieres} agendar?'),
  M('citas_elegir_profesional', 'Citas', 'Pregunta con quien quiere la cita (viene con la lista de profesionales o recursos).',
    '¿Con qué {{vocab.profesional}} {r:querés|quieres} tu {{vocab.cita}} de {{servicio}}?', { servicio: 'texto' }, { servicio: 'Corte de pelo' }),
  M('citas_elegir_personas', 'Citas', 'Pregunta para cuantas personas es la reserva (viene con la lista de cantidades).',
    '¿Para cuántas personas?'),
  M('citas_elegir_dia', 'Citas', 'Ofrece los proximos dias con lugar (viene con la lista de dias y cuantos horarios hay en cada uno).',
    'Estos son los próximos días con lugar para {{servicio}}. ¿Qué día te queda bien?', { servicio: 'texto' }, { servicio: 'Corte de pelo' }),
  M('citas_elegir_hora', 'Citas', 'Ofrece los horarios libres de un dia (viene con la lista de horarios, por la mañana y por la tarde).',
    'Horarios libres para el {{dia}}. ¿Cuál {r:elegís|eliges}?', { dia: 'texto' }, { dia: 'jueves 12 de noviembre' }),
  M('citas_sin_horarios', 'Citas', 'No hay horarios libres en los proximos dias para ese servicio.',
    'Por ahora no hay horarios libres para {{servicio}} en los próximos días 😕 {{asesor}}', { servicio: 'texto', asesor: 'texto' }, { servicio: 'Corte de pelo', asesor: 'Si querés, escribí "asesor" y una persona te ayuda.' }),
  M('citas_dia_sin_horarios', 'Citas', 'El dia que pidio el cliente no tiene horarios libres: se le ofrecen otros dias.',
    'El {{dia}} no tengo horarios libres 😕 Estos días sí:', { dia: 'texto' }, { dia: 'jueves 12 de noviembre' }),
  M('citas_pedir_nombre', 'Citas', 'Pide el nombre para la cita.',
    '¿A nombre de quién agendo?'),
  M('citas_nombre_ejemplo', 'Citas', 'No se entendio el nombre: se pide de nuevo con un ejemplo.',
    'Solo necesito tu nombre para agendar, por ejemplo: "Ana Pérez" 🙂'),
  M('citas_resumen', 'Citas', 'Resumen de la cita para confirmar (viene con los botones Confirmar / Cambiar).',
    'Este es el resumen de tu {{vocab.cita}}:\n{{resumen}}\n\n¿Está todo bien?', { resumen: 'lista' }, { resumen: '• Corte de pelo\n• jueves 12 de noviembre, 15:30' }),
  M('citas_creada', 'Citas', 'La cita quedo confirmada.',
    '¡Listo, queda agendado! ✅\n{{detalle}}{{#direccion}}\n📍 {{direccion}}{{/direccion}}', { detalle: 'lista', direccion: 'texto?' }, { detalle: '• Corte de pelo\n• jueves 12 de noviembre, 15:30', direccion: 'Av. Siempre Viva 123' }),
  M('citas_horario_ocupado', 'Citas', 'El horario elegido se acaba de ocupar: se ofrecen los que siguen libres ese dia.',
    'Ese horario se acaba de ocupar 😕 Estos siguen libres:'),
  M('citas_cliente_ocupado', 'Citas', 'El cliente ya tiene otra cita a esa hora (con otra persona o servicio): se le pide elegir otro horario.',
    'Ya {r:tenés|tienes} otra {{vocab.cita}} en ese horario 🙏 {r:Elegí|Elige} otra hora:'),
  M('citas_sin_citas', 'Citas', 'El cliente no tiene citas proximas.',
    'No {r:tenés|tienes} {{vocab.citas}} para los próximos días. ¿{r:Querés|Quieres} agendar?'),
  M('citas_elegir_cita', 'Citas', 'El cliente tiene varias citas: pregunta cual (viene con la lista).',
    'Tus {{vocab.citas}}, de la fecha más cercana en adelante. ¿Cuál {r:querés|quieres} ver?'),
  M('citas_mi_cita', 'Citas', 'Muestra la proxima cita del cliente (viene con los botones Cambiar / Cancelar).',
    'Tu {{vocab.cita}}:\n{{detalle}}\n\n¿Qué {r:querés|quieres} hacer?', { detalle: 'lista' }, { detalle: '• Corte de pelo\n• jueves 12 de noviembre, 15:30' }),
  M('citas_confirmar_cancelar', 'Citas', 'Pide confirmacion antes de cancelar (viene con los botones Si / No).',
    '¿{r:Querés|Quieres} cancelar tu {{vocab.cita}}?\n{{detalle}}', { detalle: 'lista' }, { detalle: '• Corte de pelo\n• jueves 12 de noviembre, 15:30' }),
  M('citas_cancelada', 'Citas', 'La cita se cancelo.',
    'Listo, cancelé tu {{vocab.cita}} del {{cuando}}. Cuando {r:quieras|quieras} agendar otra, acá estoy 🙂', { cuando: 'texto' }, { cuando: 'jueves 12 de noviembre, 15:30' }),
  M('citas_reprogramar', 'Citas', 'Empieza a mover una cita: pide el nuevo dia (viene con la lista de dias).',
    'Vamos a mover tu {{vocab.cita}} de {{servicio}}. ¿Qué día te queda mejor?', { servicio: 'texto' }, { servicio: 'Corte de pelo' }),
  M('citas_reprogramada', 'Citas', 'La cita se movio al nuevo horario.',
    'Listo, moví tu {{vocab.cita}} ✅\n{{detalle}}', { detalle: 'lista' }, { detalle: '• Corte de pelo\n• viernes 13 de noviembre, 10:00' }),
  M('citas_ya_agendada', 'Citas', 'El cliente toco dos veces Confirmar: la cita ya estaba agendada, no se duplica.',
    'Eso ya quedó registrado ✅\n{{detalle}}', { detalle: 'lista' }, { detalle: '• Corte de pelo\n• jueves 12 de noviembre, 15:30' }),
  M('citas_ya_no_disponible', 'Citas', 'Una cita o un boton ya no sirve (vencio, se cancelo, se uso): se vuelve al menu.',
    'Eso ya no está disponible 🙏 {r:Elegí|Elige} una opción para seguir:'),
  M('citas_tope', 'Citas', 'El negocio alcanzo el tope de citas de su plan: se ofrece un asesor.',
    'Por ahora no puedo agendar más {{vocab.citas}} por acá 🙏 {{asesor}}', { asesor: 'texto' }, { asesor: 'Si querés, escribí "asesor" y una persona te ayuda.' }),
  M('citas_grupo_grande', 'Citas', 'Piden mas personas de las que permite el servicio: lo coordina una persona.',
    'Para más de {{max}} personas lo coordina una persona del equipo. {{asesor}}', { max: 'numero', asesor: 'texto' }, { max: 8, asesor: 'Si querés, escribí "asesor" y una persona te ayuda.' }),
  M('citas_sin_servicios', 'Citas', 'El negocio todavia no cargo servicios para agendar.',
    'Todavía no tengo {{vocab.servicios}} cargados para agendar por acá. {{asesor}}', { asesor: 'texto' }, { asesor: 'Si querés, escribí "asesor" y una persona te ayuda.' }),
  M('citas_alcance', 'Citas', 'El cliente se fue del tema o intento manipular al bot de citas.',
    'Solo puedo ayudarte con {{vocab.citas}} y consultas de {{negocio}} 😊 {r:Elegí|Elige} una opción 👇'),
  M('citas_recordatorio_24h', 'Citas', 'Recordatorio un dia antes de la cita (viene con los botones Confirmo / Cambiar horario / Cancelar). Solo dentro de las 24 h del ultimo mensaje del cliente; fuera de eso se usa la plantilla aprobada por Meta.',
    'Hola {{nombre}} 👋 Te recordamos tu {{vocab.cita}} de {{servicio}}: {{cuando}}. ¿Nos confirmás que venís?', { nombre: 'texto', servicio: 'texto', cuando: 'texto' }, { nombre: 'Ana', servicio: 'Corte de pelo', cuando: 'jueves 12 de noviembre a las 10:30' }),
  M('citas_recordatorio_2h', 'Citas', 'Recordatorio un par de horas antes de la cita (viene con los botones Confirmo / Cambiar horario / Cancelar).',
    'Hola {{nombre}}, tu {{vocab.cita}} de {{servicio}} es hoy a las {{hora}}. ¡Te esperamos!{{#direccion}} 📍 {{direccion}}{{/direccion}}', { nombre: 'texto', servicio: 'texto', hora: 'texto', direccion: 'texto?' }, { nombre: 'Ana', servicio: 'Corte de pelo', hora: '10:30', direccion: 'Av. Siempre Viva 123' }),
  M('citas_confirmo_gracias', 'Citas', 'El cliente confirmo que va a ir (tocó Confirmo en el recordatorio).',
    '¡Gracias {{nombre}}! Quedó confirmada tu asistencia ✅ Te esperamos.', { nombre: 'texto' }, { nombre: 'Ana' }),
  M('citas_cancelada_por_negocio', 'Citas', 'Aviso al cliente cuando el NEGOCIO cancela su cita desde el panel (solo si el cliente escribio en las ultimas 24 h).',
    'Hola {{nombre}}, tuvimos que cancelar tu {{vocab.cita}} del {{cuando}} 🙏 Perdón por el inconveniente. {r:Escribinos|Escríbenos} para agendar otra.', { nombre: 'texto', cuando: 'texto' }, { nombre: 'Ana', cuando: 'jueves 12 de noviembre, 10:30' }),
  M('opinion_pedido', 'Comentarios', 'Se le pide un comentario al cliente despues de que su pedido se marca como entregado (solo si el negocio lo activo y el cliente escribio en las ultimas 24 h).',
    'Hola {{nombre}} 👋 ¿Cómo te fue con tu pedido? {r:Contanos|Cuéntanos} qué te pareció: el producto, la entrega, la atención. {r:Respondé|Responde} con un mensaje y lo leemos 💜', { nombre: 'texto' }, { nombre: 'Ana' }),
  M('opinion_cita', 'Comentarios', 'Se le pide un comentario al cliente despues de una cita completada.',
    'Hola {{nombre}} 👋 ¿Cómo te fue con tu {{vocab.cita}} de {{servicio}}? {r:Contanos|Cuéntanos} qué te pareció: la atención, el resultado, lo que mejorarías. {r:Respondé|Responde} con un mensaje y lo leemos 💜', { nombre: 'texto', servicio: 'texto' }, { nombre: 'Ana', servicio: 'Corte de pelo' }),
  M('opinion_recurrente', 'Comentarios', 'Comentario que se le pide a un cliente que ya vino o compro por segunda o tercera vez.',
    'Hola {{nombre}} 💜 Es la {{veces}} vez que {r:nos elegís|nos eliges} y nos alegra mucho. ¿Qué es lo que más te gusta y qué mejorarías? {r:Contanos|Cuéntanos} con un mensaje, lo leemos todos.', { nombre: 'texto', veces: 'texto' }, { nombre: 'Ana', veces: 'segunda' }),
  M('citas_menu_aclarar', 'Citas', 'No se entendio el texto libre: se vuelve a mostrar el menu (la reserva se hace tocando las opciones).',
    'No llegué a entender eso 🙏 Para agendar, cambiar o cancelar {r:tocá|toca} una opción 👇'),
```

## 18. Tests que cubren esto

`test/bot-citas.test.js` (recorrido completo, saludos, texto libre, botones), `test/agenda.test.js` (motor de agenda), `test/citas-panel.test.js` (estados desde el panel), `test/agenda-solapes.test.js` (sin dobles reservas, cliente ocupado, ventanas que se solapan), `test/recordatorios.test.js` (reglas, ventana de 24 h, plantilla, silencio, reintentos), `test/opiniones.test.js` (pedido de comentarios). Se corren con `npm test`.
