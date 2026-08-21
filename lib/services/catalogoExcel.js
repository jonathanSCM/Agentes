// Importar el catalogo desde un Excel: el dueno descarga una plantilla con
// el formato ya armado, la llena, y el sistema crea/actualiza productos,
// categorias y variantes reales - en vez de cargar todo a mano, uno por uno,
// desde el panel.
//
// Mismo principio del resto del proyecto: el backend decide y filtra, nunca
// inventa. Si una fila no se puede procesar (falta un dato, el producto de
// una variante no existe, una foto no se pudo descargar), se salta ESA fila
// puntual y queda reportada con el motivo real - nunca se calla el error ni
// se inventa un valor para "que pase".
//
// generarPlantillaExcel / parsearFilasExcel no tocan la base (se pueden
// testear sin Postgres). importarCatalogo si, y recibe por inyeccion
// `descargarFoto` y `onProductoGuardado` para no acoplarse a fs/sharp ni al
// armado del texto de embeddings, que viven en server.js.

const ExcelJS = require('exceljs');

const HOJA_PRODUCTOS = 'Productos';
const HOJA_VARIANTES = 'Variantes';
const HOJA_INSTRUCCIONES = 'Instrucciones';
const HOJA_LISTA_CATEGORIAS = 'ListaCategorias';

const COLUMNAS_PRODUCTOS = [
  'Categoría (rubro)*', 'Subcategoría', 'Nombre*', 'Descripción', 'Precio*',
  'Stock (solo si NO tiene variantes)', 'SKU', 'Marca',
  'Características (separadas por coma)', 'Atributos extra (Clave: Valor; Clave: Valor)',
  'Fotos (URLs separadas por coma)',
];
const COLUMNAS_VARIANTES = ['Producto*', 'Talla', 'Color', 'Stock*', 'Precio (vacío = el del producto)', 'SKU'];

async function generarPlantillaExcel(empresa, categoriasExistentes = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Proshop';

  const hojaInstr = wb.addWorksheet(HOJA_INSTRUCCIONES);
  hojaInstr.getColumn(1).width = 100;
  const lineas = [
    `Plantilla de catálogo — ${(empresa && (empresa.marca || empresa.nombre)) || ''}`,
    '',
    'Cómo llenarla:',
    '1) Hoja "Productos": una fila por producto. Las columnas con * son obligatorias.',
    '2) "Categoría (rubro)" y "Subcategoría": si no existen todavía, se crean solas. Si tu rubro ya tiene subcategorías, cargá el producto en la subcategoría, no en el rubro.',
    '3) "Stock" solo se usa si el producto NO tiene variantes (talla/color). Si tiene variantes, el stock se carga en la hoja "Variantes".',
    '4) "Atributos extra": para datos como Género o Uso. Formato: Clave: Valor; Clave: Valor (ej: Genero: Hombre; Uso: Casual).',
    '5) "Fotos": pegá los links (URL) de las fotos, separados por coma. El sistema las descarga y las procesa solo.',
    '6) Hoja "Variantes" (opcional): una fila por cada combinación real de talla/color, con su propio stock. La columna "Producto" tiene que coincidir EXACTO con el nombre que pusiste en la hoja Productos.',
    '7) Podés volver a subir este mismo archivo corregido: si un producto ya existe (mismo nombre y categoría), se actualiza en vez de duplicarse.',
  ];
  lineas.forEach((linea) => hojaInstr.addRow([linea]));
  hojaInstr.getRow(1).font = { bold: true, size: 14 };

  // Hoja oculta con los nombres de categoria reales, para el dropdown de la
  // columna Categoria - no aparece para el usuario, solo alimenta la lista.
  const nombresCategorias = [...new Set((categoriasExistentes || []).map((c) => c.nombre).filter(Boolean))];
  const hojaLista = wb.addWorksheet(HOJA_LISTA_CATEGORIAS);
  hojaLista.state = 'veryHidden';
  nombresCategorias.forEach((nombre, i) => { hojaLista.getCell(i + 1, 1).value = nombre; });

  const hojaProd = wb.addWorksheet(HOJA_PRODUCTOS);
  hojaProd.addRow(COLUMNAS_PRODUCTOS);
  hojaProd.getRow(1).font = { bold: true };
  COLUMNAS_PRODUCTOS.forEach((_c, i) => { hojaProd.getColumn(i + 1).width = 26; });
  if (nombresCategorias.length) {
    const rango = `${HOJA_LISTA_CATEGORIAS}!$A$1:$A$${nombresCategorias.length}`;
    for (let fila = 2; fila <= 200; fila += 1) {
      hojaProd.getCell(`A${fila}`).dataValidation = { type: 'list', allowBlank: true, formulae: [rango] };
    }
  }

  const hojaVar = wb.addWorksheet(HOJA_VARIANTES);
  hojaVar.addRow(COLUMNAS_VARIANTES);
  hojaVar.getRow(1).font = { bold: true };
  COLUMNAS_VARIANTES.forEach((_c, i) => { hojaVar.getColumn(i + 1).width = 22; });

  return wb.xlsx.writeBuffer();
}

