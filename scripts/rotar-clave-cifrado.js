// Cambia la clave con la que estan cifrados los tokens de WhatsApp.
//
// POR QUE HACE FALTA UN SCRIPT: APP_ENCRYPTION_KEY no es una contraseña que se
// verifica, es la llave con la que se cifro el dato. Cambiar la variable a
// secas no "actualiza" nada: simplemente deja de poder leerse lo que ya estaba
// guardado, y todos los agentes de WhatsApp quedan desconectados. Hay que
// descifrar con la vieja y volver a cifrar con la nueva, que es lo que hace
// esto.
//
// El unico dato cifrado en todo el sistema es ConexionWhatsApp.tokenCifrado
// (ver lib/crypto.js y lib/services/whatsapp.js).
//
// USO:
//   1) Simulacion (no escribe nada, es lo que conviene correr primero):
//        APP_ENCRYPTION_KEY_ANTERIOR="la-vieja" APP_ENCRYPTION_KEY="la-nueva" \
//          node scripts/rotar-clave-cifrado.js
//   2) Aplicar de verdad:
//        ... node scripts/rotar-clave-cifrado.js --aplicar
//   3) Recien DESPUES de que diga "listo", cambiar APP_ENCRYPTION_KEY en el
//      servidor por la nueva y redesplegar.
//
// Es seguro correrlo dos veces: los tokens que ya quedaron con la clave nueva
// se detectan y se saltean.

require('dotenv').config();
const crypto = require('crypto');
const { prisma } = require('../lib/db');

const CLAVE_VIEJA = process.env.APP_ENCRYPTION_KEY_ANTERIOR;
const CLAVE_NUEVA = process.env.APP_ENCRYPTION_KEY;
const APLICAR = process.argv.includes('--aplicar');

if (!CLAVE_VIEJA || !CLAVE_NUEVA) {
  console.error('\nFaltan variables. Se necesitan las dos:');
  console.error('  APP_ENCRYPTION_KEY_ANTERIOR = la clave con la que estan cifrados hoy');
  console.error('  APP_ENCRYPTION_KEY          = la clave nueva a la que se quiere pasar\n');
  process.exit(1);
}
if (CLAVE_VIEJA === CLAVE_NUEVA) {
  console.error('\nLas dos claves son iguales: no hay nada que rotar.\n');
  process.exit(1);
}

// Misma derivacion que lib/crypto.js, pero con la clave como parametro.
const derivar = (secreto) => crypto.createHash('sha256').update(String(secreto)).digest();

function descifrarCon(secreto, cifrado) {
  try {
    const [ivB64, tagB64, datosB64] = String(cifrado).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivar(secreto), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(datosB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (_) {
    return null; // no se pudo con esa clave
  }
}

function cifrarCon(secreto, texto) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivar(secreto), iv);
  const enc = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

(async () => {
  const conexiones = await prisma.conexionWhatsApp.findMany({
    where: { tokenCifrado: { not: null } },
    select: { id: true, tokenCifrado: true, numeroVisible: true, estado: true },
  });

  console.log(`\n${APLICAR ? 'APLICANDO' : 'SIMULACION (no se escribe nada)'} - ${conexiones.length} conexion(es) con token guardado\n`);

  let rotadas = 0;
  let yaEstaban = 0;
  const problemas = [];

  for (const c of conexiones) {
    const etiqueta = `conexion #${c.id}${c.numeroVisible ? ` (${c.numeroVisible})` : ''}`;

    if (descifrarCon(CLAVE_NUEVA, c.tokenCifrado) !== null) {
      console.log(`  = ${etiqueta}: ya estaba con la clave nueva, se saltea`);
      yaEstaban += 1;
      continue;
    }

    const token = descifrarCon(CLAVE_VIEJA, c.tokenCifrado);
    if (token === null) {
      console.log(`  ! ${etiqueta}: NO se pudo descifrar con la clave anterior`);
      problemas.push(etiqueta);
      continue;
    }

    if (APLICAR) {
      await prisma.conexionWhatsApp.update({
        where: { id: c.id },
        data: { tokenCifrado: cifrarCon(CLAVE_NUEVA, token) },
      });
    }
    console.log(`  ${APLICAR ? '+' : '~'} ${etiqueta}: ${APLICAR ? 're-cifrada' : 'se re-cifraria'}`);
    rotadas += 1;
  }

  console.log(`\nResumen: ${rotadas} ${APLICAR ? 're-cifradas' : 'a re-cifrar'}, ${yaEstaban} ya estaban, ${problemas.length} con problemas`);

  if (problemas.length) {
    console.log('\nATENCION: estas no se pudieron descifrar con la clave anterior:');
    for (const p of problemas) console.log(`  - ${p}`);
    console.log('Puede ser que la clave anterior no sea la correcta. Verificala ANTES de');
    console.log('cambiar la variable en el servidor: esos agentes van a quedar desconectados');
    console.log('y hay que volver a pegar su token desde el panel de Meta.');
  }

  if (!APLICAR && rotadas) {
    console.log('\nEsto fue una simulacion. Para aplicarlo de verdad, volve a correrlo con --aplicar');
  }
  if (APLICAR && rotadas && !problemas.length) {
    console.log('\nListo. AHORA si: cambia APP_ENCRYPTION_KEY en el servidor por la nueva y redesplega.');
  }

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nError durante la rotacion:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
