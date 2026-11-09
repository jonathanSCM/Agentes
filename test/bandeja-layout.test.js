// El chat se comporta como WhatsApp Web: la PÁGINA no se desplaza, solo la lista y la zona de mensajes.
// Si algún contenedor de la cadena pierde su alto definido, el chat se estira a todos los mensajes y obliga a
// bajar la página entera (bug real con una conversación de 339 mensajes). Estas reglas lo protegen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'bandeja.css'), 'utf8');
const ejs = fs.readFileSync(path.join(__dirname, '..', 'views', 'cliente', 'bandeja.ejs'), 'utf8');
const regla = (selector) => {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `falta la regla ${selector}`);
  return css.slice(i, css.indexOf('}', i));
};

test('la pantalla de la bandeja ocupa exactamente la ventana y no se desplaza', () => {
  const body = regla('body.admin:has(.bandeja) {');
  assert.match(body, /height:\s*100dvh/);
  assert.match(body, /overflow:\s*hidden/);
  assert.match(regla('body.admin:has(.bandeja) .admin-shell'), /height:\s*100dvh/);
  assert.match(regla('body.admin:has(.bandeja) .admin-body'), /overflow:\s*hidden/);
});

test('la bandeja tiene una sola fila de alto fijo (minmax(0, 1fr)) para que el chat no crezca con los mensajes', () => {
  const b = regla('.bandeja {');
  assert.match(b, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(b, /min-height:\s*0/);
  assert.doesNotMatch(b, /min-height:\s*4\d\dpx/, 'un min-height grande reintroduce el problema en ventanas bajas');
});

test('solo la zona de mensajes y la lista tienen scroll propio', () => {
  assert.match(regla('.bandeja .conv-body {'), /overflow-y:\s*auto/);
  assert.match(regla('.conv-lista {'), /overflow-y:\s*auto/);
  assert.match(regla('.bandeja-chat {'), /min-height:\s*0/);
});

test('al abrir un chat se baja al último mensaje', () => {
  assert.match(ejs, /body\.scrollTop\s*=\s*body\.scrollHeight/);
});