// Lee una celda como texto plano, sin importar si vino como string, numero,
// texto enriquecido o formula ya calculada por Excel.
function celdaTexto(row, indice) {
  const valor = row.getCell(indice).value;
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'object') {
    if (Array.isArray(valor.richText)) return valor.richText.map((r) => r.text).join('').trim();
    if (valor.result !== undefined) return String(valor.result ?? '').trim();
    if (valor.text !== undefined) return String(valor.text).trim();
  }
  return String(valor).trim();
}

function parsearAtributosExtra(texto) {
  const atributos = {};
  String(texto || '').split(';').forEach((par) => {
    const idx = par.indexOf(':');
    if (idx === -1) return;
    const clave = par.slice(0, idx).trim();
    const valor = par.slice(idx + 1).trim();
    if (clave && valor) atributos[clave] = valor;
  });
  return atributos;
}

function filaVacia(valores) {
  return !valores.some((v) => v);
}

/**
 * Pura y determinista - nunca toca la base. Lee el workbook y devuelve las
 * filas ya normalizadas, mas los errores de formato encontrados (precio no
 * numerico, falta el nombre, etc.). Las filas con error NO se incluyen en
 * `productos`/`variantes` - quedan solo en `erroresDeFormato`.
 */
async function parsearFilasExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const productos = [];
  const variantes = [];
  const erroresDeFormato = [];

  const hojaProd = wb.getWorksheet(HOJA_PRODUCTOS);
  if (hojaProd) {
    hojaProd.eachRow({ includeEmpty: false }, (row, numeroFila) => {
      if (numeroFila === 1) return;
      const categoria = celdaTexto(row, 1);
      const subcategoria = celdaTexto(row, 2);
      const nombre = celdaTexto(row, 3);
      const descripcion = celdaTexto(row, 4);
      const precioTexto = celdaTexto(row, 5);
      const stockTexto = celdaTexto(row, 6);
      const sku = celdaTexto(row, 7);
      const marca = celdaTexto(row, 8);
      const caracteristicasTexto = celdaTexto(row, 9);
      const atributosTexto = celdaTexto(row, 10);
      const fotosTexto = celdaTexto(row, 11);

      if (filaVacia([categoria, nombre, descripcion, precioTexto, stockTexto, sku, marca, caracteristicasTexto, atributosTexto, fotosTexto])) return;

      if (!nombre) {
        erroresDeFormato.push({ hoja: HOJA_PRODUCTOS, fila: numeroFila, motivo: 'Falta el nombre del producto.' });
        return;
      }
      const precio = Number(String(precioTexto).replace(',', '.'));
      if (!precioTexto || !Number.isFinite(precio) || precio < 0) {
        erroresDeFormato.push({ hoja: HOJA_PRODUCTOS, fila: numeroFila, motivo: `El precio no es un número válido: "${precioTexto}".` });
        return;
      }
      let stock = 0;
      if (stockTexto) {
        stock = parseInt(stockTexto, 10);
        if (!Number.isFinite(stock) || stock < 0) {
          erroresDeFormato.push({ hoja: HOJA_PRODUCTOS, fila: numeroFila, motivo: `El stock no es un número válido: "${stockTexto}".` });
          return;
        }
      }

      const atributos = parsearAtributosExtra(atributosTexto);
      if (marca) atributos.Marca = marca;

      productos.push({
        fila: numeroFila,
        categoria: categoria || null,
        subcategoria: subcategoria || null,
        nombre,
        descripcion: descripcion || null,
        precio,
        stock,
        sku: sku || null,
        atributos,
        caracteristicas: caracteristicasTexto ? caracteristicasTexto.split(',').map((c) => c.trim()).filter(Boolean) : [],
        fotos: fotosTexto ? fotosTexto.split(',').map((f) => f.trim()).filter(Boolean) : [],
      });
    });
  }

  const hojaVar = wb.getWorksheet(HOJA_VARIANTES);
  if (hojaVar) {
    hojaVar.eachRow({ includeEmpty: false }, (row, numeroFila) => {
      if (numeroFila === 1) return;
      const producto = celdaTexto(row, 1);
      const talla = celdaTexto(row, 2);
      const color = celdaTexto(row, 3);
      const stockTexto = celdaTexto(row, 4);
      const precioTexto = celdaTexto(row, 5);
      const sku = celdaTexto(row, 6);

      if (filaVacia([producto, talla, color, stockTexto, precioTexto, sku])) return;

      if (!producto) {
        erroresDeFormato.push({ hoja: HOJA_VARIANTES, fila: numeroFila, motivo: 'Falta el nombre del producto (columna Producto).' });
        return;
      }
      if (!talla && !color) {
        erroresDeFormato.push({ hoja: HOJA_VARIANTES, fila: numeroFila, motivo: 'La variante necesita al menos Talla o Color.' });
        return;
      }
      const stock = parseInt(stockTexto, 10);
      if (!stockTexto || !Number.isFinite(stock) || stock < 0) {
        erroresDeFormato.push({ hoja: HOJA_VARIANTES, fila: numeroFila, motivo: `El stock no es un número válido: "${stockTexto}".` });
        return;
      }
      let precio = null;
      if (precioTexto) {
        precio = Number(String(precioTexto).replace(',', '.'));
        if (!Number.isFinite(precio) || precio < 0) {
          erroresDeFormato.push({ hoja: HOJA_VARIANTES, fila: numeroFila, motivo: `El precio no es un número válido: "${precioTexto}".` });
          return;
        }
      }

      const atributos = {};
      if (talla) atributos.Talla = talla;
      if (color) atributos.Color = color;

      variantes.push({ fila: numeroFila, producto, atributos, stock, precio, sku: sku || null });
    });
  }

  return { productos, variantes, erroresDeFormato };
}

