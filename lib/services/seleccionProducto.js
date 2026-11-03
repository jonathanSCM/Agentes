// Talla / color elegidos en un producto SIN variantes.
//
// Hay productos cargados con la talla y el color como un atributo del propio
// producto en vez de como variantes: Talla = "8,9,9.5,10,10.5", Color = "Blanco
// nube" (es lo que genera, por ejemplo, la importacion desde Excel cuando no se
// arman variantes). Para el sistema eso es UN solo producto con UN solo stock,
// asi que el carrito no tenia donde guardar que talla quiso el cliente: si
// decia "dame la 10", el bot volvia a agregar el mismo producto y la linea
// pasaba a "2x" sin ninguna talla (bug real, pedido #26).
//
// Aca se resuelve en codigo, sin IA: se leen las opciones reales del producto,
// se valida lo que pidio el cliente contra ellas y se arma el texto que viaja
// con la linea del carrito y del pedido. Puro y determinista (sin DB ni red).

const CLAVES = ['Talla', 'Color'];

function normalizar(texto) {
  return String(texto == null ? '' : texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

function valoresDeLista(texto) {
  return String(texto == null ? '' : texto).split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * Las opciones elegibles de un producto sin variantes: los atributos "Talla" y
 * "Color" (sin importar mayusculas) del propio producto. Cada una con sus
 * valores reales. Un producto con variantes no usa esto.
 *
 * @returns {Array<{nombre:string, valores:string[]}>}
 */
function opcionesDeSeleccion(producto) {
  if (!producto || (producto.variantes && producto.variantes.length)) return [];
  const atributos = producto.atributos || {};
  const opciones = [];
  for (const clave of CLAVES) {
    const real = Object.keys(atributos).find((k) => normalizar(k) === normalizar(clave));
    if (!real) continue;
    const valores = valoresDeLista(atributos[real]);
    if (valores.length) opciones.push({ nombre: clave, valores });
  }
  return opciones;
}

/**
 * Cruza lo que pidio el cliente con las opciones reales.
 *  - Una opcion con UN solo valor (un unico color) se completa sola.
 *  - Una con varios valores exige que el cliente haya dicho uno de ellos.
 *
 * @param {object} producto
 * @param {{talla?:string, color?:string}} pedidas  lo que dijo el cliente (puede venir vacio o de otro producto)
 * @returns {{ seleccion: Object<string,string>|null, texto: string, faltan: Array<{nombre:string, valores:string[]}> }}
 */
function resolverSeleccion(producto, pedidas = {}) {
  const opciones = opcionesDeSeleccion(producto);
  if (!opciones.length) return { seleccion: null, texto: '', faltan: [] };

  const seleccion = {};
  const faltan = [];
  for (const op of opciones) {
    if (op.valores.length === 1) { seleccion[op.nombre] = op.valores[0]; continue; }
    const pedido = normalizar(pedidas[op.nombre.toLowerCase()]);
    const elegido = pedido ? op.valores.find((v) => normalizar(v) === pedido) : null;
    if (elegido) seleccion[op.nombre] = elegido;
    else faltan.push(op);
  }
  const texto = textoDeSeleccion(seleccion);
  return { seleccion: Object.keys(seleccion).length ? seleccion : null, texto, faltan };
}

/** "Talla: 10, Color: Blanco nube" (siempre en el mismo orden). */
function textoDeSeleccion(seleccion) {
  if (!seleccion) return '';
  return CLAVES.filter((k) => seleccion[k]).map((k) => `${k}: ${seleccion[k]}`).join(', ');
}

module.exports = { opcionesDeSeleccion, resolverSeleccion, textoDeSeleccion, normalizar };
