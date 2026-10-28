const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Regresion: "POST /panel/categorias/plantilla" quedaba capturada por
// "POST /panel/categorias/:id" (registrada antes) y el boton de cargar la
// estructura de ropa nunca funcionaba. Se arreglo restringiendo :id a numeros.
// Express no expone una API simple para probar el orden de rutas sin levantar
// el servidor entero, asi que se comprueba el codigo que lo garantiza.
describe('rutas de categorias', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  test('las rutas con :id de categoria solo aceptan numeros', () => {
    assert.match(server, /app\.get\('\/panel\/categorias\/:id\(\\\\d\+\)'/);
    assert.match(server, /app\.post\('\/panel\/categorias\/:id\(\\\\d\+\)'/);
  });

  test('ninguna ruta de categorias con :id suelto puede capturar "plantilla"', () => {
    const sueltas = server.match(/app\.(get|post)\('\/panel\/categorias\/:id',/g) || [];
    assert.equal(sueltas.length, 0);
  });
});
