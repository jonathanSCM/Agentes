const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { obtenerCatalogo, invalidarEmpresa, invalidarTodo, reiniciar, TTL_MS, MAX_ENTRADAS } = require('../lib/services/catalogoCache');

// Cargador falso que cuenta cuantas veces "pego a la base".
function cargadorDe(empresaId, contador, extra = {}) {
  return async () => {
    contador.n += 1;
    return { empresaId, version: contador.n, ...extra };
  };
}

describe('catalogoCache - cache del catalogo publico', () => {
  beforeEach(() => reiniciar());

  test('la segunda visita sale de la cache, sin volver a cargar', async () => {
    const c = { n: 0 };
    const a = await obtenerCatalogo('tienda', cargadorDe(1, c), 1000);
    const b = await obtenerCatalogo('tienda', cargadorDe(1, c), 2000);
    assert.equal(c.n, 1);
    assert.equal(a, b);
  });

  test('pasado el TTL se vuelve a cargar', async () => {
    const c = { n: 0 };
    await obtenerCatalogo('tienda', cargadorDe(1, c), 1000);
    await obtenerCatalogo('tienda', cargadorDe(1, c), 1000 + TTL_MS + 1);
    assert.equal(c.n, 2);
  });

  test('empresas distintas no se pisan', async () => {
    const c = { n: 0 };
    const a = await obtenerCatalogo('tienda-a', cargadorDe(1, c, { nombre: 'A' }), 1000);
    const b = await obtenerCatalogo('tienda-b', cargadorDe(2, c, { nombre: 'B' }), 1000);
    assert.equal(a.nombre, 'A');
    assert.equal(b.nombre, 'B');
    assert.equal(c.n, 2);
  });

  test('invalidarEmpresa descarta solo esa empresa', async () => {
    const c = { n: 0 };
    await obtenerCatalogo('tienda-a', cargadorDe(1, c), 1000);
    await obtenerCatalogo('tienda-b', cargadorDe(2, c), 1000);
    invalidarEmpresa(1);
    await obtenerCatalogo('tienda-a', cargadorDe(1, c), 1500); // recarga
    await obtenerCatalogo('tienda-b', cargadorDe(2, c), 1500); // sigue en cache
    assert.equal(c.n, 3);
  });

  test('invalidarTodo descarta todas las empresas', async () => {
    const c = { n: 0 };
    await obtenerCatalogo('tienda-a', cargadorDe(1, c), 1000);
    await obtenerCatalogo('tienda-b', cargadorDe(2, c), 1000);
    invalidarTodo();
    await obtenerCatalogo('tienda-a', cargadorDe(1, c), 1500);
    await obtenerCatalogo('tienda-b', cargadorDe(2, c), 1500);
    assert.equal(c.n, 4);
  });

  test('slug inexistente (null) no se cachea', async () => {
    let llamadas = 0;
    const nulo = async () => { llamadas += 1; return null; };
    assert.equal(await obtenerCatalogo('fantasma', nulo, 1000), null);
    assert.equal(await obtenerCatalogo('fantasma', nulo, 1001), null);
    assert.equal(llamadas, 2);
  });

  test('visitas simultaneas comparten una sola carga', async () => {
    const c = { n: 0 };
    const lento = async () => {
      c.n += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { empresaId: 1 };
    };
    const [a, b, d] = await Promise.all([
      obtenerCatalogo('tienda', lento, 1000),
      obtenerCatalogo('tienda', lento, 1000),
      obtenerCatalogo('tienda', lento, 1000),
    ]);
    assert.equal(c.n, 1);
    assert.equal(a, b);
    assert.equal(b, d);
  });

  test('una carga que empezo ANTES de invalidar no deja dato viejo en cache', async () => {
    let n = 0;
    let soltar;
    const compuerta = new Promise((r) => { soltar = r; });
    const lenta = async () => {
      n += 1;
      const dato = { empresaId: 1, generacion: n };
      await compuerta; // simula una consulta lenta mientras alguien edita el producto
      return dato;
    };
    const visita = obtenerCatalogo('tienda', lenta, 1000);
    invalidarEmpresa(1); // el negocio guarda un cambio mientras la consulta corre
    soltar();
    await visita;

    const rapida = async () => { n += 1; return { empresaId: 1, generacion: n }; };
    const siguiente = await obtenerCatalogo('tienda', rapida, 1100);
    assert.equal(siguiente.generacion, 2); // recargo en vez de servir el dato viejo
  });

  test('si la carga falla, el error sale y la proxima visita reintenta', async () => {
    const falla = async () => { throw new Error('base caida'); };
    await assert.rejects(() => obtenerCatalogo('tienda', falla, 1000), /base caida/);
    const c = { n: 0 };
    const v = await obtenerCatalogo('tienda', cargadorDe(1, c), 1001);
    assert.equal(v.empresaId, 1);
    assert.equal(c.n, 1);
  });

  test('tiene tope de entradas: la mas vieja se descarta', async () => {
    const c = { n: 0 };
    for (let i = 0; i < MAX_ENTRADAS + 1; i++) {
      await obtenerCatalogo(`slug-${i}`, cargadorDe(i, c), 1000);
    }
    const antes = c.n;
    await obtenerCatalogo('slug-0', cargadorDe(0, c), 1001); // fue descartada: recarga
    assert.equal(c.n, antes + 1);
    await obtenerCatalogo(`slug-${MAX_ENTRADAS}`, cargadorDe(MAX_ENTRADAS, c), 1001); // sigue
    assert.equal(c.n, antes + 1);
  });
});
