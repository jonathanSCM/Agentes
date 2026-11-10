// Cuenta abierta: sumar servicios y productos, cambiar cantidades y cobrar todo junto. El servidor recalcula precios, stock y total.
(function () {
  var C = window.CUENTA;
  var $ = function (id) { return document.getElementById(id); };
  var base = '/panel/cuentas/' + C.id;
  var aC = function (v) { return Math.round(parseFloat(String(v).replace(',', '.')) * 100) || 0; };
  var fmt = function (c) { return C.simbolo + ' ' + (c / 100).toFixed(2); };
  var timer = null;

  function error(msg) { var e = $('cuError'); if (!msg) { e.hidden = true; return; } e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'nearest' }); }
  function post(ruta, cuerpo) {
    return fetch(ruta, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Respuesta inesperada del servidor.' }; }); });
  }
  function accion(ruta, cuerpo) {
    error('');
    post(ruta, cuerpo).then(function (d) { if (d.ok) window.location.reload(); else error(d.error || 'No se pudo.'); })
      .catch(function () { error('No hay conexión. Probá de nuevo.'); });
  }

  // ---- líneas: cantidad, precio libre y quitar
  document.querySelectorAll('#cuLineas tr[data-id]').forEach(function (tr) {
    var id = tr.dataset.id; var nombre = tr.dataset.nombre;
    var celdaCant = tr.querySelector('[data-celda="cant"]');
    var inp = document.createElement('input'); inp.type = 'number'; inp.min = '1'; inp.step = '1'; inp.value = tr.dataset.cant; inp.className = 'cmp-num'; inp.setAttribute('aria-label', 'Cantidad de ' + nombre);
    celdaCant.textContent = ''; celdaCant.appendChild(inp);
    inp.addEventListener('change', function () { var n = Number(inp.value); if (Number.isInteger(n) && n > 0) accion(base + '/linea/' + id, { cantidad: n }); else inp.value = tr.dataset.cant; });
    if (tr.dataset.libre === '1') {
      var celdaPrecio = tr.querySelector('[data-celda="precio"]');
      var ip = document.createElement('input'); ip.type = 'number'; ip.min = '0'; ip.step = '0.01'; ip.value = Number(tr.dataset.precio) ? tr.dataset.precio : ''; ip.placeholder = 'Precio'; ip.className = 'cmp-num'; ip.setAttribute('aria-label', 'Precio de ' + nombre);
      celdaPrecio.textContent = ''; celdaPrecio.appendChild(ip);
      ip.addEventListener('change', function () { if (ip.value !== '') accion(base + '/linea/' + id, { precio: ip.value }); });
    }
    var x = document.createElement('button'); x.type = 'button'; x.className = 'btn btn-ghost'; x.textContent = 'Quitar'; x.setAttribute('aria-label', 'Quitar ' + nombre);
    x.addEventListener('click', function () { accion(base + '/linea/' + id, { cantidad: 0 }); });
    tr.lastElementChild.appendChild(x);
  });

  // ---- sumar servicio
  var bs = $('cuSumarServicio');
  if (bs) bs.addEventListener('click', function () { accion(base + '/servicio', { servicioId: $('cuServicio').value, recursoId: $('cuRecurso') ? $('cuRecurso').value : '' }); });

  // ---- sumar producto (el buscador del mostrador: nombre, código de barras o SKU)
  function aplanar(d) {
    if (d.exacto) return [d.exacto];
    var filas = [];
    (d.productos || []).forEach(function (p) {
      if (p.tieneVariantes) p.variantes.forEach(function (v) { filas.push({ productoId: p.id, varianteId: v.id, nombre: p.nombre + ' (' + v.etiqueta + ')', precio: v.precio, stock: v.stock }); });
      else filas.push({ productoId: p.id, varianteId: null, nombre: p.nombre, precio: p.precio, stock: p.stock });
    });
    return filas;
  }
  function mostrar(opciones) {
    var ul = $('cuResultados'); if (!ul) return; ul.innerHTML = '';
    if (!opciones.length) { var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'No encontré productos con eso.'; ul.appendChild(li); return; }
    opciones.forEach(function (o) {
      var li = document.createElement('li'); var b = document.createElement('button'); b.type = 'button'; b.className = 'cmp-resultado';
      var n = document.createElement('span'); n.textContent = o.nombre; var m = document.createElement('small'); m.textContent = fmt(aC(o.precio)) + ' · stock ' + o.stock;
      b.appendChild(n); b.appendChild(m);
      if (o.stock > 0) b.addEventListener('click', function () { accion(base + '/producto', { productoId: o.productoId, varianteId: o.varianteId }); }); else b.disabled = true;
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function buscar() {
    fetch('/panel/pos/buscar?q=' + encodeURIComponent($('cuQ').value.trim()), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (d) { mostrar(aplanar(d)); })
      .catch(function () { error('No se pudo buscar. Revisá tu conexión.'); });
  }
  if ($('cuQ')) {
    $('cuQ').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(buscar, 250); });
    $('cuQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); buscar(); } });
    buscar();
  }

  // ---- cobro: una o varias formas de pago
  var cont = $('cuPagos');
  if (!cont) return;
  var clave = 'cu-' + C.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  function fila(metodo, centavos) {
    var f = document.createElement('div'); f.className = 'pos-pago';
    var sel = document.createElement('select'); sel.setAttribute('aria-label', 'Forma de pago');
    C.metodos.forEach(function (m) { var o = document.createElement('option'); o.value = m.clave; o.textContent = m.etiqueta; if (m.clave === metodo) o.selected = true; sel.appendChild(o); });
    var monto = document.createElement('input'); monto.type = 'number'; monto.min = '0'; monto.step = '0.01'; monto.inputMode = 'decimal'; monto.value = (centavos / 100).toFixed(2); monto.setAttribute('aria-label', 'Monto');
    var rec = document.createElement('input'); rec.type = 'number'; rec.min = '0'; rec.step = '0.01'; rec.inputMode = 'decimal'; rec.placeholder = 'Recibido'; rec.setAttribute('aria-label', 'Efectivo recibido');
    var quitar = document.createElement('button'); quitar.type = 'button'; quitar.className = 'pos-quitar'; quitar.textContent = '✕'; quitar.setAttribute('aria-label', 'Quitar este pago');
    function ajustar() { rec.hidden = sel.value !== 'EFECTIVO'; actualizar(); }
    sel.addEventListener('change', ajustar); monto.addEventListener('input', actualizar); rec.addEventListener('input', actualizar);
    quitar.addEventListener('click', function () { if (cont.children.length > 1) { f.remove(); actualizar(); } });
    [sel, monto, rec, quitar].forEach(function (e) { f.appendChild(e); });
    f._lee = function () { return { metodo: sel.value, monto: aC(monto.value), recibido: rec.value === '' ? null : aC(rec.value) }; };
    rec.hidden = metodo !== 'EFECTIVO';
    return f;
  }
  function pagos() { return Array.prototype.map.call(cont.children, function (f) { return f._lee(); }); }
  function actualizar() {
    var suma = pagos().reduce(function (t, p) { return t + p.monto; }, 0);
    var ok = suma === C.totalCentavos && C.totalCentavos > 0;
    var e = $('cuEstado');
    e.textContent = C.totalCentavos <= 0 ? 'La cuenta está en 0: sumá algo o ponele precio.' : (ok ? 'Listo para cobrar.' : (suma < C.totalCentavos ? 'Falta cobrar ' + fmt(C.totalCentavos - suma) + '.' : 'Los pagos suman ' + fmt(suma - C.totalCentavos) + ' de más.'));
    e.className = 'pos-cobro-estado ' + (ok ? 'ok' : 'falta');
    $('cuConfirmar').disabled = !ok;
  }
  cont.appendChild(fila('EFECTIVO', C.totalCentavos));
  $('cuDividir').addEventListener('click', function () {
    var suma = pagos().reduce(function (t, p) { return t + p.monto; }, 0);
    cont.appendChild(fila('QR', Math.max(0, C.totalCentavos - suma))); actualizar();
  });
  actualizar();
  $('cuCobro').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('cuConfirmar'); if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Cobrando…'; var err = $('cuErrorCobro'); err.hidden = true;
    post(base + '/cobrar', { claveIdempotencia: clave, pagos: pagos().map(function (p) { return { metodo: p.metodo, monto: p.monto / 100, recibido: p.metodo === 'EFECTIVO' && p.recibido !== null ? p.recibido / 100 : undefined }; }) })
      .then(function (d) {
        btn.textContent = 'Cobrar la cuenta';
        if (!d.ok) { err.textContent = d.error || 'No se pudo cobrar.'; err.hidden = false; actualizar(); return; }
        $('cuCobro').hidden = true;
        $('cuResumen').textContent = 'Venta V-' + String(d.venta.numero).padStart(4, '0') + ' por ' + fmt(Math.round(d.venta.total * 100)) + (d.venta.vuelto > 0 ? ' · vuelto ' + fmt(Math.round(d.venta.vuelto * 100)) : '') + '.';
        $('cuRecibo').href = d.venta.reciboUrl + '?imprimir=1'; $('cuListo').hidden = false;
      })
      .catch(function () { btn.textContent = 'Cobrar la cuenta'; err.textContent = 'No hay conexión. Probá de nuevo: si ya se cobró, no se cobra dos veces.'; err.hidden = false; actualizar(); });
  });
})();