// Dos combinaciones de atributos son "la misma variante" si tienen las
// mismas claves con valor, con el mismo valor (sin importar mayusculas ni
// espacios de mas) - asi volver a subir el Excel actualiza en vez de
// duplicar, aunque el orden de las claves en el Json difiera.
function mismosAtributos(a = {}, b = {}) {
  const clavesA = Object.keys(a).filter((k) => a[k]);
  const clavesB = Object.keys(b).filter((k) => b[k]);
  if (clavesA.length !== clavesB.length) return false;
  return clavesA.every((k) => String(a[k]).trim().toLowerCase() === String(b[k] || '').trim().toLowerCase());
}

// Resuelve (o crea) el rubro y, si corresponde, la subcategoria - nunca
// duplica: reusa lo que ya existe en la empresa por nombre, igual que el
// seeder de plantillas de categorias (server.js).
async function categoriaIdParaFila(prisma, empresaId, cache, nombreCategoria, nombreSubcategoria) {
  if (!nombreCategoria) return { categoriaId: null, categoriasCreadas: 0 };
  let creadas = 0;
  const nombreRubro = nombreCategoria.trim();

  let rubro = cache.get(nombreRubro.toLowerCase());
  if (!rubro) {
    rubro = await prisma.categoria.findFirst({ where: { empresaId, nombre: nombreRubro } });
    if (!rubro) {
      rubro = await prisma.categoria.create({ data: { empresaId, nombre: nombreRubro } });
      creadas += 1;
    }
    cache.set(nombreRubro.toLowerCase(), rubro);
  }

  if (!nombreSubcategoria) return { categoriaId: rubro.id, categoriasCreadas: creadas };

  const nombreSub = nombreSubcategoria.trim();
  const claveSub = `${nombreRubro.toLowerCase()}::${nombreSub.toLowerCase()}`;
  let sub = cache.get(claveSub);
  if (!sub) {
    sub = await prisma.categoria.findFirst({ where: { empresaId, nombre: nombreSub, padreId: rubro.id } });
    if (!sub) {
      // El nombre de categoria es unico por empresa (no por rubro): si ya
      // existe una con ese nombre colgando de OTRO rubro, crearla de nuevo
      // rompe el unique - se avisa con un motivo claro en vez de reventar.
      const choque = await prisma.categoria.findFirst({ where: { empresaId, nombre: nombreSub } });
      if (choque) throw new Error(`Ya existe una categoría "${nombreSub}" que no es subcategoría de "${nombreRubro}".`);
      sub = await prisma.categoria.create({ data: { empresaId, nombre: nombreSub, padreId: rubro.id } });
      creadas += 1;
    }
    cache.set(claveSub, sub);
  }
  return { categoriaId: sub.id, categoriasCreadas: creadas };
}

