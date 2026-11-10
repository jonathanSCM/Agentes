// Chat del panel, como WhatsApp Web: Escape cierra el chat, adjuntar archivos (también arrastrando o pegando una imagen),
// mandar una ubicación, Enter envía y Shift+Enter hace un salto de línea. El servidor valida todo; esto es solo la comodidad.
(function () {
  var raiz = document.getElementById('bandeja');
  if (!raiz) return;
  var abierta = raiz.getAttribute('data-abierta') || '';
  if (!abierta) return;
  var base = '/panel/conversaciones/' + encodeURIComponent(abierta);
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- Escape: cierra lo de arriba; si no hay nada, cierra el chat
  function ventanaAbierta() {
    var ids = ['adjOverlay', 'ubiOverlay', 'prodOverlay'];
    for (var i = 0; i < ids.length; i++) { var el = $(ids[i]); if (el && !el.hidden) return el; }
    return null;
  }
  function cerrarMenu() { var m = $('adjMenu'); if (m && !m.hidden) { m.hidden = true; $('btnAdjuntar').setAttribute('aria-expanded', 'false'); return true; } return false; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    var v = ventanaAbierta();
    if (v) { v.hidden = true; e.preventDefault(); return; }
    if (cerrarMenu()) { e.preventDefault(); return; }
    // Al cerrar el chat, el borrador queda guardado (se ve al volver a abrirlo).
    var qs = '';
    var filtro = raiz.getAttribute('data-filtro'); var q = raiz.getAttribute('data-q');
    if (filtro && filtro !== 'todas') qs += (qs ? '&' : '?') + 'filtro=' + encodeURIComponent(filtro);
    if (q) qs += (qs ? '&' : '?') + 'q=' + encodeURIComponent(q);
    e.preventDefault();
    window.location.href = '/panel/conversaciones' + qs;
  });

  var form = $('formMensajeHumano');
  if (!form) return; // sin el control del chat no se puede escribir ni adjuntar

  // ---------------------------------------------------------------- Compositor: Enter envía, Shift+Enter salto, crece solo, borrador
  var texto = $('chatTexto');
  var claveBorrador = 'borrador:' + abierta;
  function leerBorrador() { try { return sessionStorage.getItem(claveBorrador) || ''; } catch (e) { return ''; } }
  function guardarBorrador(v) { try { if (v) sessionStorage.setItem(claveBorrador, v); else sessionStorage.removeItem(claveBorrador); } catch (e) { /* sin almacenamiento */ } }
  function ajustarAlto() { texto.style.height = 'auto'; texto.style.height = Math.min(texto.scrollHeight, 140) + 'px'; texto.style.overflowY = texto.scrollHeight > 140 ? 'auto' : 'hidden'; }
  texto.value = leerBorrador(); ajustarAlto();
  texto.addEventListener('input', function () { ajustarAlto(); guardarBorrador(texto.value); });
  texto.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (texto.value.trim()) form.requestSubmit();
    }
  });
  form.addEventListener('submit', function (e) { if (!texto.value.trim()) { e.preventDefault(); return; } guardarBorrador(''); });
  texto.focus();

  // ---------------------------------------------------------------- Menú de adjuntar
  var btnAdjuntar = $('btnAdjuntar'); var menu = $('adjMenu');
  btnAdjuntar.addEventListener('click', function (e) {
    e.stopPropagation();
    var abrir = menu.hidden; menu.hidden = !abrir; btnAdjuntar.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    if (abrir) { var primero = menu.querySelector('button'); if (primero) primero.focus(); }
  });
  document.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target) && e.target !== btnAdjuntar) cerrarMenu(); });
  menu.addEventListener('click', function () { cerrarMenu(); });

  // ---------------------------------------------------------------- Archivos: elegir, arrastrar o pegar → vista previa → enviar
  var inputArchivo = $('adjArchivo');
  var cola = []; var enviando = false;
  var ov = $('adjOverlay'); var previa = $('adjPrevia'); var caption = $('adjCaption'); var campoCaption = $('adjCampoCaption');
  var errorAdj = $('adjError'); var btnEnviar = $('adjEnviar'); var colaTxt = $('adjCola');
  var urlPrevia = null;

  function tam(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function esImagen(f) { return /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name); }
  function esAudio(f) { return /\.(mp3|ogg|m4a|aac|amr)$/i.test(f.name); }
  function liberarPrevia() { if (urlPrevia) { URL.revokeObjectURL(urlPrevia); urlPrevia = null; } }

  function mostrarSiguiente() {
    liberarPrevia(); errorAdj.hidden = true; caption.value = '';
    if (!cola.length) { ov.hidden = true; texto.focus(); return; }
    var f = cola[0];
    previa.innerHTML = '';
    if (esImagen(f)) { urlPrevia = URL.createObjectURL(f); var img = document.createElement('img'); img.src = urlPrevia; img.alt = ''; previa.appendChild(img); }
    else { var ic = document.createElement('div'); ic.className = 'adj-icono'; ic.textContent = esAudio(f) ? '🎤' : (/\.(mp4|3gp)$/i.test(f.name) ? '🎥' : '📄'); previa.appendChild(ic); }
    var nom = document.createElement('div'); nom.className = 'adj-nombre'; nom.textContent = f.name + ' · ' + tam(f.size); previa.appendChild(nom);
    campoCaption.hidden = esAudio(f);
    colaTxt.textContent = cola.length > 1 ? 'Faltan ' + (cola.length - 1) + ' más' : '';
    btnEnviar.disabled = false; btnEnviar.textContent = 'Enviar';
    ov.hidden = false; (campoCaption.hidden ? btnEnviar : caption).focus();
  }
  function encolar(archivos) {
    var lista = Array.prototype.slice.call(archivos || []);
    if (!lista.length) return;
    var vacia = !cola.length;
    lista.forEach(function (f) { cola.push(f); });
    if (vacia) mostrarSiguiente();
  }
  function cancelarTodo() { cola = []; mostrarSiguiente(); }

  menu.querySelectorAll('[data-adj="documento"], [data-adj="foto"]').forEach(function (b) {
    b.addEventListener('click', function () { inputArchivo.value = ''; inputArchivo.click(); });
  });
  inputArchivo.addEventListener('change', function () { encolar(inputArchivo.files); inputArchivo.value = ''; });

  btnEnviar.addEventListener('click', function () {
    if (enviando || !cola.length) return;
    enviando = true; btnEnviar.disabled = true; btnEnviar.textContent = 'Enviando…'; errorAdj.hidden = true;
    var datos = new FormData(); datos.append('archivo', cola[0]); datos.append('caption', caption.value);
    fetch(base + '/archivo', { method: 'POST', credentials: 'same-origin', body: datos })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Respuesta inesperada del servidor.' }; }); })
      .then(function (d) {
        enviando = false;
        if (!d.ok) { errorAdj.textContent = d.error || 'No se pudo enviar.'; errorAdj.hidden = false; btnEnviar.disabled = false; btnEnviar.textContent = 'Reintentar'; return; }
        cola.shift(); mostrarSiguiente(); // el mensaje aparece en el chat por el canal en vivo
      })
      .catch(function () { enviando = false; errorAdj.textContent = 'No hay conexión. Probá de nuevo.'; errorAdj.hidden = false; btnEnviar.disabled = false; btnEnviar.textContent = 'Reintentar'; });
  });
  $('adjCancelar').addEventListener('click', cancelarTodo);
  $('adjCerrar').addEventListener('click', cancelarTodo);
  ov.addEventListener('click', function (e) { if (e.target === ov) cancelarTodo(); });
  caption.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); btnEnviar.click(); } });
  // Escape cierra la vista previa y descarta lo que faltaba (el handler de arriba la oculta; acá se vacía la cola).
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) { cola = []; liberarPrevia(); } }, true);

  // Pegar una imagen (captura de pantalla, copiada de otra app) en el cuadro de texto.
  texto.addEventListener('paste', function (e) {
    var archivos = e.clipboardData && e.clipboardData.files;
    if (archivos && archivos.length) { e.preventDefault(); encolar(archivos); }
  });
  // Arrastrar archivos sobre el chat.
  var zona = $('chatMensajes');
  var arrastre = 0;
  function conArchivos(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
  ['dragenter', 'dragover'].forEach(function (t) { zona.addEventListener(t, function (e) { if (!conArchivos(e)) return; e.preventDefault(); if (t === 'dragenter') arrastre++; zona.classList.add('chat-arrastrando'); }); });
  zona.addEventListener('dragleave', function () { arrastre = Math.max(0, arrastre - 1); if (!arrastre) zona.classList.remove('chat-arrastrando'); });
  zona.addEventListener('drop', function (e) { if (!conArchivos(e)) return; e.preventDefault(); arrastre = 0; zona.classList.remove('chat-arrastrando'); encolar(e.dataTransfer.files); });

  // ---------------------------------------------------------------- Ubicación
  var uov = $('ubiOverlay'); var uError = $('ubiError'); var uEnviar = $('ubiEnviar');
  var campos = { enlace: $('ubiEnlace'), lat: $('ubiLat'), lng: $('ubiLng'), nombre: $('ubiNombre'), direccion: $('ubiDireccion') };
  menu.querySelector('[data-adj="ubicacion"]').addEventListener('click', function () {
    Object.keys(campos).forEach(function (k) { campos[k].value = ''; });
    uError.hidden = true; uEnviar.disabled = false; uEnviar.textContent = 'Enviar ubicación'; uov.hidden = false; campos.enlace.focus();
  });
  function cerrarUbicacion() { uov.hidden = true; texto.focus(); }
  $('ubiCerrar').addEventListener('click', cerrarUbicacion);
  $('ubiCancelar').addEventListener('click', cerrarUbicacion);
  uov.addEventListener('click', function (e) { if (e.target === uov) cerrarUbicacion(); });
  function errorUbi(msg) { uError.textContent = msg; uError.hidden = false; }

  $('ubiMia').addEventListener('click', function () {
    uError.hidden = true;
    if (!navigator.geolocation) { errorUbi('Tu navegador no puede darme tu ubicación. Pegá un link de Google Maps.'); return; }
    var b = $('ubiMia'); b.disabled = true; b.textContent = 'Buscando…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      b.disabled = false; b.textContent = '📍 Mi ubicación actual';
      campos.lat.value = pos.coords.latitude.toFixed(6); campos.lng.value = pos.coords.longitude.toFixed(6); campos.enlace.value = '';
    }, function () {
      b.disabled = false; b.textContent = '📍 Mi ubicación actual';
      errorUbi('No pude obtener tu ubicación (revisá el permiso del navegador). Pegá un link de Google Maps.');
    }, { enableHighAccuracy: true, timeout: 10000 });
  });

  function enviarUbicacion(cuerpo) {
    uEnviar.disabled = true; uEnviar.textContent = 'Enviando…'; uError.hidden = true;
    fetch(base + '/ubicacion', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Respuesta inesperada del servidor.' }; }); })
      .then(function (d) {
        uEnviar.disabled = false; uEnviar.textContent = 'Enviar ubicación';
        if (!d.ok) { errorUbi(d.error || 'No se pudo enviar.'); return; }
        cerrarUbicacion();
      })
      .catch(function () { uEnviar.disabled = false; uEnviar.textContent = 'Enviar ubicación'; errorUbi('No hay conexión. Probá de nuevo.'); });
  }
  $('ubiLocal').addEventListener('click', function () { enviarUbicacion({ tienda: true, nombre: campos.nombre.value, direccion: campos.direccion.value }); });
  uEnviar.addEventListener('click', function () {
    var c = { nombre: campos.nombre.value, direccion: campos.direccion.value };
    if (campos.lat.value.trim() || campos.lng.value.trim()) { c.lat = campos.lat.value.trim().replace(',', '.'); c.lng = campos.lng.value.trim().replace(',', '.'); }
    else if (campos.enlace.value.trim()) c.enlace = campos.enlace.value.trim();
    else { errorUbi('Pegá un link de Google Maps, escribí las coordenadas o usá "Mi ubicación actual".'); return; }
    enviarUbicacion(c);
  });
})();
