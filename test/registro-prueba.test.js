// Registro: un cliente nuevo entra en PRUEBA GRATIS con un solo módulo (el Agente).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { registrarCliente } = require('../lib/services/auth');
const P = require('../lib/services/planesCliente');

const EMAILS = [];
const correo = () => { const e = `registro-prueba-${Math.random().toString(36).slice(2, 8)}@test.local`; EMAILS.push(e); return e; };

after(async () => {
  const usuarios = await prisma.usuario.findMany({ where: { email: { in: EMAILS } } });
  await prisma.empresa.deleteMany({ where: { id: { in: usuarios.map((u) => u.empresaId).filter(Boolean) } } });
});

describe('registro con prueba gratis', () => {
  test('entra en PRUEBA solo con el módulo Agente y vence en los días de prueba', async () => {
    const { empresa } = await registrarCliente({ empresa: 'Tienda Nueva', nombre: 'Ana', email: correo(), password: 'clave-segura-1' });
    const v = await P.valoresDe(empresa.id);
    assert.equal(v.estado, 'PRUEBA');
    assert.deepEqual(v.modulos, ['AGENTE']);
    assert.equal(await P.tieneModulo(empresa.id, 'POS'), false);
    assert.equal(await P.tieneModulo(empresa.id, 'PANEL'), false);
    const dias = Math.round((v.planFin - Date.now()) / 86400000);
    assert.ok(dias >= P.DIAS_PRUEBA - 1 && dias <= P.DIAS_PRUEBA, `vence en ${dias} días`);
  });

  test('ya no se crea un pago pendiente ni se elige plan al registrarse', async () => {
    const { empresa } = await registrarCliente({ empresa: 'Otra Tienda', nombre: 'Beto', email: correo(), password: 'clave-segura-1' });
    assert.equal(await prisma.pago.count({ where: { empresaId: empresa.id } }), 0);
  });

  test('correo repetido se rechaza', async () => {
    const e = correo();
    await registrarCliente({ empresa: 'Uno', nombre: 'A', email: e, password: 'clave-segura-1' });
    await assert.rejects(() => registrarCliente({ empresa: 'Dos', nombre: 'B', email: e, password: 'clave-segura-1' }), /Ya existe/);
  });

  test('la siembra puede dar el plan de acceso total (solo pruebas)', async () => {
    const full = await prisma.plan.findUnique({ where: { codigo: 'ACCESO_TOTAL' } });
    const { empresa } = await registrarCliente({ empresa: 'Mi Prueba Total', nombre: 'Admin', email: correo(), password: 'clave-segura-1', planId: full.id });
    const v = await P.valoresDe(empresa.id);
    assert.equal(v.ilimitado, true);
    assert.deepEqual([...v.modulos].sort(), ['AGENTE', 'PANEL', 'POS']);
  });
});
