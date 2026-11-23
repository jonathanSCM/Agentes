// Sistema de estilos: una sola fuente de colores (tokens.css), fuentes propias, sin degradados decorativos y con contraste suficiente.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const leer = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8');
const tokens = leer('public', 'css', 'tokens.css');

// Extrae las variables de un bloque (claro: el primer :root; oscuro: [data-theme="dark"]).
function variables(bloque) { const o = {}; for (const m of bloque.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) o[m[1]] = m[2].trim(); return o; }
const claro = variables(tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('@media (prefers-color-scheme: dark)')));
const oscuro = variables(tokens.slice(tokens.indexOf(':root[data-theme="dark"]'), tokens.indexOf('/* ---------- Equivalencias')));

function luminancia(hex) {
  const h = hex.replace('#', ''); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contraste = (a, b) => { const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const HOJAS = fs.readdirSync(path.join(RAIZ, 'public', 'css')).filter((f) => f.endsWith('.css') && !['tokens.css', 'fonts.css', 'reservar.css'].includes(f));

describe('tokens', () => {
  const necesarios = ['paper', 'paper-deep', 'paper-raised', 'paper-raised-2', 'ink', 'ink-soft', 'ink-faint', 'line', 'line-strong', 'rust', 'rust-dark', 'accent', 'moss', 'moss-ink', 'blue', 'danger', 'warn', 'ring', 'on-fill', 'on-moss', 'chat-bg', 'bubble-mine', 'chip-tint'];
  test('el tema claro y el oscuro definen todos los tokens', () => {
    for (const k of necesarios) { assert.ok(claro[k], `claro: falta --${k}`); assert.ok(oscuro[k], `oscuro: falta --${k}`); }
  });
  test('la paleta es la aprobada (morado de marca y menta)', () => {
    assert.equal(claro.rust, '#6d28d9'); assert.equal(oscuro.rust, '#8b5cf6'); assert.equal(oscuro.moss, '#2fe3a6'); assert.equal(claro.paper, '#ffffff'); assert.equal(oscuro.paper, '#0f0e17');
  });
  test('el contraste de los pares de texto cumple 4,5:1 en los dos temas', () => {
    const pares = [['ink', 'paper'], ['ink-soft', 'paper'], ['ink-faint', 'paper'], ['ink-faint', 'paper-raised-2'], ['on-fill', 'rust'], ['rust', 'paper'], ['on-moss', 'moss'], ['moss-ink', 'paper'], ['danger', 'paper'], ['warn', 'paper'], ['blue', 'paper'], ['ink', 'chip-tint'], ['ink', 'bubble-mine'], ['ink', 'chat-bg']];
    for (const [t, f] of pares) {
      for (const [nombre, tema] of [['claro', claro], ['oscuro', oscuro]]) {
        const r = contraste(tema[t], tema[f]);
        assert.ok(r >= 4.5, `${nombre}: --${t} sobre --${f} da ${r.toFixed(2)}:1 (mínimo 4,5)`);
      }
    }
  });
  test('las equivalencias de las variables viejas apuntan a los tokens', () => {
    assert.match(tokens, /--primary:\s*var\(--rust\)/); assert.match(tokens, /--surface:\s*var\(--paper-raised\)/); assert.match(tokens, /--text:\s*var\(--ink\)/);
  });
});

describe('hojas de estilo', () => {
  test('ninguna escribe colores de vidrio ni degradados decorativos', () => {
    for (const f of HOJAS) {
      const css = leer('public', 'css', f).replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(css, /backdrop-filter/, `${f}: sin desenfoque de vidrio`);
      assert.doesNotMatch(css, /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/, `${f}: usar color-mix con --ink, no blanco translúcido`);
      for (const m of css.matchAll(/(linear|radial)-gradient\(([^;]*)/g)) assert.match(m[0], /var\(--pct/, `${f}: degradado decorativo no permitido: ${m[0].slice(0, 60)}`);
    }
  });
  test('no quedan los morados oscuros de antes escritos a mano', () => {
    for (const f of HOJAS) assert.doesNotMatch(leer('public', 'css', f), /#(190f28|241634|110a1d|241246|231536|1b0f30|1d1129|1e1230)\b/i, f);
  });
});

describe('cabecera común', () => {
  const head = leer('views', 'partials', 'head.ejs');
  test('carga los tokens y las fuentes propias, sin Google Fonts', () => {
    assert.match(head, /\/css\/tokens\.css/); assert.match(head, /\/css\/fonts\.css/); assert.doesNotMatch(head, /fonts\.googleapis|fonts\.gstatic/);
  });
  test('aplica el tema guardado antes de pintar (sin parpadeo)', () => {
    assert.match(head, /proshop-tema/); assert.match(head, /data-theme/);
  });
  test('los archivos de fuente que usa fonts.css existen', () => {
    const fuentes = leer('public', 'css', 'fonts.css');
    const rutas = [...fuentes.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(rutas.length >= 6);
    for (const r of rutas) assert.ok(fs.existsSync(path.join(RAIZ, 'public', 'fonts', r)), `falta public/fonts/${r}`);
  });
});
