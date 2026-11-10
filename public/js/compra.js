// Nueva compra a proveedor: busca mercadería, arma las líneas y manda todo al servidor (que recalcula el total).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var lineas = []; // { productoId, varianteId, nombre, stock, cantidad, costo }
  var clave = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  var guardando = false;
  var timer = null;

  function aCentavos(v) { var n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; }
  function dinero(c) { return (c / 100).toFixed(2); }
  function error(msg) { var e = $('cmpError'); if (!msg) { e.hidden = true; return; } e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'nearest' }); }

  function dibujar() {
    var cuerpo = $('cmpLineas'); cuerpo.innerHTML = '';
    var total = 0; var valido = lineas.length > 0;
    lineas.forEach(function (l, i) {
      var cant = Number(l.cantidad); var costo = aCentavos(l.costo);
      var sub = (Number.isInteger(cant) && cant > 0 && Number.isFinite(costo) && costo >= 0) ? cant * costo : NaN;
      if (!Number.isFinite(sub)) valido = false; else total += sub;
      var tr = document.createElement('tr');
      var tdN = document.createElement('td'); var b = document.createElement('strong'); b.textContent = l.nombre; tdN.appendChild(b);
      var s = document.createElement('div'); s.className = 'muted cmp-nota'; s.textContent = 'Stock actual: ' + l.stock; tdN.appendChild(s);
      var tdC = document.createElement('td'); tdC.className = 'num';
      var iC = document.createElement('input'); iC.type = 'number'; iC.min = '1'; iC.step = '1'; iC.value = l.cantidad; iC.className = 'cmp-num'; iC.setAttribute('aria-label', 'Cantidad de ' + l.nombre);
      iC.addEventListener('input', function () { l.cantidad = iC.value; pie(); });
      tdC.appendChild(iC);
      var tdK = document.createElement('td'); tdK.className = 'num';
      var iK = document.createElement('input'); iK.type = 'number'; iK.min = '0'; iK.step = '0.01'; iK.value = l.costo; iK.className = 'cmp-num'; iK.setAttribute('aria-label', 'Costo de ' + l.nombre);
      iK.addEventListener('input', function () { l.costo = iK.value; pie(); });
      tdK.appendChild(iK);
      var tdS = document.createElement('td'); tdS.className = 'num'; tdS.textContent = Number.isFinite(sub) ? window.COMPRA.simbolo + ' ' + dinero(sub) : '—'; tdS.dataset.sub = '1';
      var tdX = document.createElement('td'); var x = document.createElement('button'); x.type = 'button'; x.className = 'btn btn-ghost'; x.textContent = 'Quitar'; x.setAttribute('aria-label', 'Quitar ' + l.nombre);
      x.addEventListener('click', function () { lineas.splice(i, 1); dibujar(); }); tdX.appendChild(x);
      [tdN, tdC, tdK, tdS, tdX].forEach(function (td) { tr.appendChild(td); }); cuerpo.appendChild(tr);
    });
    $('cmpVacio').hidden = lineas.length > 0;
    $('cmpTabla').hidden = lineas.length === 0;
    $('cmpTotal').textContent = dinero(total);
    $('cmpGuardar').disabled = !valido || guardando;
  }
  // Recalcula totales sin redibujar (para no perder el foco mientras se escribe).
  function pie() {
    var total = 0; var valido = lineas.length > 0;
    var celdas = $('cmpLineas').querySelectorAll('td[data-sub]');
    lineas.forEach(function (l, i) {
      var cant = Number(l.cantidad); var costo = aCentavos(l.costo);
      var sub = (Number.isInteger(cant) && cant > 0 && Number.isFinite(costo) && costo >= 0) ? cant * costo : NaN;
      if (!Number.isFinite(sub)) valido = false; else total += sub;
      if (celdas[i]) celdas[i].textContent = Number.isFinite(sub) ? window.COMPRA.simbolo + ' ' + dinero(sub) : '—';
    });
    $('cmpTotal').textContent = dinero(total);
    $('cmpGuardar').disabled = !valido || guardando;
  }

  function agregar(p) {
    var ya = lineas.find(function (l) { return l.productoId === p.productoId && (l.varianteId || null) === (p.varianteId || null); });
    if (ya) { ya.cantidad = String(Number(ya.cantidad) + 1); dibujar(); return; }
    lineas.push({ productoId: p.productoId, varianteId: p.varianteId || null, nombre: p.nombre, stock: p.stock, cantidad: '1', costo: p.costo === null || p.costo === undefined ? '' : String(p.costo) });
    dibujar();
  }

  function mostrarResultados(productos) {
    var ul = $('cmpResultados'); ul.innerHTML = '';
    if (!productos.length) { var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'No encontré productos con eso.'; ul.appendChild(li); return; }
    productos.forEach(function (p) {
      var li = document.createElement('li'); var b = document.createElement('button'); b.type = 'button'; b.className = 'cmp-resultado';
      var n = document.createElement('span'); n.textContent = p.nombre; var m = document.createElement('small'); m.textContent = 'Stock ' + p.stock + (p.costo !== null ? ' · costo ' + window.COMPRA.simbolo + ' ' + Number(p.costo).toFixed(2) : '');
      b.appendChild(n); b.appendChild(m); b.addEventListener('click', function () { agregar(p); }); li.appendChild(b); ul.appendChild(li);
    });
  }
  function buscar() {
    var q = $('cmpQ').value.trim();
    fetch('/panel/compras-proveedor/buscar?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (d) { mostrarResultados(d.productos || []); })
      .catch(function () { error('No se pudo buscar. Revisá tu conexión.'); });
  }
  $('cmpQ').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(buscar, 250); });
  $('cmpQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); buscar(); } });

  $('cmpGuardar').addEventListener('click', function () {
    if (guardando) return;
    error(''); guardando = true; $('cmpGuardar').disabled = true; $('cmpGuardar').textContent = 'Guardando…';
    var pago = document.querySelector('input[name="pago"]:checked');
    fetch('/panel/compras-proveedor', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proveedorId: $('cmpProveedor').value || null, referencia: $('cmpRef').value, notas: $('cmpNotas').value, pago: pago ? pago.value : 'PENDIENTE', claveIdempotencia: clave,
        items: lineas.map(function (l) { return { productoId: l.productoId, varianteId: l.varianteId, cantidad: Number(l.cantidad), costo: l.costo }; }),
      }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (x.ok && x.d.ok) { window.location = x.d.url + '?ok=' + encodeURIComponent('Compra registrada: el stock ya subió.'); return; }
        guardando = false; $('cmpGuardar').textContent = 'Registrar la compra'; error((x.d && x.d.error) || 'No se pudo registrar.'); pie();
      })
      .catch(function () { guardando = false; $('cmpGuardar').textContent = 'Registrar la compra'; error('No hay conexión. Probá de nuevo: si ya se registró, no se duplica.'); pie(); });
  });

  dibujar(); buscar();
})();
