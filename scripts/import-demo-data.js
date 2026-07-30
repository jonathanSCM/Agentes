const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { PrismaClient } = require('../lib/generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');

const demoPath = path.join(__dirname, '..', 'demo-data.json');
if (!fs.existsSync(demoPath)) {
  throw new Error('No se encontró demo-data.json en la raíz del proyecto. Ejecuta primero scripts/export-demo-data.js o copia el archivo.');
}

const demo = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('La variable de entorno DATABASE_URL no está definida.');
}

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

function seedCatalog() {
  console.log('1) Cargando planes y paquetes base...');
  childProcess.execSync('npm run seed', { stdio: 'inherit' });
}

async function upsertEmpresa(empresaData) {
  return client.empresa.upsert({
    where: { slug: empresaData.slug },
    create: {
      id: empresaData.id,
      nombre: empresaData.nombre,
      slug: empresaData.slug,
      marca: empresaData.marca,
      createdAt: new Date(empresaData.createdAt),
      updatedAt: new Date(empresaData.updatedAt),
    },
    update: {
      nombre: empresaData.nombre,
      marca: empresaData.marca,
      updatedAt: new Date(empresaData.updatedAt),
    },
  });
}

function normalizePackageKey(cantidad, precioUsd) {
  if (cantidad == null || precioUsd == null) return null;
  return `${cantidad}|${precioUsd}`;
}

async function buildPackageMap() {
  const paquetes = await client.paquete.findMany();
  const map = new Map();
  paquetes.forEach((paquete) => {
    map.set(normalizePackageKey(paquete.cantidad, paquete.precioUsd.toString()), paquete.id);
  });
  return map;
}

