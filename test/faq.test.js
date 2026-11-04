// Preguntas frecuentes y horario que carga el negocio (lib/services/faq.js) y su uso sin IA.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../lib/db');
const { generarRespuesta } = require('../lib/services/agente');
const { coincideFaq, formatearHorario, faqDesdeFormulario, horarioDesdeFormulario } = require('../lib/services/faq');
const { respuestaPorReglas } = require('../lib/services/modoSinIA');

const FAQ = [
  { pregunta: '¿Hacen envíos a otras ciudades?', respuesta: 'Sí, enviamos por flota a todo el país.' },
  { pregunta: '¿Tienen garantía?', respuesta: '30 días por falla de fábrica.' },
  { pregunta: '¿Se pueden cambiar las zapatillas si no me quedan?', respuesta: 'Sí, dentro de 7 días con la etiqueta.' },
];

describe('coincideFaq', () => {
  const r = (t) => (coincideFaq(t, FAQ) || {}).respuesta || null;
  test('encuentra la pregunta aunque la redacte distinto', () => {
    assert.match(r('hacen envios a otras ciudades?'), /flota/);
    assert.match(r('¿Envían a otra ciudad?'), /flota/);
    assert.match(r('tienen garantia'), /30 días/);
    assert.match(r('si no me quedan las zapatillas las puedo cambiar'), /7 días/);
  });
  test('no contesta lo que no es una pregunta cargada', () => {
    assert.equal(r('a qué hora abren'), null);
    assert.equal(r('quiero zapatillas negras talla 42'), null);
    assert.equal(r('hola'), null);
  });
  test('una sola palabra en común NO alcanza', () => assert.equal(r('tienen zapatillas'), null));
  test('un párrafo largo no es una FAQ', () => assert.equal(r(`hacen envios a otras ciudades ${'blabla '.repeat(40)}`), null));
  test('si dos preguntas empatan con respuestas distintas, no contesta', () => {
    const dudosa = [{ pregunta: 'envío rápido', respuesta: 'A' }, { pregunta: 'envío rápido', respuesta: 'B' }];
    assert.equal(coincideFaq('envio rapido', dudosa), null);
  });
  test('sin preguntas cargadas devuelve null', () => assert.equal(coincideFaq('tienen garantia', []), null));
});

describe('formatearHorario', () => {
  const dia = (n, abre, cierra) => ({ dia: n, abre, cierra, cerrado: false });
  const cerrado = (n) => ({ dia: n, abre: '', cierra: '', cerrado: true });
  test('agrupa días seguidos con el mismo horario', () => {
    const h = { dias: [cerrado(0), dia(1, '09:00', '18:00'), dia(2, '09:00', '18:00'), dia(3, '09:00', '18:00'), dia(4, '09:00', '18:00'), dia(5, '09:00', '18:00'), dia(6, '09:00', '13:00')] };
    assert.equal(formatearHorario(h), 'Lun a Vie 09:00 a 18:00 · Sáb 09:00 a 13:00 · Dom cerrado');
  });
  test('todo cerrado o vacío = sin horario (el bot no inventa)', () => {
    assert.equal(formatearHorario(null), null);
    assert.equal(formatearHorario({ dias: [0, 1, 2, 3, 4, 5, 6].map(cerrado) }), null);
  });
  test('texto libre', () => assert.equal(formatearHorario({ texto: 'Todos los días de 10 a 20' }), 'Todos los días de 10 a 20'));
});

describe('formularios', () => {
  test('faqDesdeFormulario descarta filas incompletas y recorta', () => {
    const f = faqDesdeFormulario({ faqPregunta: ['  ¿Garantía?  ', '', 'sin respuesta'], faqRespuesta: ['30 días', 'x', ''] });
    assert.deepEqual(f, [{ pregunta: '¿Garantía?', respuesta: '30 días' }]);
  });
  test('faqDesdeFormulario acepta un solo valor (no arreglo)', () => {
    assert.equal(faqDesdeFormulario({ faqPregunta: '¿Algo?', faqRespuesta: 'Sí' }).length, 1);
  });
  test('horarioDesdeFormulario: solo los días marcados con horas válidas', () => {
    const h = horarioDesdeFormulario({ horaAbierto1: '1', horaAbre1: '09:00', horaCierra1: '18:00', horaAbierto2: '1', horaAbre2: '20:00', horaCierra2: '08:00' });
    assert.equal(h.dias.find((d) => d.dia === 1).cerrado, false);
    assert.equal(h.dias.find((d) => d.dia === 2).cerrado, true, 'la hora de cierre es anterior a la de apertura');
    assert.equal(horarioDesdeFormulario({}), null);
  });
});

