// Los escenarios de evaluación (scripts/eval) son parte de la red de seguridad:
//  - su definición tiene que ser coherente (ids únicos, pasos, tipos)
//  - los que no necesitan IA corren acá, con la IA "caída" (sin gastar nada):
//    si alguien rompe el modo sin IA o el cierre por botones, este test lo ve.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { ESCENARIOS } = require('../scripts/eval/escenarios');

describe('escenarios de evaluación: definición', () => {
  test('ids únicos, tipos válidos y pasos con texto', () => {
    const ids = ESCENARIOS.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'hay ids repetidos');
    for (const e of ESCENARIOS) {
      assert.ok(['funcional', 'seguridad', 'resiliencia'].includes(e.tipo), `${e.id}: tipo inválido`);
      assert.ok(['flujo', 'ia'].includes(e.agente), `${e.id}: agente inválido`);
      assert.ok(e.pasos.length > 0 && e.pasos.every((p) => p.texto), `${e.id}: pasos vacíos`);
      assert.ok(e.esperado, `${e.id}: sin esperado`);
    }
  });

  test('los de seguridad exigen IA real (sin IA pasarían "de casualidad")', () => {
    for (const e of ESCENARIOS.filter((x) => x.tipo === 'seguridad')) assert.equal(e.requiereIA, true, e.id);
  });
});

describe('escenarios de evaluación: corrida sin IA (IA caída simulada)', () => {
  test('todos los escenarios que no necesitan IA aprueban', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'eval', 'correr.js'), '--sin-ia'], {
      encoding: 'utf8', timeout: 240000, env: { ...process.env },
    });
    const salida = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, `el eval sin IA falló:\n${salida.split('\n').filter((l) => /✖|·|Error/.test(l)).join('\n')}`);
    assert.match(salida, /Aprobados \(todas las corridas\): (\d+)\/\1/);
  });
});
