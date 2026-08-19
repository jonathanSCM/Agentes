// Token de sesion del catalogo web publico: sin login, el cliente llega
// desde un link firmado que le manda el bot. Puro, sin DB.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { generarTokenSesion, verificarTokenSesion } = require('../lib/services/sesionWeb');

describe('sesion web del catalogo', () => {
  test('un token recien generado es valido y trae la identidad correcta', () => {
    const token = generarTokenSesion({ empresaId: 2, telefono: '59169160031', conversacionId: 81 });
    const payload = verificarTokenSesion(token);
    assert.equal(payload.empresaId, 2);
    assert.equal(payload.telefono, '59169160031');
    assert.equal(payload.conversacionId, 81);
  });

  test('sin conversacionId igual genera un token valido', () => {
    const token = generarTokenSesion({ empresaId: 2, telefono: '111' });
    const payload = verificarTokenSesion(token);
    assert.equal(payload.conversacionId, null);
  });

  test('un token vencido no es valido', () => {
    const token = generarTokenSesion({ empresaId: 2, telefono: '59169160031' }, -1);
    assert.equal(verificarTokenSesion(token), null);
  });

  test('un token manipulado (payload cambiado, firma vieja) no es valido', () => {
    const token = generarTokenSesion({ empresaId: 2, telefono: '59169160031' });
    const [payloadTexto, firma] = token.split('.');
    const payloadFalso = Buffer.from(JSON.stringify({ empresaId: 999, telefono: '000', vence: Date.now() + 60000 })).toString('base64url');
    assert.equal(verificarTokenSesion(`${payloadFalso}.${firma}`), null);
  });

  test('basura, string vacio, o sin el separador nunca rompe ni pasa', () => {
    assert.equal(verificarTokenSesion(''), null);
    assert.equal(verificarTokenSesion(null), null);
    assert.equal(verificarTokenSesion(undefined), null);
    assert.equal(verificarTokenSesion('sin-punto-no-es-token'), null);
    assert.equal(verificarTokenSesion('cualquier.cosa.rota'), null);
  });

  test('generarTokenSesion exige empresaId y telefono', () => {
    assert.throws(() => generarTokenSesion({ telefono: '111' }));
    assert.throws(() => generarTokenSesion({ empresaId: 1 }));
  });
});
