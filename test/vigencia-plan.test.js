const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../lib/services/vigenciaPlan');

const d = (s) => new Date(s);
const iso = (f) => f.toISOString().slice(0, 10);

describe('fechas de un plan', () => {
  test('sumar meses respeta el fin de mes', () => {
    assert.equal(iso(v.sumarMeses(d('2026-01-31T10:00:00Z'), 1)), '2026-02-28');
    assert.equal(iso(v.sumarMeses(d('2028-01-31T10:00:00Z'), 1)), '2028-02-29'); // bisiesto
    assert.equal(iso(v.sumarMeses(d('2026-11-15T10:00:00Z'), 3)), '2027-02-15');
    assert.equal(iso(v.sumarMeses(d('2026-11-15T10:00:00Z'), 12)), '2027-11-15');
  });

  test('el fin sale de meses (1, 2, 3, 6, 12) o de una fecha personalizada posterior', () => {
    const inicio = d('2026-11-08T12:00:00Z');
    for (const m of [1, 2, 3, 6, 12]) assert.ok(v.calcularFin({ desde: inicio, meses: m }) > inicio);
    assert.equal(iso(v.calcularFin({ desde: inicio, meses: 6 })), '2027-05-08');
    assert.equal(iso(v.calcularFin({ desde: inicio, fechaPersonalizada: '2027-01-20T00:00:00Z' })), '2027-01-20');
    assert.throws(() => v.calcularFin({ desde: inicio, meses: 5 }), /1, 2, 3, 6 o 12/);
    assert.throws(() => v.calcularFin({ desde: inicio, fechaPersonalizada: '2026-11-01T00:00:00Z' }), /posterior/);
    assert.throws(() => v.calcularFin({ desde: inicio, fechaPersonalizada: 'basura' }), /no es valida/);
  });

  test('renovar suma al fin vigente; si ya venció, cuenta desde hoy', () => {
    const ahora = d('2026-11-08T12:00:00Z');
    assert.equal(iso(v.renovarFin({ planFin: '2026-12-01T12:00:00Z', meses: 1, ahora })), '2027-01-01');
    assert.equal(iso(v.renovarFin({ planFin: '2026-10-01T12:00:00Z', meses: 1, ahora })), '2026-12-08');
    assert.equal(iso(v.renovarFin({ planFin: null, meses: 2, ahora })), '2027-01-08');
  });
});

describe('ventana mensual de conversaciones', () => {
  const inicio = d('2026-01-15T09:00:00Z');
  test('se reinicia cada mes el mismo día en que empezó el plan', () => {
    let p = v.periodoMensual(inicio, d('2026-01-20T00:00:00Z'));
    assert.equal(iso(p.desde), '2026-01-15'); assert.equal(iso(p.hasta), '2026-02-15');
    p = v.periodoMensual(inicio, d('2026-03-14T23:00:00Z'));
    assert.equal(iso(p.desde), '2026-02-15'); assert.equal(iso(p.hasta), '2026-03-15');
    p = v.periodoMensual(inicio, d('2026-03-15T09:00:00Z'));
    assert.equal(iso(p.desde), '2026-03-15');
  });
  test('un plan que empezó el 31 usa el último día de los meses cortos', () => {
    const p = v.periodoMensual(d('2026-01-31T09:00:00Z'), d('2026-03-01T00:00:00Z'));
    assert.equal(iso(p.desde), '2026-02-28'); assert.equal(iso(p.hasta), '2026-03-31');
  });
  test('antes de empezar devuelve el primer mes', () => {
    const p = v.periodoMensual(inicio, d('2026-01-01T00:00:00Z'));
    assert.equal(iso(p.desde), '2026-01-15');
  });
});

describe('estado por vigencia', () => {
  const fin = d('2026-12-01T00:00:00Z');
  test('sin fecha de fin nunca vence', () => {
    assert.deepEqual(v.estadoVigencia({ planFin: null }), { estado: 'SIN_FIN', diasRestantes: null, graciaHasta: null, puedeUsarAgente: true });
  });
  test('vigente → por vencer (7 días) → gracia (5 días, todo funciona) → vencido (se corta el agente)', () => {
    assert.equal(v.estadoVigencia({ planFin: fin, ahora: d('2026-11-01T00:00:00Z') }).estado, 'VIGENTE');
    assert.equal(v.estadoVigencia({ planFin: fin, ahora: d('2026-11-24T00:00:00Z') }).estado, 'POR_VENCER');
    const g = v.estadoVigencia({ planFin: fin, ahora: d('2026-12-03T00:00:00Z') });
    assert.equal(g.estado, 'GRACIA'); assert.equal(g.puedeUsarAgente, true);
    const x = v.estadoVigencia({ planFin: fin, ahora: d('2026-12-06T00:00:01Z') });
    assert.equal(x.estado, 'VENCIDO'); assert.equal(x.puedeUsarAgente, false);
  });
});

describe('avisos (una sola vez cada uno)', () => {
  const fin = d('2026-12-01T00:00:00Z');
  test('corte: 7 días antes, 2 días antes y el mismo día', () => {
    assert.deepEqual(v.avisosDeCorte({ planFin: fin, ahora: d('2026-11-10T00:00:00Z') }), []);
    const a7 = v.avisosDeCorte({ planFin: fin, ahora: d('2026-11-24T00:00:00Z') });
    assert.equal(a7[0].clave, 'corte7');
    assert.equal(v.avisosDeCorte({ planFin: fin, ahora: d('2026-11-24T10:00:00Z'), enviados: ['corte7'] }).length, 0, 'no se repite');
    assert.equal(v.avisosDeCorte({ planFin: fin, ahora: d('2026-11-29T00:00:00Z'), enviados: ['corte7'] })[0].clave, 'corte2');
    assert.equal(v.avisosDeCorte({ planFin: fin, ahora: d('2026-12-01T00:00:00Z'), enviados: ['corte7', 'corte2'] })[0].clave, 'corte0');
  });
  test('si el job no corrió, sale solo el más urgente (no tres avisos juntos) y marca los anteriores', () => {
    const r = v.avisosDeCorte({ planFin: fin, ahora: d('2026-11-30T12:00:00Z') });
    assert.equal(r.length, 1);
    assert.equal(r[0].clave, 'corte2');
    assert.deepEqual(r[0].marcar.sort(), ['corte2', 'corte7']);
  });
  test('sin fecha de fin o ya pasado el corte no hay avisos de corte', () => {
    assert.deepEqual(v.avisosDeCorte({ planFin: null }), []);
    assert.deepEqual(v.avisosDeCorte({ planFin: fin, ahora: d('2026-12-05T00:00:00Z') }), []);
  });
  test('uso de conversaciones: 80 % y 95 %, una sola vez', () => {
    assert.deepEqual(v.avisosDeUso({ usadas: 70, total: 100 }), []);
    assert.equal(v.avisosDeUso({ usadas: 80, total: 100 })[0].clave, 'uso80');
    assert.equal(v.avisosDeUso({ usadas: 85, total: 100, enviados: ['uso80'] }).length, 0);
    const r = v.avisosDeUso({ usadas: 96, total: 100, enviados: ['uso80'] });
    assert.equal(r[0].clave, 'uso95');
    assert.deepEqual(v.avisosDeUso({ usadas: 10, total: 0 }), [], 'sin tope no hay aviso');
  });
});
