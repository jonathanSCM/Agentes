/* Selector de tema claro / oscuro. Recuerda la eleccion; sin elegir sigue al sistema. */
(function () {
  function efectivo() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function aplicar(nuevo) {
    document.documentElement.setAttribute('data-theme', nuevo);
    try { localStorage.setItem('proshop-tema', nuevo === 'dark' ? 'oscuro' : 'claro'); } catch (e) {}
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', nuevo === 'dark' ? '#0f0e17' : '#6d28d9');
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-tema-toggle]');
    if (b) aplicar(efectivo() === 'dark' ? 'light' : 'dark');
  });
})();
