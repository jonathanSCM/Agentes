/* Punto de venta (docs/11 F5). JavaScript simple, sin librerias.
   - El lector de codigos de barras USB escribe como un teclado y manda Enter: el buscador esta SIEMPRE enfocado.
   - El navegador solo manda producto, opcion, cantidad, descuento y pagos: el servidor recalcula los precios.
   - Cada intento de cobro lleva una clave de idempotencia: un doble clic o un reintento no cobra dos veces. */
(function () {
  'use strict';
  var raiz = document.getElementById('pos');
  if (!raiz) return;

  var SIMBOLO = raiz.getAttribute('data-simbolo') || '';
  var EMPRESA = raiz.getAttribute('data-empresa') || '0';
  var CAMBIO = window.POS_CAMBIO || null;   // modo cambio: se llega desde el detalle de una venta
  var CLAVE_CARRITO = 'pos:carrito:' + (CAMBIO ? 'cambio:' + CAMBIO.ventaId + ':' : '') + EMPRESA;
  var CLAVE_AUTO = 'pos:autoimprimir';
  var METODOS = window.POS_METODOS || [];
  var $ = function (id) { return document.getElementById(id); };

  var carrito = [];       // { productoId, varianteId, nombre, precio, stock, cantidad }
  var claveCobro = null;  // se mantiene mientras el cobro no se confirme (reintentos seguros)
  var ultimaVenta = null;
  var credito = 0;        // modo cambio: lo que vale (en centavos) lo que devuelve el cliente

  // ---------- utilidades ----------
  function aC(n) { return Math.round((Number(n) || 0) * 100); }           // a centavos enteros
  function fmtC(c) { return SIMBOLO + ' ' + (c / 100).toFixed(2); }
  function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento: sigue funcionando */ } }
  function leerLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function nuevaClave() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)); }
  function texto(el, t) { el.textContent = t; return el; }

  function aviso(msg, tipo) {
    var el = $('posAviso');
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg; el.className = 'pos-aviso' + (tipo ? ' es-' + tipo : ''); el.hidden = false;
    clearTimeout(aviso._t); aviso._t = setTimeout(function () { el.hidden = true; }, 4500);
  }

  // ---------- carrito ----------
  function guardarCarrito() { guardar(CLAVE_CARRITO, JSON.stringify({ lineas: carrito, descuento: $('posDescuento').value })); }

  function totales() {
    var sub = 0;
    carrito.forEach(function (l) { sub += aC(l.precio) * l.cantidad; });
    var desc = Math.min(aC($('posDescuento').value), sub);
    var total = sub - desc;
    // En un cambio lo devuelto es un credito: se cobra la diferencia, o se devuelve en efectivo si lo nuevo vale menos.
    return { sub: sub, desc: desc, total: total, credito: credito, cobrar: CAMBIO ? Math.max(0, total - credito) : total, devolver: CAMBIO ? Math.max(0, credito - total) : 0 };
  }
  function objetivo() { return totales().cobrar; }   // lo que los pagos tienen que sumar

  function pintarCarrito() {
    var ul = $('posLineas');
    ul.innerHTML = '';
    carrito.forEach(function (l, i) {
      var li = document.createElement('li');
      li.className = 'pos-linea';
      var info = document.createElement('div'); info.className = 'pos-linea-info';
      info.appendChild(texto(document.createElement('strong'), l.nombre));
      info.appendChild(texto(document.createElement('small'), fmtC(aC(l.precio)) + ' c/u'));
      var ctl = document.createElement('div'); ctl.className = 'pos-linea-ctl';
      var menos = texto(document.createElement('button'), '−'); menos.type = 'button'; menos.setAttribute('aria-label', 'Una menos');
      var cant = texto(document.createElement('span'), String(l.cantidad)); cant.className = 'pos-cant';
      var mas = texto(document.createElement('button'), '+'); mas.type = 'button'; mas.setAttribute('aria-label', 'Una más');
      menos.addEventListener('click', function () { cambiarCantidad(i, -1); });
      mas.addEventListener('click', function () { cambiarCantidad(i, 1); });
      ctl.appendChild(menos); ctl.appendChild(cant); ctl.appendChild(mas);
      var tot = texto(document.createElement('strong'), fmtC(aC(l.precio) * l.cantidad)); tot.className = 'pos-linea-total';
      var quitar = texto(document.createElement('button'), '✕'); quitar.type = 'button'; quitar.className = 'pos-quitar'; quitar.setAttribute('aria-label', 'Quitar');
      quitar.addEventListener('click', function () { carrito.splice(i, 1); pintarCarrito(); });
      li.appendChild(info); li.appendChild(ctl); li.appendChild(tot); li.appendChild(quitar);
      ul.appendChild(li);
    });
    $('posVacio').hidden = carrito.length > 0;
    var t = totales();
    texto($('posSubtotal'), fmtC(t.sub));
    texto($('posTotal'), fmtC(t.total));
    if (CAMBIO) {
      texto($('posCredito'), credito ? fmtC(credito) : '—');
      texto($('posDiferenciaEtq'), t.devolver > 0 ? 'A devolver al cliente (efectivo)' : (t.cobrar > 0 ? 'A cobrar' : 'Diferencia'));
      texto($('posDiferencia'), credito ? fmtC(t.devolver > 0 ? t.devolver : t.cobrar) : '—');
    }
    $('posCobrar').disabled = carrito.length === 0 || (CAMBIO && !credito);
    guardarCarrito();
  }

  function agregar(linea) {
    if (!linea.stock || linea.stock <= 0) { aviso('"' + linea.nombre + '" no tiene stock.', 'error'); return; }
    var existente = null;
    carrito.forEach(function (l) { if (l.productoId === linea.productoId && (l.varianteId || null) === (linea.varianteId || null)) existente = l; });
    if (existente) {
      if (existente.cantidad + 1 > linea.stock) { aviso('Solo quedan ' + linea.stock + ' de "' + linea.nombre + '".', 'error'); return; }
      existente.cantidad += 1; existente.stock = linea.stock;
    } else {
      carrito.push({ productoId: linea.productoId, varianteId: linea.varianteId || null, nombre: linea.nombre, precio: linea.precio, stock: linea.stock, cantidad: 1 });
    }
    pintarCarrito();
  }

  function cambiarCantidad(i, delta) {
    var l = carrito[i];
    if (!l) return;
    var nueva = l.cantidad + delta;
    if (nueva <= 0) { carrito.splice(i, 1); }
    else if (nueva > l.stock) { aviso('Solo quedan ' + l.stock + ' de "' + l.nombre + '".', 'error'); return; }
    else { l.cantidad = nueva; }
    pintarCarrito();
  }

  // ---------- busqueda ----------
  var pedido = 0;
  function buscar(q, alEnter) {
    var mio = ++pedido;
    return fetch('/panel/pos/buscar?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (mio !== pedido) return;
        if (alEnter && d.exacto) { agregar(d.exacto); $('posBuscar').value = ''; aviso(d.exacto.nombre + ' agregado.', 'ok'); buscar('', false); return; }
        if (alEnter && d.sinStock) { aviso('"' + d.sinStock + '" no tiene stock.', 'error'); return; }
        if (alEnter && q && !d.productos.length) { aviso('No encontré "' + q + '".', 'error'); }
        pintarGrilla(d.productos || []);
      })
      .catch(function () { aviso('No se pudo buscar. Revisá la conexión.', 'error'); });
  }

  function pintarGrilla(productos) {
    var g = $('posGrilla');
    g.innerHTML = '';
    if (!productos.length) { g.appendChild(texto(document.createElement('p'), 'Sin resultados.')).className = 'pos-sin'; return; }
    productos.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pos-tile' + (p.stock <= 0 ? ' agotado' : '');
      if (p.foto) { var img = document.createElement('img'); img.src = p.foto; img.alt = ''; img.loading = 'lazy'; b.appendChild(img); }
      b.appendChild(texto(document.createElement('strong'), p.nombre));
      b.appendChild(texto(document.createElement('span'), fmtC(aC(p.precio))));
      b.appendChild(texto(document.createElement('small'), p.stock <= 0 ? 'Sin stock' : (p.tieneVariantes ? p.stock + ' en total · elegir opción' : p.stock + ' en stock')));
      b.addEventListener('click', function () {
        if (p.stock <= 0) { aviso('"' + p.nombre + '" no tiene stock.', 'error'); return; }
        if (p.tieneVariantes) abrirOpciones(p); else agregar({ productoId: p.id, varianteId: null, nombre: p.nombre, precio: p.precio, stock: p.stock });
        $('posBuscar').focus();
      });
      g.appendChild(b);
    });
  }

  // ---------- modales ----------
  function abrirModal(id) { $(id).hidden = false; }
  function cerrarModal(id) { $(id).hidden = true; if (id === 'modalCamara') detenerCamara(); $('posBuscar').focus(); }
  Array.prototype.forEach.call(document.querySelectorAll('.pos-modal'), function (m) {
    m.addEventListener('click', function (e) { if (e.target === m || e.target.hasAttribute('data-cerrar')) cerrarModal(m.id); });
  });
  function hayModalAbierto() { return Array.prototype.some.call(document.querySelectorAll('.pos-modal'), function (m) { return !m.hidden; }); }

  function abrirOpciones(p) {
    texto($('opcionesTitulo'), p.nombre + ' · elegí la opción');
    var cont = $('opcionesLista'); cont.innerHTML = '';
    p.variantes.forEach(function (v) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'pos-opcion' + (v.stock <= 0 ? ' agotado' : '');
      b.appendChild(texto(document.createElement('strong'), v.etiqueta));
      b.appendChild(texto(document.createElement('span'), fmtC(aC(v.precio))));
      b.appendChild(texto(document.createElement('small'), v.stock <= 0 ? 'Sin stock' : v.stock + ' en stock'));
      b.addEventListener('click', function () {
        if (v.stock <= 0) { aviso('Esa opción no tiene stock.', 'error'); return; }
        agregar({ productoId: p.id, varianteId: v.id, nombre: p.nombre + ' (' + v.etiqueta + ')', precio: v.precio, stock: v.stock });
        cerrarModal('modalOpciones');
      });
      cont.appendChild(b);
    });
    abrirModal('modalOpciones');
  }

  // ---------- cobro ----------
  function filaPago(metodo, monto) {
    var fila = document.createElement('div'); fila.className = 'pos-pago';
    var sel = document.createElement('select'); sel.setAttribute('aria-label', 'Forma de pago');
    METODOS.forEach(function (m) { var o = document.createElement('option'); o.value = m.clave; o.textContent = m.etiqueta; if (m.clave === metodo) o.selected = true; sel.appendChild(o); });
    var inMonto = document.createElement('input'); inMonto.type = 'number'; inMonto.min = '0'; inMonto.step = '0.01'; inMonto.inputMode = 'decimal'; inMonto.value = (monto / 100).toFixed(2); inMonto.setAttribute('aria-label', 'Monto');
    var inRec = document.createElement('input'); inRec.type = 'number'; inRec.min = '0'; inRec.step = '0.01'; inRec.inputMode = 'decimal'; inRec.placeholder = 'Recibido'; inRec.className = 'pos-recibido'; inRec.setAttribute('aria-label', 'Efectivo recibido');
    var vuelto = document.createElement('span'); vuelto.className = 'pos-vuelto';
    var quitar = texto(document.createElement('button'), '✕'); quitar.type = 'button'; quitar.className = 'pos-quitar'; quitar.setAttribute('aria-label', 'Quitar este pago');
    function esEfectivo() { return sel.value === 'EFECTIVO'; }
    function ajustar() { inRec.hidden = !esEfectivo(); vuelto.hidden = !esEfectivo(); actualizarCobro(); }
    sel.addEventListener('change', ajustar); inMonto.addEventListener('input', actualizarCobro); inRec.addEventListener('input', actualizarCobro);
    quitar.addEventListener('click', function () { if ($('cobroPagos').children.length > 1) { fila.remove(); actualizarCobro(); } });
    fila.appendChild(sel); fila.appendChild(inMonto); fila.appendChild(inRec); fila.appendChild(vuelto); fila.appendChild(quitar);
    fila._lee = function () { return { metodo: sel.value, monto: aC(inMonto.value), recibido: inRec.value === '' ? null : aC(inRec.value), el: { rec: inRec, vuelto: vuelto } }; };
    return fila;
  }

  function leerPagos() { return Array.prototype.map.call($('cobroPagos').children, function (f) { return f._lee(); }); }

  function actualizarCobro() {
    var total = objetivo();
    var pagos = leerPagos();
    var suma = 0, valido = pagos.length > 0 || total === 0;
    pagos.forEach(function (p) {
      suma += p.monto;
      if (p.monto <= 0) valido = false;
      if (p.metodo === 'EFECTIVO') {
        var rec = p.recibido === null ? p.monto : p.recibido;
        if (rec < p.monto) { valido = false; p.el.vuelto.textContent = 'Falta ' + fmtC(p.monto - rec); }
        else { p.el.vuelto.textContent = 'Vuelto ' + fmtC(rec - p.monto); }
      }
    });
    var estado = $('cobroEstado');
    if (suma === total) { estado.textContent = 'Listo para cobrar.'; estado.className = 'pos-cobro-estado ok'; }
    else if (suma < total) { estado.textContent = 'Falta cobrar ' + fmtC(total - suma) + '.'; estado.className = 'pos-cobro-estado falta'; valido = false; }
    else { estado.textContent = 'Los pagos suman ' + fmtC(suma - total) + ' de más.'; estado.className = 'pos-cobro-estado falta'; valido = false; }
    $('cobroConfirmar').disabled = !valido;
  }

  function abrirCobro() {
    if (!carrito.length) return;
    var t = totales();
    if (CAMBIO) {
      if (!credito) { aviso('Primero indicá qué devuelve el cliente.', 'error'); return; }
      if (motivoCambio().length < 5) { aviso('Escribí el motivo del cambio (mínimo 5 letras).', 'error'); $('cambioMotivo').focus(); return; }
    } else if (t.total <= 0 && t.sub <= 0) return;
    claveCobro = claveCobro || nuevaClave();
    var total = t.cobrar;
    texto($('cobroTotalEtq'), CAMBIO ? 'A cobrar (la diferencia)' : 'Total a cobrar');
    texto($('cobroTotal'), fmtC(total));
    var info = $('cobroCambioInfo');
    if (CAMBIO) {
      info.textContent = 'Lo nuevo ' + fmtC(t.total) + ' − lo que devuelve ' + fmtC(credito) + (t.devolver > 0 ? ' → hay que devolverle ' + fmtC(t.devolver) + ' en efectivo.' : (total === 0 ? ' → no hay nada que cobrar.' : '.'));
      info.hidden = false;
    } else { info.hidden = true; }
    $('cobroError').hidden = true;
    var cont = $('cobroPagos'); cont.innerHTML = '';
    var primera = null;
    if (total > 0) { cont.appendChild(filaPago('EFECTIVO', total)); primera = cont.firstChild; primera.querySelector('.pos-recibido').hidden = false; }
    $('cobroDividir').hidden = total === 0;
    actualizarCobro();
    abrirModal('modalCobro');
    var inRec = primera && primera.querySelector('.pos-recibido'); if (inRec) inRec.focus(); else $('cobroConfirmar').focus();
  }

  $('cobroDividir').addEventListener('click', function () {
    var total = objetivo();
    var suma = leerPagos().reduce(function (t, p) { return t + p.monto; }, 0);
    $('cobroPagos').appendChild(filaPago('QR', Math.max(0, total - suma)));
    actualizarCobro();
  });

  // Cliente (opcional): sugiere clientes del negocio por nombre o telefono; si elige uno, la venta queda ligada a el.
  var clientesPorTexto = {};
  var temporizadorClientes = null;
  $('cobroCliente').addEventListener('input', function () {
    var q = this.value.trim();
    clearTimeout(temporizadorClientes);
    if (q.length < 2 || clientesPorTexto[q]) return;
    temporizadorClientes = setTimeout(function () {
      fetch('/panel/pos/clientes?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var lista = $('cobroClientes'); lista.innerHTML = '';
          (d.clientes || []).forEach(function (c) {
            clientesPorTexto[c.texto] = c.id;
            var o = document.createElement('option'); o.value = c.texto; lista.appendChild(o);
          });
        })
        .catch(function () {});
    }, 250);
  });

  function confirmarCobro() {
    var btn = $('cobroConfirmar');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Cobrando…';
    var cuerpo = {
      lineas: carrito.map(function (l) { return { productoId: l.productoId, varianteId: l.varianteId, cantidad: l.cantidad }; }),
      ventaId: CAMBIO ? CAMBIO.ventaId : undefined,
      devuelven: CAMBIO ? itemsQueDevuelve() : undefined,
      repone: CAMBIO ? $('cambioRepone').checked : undefined,
      motivo: CAMBIO ? motivoCambio() : undefined,
      descuento: ($('posDescuento').value || '0'),
      pagos: leerPagos().map(function (p) { return { metodo: p.metodo, monto: p.monto / 100, recibido: p.metodo === 'EFECTIVO' && p.recibido !== null ? p.recibido / 100 : undefined }; }),
      clienteNombre: $('cobroCliente').value.trim(),
      clienteId: clientesPorTexto[$('cobroCliente').value.trim()] || undefined,
      claveIdempotencia: claveCobro
    };
    fetch(CAMBIO ? '/panel/pos/cambio' : '/panel/pos/venta', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Respuesta inesperada del servidor.' }; }); })
      .then(function (d) {
        btn.textContent = 'Confirmar cobro';
        if (!d.ok) { var e = $('cobroError'); e.textContent = d.error || 'No se pudo cobrar.'; e.hidden = false; actualizarCobro(); return; }
        ventaCobrada(d.venta, d.aDevolver);
      })
      .catch(function () {
        // Sin conexion: la misma clave permite reintentar sin riesgo de cobrar dos veces.
        btn.textContent = 'Confirmar cobro';
        var e = $('cobroError'); e.textContent = 'No hay conexión. Probá de nuevo: si ya se cobró, no se cobra dos veces.'; e.hidden = false; actualizarCobro();
      });
  }
  $('cobroConfirmar').addEventListener('click', confirmarCobro);

  function ventaCobrada(v, aDevolver) {
    ultimaVenta = v;
    claveCobro = null;
    cerrarModalSinFoco('modalCobro');
    texto($('exitoTitulo'), CAMBIO ? 'Cambio hecho' : 'Venta cobrada');
    texto($('exitoNumero'), (CAMBIO ? 'Cambio V-' : 'Venta V-') + String(v.numero).padStart(4, '0') + ' · ' + fmtC(aC(v.total)));
    var vu = $('exitoVuelto');
    if (aDevolver > 0) { texto(vu, 'Devolvele ' + fmtC(aC(aDevolver)) + ' en efectivo'); vu.hidden = false; }
    else if (v.vuelto > 0) { texto(vu, 'Vuelto: ' + fmtC(aC(v.vuelto))); vu.hidden = false; } else { vu.hidden = true; }
    $('exitoVer').href = v.reciboUrl;
    abrirModal('modalExito');
    $('exitoNueva').focus();
    if ($('posAutoImprimir').checked) imprimir(v.reciboUrl);
  }
  function cerrarModalSinFoco(id) { $(id).hidden = true; }

  function nuevaVenta() {
    carrito = []; $('posDescuento').value = ''; $('cobroCliente').value = '';
    guardar(CLAVE_CARRITO, '');
    if (CAMBIO) { window.location.href = '/panel/pos'; return; }   // el cambio termino: se vuelve al punto de venta normal
    pintarCarrito();
    cerrarModal('modalExito');
    buscar('', false);
  }
  $('exitoNueva').addEventListener('click', nuevaVenta);
  $('exitoImprimir').addEventListener('click', function () { if (ultimaVenta) imprimir(ultimaVenta.reciboUrl); });

  // Impresion termica: se abre el recibo (80 mm) en un marco invisible y se imprime solo.
  function imprimir(url) {
    var f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    f.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'imprimir=1';
    document.body.appendChild(f);
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 60000);
  }

  // ---------- camara (si el navegador sabe leer codigos) ----------
  var streamCamara = null, timerCamara = null;
  function detenerCamara() {
    if (timerCamara) { clearInterval(timerCamara); timerCamara = null; }
    if (streamCamara) { streamCamara.getTracks().forEach(function (t) { t.stop(); }); streamCamara = null; }
  }
  if ('BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var botonCam = $('posCamara'); botonCam.hidden = false;
    botonCam.addEventListener('click', function () {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (s) {
        streamCamara = s; var v = $('camaraVideo'); v.srcObject = s; v.play(); abrirModal('modalCamara');
        var det = new window.BarcodeDetector();
        timerCamara = setInterval(function () {
          det.detect(v).then(function (cods) {
            if (cods && cods.length) { var c = cods[0].rawValue; cerrarModal('modalCamara'); buscar(c, true); }
          }).catch(function () { /* sigue intentando */ });
        }, 350);
      }).catch(function () { aviso('No se pudo usar la cámara.', 'error'); });
    });
  }

  // ---------- eventos de la pantalla ----------
  var buscador = $('posBuscar');
  var debounce = null;
  buscador.addEventListener('input', function () { clearTimeout(debounce); var q = buscador.value.trim(); debounce = setTimeout(function () { buscar(q, false); }, 220); });
  buscador.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(debounce); var q = buscador.value.trim(); if (q) buscar(q, true); }
  });
  $('posDescuento').addEventListener('input', pintarCarrito);
  $('posVaciar').addEventListener('click', function () { if (carrito.length && confirm('¿Vaciar la venta actual?')) { carrito = []; $('posDescuento').value = ''; pintarCarrito(); } });
  $('posCobrar').addEventListener('click', abrirCobro);
  $('posAutoImprimir').checked = leerLS(CLAVE_AUTO) === '1';
  $('posAutoImprimir').addEventListener('change', function () { guardar(CLAVE_AUTO, this.checked ? '1' : '0'); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'F2') { e.preventDefault(); buscador.focus(); buscador.select(); }
    else if (e.key === 'F4') { e.preventDefault(); if (!hayModalAbierto()) abrirCobro(); }
    else if (e.key === 'Escape') { Array.prototype.forEach.call(document.querySelectorAll('.pos-modal'), function (m) { if (!m.hidden && m.id !== 'modalExito') cerrarModal(m.id); }); }
    else if (e.key === 'Enter' && !$('modalExito').hidden) { e.preventDefault(); nuevaVenta(); }
    else if (e.key === 'Enter' && !$('modalCobro').hidden && !$('cobroConfirmar').disabled && e.target.tagName !== 'SELECT') { e.preventDefault(); confirmarCobro(); }
  });

  // ---------- cambio de producto: lo que devuelve el cliente ----------
  function motivoCambio() { var m = $('cambioMotivo'); return m ? m.value.trim() : ''; }
  function itemsQueDevuelve() {
    var items = [];
    Array.prototype.forEach.call(document.querySelectorAll('.pos-cambio-cant'), function (i) {
      var n = parseInt(i.value, 10) || 0;
      if (n > 0) items.push({ ventaItemId: Number(i.getAttribute('data-item')), cantidad: n });
    });
    return items;
  }
  function recalcularCredito() {
    var items = itemsQueDevuelve();
    if (!items.length) { credito = 0; pintarCarrito(); return; }
    fetch('/panel/pos/cambio/calcular', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ventaId: CAMBIO.ventaId, devuelven: items }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { credito = 0; aviso(d.error || 'No se pudo calcular.', 'error'); } else { credito = d.creditoCentavos || 0; }
        claveCobro = null; pintarCarrito();
      })
      .catch(function () { aviso('No se pudo calcular. Revisá la conexión.', 'error'); });
  }
  if (CAMBIO) {
    Array.prototype.forEach.call(document.querySelectorAll('.pos-cambio-cant'), function (i) { i.addEventListener('input', recalcularCredito); });
  }

  // ---------- ventas en espera ----------
  function esperaError(msg) { var e = $('esperaError'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; }
  function pintarEspera(ventas) {
    var ul = $('esperaLista'); ul.innerHTML = '';
    $('esperaVacia').hidden = ventas.length > 0;
    var n = $('posEsperaN'); n.textContent = String(ventas.length); n.hidden = ventas.length === 0;
    ventas.forEach(function (v) {
      var li = document.createElement('li'); li.className = 'pos-espera-item';
      var info = document.createElement('div');
      info.appendChild(texto(document.createElement('strong'), v.etiqueta || 'Venta sin nombre'));
      var hora = new Date(v.creadaAt).toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
      info.appendChild(texto(document.createElement('small'), v.productos + (v.productos === 1 ? ' producto' : ' productos') + ' · ' + hora + (v.por ? ' · ' + v.por : '')));
      var retomar = texto(document.createElement('button'), 'Retomar'); retomar.type = 'button'; retomar.className = 'btn btn-primary btn-chico';
      var borrar = texto(document.createElement('button'), '✕'); borrar.type = 'button'; borrar.className = 'pos-quitar'; borrar.setAttribute('aria-label', 'Borrar esta venta en espera');
      retomar.addEventListener('click', function () { retomarEspera(v.id); });
      borrar.addEventListener('click', function () {
        if (!confirm('¿Borrar esta venta en espera? No se puede deshacer.')) return;
        fetch('/panel/pos/espera/' + v.id + '/eliminar', { method: 'POST', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) { if (!d.ok) esperaError(d.error); cargarEspera(); });
      });
      li.appendChild(info); li.appendChild(retomar); li.appendChild(borrar); ul.appendChild(li);
    });
  }
  function cargarEspera() {
    return fetch('/panel/pos/espera', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) pintarEspera(d.ventas || []); }).catch(function () { /* sin red: queda como estaba */ });
  }
  function cuerpoEspera(etiqueta) {
    return {
      lineas: carrito.map(function (l) { return { productoId: l.productoId, varianteId: l.varianteId, cantidad: l.cantidad }; }),
      descuento: $('posDescuento').value || '0', etiqueta: etiqueta || '',
      clienteNombre: $('cobroCliente').value.trim(), clienteId: clientesPorTexto[$('cobroCliente').value.trim()] || undefined
    };
  }
  function vaciarVentaActual() { carrito = []; $('posDescuento').value = ''; $('cobroCliente').value = ''; claveCobro = null; pintarCarrito(); }
  function dejarEnEspera(etiqueta) {
    return fetch('/panel/pos/espera', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpoEspera(etiqueta)) })
      .then(function (r) { return r.json(); });
  }
  function retomarEspera(id) {
    esperaError('');
    var seguir = function () {
      fetch('/panel/pos/espera/' + id + '/retomar', { method: 'POST', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { esperaError(d.error); cargarEspera(); return; }
        carrito = d.lineas || []; $('posDescuento').value = d.descuento ? String(d.descuento) : ''; $('cobroCliente').value = d.clienteNombre || ''; claveCobro = null;
        pintarCarrito(); cargarEspera(); cerrarModal('modalEspera');
        aviso(d.avisos && d.avisos.length ? d.avisos.join(' ') : 'Venta retomada.', d.avisos && d.avisos.length ? 'error' : 'ok');
      }).catch(function () { esperaError('No se pudo retomar. Revisá la conexión.'); });
    };
    if (!carrito.length) { seguir(); return; }
    // Hay una venta en curso: se deja en espera antes de retomar la otra, para no perderla.
    if (!confirm('Hay una venta en curso: se deja en espera y se retoma la otra. ¿Seguir?')) return;
    dejarEnEspera('').then(function (d) { if (!d.ok) { esperaError(d.error); return; } seguir(); });
  }
  if ($('posEspera')) {
    $('posEspera').addEventListener('click', function () {
      esperaError(''); $('esperaGuardar').hidden = carrito.length === 0; $('esperaEtiqueta').value = '';
      cargarEspera(); abrirModal('modalEspera'); if (carrito.length) $('esperaEtiqueta').focus();
    });
    $('esperaDejar').addEventListener('click', function () {
      esperaError('');
      dejarEnEspera($('esperaEtiqueta').value.trim()).then(function (d) {
        if (!d.ok) { esperaError(d.error); return; }
        vaciarVentaActual(); aviso('Venta dejada en espera.', 'ok'); cargarEspera(); $('esperaGuardar').hidden = true;
      }).catch(function () { esperaError('No se pudo guardar. Revisá la conexión.'); });
    });
    $('esperaEtiqueta').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('esperaDejar').click(); } });
    cargarEspera();
  }

  // ---------- arranque ----------
  try {
    var guardado = leerLS(CLAVE_CARRITO);
    if (guardado) { var d = JSON.parse(guardado); carrito = Array.isArray(d.lineas) ? d.lineas : []; if (d.descuento) $('posDescuento').value = d.descuento; }
  } catch (e) { carrito = []; }
  pintarCarrito();
  buscar('', false);
})();
