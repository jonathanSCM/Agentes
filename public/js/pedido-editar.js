// Editar un pedido abierto: cantidades, quitar y agregar productos. El servidor recalcula precios, stock y total.
(function () {
  var P = window.PEDIDO;
  var $ = function (id) { return document.getElementById(id); };
  var lineas = P.items.map(function (i) { return { itemId: i.itemId, productoId: i.productoId, varianteId: i.varianteId, nombre: i.nombre, precio: i.precio, cantidad: String(i.cantidad), editable: i.editable, original: i.cantidad }; });
  var guardando = false; var timer = null;
  var aC = function (n) { return Math.round(Number(n) * 100); };
  var fmt = function (c) { return P.simbolo + ' ' + (c / 100).toFixed(2); };
  function error(msg) { var e = $('pedError'); if (!msg) { e.hidden = true; return; } e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'nearest' }); }

  function calcular() {
    var total = 0; var ok = true; var hayCambio = false; var activas = 0;
    lineas.forEach(function (l) {
      var c = Number(l.cantidad);
      if (l.cantidad === '' || !Number.isInteger(c) || c < 0) { ok = false; return; }
      if (c > 0) activas += 1;
      total += aC(l.precio) * c;
      if (l.itemId ? c !== l.original : c > 0) hayCambio = true;
    });
    return { total: total, ok: ok && activas > 0 && !(P.pagado > total), hayCambio: hayCambio, activas: activas, pagadoAlto: P.pagado > total };
  }
  function pie() {
    var r = calcular();
    $('pedTotal').textContent = (r.total / 100).toFixed(2);
    var d = r.total - P.totalOriginal;
    $('pedDiferencia').textContent = r.pagadoAlto ? 'Con estos cambios el total queda por debajo de lo que el cliente ya pagó (' + fmt(P.pagado) + ').'
      : (d === 0 ? '' : (d > 0 ? 'Sube ' + fmt(d) : 'Baja ' + fmt(-d)) + ' respecto del pedido original' + (P.pagado > 0 && d > 0 ? ' (se cobra solo esa diferencia).' : '.'));
    $('pedGuardar').disabled = !(r.ok && r.hayCambio) || guardando;
    $('pedVacio').hidden = r.activas > 0;
    var celdas = $('pedLineas').querySelectorAll('td[data-sub]');
    lineas.forEach(function (l, i) { if (celdas[i]) celdas[i].textContent = fmt(aC(l.precio) * (Number(l.cantidad) || 0)); });
  }
  function dibujar() {
    var cuerpo = $('pedLineas'); cuerpo.innerHTML = '';
    lineas.forEach(function (l, i) {
      var tr = document.createElement('tr');
      var tdN = document.createElement('td'); var b = document.createElement('strong'); b.textContent = l.nombre; tdN.appendChild(b);
      if (!l.editable) { var w = document.createElement('div'); w.className = 'muted cmp-nota'; w.textContent = 'Ya no está en el catálogo: solo se puede quitar.'; tdN.appendChild(w); }
      var tdP = document.createElement('td'); tdP.className = 'num'; tdP.textContent = fmt(aC(l.precio));
      var tdC = document.createElement('td'); tdC.className = 'num';
      var inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.value = l.cantidad; inp.className = 'cmp-num'; inp.setAttribute('aria-label', 'Cantidad de ' + l.nombre);
      if (!l.editable) inp.max = String(l.original);
      inp.addEventListener('input', function () { l.cantidad = inp.value; pie(); });
      tdC.appendChild(inp);
      var tdS = document.createElement('td'); tdS.className = 'num'; tdS.dataset.sub = '1';
      var tdX = document.createElement('td'); var x = document.createElement('button'); x.type = 'button'; x.className = 'btn btn-ghost'; x.textContent = 'Quitar'; x.setAttribute('aria-label', 'Quitar ' + l.nombre);
      x.addEventListener('click', function () { if (l.itemId) { l.cantidad = '0'; inp.value = '0'; pie(); } else { lineas.splice(i, 1); dibujar(); } }); tdX.appendChild(x);
      [tdN, tdP, tdC, tdS, tdX].forEach(function (td) { tr.appendChild(td); }); cuerpo.appendChild(tr);
    });
    pie();
  }

  function agregar(p) {
    var ya = lineas.find(function (l) { return l.productoId === p.productoId && (l.varianteId || null) === (p.varianteId || null) && l.editable; });
    if (ya) { ya.cantidad = String((Number(ya.cantidad) || 0) + 1); dibujar(); return; }
    lineas.push({ itemId: null, productoId: p.productoId, varianteId: p.varianteId || null, nombre: p.nombre, precio: p.precio, cantidad: '1', editable: true, original: 0 });
    dibujar();
  }
  function mostrar(opciones) {
    var ul = $('pedResultados'); ul.innerHTML = '';
    if (!opciones.length) { var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'No encontré productos con eso.'; ul.appendChild(li); return; }
    opciones.forEach(function (o) {
      var li = document.createElement('li'); var b = document.createElement('button'); b.type = 'button'; b.className = 'cmp-resultado';
      var n = document.createElement('span'); n.textContent = o.nombre; var m = document.createElement('small'); m.textContent = fmt(aC(o.precio)) + ' · stock ' + o.stock;
      b.appendChild(n); b.appendChild(m); b.addEventListener('click', function () { agregar(o); }); li.appendChild(b); ul.appendChild(li);
    });
  }
  // El buscador del mostrador devuelve productos con opciones: cada opción es una fila para elegir.
  function aplanar(d) {
    if (d.exacto) return [d.exacto];
    var filas = [];
    (d.productos || []).forEach(function (p) {
      if (p.tieneVariantes) p.variantes.forEach(function (v) { filas.push({ productoId: p.id, varianteId: v.id, nombre: p.nombre + ' (' + v.etiqueta + ')', precio: v.precio, stock: v.stock }); });
      else filas.push({ productoId: p.id, varianteId: null, nombre: p.nombre, precio: p.precio, stock: p.stock });
    });
    return filas;
  }
  function buscar() {
    fetch('/panel/pos/buscar?q=' + encodeURIComponent($('pedQ').value.trim()), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (d) { mostrar(aplanar(d)); })
      .catch(function () { error('No se pudo buscar. Revisá tu conexión.'); });
  }
  $('pedQ').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(buscar, 250); });
  $('pedQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); buscar(); } });

  $('pedGuardar').addEventListener('click', function () {
    if (guardando) return;
    error(''); guardando = true; $('pedGuardar').disabled = true; $('pedGuardar').textContent = 'Guardando…';
    fetch('/panel/pos/pedidos/' + P.id + '/editar', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: lineas.map(function (l) { return { itemId: l.itemId, productoId: l.productoId, varianteId: l.varianteId, cantidad: Number(l.cantidad) }; }) }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (x.ok && x.d.ok) { window.location = x.d.url; return; }
        guardando = false; $('pedGuardar').textContent = 'Guardar los cambios'; error((x.d && x.d.error) || 'No se pudo guardar.'); pie();
      })
      .catch(function () { guardando = false; $('pedGuardar').textContent = 'Guardar los cambios'; error('No hay conexión. Probá de nuevo.'); pie(); });
  });

  dibujar(); buscar();
})();
