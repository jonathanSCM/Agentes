'use strict';
// scripts/demo-panel.js  (SOLO DESARROLLO)
//
// Crea (o reinicia) dos clientes de prueba locales para revisar el panel a ojo:
//   - "Demo Agente": plan Agente (modulos bloqueados con candado en el menu)
//   - "Demo Total":  plan Acceso total (todos los modulos)
// Cada uno con un usuario dueño, unas categorias, productos y una conversacion de ejemplo.
// La contraseña se genera al azar y se guarda en el archivo que se pase como argumento (no en el repo).
//
//   node scripts/demo-panel.js "C:\ruta\fuera\del\proyecto\demo-panel.txt"

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');

if (process.env.NODE_ENV === 'production') { console.error('No se corre en produccion.'); process.exit(1); }

const { prisma } = require('../lib/db');
const { registrarCliente } = require('../lib/services/auth');
const P = require('../lib/services/planesCliente');

const destino = process.argv[2];
if (!destino) { console.error('Falta el archivo donde guardar las credenciales (fuera del proyecto).'); process.exit(1); }

const CLIENTES = [
  { empresa: 'Demo Agente', email: 'demo-agente@proshop.test', plan: 'AGENTE', meses: 3 },
  { empresa: 'Demo Total', email: 'demo-total@proshop.test', plan: 'ACCESO_TOTAL', meses: null },
];

async function reiniciar(email) {
  const u = await prisma.usuario.findUnique({ where: { email } });
  if (u && u.empresaId) await prisma.empresa.delete({ where: { id: u.empresaId } }).catch(() => {});
  await prisma.usuario.deleteMany({ where: { email } });
}

async function datosDeEjemplo(empresaId) {
  const calzado = await prisma.categoria.create({ data: { empresaId, nombre: 'Calzado', orden: 1 } });
  const ropa = await prisma.categoria.create({ data: { empresaId, nombre: 'Ropa', orden: 2 } });
  const productos = [
    ['Zapatilla Runner', calzado.id, 300, 12], ['Zapatilla Urbana', calzado.id, 250, 8],
    ['Polera Rayada', ropa.id, 135, 20], ['Camisa de Vestir', ropa.id, 380, 6],
  ];
  const creados = [];
  for (const [nombre, categoriaId, precio, stock] of productos) {
    creados.push(await prisma.producto.create({ data: { empresaId, categoriaId, nombre, precio, stock, fotos: [] } }));
  }
  const agente = await prisma.agente.findFirst({ where: { empresaId } });
  if (agente) {
    const nombres = ['Ana Pérez', 'Beto Rojas', 'Carla Méndez'];
    for (let i = 0; i < nombres.length; i += 1) {
      const tel = `59170000${100 + i}`;
      await prisma.clienteFinal.create({ data: { empresaId, telefono: tel, nombre: nombres[i] } }).catch(() => {});
      // 0: leida · 1: la atiende una persona · 2: pidio un asesor y tiene mensajes sin leer
      const conv = await prisma.conversacion.create({
        data: { agenteId: agente.id, telefonoCliente: tel, modo: i === 1 ? 'HUMANO' : 'IA', leidoAt: i === 0 ? new Date(Date.now() + 60000) : null, ultimoMensajeAt: new Date(Date.now() - i * 3600000) },
      });
      const base = Date.now() - (i + 1) * 3600000;
      await prisma.mensaje.createMany({
        data: [
          { conversacionId: conv.id, rol: 'CLIENTE', contenido: 'Hola, ¿qué zapatillas tienen?', createdAt: new Date(base) },
          { conversacionId: conv.id, rol: 'AGENTE', contenido: 'Esto es lo que tenemos, ¿cuál te interesa?', createdAt: new Date(base + 1000) },
          ...(i === 2 ? [
            { conversacionId: conv.id, rol: 'CLIENTE', contenido: 'Quiero hablar con un asesor por favor', createdAt: new Date(base + 60000) },
            { conversacionId: conv.id, rol: 'CLIENTE', contenido: '¿Hacen envíos a Montero?', createdAt: new Date(base + 90000) },
          ] : []),
        ],
      });
      if (i === 2) await prisma.clienteFinal.updateMany({ where: { empresaId, telefono: tel }, data: { estadoLead: 'DERIVADO_A_ASESOR', categoriaInteres: 'Calzado', presupuesto: 'Bs 300' } });
      if (i === 0) {
        const cf = await prisma.clienteFinal.findFirst({ where: { empresaId, telefono: tel } });
        if (cf) await prisma.pedido.create({ data: { empresaId, clienteId: cf.id, total: 300, estado: 'ENTREGADO' } });
      }
    }
  }
  return creados;
}

(async () => {
  const lineas = [];
  for (const c of CLIENTES) {
    await reiniciar(c.email);
    const password = crypto.randomBytes(9).toString('base64url');
    const { empresa } = await registrarCliente({ empresa: c.empresa, nombre: 'Admin Demo', email: c.email, password });
    const plan = await prisma.plan.findUnique({ where: { codigo: c.plan } });
    await P.asignarPlan(empresa.id, plan.id, c.meses ? { meses: c.meses } : {});
    await datosDeEjemplo(empresa.id);
    lineas.push(`${c.empresa}: ${c.email} / ${password}`);
  }
  fs.writeFileSync(destino, lineas.join('\n') + '\n');
  console.log(`Listo. Credenciales guardadas en ${destino}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
