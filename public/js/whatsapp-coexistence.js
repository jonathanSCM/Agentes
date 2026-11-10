// Conectar el número por coexistence (Embedded Signup de Meta). Abre el registro de Meta, junta el código y el id de la cuenta de
// WhatsApp Business, y se los manda al servidor (que canjea el código y guarda todo; el secreto de la app nunca pasa por acá).
(function () {
  var C = window.COEX;
  var btn = document.getElementById('waCoexBtn');
  if (!C || !btn) return;
  var err = document.getElementById('waCoexError'); var ok = document.getElementById('waCoexOk');
  var sesion = { code: null, wabaId: null, phoneNumberId: null, terminado: false };
  var enviando = false;

  function mostrar(el, msg) { err.hidden = true; ok.hidden = true; el.textContent = msg; el.hidden = false; }

  // Meta avisa por postMessage (desde facebook.com) cómo terminó el registro.
  window.addEventListener('message', function (e) {
    if (!/^https:\/\/(www|web)\.facebook\.com$/.test(e.origin)) return;
    var d;
    try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (x) { return; }
    if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (/^FINISH/.test(d.event || '') && d.data) {
      sesion.wabaId = d.data.waba_id || sesion.wabaId;
      sesion.phoneNumberId = d.data.phone_number_id || sesion.phoneNumberId;
      sesion.terminado = true; intentarConectar();
    } else if (d.event === 'CANCEL') {
      mostrar(err, 'Cancelaste el registro en Meta. Cuando quieras, probá de nuevo.');
      btn.disabled = false;
    } else if (d.event === 'ERROR') {
      mostrar(err, 'Meta informó un error durante el registro' + (d.data && d.data.error_message ? ': ' + d.data.error_message : '') + '.');
      btn.disabled = false;
    }
  });

  function intentarConectar() {
    if (enviando || !sesion.code || !sesion.terminado || !sesion.wabaId) return;
    enviando = true; btn.disabled = true; btn.textContent = 'Conectando…';
    fetch('/panel/whatsapp/coexistence', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: sesion.code, wabaId: sesion.wabaId, phoneNumberId: sesion.phoneNumberId }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Respuesta inesperada del servidor.' }; }); })
      .then(function (d) {
        enviando = false; btn.textContent = 'Conectar con Meta';
        if (!d.ok) { mostrar(err, d.error || 'No se pudo conectar.'); btn.disabled = false; return; }
        mostrar(ok, '¡Listo! Número ' + (d.numero || '') + ' conectado. Recargando…');
        setTimeout(function () { window.location.reload(); }, 1200);
      })
      .catch(function () { enviando = false; btn.disabled = false; btn.textContent = 'Conectar con Meta'; mostrar(err, 'No hay conexión. Probá de nuevo.'); });
  }

  window.fbAsyncInit = function () { FB.init({ appId: C.appId, autoLogAppEvents: true, xfbml: false, version: C.graphVersion }); };
  var sdk = document.createElement('script'); sdk.async = true; sdk.defer = true; sdk.crossOrigin = 'anonymous'; sdk.src = 'https://connect.facebook.net/en_US/sdk.js';
  sdk.onerror = function () { mostrar(err, 'No se pudo cargar Meta. Revisá tu conexión o si tu navegador bloquea facebook.com.'); };
  document.head.appendChild(sdk);

  btn.addEventListener('click', function () {
    if (!window.FB) { mostrar(err, 'Meta todavía está cargando. Esperá un segundo y probá de nuevo.'); return; }
    err.hidden = true; ok.hidden = true; sesion = { code: null, wabaId: null, phoneNumberId: null, terminado: false }; btn.disabled = true;
    FB.login(function (resp) {
      if (resp && resp.authResponse && resp.authResponse.code) { sesion.code = resp.authResponse.code; intentarConectar(); }
      else { btn.disabled = false; mostrar(err, 'No se completó la autorización en Meta.'); }
    }, C.login);
  });
})();
