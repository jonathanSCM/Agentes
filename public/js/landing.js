// Landing de Proshop: chat animado, contadores, pestañas de módulos. Todo es mejora: sin JS la página se lee igual.
(function () {
  'use strict';
  var quieto = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Chat del hero: los mensajes aparecen de a uno y se repite ----
  var chat = document.getElementById('lpChat');
  if (chat) {
    var msgs = [].slice.call(chat.querySelectorAll('.lp-msg'));
    var typing = chat.querySelector('.lp-typing');
    var toasts = [].slice.call(document.querySelectorAll('.lp-toast'));
    if (quieto) { msgs.forEach(function (m) { m.classList.add('on'); }); toasts.forEach(function (t) { t.classList.add('on'); }); }
    else {
      var corre = function () {
        msgs.forEach(function (m) { m.classList.remove('on'); }); toasts.forEach(function (t) { t.classList.remove('on'); });
        var t0 = 400;
        msgs.forEach(function (m, i) {
          var esAgente = m.classList.contains('out');
          if (esAgente) { setTimeout(function () { typing.classList.add('on'); }, t0); t0 += 900; }
          setTimeout(function () { typing.classList.remove('on'); m.classList.add('on'); }, t0);
          t0 += 1100;
          if (i === 3) setTimeout(function () { toasts[0] && toasts[0].classList.add('on'); }, t0);
        });
        setTimeout(function () { toasts[1] && toasts[1].classList.add('on'); }, t0 + 500);
        setTimeout(corre, t0 + 6000);
      };
      corre();
    }
  }

  // ---- Contadores: suben cuando entran en pantalla ----
  var fmt = function (n) { return Math.round(n).toLocaleString('es-BO'); };
  var contar = function (el) {
    var meta = Number(el.getAttribute('data-count')); var pref = el.getAttribute('data-pref') || ''; var suf = el.getAttribute('data-suf') || '';
    if (quieto || !isFinite(meta)) { el.textContent = pref + fmt(meta) + suf; return; }
    var ini = performance.now(); var dur = 1400;
    (function paso(t) {
      var p = Math.min(1, (t - ini) / dur); var e = 1 - Math.pow(1 - p, 3);
      el.textContent = pref + fmt(meta * e) + suf;
      if (p < 1) requestAnimationFrame(paso);
    })(ini);
  };
  var cont = [].slice.call(document.querySelectorAll('[data-count]'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { contar(e.target); io.unobserve(e.target); } }); }, { threshold: 0.4 });
    cont.forEach(function (el) { io.observe(el); });
  } else cont.forEach(contar);

  // ---- Pestañas de módulos ----
  var tabs = [].slice.call(document.querySelectorAll('.lp-tab'));
  var panes = [].slice.call(document.querySelectorAll('.lp-pane'));
  function abrir(id, foco) {
    tabs.forEach(function (t) { var on = t.getAttribute('aria-controls') === id; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; if (on && foco) t.focus(); });
    panes.forEach(function (p) { p.classList.toggle('on', p.id === id); });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { abrir(t.getAttribute('aria-controls')); });
    t.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
      e.preventDefault(); abrir(tabs[(i + d + tabs.length) % tabs.length].getAttribute('aria-controls'), true);
    });
  });
})();