describe('respuestaPorReglas con la configuración del negocio', () => {
  test('FAQ del negocio primero; horario real; sin horario deriva', () => {
    const horario = { dias: [{ dia: 1, abre: '09:00', cierra: '18:00', cerrado: false }] };
    assert.match(respuestaPorReglas('tienen garantia?', { config: { faq: FAQ } }), /30 días/);
    assert.match(respuestaPorReglas('a que hora abren', { config: { horarioAtencion: horario } }), /Lun 09:00 a 18:00/);
    assert.match(respuestaPorReglas('a que hora abren', { config: {} }), /asesor/);
  });
  test('sinFaq: cuando el cliente nombra un producto, la FAQ no interviene', () => {
    assert.equal(respuestaPorReglas('tienen garantia?', { config: { faq: FAQ }, sinFaq: true }), null);
  });
});

describe('generarRespuesta: FAQ sin IA', () => {
  let empresaId; let agenteId; let conv; const TEL = '000-test-faq';
  const ia = () => { let n = 0; return { llamar: async () => { n += 1; return { content: 'IA', tool_calls: [] }; }, llamadas: () => n }; };
  const escribe = async (texto, fake) => {
    await prisma.mensaje.create({ data: { conversacionId: conv.id, rol: 'CLIENTE', contenido: texto } });
    return generarRespuesta(agenteId, TEL, [{ rol: 'AGENTE', contenido: 'Hola' }], texto, conv.id, { llamarInyectado: fake.llamar });
  };

  before(async () => {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.deleteMany({ where: { slug: 'test-faq' } });
    const empresa = await prisma.empresa.create({
      data: {
        nombre: 'Tienda FAQ', slug: 'test-faq', moneda: 'BOB',
        agentes: { create: [{ nombre: 'V', estado: 'ACTIVO', config: { create: { aceptaEfectivo: true, preguntasIniciales: [], faq: FAQ, horarioAtencion: { dias: [{ dia: 1, abre: '09:00', cierra: '18:00', cerrado: false }] } } } }] },
      },
      include: { agentes: true },
    });
    empresaId = empresa.id;
    agenteId = empresa.agentes[0].id;
    conv = await prisma.conversacion.create({ data: { agenteId, telefonoCliente: TEL, ultimoMensajeAt: new Date() } });
    const cat = await prisma.categoria.create({ data: { empresaId, nombre: 'Zapatillas' } });
    await prisma.producto.create({ data: { empresaId, categoriaId: cat.id, nombre: 'Zapatilla Runner', precio: 300, stock: 9, fotos: [] } });
    await prisma.clienteFinal.create({ data: { empresaId, telefono: TEL, categoriaId: cat.id, categoriaInteres: 'Zapatillas', contexto: { tarjetasCategoriaMostradas: [cat.id] } } });
  });
  after(async () => {
    await prisma.clienteFinal.deleteMany({ where: { telefono: TEL } });
    await prisma.empresa.delete({ where: { id: empresaId } }).catch(() => {});
  });

  test('una pregunta cargada por el negocio se contesta sin llamar a la IA (también sin el flujo de botones)', async () => {
    const fake = ia();
    const r = await escribe('¿hacen envíos a otras ciudades?', fake);
    assert.match(r.respuesta, /flota/);
    assert.equal(fake.llamadas(), 0);
    assert.equal(r.botones, undefined, 'sin el flujo de botones no se mandan botones con ID');
  });

  test('el horario cargado se contesta sin IA', async () => {
    const fake = ia();
    const r = await escribe('a qué hora abren?', fake);
    assert.match(r.respuesta, /Lun 09:00 a 18:00/);
    assert.equal(fake.llamadas(), 0);
  });

  test('si nombra un producto, la FAQ no se mete: va por el camino normal', async () => {
    const fake = ia();
    const r = await escribe('¿tienen garantía la Zapatilla Runner?', fake);
    assert.doesNotMatch(r.respuesta, /30 días por falla/, 'la FAQ genérica no tapa una pregunta sobre un producto');
  });
});
