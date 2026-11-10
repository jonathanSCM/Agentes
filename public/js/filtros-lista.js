// Filtros instantáneos para listas del panel: buscador, categoría y botones de estado. Funciona con cualquier lista cuyos elementos
// lleven data-item, data-texto (lo que se busca), data-categoria y data-tags (separados por espacio).
// <div class="filtros-barra" data-objetivo="#lista"> con [data-filtro-q], [data-filtro-cat], [data-filtro-chip="tag"], [data-filtro-cuenta].
(function () {
  document.querySelectorAll('.filtros-barra[data-objetivo]').forEach(function (barra) {
    var lista = document.querySelector(barra.getAttribute('data-objetivo'));
    if (!lista) return;
    var items = Array.prototype.slice.call(lista.querySelectorAll('[data-item]'));
    var q = barra.querySelector('[data-filtro-q]');
    var cat = barra.querySelector('[data-filtro-cat]');
    var chips = Array.prototype.slice.call(barra.querySelectorAll('[data-filtro-chip]'));
    var cuenta = barra.querySelector('[data-filtro-cuenta]');
    var vacio = document.querySelector(barra.getAttribute('data-vacio') || '[data-filtro-vacio]');
    var etiqueta = barra.getAttribute('data-etiqueta') || 'resultados';
    var porPagina = parseInt(barra.getAttribute('data-pagina'), 10) || 0; // 0 = sin páginas
    var pagina = 1;
    var tag = '';
    var nav = null;
    if (porPagina) { nav = document.createElement('div'); nav.className = 'f-paginas'; nav.setAttribute('role', 'navigation'); nav.setAttribute('aria-label', 'Páginas'); var ref = lista.closest('.table-wrap') || lista; ref.parentNode.insertBefore(nav, ref.nextSibling); }
    var norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };

    function aplicar() {
      var texto = norm(q ? q.value.trim() : '');
      var categoria = cat ? cat.value : '';
      var visibles = 0;
      var coinciden = [];
      items.forEach(function (el) {
        var ok = (!texto || norm(el.getAttribute('data-texto')).indexOf(texto) !== -1)
          && (!categoria || el.getAttribute('data-categoria') === categoria)
          && (!tag || (' ' + (el.getAttribute('data-tags') || '') + ' ').indexOf(' ' + tag + ' ') !== -1);
        if (ok) coinciden.push(el);
        el.hidden = true;
      });
      visibles = coinciden.length;
      var paginas = porPagina ? Math.max(1, Math.ceil(visibles / porPagina)) : 1;
      if (pagina > paginas) pagina = paginas;
      var desde = porPagina ? (pagina - 1) * porPagina : 0;
      var hasta = porPagina ? desde + porPagina : visibles;
      coinciden.forEach(function (el, i) { el.hidden = !(i >= desde && i < hasta); });
      if (cuenta) cuenta.textContent = visibles + ' de ' + items.length + ' ' + etiqueta;
      if (vacio) vacio.hidden = visibles !== 0;
      if (nav) dibujarPaginas(paginas, visibles, desde, Math.min(hasta, visibles));
    }
    function dibujarPaginas(paginas, total, desde, hasta) {
      nav.innerHTML = '';
      if (paginas <= 1) return;
      function boton(texto, destino, extra, deshabilitado) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = texto; b.disabled = Boolean(deshabilitado);
        if (extra) b.className = extra; if (extra === 'actual') b.setAttribute('aria-current', 'page');
        b.addEventListener('click', function () { pagina = destino; aplicar(); var ref = lista.closest('.table-wrap') || lista; ref.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
        nav.appendChild(b);
      }
      boton('‹', pagina - 1, '', pagina === 1);
      var mostrar = [];
      for (var n = 1; n <= paginas; n++) if (n === 1 || n === paginas || Math.abs(n - pagina) <= 1) mostrar.push(n);
      var previo = 0;
      mostrar.forEach(function (n) {
        if (previo && n - previo > 1) { var p = document.createElement('span'); p.className = 'f-pag-info'; p.textContent = '…'; nav.appendChild(p); }
        boton(String(n), n, n === pagina ? 'actual' : '', false); previo = n;
      });
      boton('›', pagina + 1, '', pagina === paginas);
      var info = document.createElement('span'); info.className = 'f-pag-info'; info.textContent = (desde + 1) + '–' + hasta + ' de ' + total; nav.appendChild(info);
    }
    function ir1() { pagina = 1; aplicar(); }
    if (q) q.addEventListener('input', ir1);
    if (cat) cat.addEventListener('change', ir1);
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        tag = c.getAttribute('data-filtro-chip');
        chips.forEach(function (o) { o.classList.toggle('activo', o === c); o.setAttribute('aria-pressed', o === c ? 'true' : 'false'); });
        ir1();
      });
    });
    aplicar();
  });
})();
