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
    var tag = '';
    var norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };

    function aplicar() {
      var texto = norm(q ? q.value.trim() : '');
      var categoria = cat ? cat.value : '';
      var visibles = 0;
      items.forEach(function (el) {
        var ok = (!texto || norm(el.getAttribute('data-texto')).indexOf(texto) !== -1)
          && (!categoria || el.getAttribute('data-categoria') === categoria)
          && (!tag || (' ' + (el.getAttribute('data-tags') || '') + ' ').indexOf(' ' + tag + ' ') !== -1);
        el.hidden = !ok;
        if (ok) visibles++;
      });
      if (cuenta) cuenta.textContent = visibles + ' de ' + items.length + ' ' + etiqueta;
      if (vacio) vacio.hidden = visibles !== 0;
    }
    if (q) q.addEventListener('input', aplicar);
    if (cat) cat.addEventListener('change', aplicar);
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        tag = c.getAttribute('data-filtro-chip');
        chips.forEach(function (o) { o.classList.toggle('activo', o === c); o.setAttribute('aria-pressed', o === c ? 'true' : 'false'); });
        aplicar();
      });
    });
    aplicar();
  });
})();
