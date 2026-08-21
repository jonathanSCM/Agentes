// Parseo del Excel de import de catalogo: puro y determinista (sin DB), asi
// que se prueba sin levantar nada. importarCatalogo (que si toca la base) se
// testea aparte en test/catalogo-excel-import.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const {
  generarPlantillaExcel,
  parsearFilasExcel,
  mismosAtributos,
  HOJA_PRODUCTOS,
  HOJA_VARIANTES,
  COLUMNAS_PRODUCTOS,
  COLUMNAS_VARIANTES,
} = require('../lib/services/catalogoExcel');

// Arma un workbook a mano (mismo layout que la plantilla real) para poder
// probar filas puntuales sin depender de generarPlantillaExcel.
async function workbookConFilas({ productos = [], variantes = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  const hojaProd = wb.addWorksheet(HOJA_PRODUCTOS);
  hojaProd.addRow(COLUMNAS_PRODUCTOS);
  productos.forEach((fila) => hojaProd.addRow(fila));

  const hojaVar = wb.addWorksheet(HOJA_VARIANTES);
  hojaVar.addRow(COLUMNAS_VARIANTES);
  variantes.forEach((fila) => hojaVar.addRow(fila));

  return wb.xlsx.writeBuffer();
}

describe('generarPlantillaExcel', () => {
  test('arma las 4 hojas esperadas (instrucciones + lista oculta + productos + variantes)', async () => {
    const buffer = await generarPlantillaExcel({ nombre: 'Tienda Test', marca: null }, [{ nombre: 'Calzado' }, { nombre: 'Ropa' }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const nombresHojas = wb.worksheets.map((h) => h.name);
    assert.ok(nombresHojas.includes('Instrucciones'));
    assert.ok(nombresHojas.includes('ListaCategorias'));
    assert.ok(nombresHojas.includes(HOJA_PRODUCTOS));
    assert.ok(nombresHojas.includes(HOJA_VARIANTES));
  });

  test('la hoja Productos ya trae el encabezado con las columnas reales', async () => {
    const buffer = await generarPlantillaExcel({ nombre: 'Tienda Test' }, []);
    const { productos, variantes } = await parsearFilasExcel(buffer);
    // Plantilla vacia (sin filas de datos, solo encabezado): no debe inventar nada.
    assert.deepEqual(productos, []);
    assert.deepEqual(variantes, []);
  });

  test('sin categorias existentes, no revienta (la lista del dropdown queda vacia)', async () => {
    const buffer = await generarPlantillaExcel({ nombre: 'Tienda Nueva' }, []);
    assert.ok(buffer.length > 0);
  });
});

describe('parsearFilasExcel - hoja Productos', () => {
  test('una fila valida se parsea completa, con atributos extra y fotos', async () => {
    const buffer = await workbookConFilas({
      productos: [[
        'Calzado', 'Zapatillas urbanas', 'Zapatilla Test', 'Descripcion real', '379', '5', 'SKU-1', 'Adidas',
        'cuero, comoda', 'Genero: Hombre; Uso: Casual', 'https://a.jpg, https://b.jpg',
      ]],
    });
    const { productos, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(erroresDeFormato.length, 0);
    assert.equal(productos.length, 1);
    const p = productos[0];
    assert.equal(p.categoria, 'Calzado');
    assert.equal(p.subcategoria, 'Zapatillas urbanas');
    assert.equal(p.nombre, 'Zapatilla Test');
    assert.equal(p.precio, 379);
    assert.equal(p.stock, 5);
    assert.equal(p.sku, 'SKU-1');
    assert.deepEqual(p.atributos, { Genero: 'Hombre', Uso: 'Casual', Marca: 'Adidas' });
    assert.deepEqual(p.caracteristicas, ['cuero', 'comoda']);
    assert.deepEqual(p.fotos, ['https://a.jpg', 'https://b.jpg']);
  });

  test('fila sin nombre: se reporta como error de formato, no se incluye en productos', async () => {
    const buffer = await workbookConFilas({ productos: [['Calzado', '', '', 'desc', '100', '1', '', '', '', '', '']] });
    const { productos, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(productos.length, 0);
    assert.equal(erroresDeFormato.length, 1);
    assert.match(erroresDeFormato[0].motivo, /nombre/i);
  });

  test('precio no numerico: error de formato con el valor real en el motivo', async () => {
    const buffer = await workbookConFilas({ productos: [['', '', 'Producto X', '', 'gratis', '', '', '', '', '', '']] });
    const { productos, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(productos.length, 0);
    assert.match(erroresDeFormato[0].motivo, /precio/i);
    assert.match(erroresDeFormato[0].motivo, /gratis/);
  });

  test('precio con coma decimal (formato local) se interpreta bien', async () => {
    const buffer = await workbookConFilas({ productos: [['', '', 'Producto Y', '', '99,50', '', '', '', '', '', '']] });
    const { productos } = await parsearFilasExcel(buffer);
    assert.equal(productos[0].precio, 99.5);
  });

  test('fila completamente vacia se ignora en silencio (no es un error)', async () => {
    const buffer = await workbookConFilas({ productos: [['', '', '', '', '', '', '', '', '', '', '']] });
    const { productos, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(productos.length, 0);
    assert.equal(erroresDeFormato.length, 0);
  });

  test('sin categoria ni subcategoria, el producto igual se parsea (categoria null)', async () => {
    const buffer = await workbookConFilas({ productos: [['', '', 'Producto sin categoria', '', '50', '', '', '', '', '', '']] });
    const { productos, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(erroresDeFormato.length, 0);
    assert.equal(productos[0].categoria, null);
  });
});

describe('parsearFilasExcel - hoja Variantes', () => {
  test('una fila valida con talla y color', async () => {
    const buffer = await workbookConFilas({
      variantes: [['Zapatilla Test', '42', 'Negro', '3', '399', 'SKU-42-NEGRO']],
    });
    const { variantes, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(erroresDeFormato.length, 0);
    assert.equal(variantes.length, 1);
    assert.deepEqual(variantes[0].atributos, { Talla: '42', Color: 'Negro' });
    assert.equal(variantes[0].stock, 3);
    assert.equal(variantes[0].precio, 399);
  });

  test('sin producto: error de formato', async () => {
    const buffer = await workbookConFilas({ variantes: [['', '42', 'Negro', '3', '', '']] });
    const { variantes, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(variantes.length, 0);
    assert.match(erroresDeFormato[0].motivo, /producto/i);
  });

  test('sin talla ni color: error de formato (no hay nada que distinga la variante)', async () => {
    const buffer = await workbookConFilas({ variantes: [['Zapatilla Test', '', '', '3', '', '']] });
    const { variantes, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(variantes.length, 0);
    assert.match(erroresDeFormato[0].motivo, /Talla o Color/);
  });

  test('stock invalido: error de formato', async () => {
    const buffer = await workbookConFilas({ variantes: [['Zapatilla Test', '42', '', 'muchas', '', '']] });
    const { variantes, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(variantes.length, 0);
    assert.match(erroresDeFormato[0].motivo, /stock/i);
  });

  test('precio vacio es valido (hereda el del producto)', async () => {
    const buffer = await workbookConFilas({ variantes: [['Zapatilla Test', '42', 'Negro', '3', '', '']] });
    const { variantes, erroresDeFormato } = await parsearFilasExcel(buffer);
    assert.equal(erroresDeFormato.length, 0);
    assert.equal(variantes[0].precio, null);
  });
});

describe('mismosAtributos', () => {
  test('mismas claves y valores (sin importar mayusculas/espacios) son la misma variante', () => {
    assert.equal(mismosAtributos({ Talla: '42', Color: 'Negro' }, { Talla: ' 42 ', Color: 'negro' }), true);
  });

  test('distinta cantidad de claves con valor no es la misma variante', () => {
    assert.equal(mismosAtributos({ Talla: '42', Color: 'Negro' }, { Talla: '42' }), false);
  });

  test('mismo valor pero distinta clave no es la misma variante', () => {
    assert.equal(mismosAtributos({ Talla: '42' }, { Color: '42' }), false);
  });
});
