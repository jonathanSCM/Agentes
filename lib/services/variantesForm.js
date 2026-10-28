// Variantes que llegan del formulario guiado de producto.
//
// El formulario arma en el navegador la tabla de combinaciones (Talla x Color,
// cada una con su stock y precio) y la manda como un solo campo JSON
// (`variantesJson`). Aca se valida: el navegador nunca es de fiar, asi que
// nada de lo que llega se guarda sin pasar por este filtro.

const MAX_VARIANTES = 100;
const MAX_ATRIBUTOS_POR_VARIANTE = 6;

function normalizar(texto) {
  return String(texto == null ? '' : texto).trim().toLowerCase();
}

// Identidad de una variante: sus atributos sin importar el orden ni las
// mayusculas ("Talla=42, Color=Negro" == "color=negro, talla=42").
function claveDeAtributos(atributos) {
  return Object.entries(atributos || {})
    .map(([k, v]) => `${normalizar(k)}=${normalizar(v)}`)
    .sort()
    .join('|');
}

/**
 * @param {string|undefined} texto JSON con [{ atributos:{Talla:'42'}, stock:3, precio:'' }]
 * @returns {{ ok:boolean, variantes:Array<{atributos:Object,stock:number,precio:number|null}>, error?:string }}
 */
function parsearVariantesJson(texto) {
  if (texto === undefined || texto === null || String(texto).trim() === '') return { ok: true, variantes: [] };

  let crudo;
  try { crudo = JSON.parse(texto); } catch { return { ok: false, variantes: [], error: 'No pudimos leer las variantes. Probá armarlas de nuevo.' }; }
  if (!Array.isArray(crudo)) return { ok: false, variantes: [], error: 'No pudimos leer las variantes. Probá armarlas de nuevo.' };
  if (crudo.length > MAX_VARIANTES) {
    return { ok: false, variantes: [], error: `Son demasiadas combinaciones (máximo ${MAX_VARIANTES} por vez). Dividilas en dos tandas.` };
  }

  const vistas = new Set();
  const variantes = [];
  for (const fila of crudo) {
    const atributos = {};
    for (const [k, v] of Object.entries((fila && fila.atributos) || {})) {
      const clave = String(k || '').trim().slice(0, 60);
      const valor = String(v == null ? '' : v).trim().slice(0, 120);
      if (clave && valor) atributos[clave] = valor;
    }
    const n = Object.keys(atributos).length;
    if (n === 0) continue; // fila vacia: se ignora
    if (n > MAX_ATRIBUTOS_POR_VARIANTE) {
      return { ok: false, variantes: [], error: `Una variante no puede tener más de ${MAX_ATRIBUTOS_POR_VARIANTE} opciones.` };
    }
    const clave = claveDeAtributos(atributos);
    if (vistas.has(clave)) continue; // repetida dentro del mismo envio
    vistas.add(clave);

    const stock = Math.max(0, parseInt(fila.stock, 10) || 0);
    const precioNum = fila.precio === '' || fila.precio == null ? null : Number(fila.precio);
    const precio = precioNum !== null && Number.isFinite(precioNum) && precioNum >= 0 ? precioNum : null;
    variantes.push({ atributos, stock, precio });
  }
  return { ok: true, variantes };
}

/** Saca las variantes que el producto ya tiene (mismos atributos). */
function sinLasExistentes(nuevas, existentes) {
  const yaEstan = new Set((existentes || []).map((v) => claveDeAtributos(v.atributos)));
  return nuevas.filter((v) => !yaEstan.has(claveDeAtributos(v.atributos)));
}

module.exports = { parsearVariantesJson, sinLasExistentes, claveDeAtributos, MAX_VARIANTES, MAX_ATRIBUTOS_POR_VARIANTE };