/**
 * Hace el trabajo real contra la base: crea/actualiza categorias, productos
 * y variantes a partir de las filas ya parseadas. Nunca falla en bloque -
 * cada fila que no se pudo procesar queda en `saltados` con el motivo real,
 * el resto del import sigue.
 *
 * @param {object} opciones
 * @param {number} [opciones.maxProductos] limite del plan - igual que la
 *   creacion manual, si se alcanza a mitad del import se corta y se reporta.
 * @param {(url:string)=>Promise<string|null>} [opciones.descargarFoto]
 *   inyectado desde server.js (fetch + sharp + guardado en /uploads) - sin
 *   esto no se cargan fotos, pero el resto del producto igual se guarda.
 * @param {(producto:object)=>void} [opciones.onProductoGuardado] inyectado
 *   para disparar el backfill de embeddings, igual que la creacion manual.
 */
async function importarCatalogo(prisma, empresaId, { productos = [], variantes = [] }, opciones = {}) {
  const { maxProductos = Infinity, descargarFoto, onProductoGuardado } = opciones;

  const reporte = {
    categoriasCreadas: 0,
    productosCreados: 0,
    productosActualizados: 0,
    variantesCreadas: 0,
    variantesActualizadas: 0,
    saltados: [],
  };

  const cacheCategorias = new Map();
  const productoIdPorNombre = new Map();
  // Un producto con filas en la hoja Variantes no usa el Stock de la hoja
  // Productos (igual que el formulario manual: el stock real cuando hay
  // variantes es la suma de las variantes, Producto.stock queda en 0).
  const nombresConVariantes = new Set(variantes.map((v) => v.producto.trim().toLowerCase()));

  let totalActual = await prisma.producto.count({ where: { empresaId } });

  for (const fila of productos) {
    try {
      if (totalActual >= maxProductos) {
        reporte.saltados.push({ hoja: HOJA_PRODUCTOS, fila: fila.fila, motivo: 'Se alcanzó el límite de productos de tu plan.' });
        continue;
      }

      const { categoriaId, categoriasCreadas } = await categoriaIdParaFila(prisma, empresaId, cacheCategorias, fila.categoria, fila.subcategoria);
      reporte.categoriasCreadas += categoriasCreadas;

      const fotosNuevas = [];
      if (fila.fotos.length && descargarFoto) {
        for (const url of fila.fotos) {
          const nombreArchivo = await descargarFoto(url).catch(() => null);
          if (nombreArchivo) fotosNuevas.push(nombreArchivo);
          else reporte.saltados.push({ hoja: HOJA_PRODUCTOS, fila: fila.fila, motivo: `No se pudo descargar la foto: ${url}` });
        }
      }

      const stockReal = nombresConVariantes.has(fila.nombre.trim().toLowerCase()) ? 0 : fila.stock;
      const existente = await prisma.producto.findFirst({
        where: { empresaId, categoriaId, nombre: { equals: fila.nombre, mode: 'insensitive' } },
      });

      const datosComunes = {
        categoriaId,
        nombre: fila.nombre.slice(0, 120),
        descripcion: fila.descripcion ? fila.descripcion.slice(0, 200) : null,
        precio: fila.precio,
        stock: stockReal,
        sku: fila.sku ? fila.sku.slice(0, 60) : null,
        caracteristicas: fila.caracteristicas,
        atributos: fila.atributos,
      };

      let producto;
      if (existente) {
        producto = await prisma.producto.update({
          where: { id: existente.id },
          data: { ...datosComunes, fotos: fotosNuevas.length ? [...existente.fotos, ...fotosNuevas] : existente.fotos },
        });
        reporte.productosActualizados += 1;
      } else {
        producto = await prisma.producto.create({ data: { ...datosComunes, empresaId, activo: true, fotos: fotosNuevas } });
        reporte.productosCreados += 1;
        totalActual += 1;
      }

      productoIdPorNombre.set(fila.nombre.trim().toLowerCase(), producto.id);
      if (onProductoGuardado) onProductoGuardado(producto);
    } catch (err) {
      reporte.saltados.push({ hoja: HOJA_PRODUCTOS, fila: fila.fila, motivo: err.message || 'No se pudo guardar el producto.' });
    }
  }

  for (const fila of variantes) {
    try {
      const productoId = productoIdPorNombre.get(fila.producto.trim().toLowerCase());
      if (!productoId) {
        reporte.saltados.push({ hoja: HOJA_VARIANTES, fila: fila.fila, motivo: `No se encontró el producto "${fila.producto}" en la hoja Productos.` });
        continue;
      }
      const variantesDelProducto = await prisma.variante.findMany({ where: { productoId } });
      const existente = variantesDelProducto.find((v) => mismosAtributos(v.atributos, fila.atributos));

      if (existente) {
        await prisma.variante.update({
          where: { id: existente.id },
          data: { stock: fila.stock, precio: fila.precio, sku: fila.sku },
        });
        reporte.variantesActualizadas += 1;
      } else {
        await prisma.variante.create({
          data: { productoId, atributos: fila.atributos, stock: fila.stock, precio: fila.precio, sku: fila.sku },
        });
        reporte.variantesCreadas += 1;
      }
    } catch (err) {
      reporte.saltados.push({ hoja: HOJA_VARIANTES, fila: fila.fila, motivo: err.message || 'No se pudo guardar la variante.' });
    }
  }

  return reporte;
}

module.exports = {
  generarPlantillaExcel,
  parsearFilasExcel,
  importarCatalogo,
  mismosAtributos,
  HOJA_PRODUCTOS,
  HOJA_VARIANTES,
  HOJA_INSTRUCCIONES,
  COLUMNAS_PRODUCTOS,
  COLUMNAS_VARIANTES,
};