async function resetSequence(table) {
  await client.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true);`);
}

async function main() {
  seedCatalog();

  console.log('2) Importando empresa demo...');
  const empresa = await upsertEmpresa(demo);
  const empresaId = empresa.id;

  console.log('3) Importando usuarios...');
  for (const usuario of demo.usuarios || []) {
    await client.usuario.upsert({
      where: { email: usuario.email },
      create: {
        id: usuario.id,
        empresaId,
        email: usuario.email,
        passwordHash: usuario.passwordHash,
        nombre: usuario.nombre,
        rol: usuario.rol,
        createdAt: new Date(usuario.createdAt),
      },
      update: {
        empresaId,
        passwordHash: usuario.passwordHash,
        nombre: usuario.nombre,
        rol: usuario.rol,
      },
    });
  }

  console.log('4) Importando agente y configuracion...');
  for (const agente of demo.agentes || []) {
    const agenteUpsert = await client.agente.upsert({
      where: { id: agente.id },
      create: {
        id: agente.id,
        empresaId,
        nombre: agente.nombre,
        numeroWhatsapp: agente.numeroWhatsapp,
        estado: agente.estado,
        createdAt: new Date(agente.createdAt),
        updatedAt: new Date(agente.updatedAt),
      },
      update: {
        nombre: agente.nombre,
        numeroWhatsapp: agente.numeroWhatsapp,
        estado: agente.estado,
        updatedAt: new Date(agente.updatedAt),
      },
    });

    if (agente.config) {
      await client.agenteConfig.upsert({
        where: { agenteId: agenteUpsert.id },
        create: {
          id: agente.config.id,
          agenteId: agenteUpsert.id,
          mensajeBienvenida: agente.config.mensajeBienvenida,
          tono: agente.config.tono,
          instrucciones: agente.config.instrucciones,
          derivarAHumano: agente.config.derivarAHumano,
          updatedAt: new Date(agente.config.updatedAt),
        },
        update: {
          mensajeBienvenida: agente.config.mensajeBienvenida,
          tono: agente.config.tono,
          instrucciones: agente.config.instrucciones,
          derivarAHumano: agente.config.derivarAHumano,
          updatedAt: new Date(agente.config.updatedAt),
        },
      });
    }
  }

  console.log('5) Importando clientes finales...');
  for (const cliente of demo.clientes || []) {
    await client.clienteFinal.upsert({
      where: { empresaId_telefono: { empresaId, telefono: cliente.telefono } },
      create: {
        id: cliente.id,
        empresaId,
        nombre: cliente.nombre,
        telefono: cliente.telefono,
        createdAt: new Date(cliente.createdAt),
        categoriaInteres: cliente.categoriaInteres,
        presupuesto: cliente.presupuesto,
        cantidad: cliente.cantidad,
        direccionEntrega: cliente.direccionEntrega,
        ubicacionLat: cliente.ubicacionLat,
        ubicacionLng: cliente.ubicacionLng,
        observaciones: cliente.observaciones,
        nivelInteres: cliente.nivelInteres,
        estadoLead: cliente.estadoLead,
        contexto: cliente.contexto,
        updatedAt: new Date(cliente.updatedAt),
      },
      update: {
        nombre: cliente.nombre,
        categoriaInteres: cliente.categoriaInteres,
        presupuesto: cliente.presupuesto,
        cantidad: cliente.cantidad,
        direccionEntrega: cliente.direccionEntrega,
        ubicacionLat: cliente.ubicacionLat,
        ubicacionLng: cliente.ubicacionLng,
        observaciones: cliente.observaciones,
        nivelInteres: cliente.nivelInteres,
        estadoLead: cliente.estadoLead,
        contexto: cliente.contexto,
      },
    });
  }

  console.log('6) Importando productos...');
  for (const producto of demo.productos || []) {
    await client.producto.upsert({
      where: { id: producto.id },
      create: {
        id: producto.id,
        empresaId,
        nombre: producto.nombre,
        categoria: producto.categoria,
        descripcion: producto.descripcion,
        precio: producto.precio,
        stock: producto.stock,
        activo: producto.activo,
        fotos: producto.fotos,
        caracteristicas: producto.caracteristicas,
        createdAt: new Date(producto.createdAt),
      },
      update: {
        nombre: producto.nombre,
        categoria: producto.categoria,
        descripcion: producto.descripcion,
        precio: producto.precio,
        stock: producto.stock,
        activo: producto.activo,
        fotos: producto.fotos,
        caracteristicas: producto.caracteristicas,
      },
    });
  }

  console.log('7) Importando suscripcion...');
  if (demo.suscripcion) {
    await client.suscripcion.upsert({
      where: { empresaId: empresaId },
      create: {
        id: demo.suscripcion.id,
        empresaId,
        planId: demo.suscripcion.planId,
        estado: demo.suscripcion.estado,
        periodoInicio: new Date(demo.suscripcion.periodoInicio),
        periodoFin: new Date(demo.suscripcion.periodoFin),
        refClientePago: demo.suscripcion.refClientePago,
        refSuscripPago: demo.suscripcion.refSuscripPago,
        createdAt: new Date(demo.suscripcion.createdAt),
        updatedAt: new Date(demo.suscripcion.updatedAt),
      },
      update: {
        planId: demo.suscripcion.planId,
        estado: demo.suscripcion.estado,
        periodoInicio: new Date(demo.suscripcion.periodoInicio),
        periodoFin: new Date(demo.suscripcion.periodoFin),
        refClientePago: demo.suscripcion.refClientePago,
        refSuscripPago: demo.suscripcion.refSuscripPago,
        updatedAt: new Date(demo.suscripcion.updatedAt),
      },
    });
  }

  console.log('8) Importando pedidos y items...');
  for (const pedido of demo.pedidos || []) {
    await client.pedido.upsert({
      where: { id: pedido.id },
      create: {
        id: pedido.id,
        empresaId,
        clienteId: pedido.clienteId,
        total: pedido.total,
        direccionEntrega: pedido.direccionEntrega,
        entregaLat: pedido.entregaLat,
        entregaLng: pedido.entregaLng,
        notas: pedido.notas,
        estado: pedido.estado,
        createdAt: new Date(pedido.createdAt),
      },
      update: {
        clienteId: pedido.clienteId,
        total: pedido.total,
        direccionEntrega: pedido.direccionEntrega,
        entregaLat: pedido.entregaLat,
        entregaLng: pedido.entregaLng,
        notas: pedido.notas,
        estado: pedido.estado,
      },
    });
    for (const item of pedido.items || []) {
      await client.pedidoItem.upsert({
        where: { id: item.id },
        create: {
          id: item.id,
          pedidoId: pedido.id,
          productoId: item.productoId,
          nombre: item.nombre,
          precio: item.precio,
          cantidad: item.cantidad,
        },
        update: {
          pedidoId: pedido.id,
          productoId: item.productoId,
          nombre: item.nombre,
          precio: item.precio,
          cantidad: item.cantidad,
        },
      });
    }
  }

  const packageMap = new Map();
  if (demo.comprasPaquete) {
    for (const compra of demo.comprasPaquete) {
      if (compra.paqueteId == null) continue;
      const key = normalizePackageKey(compra.cantidad, compra.precioUsd);
      packageMap.set(compra.paqueteId, key);
    }
  }

  const resolvedPackageIds = new Map();
  if (packageMap.size > 0) {
    const paquetes = await client.paquete.findMany();
    for (const [oldPaqueteId, key] of packageMap.entries()) {
      const paqueteRow = paquetes.find((p) => normalizePackageKey(p.cantidad, p.precioUsd.toString()) === key);
      if (paqueteRow) {
        resolvedPackageIds.set(oldPaqueteId, paqueteRow.id);
      }
    }
  }

  console.log('9) Importando pagos...');
  for (const pago of demo.pagos || []) {
    const paqueteId = pago.paqueteId ? resolvedPackageIds.get(pago.paqueteId) ?? pago.paqueteId : null;
    await client.pago.upsert({
      where: { id: pago.id },
      create: {
        id: pago.id,
        empresaId,
        tipo: pago.tipo,
        monto: pago.monto,
        moneda: pago.moneda,
        estado: pago.estado,
        referencia: pago.referencia,
        paqueteId,
        compraPaqueteId: pago.compraPaqueteId,
        fecha: new Date(pago.fecha),
      },
      update: {
        tipo: pago.tipo,
        monto: pago.monto,
        moneda: pago.moneda,
        estado: pago.estado,
        referencia: pago.referencia,
        paqueteId,
        compraPaqueteId: pago.compraPaqueteId,
      },
    });
  }

  console.log('10) Importando compras de paquete...');
  for (const compra of demo.comprasPaquete || []) {
    await client.compraPaquete.upsert({
      where: { id: compra.id },
      create: {
        id: compra.id,
        empresaId,
        paqueteId: compra.paqueteId,
        cantidad: compra.cantidad,
        consumidas: compra.consumidas,
        precioUsd: compra.precioUsd,
        fechaCompra: new Date(compra.fechaCompra),
        fechaRenovacion: new Date(compra.fechaRenovacion),
        estado: compra.estado,
        nota: compra.nota,
      },
      update: {
        paqueteId: compra.paqueteId,
        cantidad: compra.cantidad,
        consumidas: compra.consumidas,
        precioUsd: compra.precioUsd,
        fechaCompra: new Date(compra.fechaCompra),
        fechaRenovacion: new Date(compra.fechaRenovacion),
        estado: compra.estado,
        nota: compra.nota,
      },
    });
  }

  console.log('11) Importando notificaciones...');
  for (const notificacion of demo.notificaciones || []) {
    await client.notificacion.upsert({
      where: { id: notificacion.id },
      create: {
        id: notificacion.id,
        empresaId,
        titulo: notificacion.titulo,
        mensaje: notificacion.mensaje,
        tipo: notificacion.tipo,
        conBotones: notificacion.conBotones,
        leida: notificacion.leida,
        createdAt: new Date(notificacion.createdAt),
      },
      update: {
        titulo: notificacion.titulo,
        mensaje: notificacion.mensaje,
        tipo: notificacion.tipo,
        conBotones: notificacion.conBotones,
        leida: notificacion.leida,
      },
    });
  }

  console.log('12) Importando conversaciones y mensajes...');
  for (const conversacion of demo.agentes.flatMap((ag) => ag.conversaciones || [])) {
    await client.conversacion.upsert({
      where: { id: conversacion.id },
      create: {
        id: conversacion.id,
        agenteId: conversacion.agenteId,
        telefonoCliente: conversacion.telefonoCliente,
        origen: conversacion.origen,
        ultimoMensajeAt: new Date(conversacion.ultimoMensajeAt),
        createdAt: new Date(conversacion.createdAt),
      },
      update: {
        agenteId: conversacion.agenteId,
        telefonoCliente: conversacion.telefonoCliente,
        origen: conversacion.origen,
        ultimoMensajeAt: new Date(conversacion.ultimoMensajeAt),
      },
    });
    for (const mensaje of conversacion.mensajes || []) {
      await client.mensaje.upsert({
        where: { id: mensaje.id },
        create: {
          id: mensaje.id,
          conversacionId: conversacion.id,
          rol: mensaje.rol,
          contenido: mensaje.contenido,
          createdAt: new Date(mensaje.createdAt),
        },
        update: {
          conversacionId: conversacion.id,
          rol: mensaje.rol,
          contenido: mensaje.contenido,
        },
      });
    }
  }

  console.log('13) Ajustando secuencias de IDs...');
  const tables = [
    'empresas',
    'usuarios',
    'agentes',
    'agente_config',
    'conexiones_whatsapp',
    'conversaciones',
    'mensajes',
    'productos',
    'clientes_finales',
    'pedidos',
    'pedido_items',
    'pagos',
    'compras_paquete',
    'notificaciones',
    'suscripciones',
  ];
  for (const table of tables) {
    await resetSequence(table);
  }

  console.log('Importacion completa.');
}

main()
  .catch((error) => {
    console.error('Importación fallida:', error.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await client.$disconnect();
  });
