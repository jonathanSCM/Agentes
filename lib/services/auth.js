// Autenticacion de usuarios cliente.
// Las contrasenas se guardan con scrypt (modulo crypto de Node, sin dependencias
// externas). Formato almacenado:  scrypt$<salt hex>$<hash hex>

const crypto = require('crypto');
const { prisma } = require('../db');

const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, almacenado) {
  try {
    const [algo, saltHex, hashHex] = String(almacenado).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const hash = Buffer.from(hashHex, 'hex');
    const prueba = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), hash.length);
    return crypto.timingSafeEqual(hash, prueba);
  } catch (_) {
    return false;
  }
}

function slugify(texto) {
  const base = String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base || 'empresa';
}

/**
 * Registra una empresa nueva con su usuario dueno y su suscripcion inicial.
 * Todo ocurre en una transaccion: o se crea completo, o no se crea nada.
 */
async function registrarCliente({ empresa, nombre, email, password, planId }) {
  const correo = String(email).trim().toLowerCase();

  const yaExiste = await prisma.usuario.findUnique({ where: { email: correo } });
  if (yaExiste) {
    const err = new Error('Ya existe una cuenta con ese correo.');
    err.codigo = 'EMAIL_DUPLICADO';
    throw err;
  }

  const plan = await prisma.plan.findUnique({ where: { id: Number(planId) } });
  if (!plan || !plan.activo) {
    const err = new Error('El plan seleccionado no está disponible.');
    err.codigo = 'PLAN_INVALIDO';
    throw err;
  }

  // Slug unico para la empresa
  let slug = slugify(empresa);
  if (await prisma.empresa.findUnique({ where: { slug } })) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  // Los planes de pago entran como PRUEBA hasta confirmar el primer pago.
  const esGratis = Number(plan.mensualidadBs) === 0;
  const periodoFin = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    const nuevaEmpresa = await tx.empresa.create({
      data: {
        nombre: String(empresa).trim().slice(0, 120),
        slug,
        suscripcion: {
          create: {
            planId: plan.id,
            estado: esGratis ? 'ACTIVA' : 'PRUEBA',
            periodoFin,
          },
        },
        agentes: { create: { nombre: `Agente de ${String(empresa).trim().slice(0, 60)}` } },
      },
    });

    const usuario = await tx.usuario.create({
      data: {
        empresaId: nuevaEmpresa.id,
        email: correo,
        passwordHash: hashPassword(password),
        nombre: String(nombre).trim().slice(0, 120),
        rol: 'OWNER',
      },
    });

    // Si el plan tiene costo, queda un pago pendiente (implementacion + 1er mes)
    if (!esGratis) {
      await tx.pago.create({
        data: {
          empresaId: nuevaEmpresa.id,
          tipo: 'PRIMER_PAGO',
          monto: plan.primerPagoBs,
          moneda: 'BOB',
          estado: 'PENDIENTE',
          referencia: 'Registro desde el sitio',
        },
      });
    }

    return { empresa: nuevaEmpresa, usuario };
  });
}

/**
 * Valida credenciales y devuelve el usuario con su empresa, o null.
 */
async function autenticar(email, password) {
  const usuario = await prisma.usuario.findUnique({
    where: { email: String(email).trim().toLowerCase() },
    include: { empresa: true },
  });
  if (!usuario || !usuario.empresaId) return null;
  if (!verifyPassword(password, usuario.passwordHash)) return null;
  return usuario;
}

module.exports = { hashPassword, verifyPassword, registrarCliente, autenticar, slugify };
