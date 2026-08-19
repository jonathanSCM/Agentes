// Arma el catalogo de demo en DOS NIVELES para poder probar el flujo completo
// del agente: rubro -> subtipo -> productos.
//
//   Pantalones -> Jeans, Joggers, Elegantes, Cotidianos
//   Poleras    -> Cuello redondo, Manga larga, Cuello V
//   Camisas    -> Casuales, Manga corta, De vestir
//
// "Zapatillas urbanas" NO se toca: es la categoria que ya estaba cargada con
// productos y fotos reales.
//
// Cada subtipo queda con 3 productos completos (descripcion, caracteristicas,
// atributos, variantes de talla y color con su propio stock) y una foto
// generada. Genero se marca OBLIGATORIO en cada subtipo: es lo que hace que
// el agente pregunte "¿para hombre o para mujer?" antes de mostrar tarjetas.
//
// Es IDEMPOTENTE: se puede correr varias veces. Las categorias que ya existen
// se reutilizan, y los productos de los subtipos que maneja este script se
// reemplazan (nunca toca productos de otras categorias).
//
// Ejecutar con:  node scripts/seed-catalogo-demo.js
//                npm run seed:catalogo
//
// Variables:
//   SEED_CATALOGO_SLUG  empresa destino (default: tienda-demo)
//   APP_BASE_URL        URL publica desde donde WhatsApp va a bajar las fotos.
//                       En produccion TIENE que ser la url real del sitio
//                       (ej. https://agentes.proshop.lat), si no el bot manda
//                       links que el telefono del cliente no puede abrir.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { prisma } = require('../lib/db');

const SLUG_EMPRESA = process.env.SEED_CATALOGO_SLUG || 'tienda-demo';
const BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

// Atributos de cada subtipo. Genero OBLIGATORIO a proposito (dispara la
// pregunta de hombre/mujer); talla y color son de variante, que es donde vive
// el stock real.
const ATRIBUTOS_SUBTIPO = [
  { nombre: 'Genero', nivel: 'OBLIGATORIO', esDeVariante: false, orden: 0 },
  { nombre: 'Talla', nivel: 'RECOMENDADO', esDeVariante: true, orden: 1 },
  { nombre: 'Color', nivel: 'RECOMENDADO', esDeVariante: true, orden: 2 },
  { nombre: 'Material', nivel: 'RECOMENDADO', esDeVariante: false, orden: 3 },
  { nombre: 'Corte', nivel: 'RECOMENDADO', esDeVariante: false, orden: 4 },
  { nombre: 'Marca', nivel: 'OPCIONAL', esDeVariante: false, orden: 5 },
];

// Paleta por subtipo, para que la foto generada no sea toda igual y se
// distinga de un vistazo en el chat.
//
// OJO con los nombres de subtipo: NO pueden contener la palabra del rubro.
// El lead resuelve la categoria por coincidencia de texto, asi que si existe
// "Pantalones elegantes", un cliente que escribe "pantalones" cae en ESE
// subtipo en vez del rubro, y el submenu no aparece. Paso de verdad.
// Tampoco pueden repetirse entre rubros: Categoria tiene @@unique([empresaId,
// nombre]) y el segundo se robaria la fila del primero.
const COLORES_FONDO = {
  Jeans: '#3b5a7a',
  Joggers: '#4a5240',
  Elegantes: '#2f3136',
  Cotidianos: '#7a6248',
  'Cuello redondo': '#4a6670',
  'Manga larga': '#5c4a6b',
  'Cuello V': '#3f4a5c',
  Casuales: '#3f6b5c',
  'Manga corta': '#5c6b3f',
  'De vestir': '#38414d',
};

/**
 * Arma las variantes talla x color. El stock vive aca (no en el producto):
 * asi lo espera el motor de busqueda, que considera "con stock" a un producto
 * cuyas variantes tengan stock aunque el padre tenga 0.
 */
function variantes(tallas, colores, stockBase = 4) {
  const out = [];
  for (const [i, talla] of tallas.entries()) {
    for (const [j, color] of colores.entries()) {
      out.push({
        atributos: { Talla: talla, Color: color },
        // Stock variado a proposito: un catalogo donde todo tiene el mismo
        // numero no sirve para probar los avisos de "ultima unidad".
        stock: Math.max(1, stockBase - ((i + j) % 3)),
      });
    }
  }
  return out;
}

const TALLAS_PANTALON = ['28', '30', '32', '34'];
const TALLAS_PRENDA = ['S', 'M', 'L', 'XL'];

// El catalogo. Un objeto por rubro, con sus subtipos y 3 productos cada uno.
const CATALOGO = [
  {
    rubro: 'Pantalones',
    subtipos: [
      {
        nombre: 'Jeans',
        productos: [
          {
            nombre: 'Jean Slim Azul Índigo', precio: 320, genero: 'Hombre',
            descripcion: 'Jean de corte slim en azul índigo, tela con elastano para que acompañe el movimiento sin perder la forma.',
            caracteristicas: ['Corte slim', 'Tela con elastano', 'Cinco bolsillos'],
            atributos: { Tipo: 'Jean slim', Corte: 'Slim', Marca: 'Denim Co', Material: 'Algodón 98% / elastano 2%', Estilo: 'Casual', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PANTALON, ['Azul índigo', 'Azul oscuro'], 5),
          },
          {
            nombre: 'Jean Recto Negro', precio: 340, genero: 'Unisex',
            descripcion: 'Jean de corte recto en negro sólido, un básico que combina con todo y no se desteñe al lavado.',
            caracteristicas: ['Corte recto', 'Color firme al lavado', 'Tiro medio'],
            atributos: { Tipo: 'Jean recto', Corte: 'Recto', Marca: 'Denim Co', Material: 'Algodón 100%', Estilo: 'Básico', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PANTALON, ['Negro', 'Gris grafito'], 4),
          },
          {
            nombre: 'Jean Mom Celeste', precio: 355, genero: 'Mujer',
            descripcion: 'Jean mom de tiro alto en celeste lavado, corte holgado en la pierna y ajustado en la cintura.',
            caracteristicas: ['Tiro alto', 'Corte mom', 'Lavado claro'],
            atributos: { Tipo: 'Jean mom', Corte: 'Holgado', Marca: 'Aura', Material: 'Algodón 100%', Estilo: 'Retro', Temporada: 'Primavera/Verano' },
            variantes: variantes(TALLAS_PANTALON, ['Celeste', 'Azul claro'], 3),
          },
        ],
      },
      {
        nombre: 'Joggers',
        productos: [
          {
            nombre: 'Jogger Cargo Beige', precio: 290, genero: 'Unisex',
            descripcion: 'Jogger cargo con bolsillos laterales y puños elásticos, en tela resistente para uso diario.',
            caracteristicas: ['Bolsillos cargo', 'Puños elásticos', 'Cordón ajustable'],
            atributos: { Tipo: 'Jogger cargo', Corte: 'Regular', Marca: 'Urbana', Material: 'Gabardina de algodón', Estilo: 'Urbano', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PRENDA, ['Beige', 'Verde militar'], 5),
          },
          {
            nombre: 'Jogger Deportivo Negro', precio: 250, genero: 'Hombre',
            descripcion: 'Jogger deportivo liviano de secado rápido, pensado para entrenar y salir sin cambiarse.',
            caracteristicas: ['Secado rápido', 'Bolsillo con cierre', 'Tela liviana'],
            atributos: { Tipo: 'Jogger deportivo', Corte: 'Ajustado', Marca: 'ActivFit', Material: 'Poliéster técnico', Estilo: 'Deportivo', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PRENDA, ['Negro', 'Azul marino'], 6),
          },
          {
            nombre: 'Jogger Felpa Gris', precio: 270, genero: 'Mujer',
            descripcion: 'Jogger de felpa perchada por dentro, abrigado y suave, con cintura elástica ancha.',
            caracteristicas: ['Interior perchado', 'Cintura ancha', 'Abrigado'],
            atributos: { Tipo: 'Jogger de felpa', Corte: 'Regular', Marca: 'Urbana', Material: 'Algodón con felpa', Estilo: 'Cómodo', Temporada: 'Otoño/Invierno' },
            variantes: variantes(TALLAS_PRENDA, ['Gris melange', 'Negro'], 4),
          },
        ],
      },
      {
        nombre: 'Elegantes',
        productos: [
          {
            nombre: 'Pantalón de Vestir Negro', precio: 420, genero: 'Hombre',
            descripcion: 'Pantalón de vestir en negro, caída recta y tela con leve stretch para no marcar arrugas.',
            caracteristicas: ['Caída recta', 'Tela anti-arrugas', 'Pretina reforzada'],
            atributos: { Tipo: 'Pantalón de vestir', Corte: 'Recto', Marca: 'Sartoria', Material: 'Poliviscosa con stretch', Estilo: 'Formal', Ocasion: 'Oficina, Evento' },
            variantes: variantes(TALLAS_PANTALON, ['Negro', 'Azul noche'], 4),
          },
          {
            nombre: 'Pantalón Sastre Gris', precio: 450, genero: 'Mujer',
            descripcion: 'Pantalón sastre de tiro alto en gris, pierna amplia y pinzas al frente para una caída limpia.',
            caracteristicas: ['Tiro alto', 'Pierna amplia', 'Pinzas al frente'],
            atributos: { Tipo: 'Pantalón sastre', Corte: 'Amplio', Marca: 'Sartoria', Material: 'Mezcla de lana fría', Estilo: 'Formal', Ocasion: 'Oficina, Evento' },
            variantes: variantes(TALLAS_PRENDA, ['Gris', 'Camel'], 3),
          },
          {
            nombre: 'Pantalón Pinzas Azul', precio: 430, genero: 'Unisex',
            descripcion: 'Pantalón con pinzas en azul marino, corte clásico que combina con cualquier prenda de arriba.',
            caracteristicas: ['Corte clásico', 'Con pinzas', 'Bolsillos ocultos'],
            atributos: { Tipo: 'Pantalón con pinzas', Corte: 'Clásico', Marca: 'Sartoria', Material: 'Gabardina fina', Estilo: 'Semi formal', Ocasion: 'Oficina' },
            variantes: variantes(TALLAS_PANTALON, ['Azul marino', 'Gris plomo'], 4),
          },
        ],
      },
      {
        nombre: 'Cotidianos',
        productos: [
          {
            nombre: 'Chino Caqui', precio: 280, genero: 'Hombre',
            descripcion: 'Pantalón chino en caqui, el intermedio perfecto entre lo casual y lo formal.',
            caracteristicas: ['Corte regular', 'Tela suave', 'Versátil'],
            atributos: { Tipo: 'Chino', Corte: 'Regular', Marca: 'Basicos BO', Material: 'Algodón con stretch', Estilo: 'Casual', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PANTALON, ['Caqui', 'Beige'], 5),
          },
          {
            nombre: 'Pantalón Cargo Verde', precio: 300, genero: 'Unisex',
            descripcion: 'Cargo de tela resistente con seis bolsillos, para quien necesita llevar todo encima.',
            caracteristicas: ['Seis bolsillos', 'Tela resistente', 'Refuerzo en rodillas'],
            atributos: { Tipo: 'Cargo', Corte: 'Holgado', Marca: 'Urbana', Material: 'Gabardina gruesa', Estilo: 'Utilitario', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PRENDA, ['Verde militar', 'Negro'], 4),
          },
          {
            nombre: 'Pantalón Lino Beige', precio: 310, genero: 'Mujer',
            descripcion: 'Pantalón de lino fresco en beige, liviano y con cintura elástica: ideal para el calor.',
            caracteristicas: ['Tela fresca', 'Cintura elástica', 'Liviano'],
            atributos: { Tipo: 'Pantalón de lino', Corte: 'Suelto', Marca: 'Aura', Material: 'Lino 70% / viscosa 30%', Estilo: 'Fresco', Temporada: 'Primavera/Verano' },
            variantes: variantes(TALLAS_PRENDA, ['Beige', 'Blanco crudo'], 3),
          },
        ],
      },
    ],
  },
  {
    rubro: 'Poleras',
    subtipos: [
      {
        nombre: 'Cuello redondo',
        productos: [
          {
            nombre: 'Polera Cuello Redondo Blanca', precio: 120, genero: 'Unisex',
            descripcion: 'Polera de cuello redondo en algodón peinado, el básico que no falla.',
            caracteristicas: ['Algodón peinado', 'Cuello reforzado', 'Corte clásico'],
            atributos: { Tipo: 'Polera cuello redondo', Corte: 'Clásico', Marca: 'Basicos BO', Material: 'Algodón peinado 100%', Estilo: 'Básico', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PRENDA, ['Blanco', 'Negro', 'Gris melange'], 6),
          },
          {
            nombre: 'Polera Oversize Negra', precio: 145, genero: 'Unisex',
            descripcion: 'Polera de corte oversize con hombros caídos, en algodón grueso que mantiene la forma.',
            caracteristicas: ['Corte oversize', 'Hombros caídos', 'Algodón grueso'],
            atributos: { Tipo: 'Polera oversize', Corte: 'Oversize', Marca: 'Urbana', Material: 'Algodón 100% 240g', Estilo: 'Urbano', Temporada: 'Todo el año' },
            variantes: variantes(TALLAS_PRENDA, ['Negro', 'Beige'], 5),
          },
          {
            nombre: 'Polera Cuello Redondo Rayada', precio: 135, genero: 'Mujer',
            descripcion: 'Polera de cuello redondo con rayas horizontales, corte entallado y manga corta.',
            caracteristicas: ['Rayas horizontales', 'Corte entallado', 'Manga corta'],
            atributos: { Tipo: 'Polera rayada', Corte: 'Entallado', Marca: 'Aura', Material: 'Algodón con modal', Estilo: 'Marinero', Temporada: 'Primavera/Verano' },
            variantes: variantes(TALLAS_PRENDA, ['Blanco/Azul', 'Blanco/Negro'], 4),
          },
        ],
      },
      {
        nombre: 'Manga larga',
        productos: [
          {
            nombre: 'Polera Manga Larga Gris', precio: 160, genero: 'Unisex',
            descripcion: 'Polera de manga larga en gris melange, tela media que sirve sola o como primera capa.',
            caracteristicas: ['Manga larga', 'Puños elásticos', 'Tela media'],
            atributos: { Tipo: 'Polera manga larga', Corte: 'Regular', Marca: 'Basicos BO', Material: 'Algodón 95% / elastano 5%', Estilo: 'Básico', Temporada: 'Otoño/Invierno' },
            variantes: variantes(TALLAS_PRENDA, ['Gris melange', 'Negro'], 5),
          },
          {
            nombre: 'Polera Manga Larga Cuello Alto', precio: 185, genero: 'Mujer',
            descripcion: 'Polera de manga larga con cuello alto, ajustada al cuerpo y en tela suave que no pica.',
            caracteristicas: ['Cuello alto', 'Ajustada', 'Tela suave'],
            atributos: { Tipo: 'Polera cuello alto', Corte: 'Ajustado', Marca: 'Aura', Material: 'Viscosa con elastano', Estilo: 'Minimalista', Temporada: 'Otoño/Invierno' },
            variantes: variantes(TALLAS_PRENDA, ['Negro', 'Vino', 'Crema'], 4),
          },
          {
            nombre: 'Polera Manga Larga Térmica', precio: 200, genero: 'Hombre',
            descripcion: 'Polera térmica de manga larga con interior afelpado, abriga sin abultar debajo de la ropa.',
            caracteristicas: ['Interior afelpado', 'Abriga sin abultar', 'Costuras planas'],
            atributos: { Tipo: 'Polera térmica', Corte: 'Ajustado', Marca: 'ActivFit', Material: 'Poliéster térmico', Estilo: 'Funcional', Temporada: 'Invierno' },
            variantes: variantes(TALLAS_PRENDA, ['Negro', 'Azul marino'], 5),
          },
        ],
      },
      {
        nombre: 'Cuello V',
        productos: [
          {
            nombre: 'Polera Elegante Cuello V', precio: 210, genero: 'Mujer',
            descripcion: 'Polera de cuello en V en tela con caída, se puede usar en la oficina sin parecer informal.',
            caracteristicas: ['Cuello en V', 'Tela con caída', 'Apta oficina'],
            atributos: { Tipo: 'Polera cuello V', Corte: 'Regular', Marca: 'Sartoria', Material: 'Modal con viscosa', Estilo: 'Elegante', Ocasion: 'Oficina, Salida' },
            variantes: variantes(TALLAS_PRENDA, ['Negro', 'Marfil'], 4),
          },
          {
            nombre: 'Polera Piqué Cuello Camisero', precio: 230, genero: 'Hombre',
            descripcion: 'Polera de piqué con cuello camisero y tres botones, un punto medio entre lo casual y lo formal.',
            caracteristicas: ['Tejido piqué', 'Cuello camisero', 'Tres botones'],
            atributos: { Tipo: 'Polera piqué', Corte: 'Regular', Marca: 'Sartoria', Material: 'Algodón piqué', Estilo: 'Semi formal', Ocasion: 'Oficina' },
            variantes: variantes(TALLAS_PRENDA, ['Azul marino', 'Blanco'], 4),
          },
          {
            nombre: 'Polera Elegante Satinada', precio: 260, genero: 'Mujer',
            descripcion: 'Polera de acabado satinado con brillo suave, pensada para salidas de noche.',
            caracteristicas: ['Acabado satinado', 'Brillo suave', 'Caída fluida'],
            atributos: { Tipo: 'Polera satinada', Corte: 'Suelto', Marca: 'Aura', Material: 'Poliéster satinado', Estilo: 'Nocturno', Ocasion: 'Evento, Salida' },
            variantes: variantes(TALLAS_PRENDA, ['Negro', 'Champagne'], 3),
          },
        ],
      },
    ],
  },
  {
    rubro: 'Camisas',
    subtipos: [
      {
        nombre: 'Casuales',
        productos: [
          {
            nombre: 'Camisa Manga Larga Blanca', precio: 290, genero: 'Hombre',
            descripcion: 'Camisa blanca de manga larga en popelina, corte slim y cuello con entretela firme.',
            caracteristicas: ['Corte slim', 'Cuello firme', 'Popelina'],
            atributos: { Tipo: 'Camisa popelina', Corte: 'Slim', Marca: 'Sartoria', Material: 'Algodón popelina', Estilo: 'Formal', Ocasion: 'Oficina, Evento' },
            variantes: variantes(TALLAS_PRENDA, ['Blanco', 'Celeste'], 5),
          },
          {
            nombre: 'Camisa Manga Larga a Cuadros', precio: 310, genero: 'Unisex',
            descripcion: 'Camisa de franela a cuadros, tela abrigada que se puede usar abierta como abrigo liviano.',
            caracteristicas: ['Franela abrigada', 'Estampado a cuadros', 'Sirve de sobrecamisa'],
            atributos: { Tipo: 'Camisa de franela', Corte: 'Regular', Marca: 'Urbana', Material: 'Franela de algodón', Estilo: 'Casual', Temporada: 'Otoño/Invierno' },
            variantes: variantes(TALLAS_PRENDA, ['Rojo/Negro', 'Verde/Gris'], 4),
          },
          {
            nombre: 'Camisa Manga Larga de Lino', precio: 330, genero: 'Mujer',
            descripcion: 'Camisa de lino de manga larga, holgada y fresca, con botones de nácar.',
            caracteristicas: ['Lino fresco', 'Corte holgado', 'Botones de nácar'],
            atributos: { Tipo: 'Camisa de lino', Corte: 'Holgado', Marca: 'Aura', Material: 'Lino 100%', Estilo: 'Fresco', Temporada: 'Primavera/Verano' },
            variantes: variantes(TALLAS_PRENDA, ['Blanco crudo', 'Arena'], 3),
          },
        ],
      },
      {
        nombre: 'Manga corta',
        productos: [
          {
            nombre: 'Camisa Manga Corta Celeste', precio: 250, genero: 'Hombre',
            descripcion: 'Camisa de manga corta en celeste liso, liviana y con corte recto para el calor.',
            caracteristicas: ['Manga corta', 'Tela liviana', 'Corte recto'],
            atributos: { Tipo: 'Camisa manga corta', Corte: 'Recto', Marca: 'Basicos BO', Material: 'Algodón liviano', Estilo: 'Casual', Temporada: 'Primavera/Verano' },
            variantes: variantes(TALLAS_PRENDA, ['Celeste', 'Blanco'], 5),
          },
          {
            nombre: 'Camisa Manga Corta Estampada', precio: 275, genero: 'Unisex',
            descripcion: 'Camisa de manga corta con estampado tropical, cuello abierto y caída suelta.',
            caracteristicas: ['Estampado tropical', 'Cuello abierto', 'Caída suelta'],
            atributos: { Tipo: 'Camisa estampada', Corte: 'Suelto', Marca: 'Urbana', Material: 'Viscosa', Estilo: 'Veraniego', Temporada: 'Verano' },
            variantes: variantes(TALLAS_PRENDA, ['Verde tropical', 'Azul palmeras'], 4),
          },
          {
            nombre: 'Camisa Manga Corta Oversize', precio: 265, genero: 'Mujer',
            descripcion: 'Camisa oversize de manga corta, se usa suelta o anudada en la cintura.',
            caracteristicas: ['Corte oversize', 'Uso versátil', 'Tela fresca'],
            atributos: { Tipo: 'Camisa oversize', Corte: 'Oversize', Marca: 'Aura', Material: 'Algodón fresco', Estilo: 'Urbano', Temporada: 'Verano' },
            variantes: variantes(TALLAS_PRENDA, ['Blanco', 'Celeste'], 4),
          },
        ],
      },
      {
        nombre: 'De vestir',
        productos: [
          {
            nombre: 'Camisa de Vestir Negra', precio: 360, genero: 'Hombre',
            descripcion: 'Camisa de vestir negra con puño doble, para eventos donde hay que ir formal.',
            caracteristicas: ['Puño doble', 'Cuello italiano', 'Acabado mate'],
            atributos: { Tipo: 'Camisa de vestir', Corte: 'Slim', Marca: 'Sartoria', Material: 'Algodón egipcio', Estilo: 'Formal', Ocasion: 'Evento' },
            variantes: variantes(TALLAS_PRENDA, ['Negro', 'Blanco'], 4),
          },
          {
            nombre: 'Camisa de Vestir Rayada', precio: 340, genero: 'Unisex',
            descripcion: 'Camisa de vestir con raya fina, discreta y con caída limpia bajo el saco.',
            caracteristicas: ['Raya fina', 'Caída limpia', 'Anti-arrugas'],
            atributos: { Tipo: 'Camisa rayada', Corte: 'Regular', Marca: 'Sartoria', Material: 'Algodón con poliéster', Estilo: 'Formal', Ocasion: 'Oficina' },
            variantes: variantes(TALLAS_PRENDA, ['Blanco/Azul', 'Blanco/Gris'], 4),
          },
          {
            nombre: 'Camisa de Vestir Entallada', precio: 380, genero: 'Mujer',
            descripcion: 'Camisa entallada de vestir con pinzas en la espalda, marca la silueta sin apretar.',
            caracteristicas: ['Pinzas en la espalda', 'Entallada', 'Cuello clásico'],
            atributos: { Tipo: 'Camisa entallada', Corte: 'Entallado', Marca: 'Sartoria', Material: 'Algodón con stretch', Estilo: 'Formal', Ocasion: 'Oficina, Evento' },
            variantes: variantes(TALLAS_PRENDA, ['Blanco', 'Negro'], 4),
          },
        ],
      },
    ],
  },
];

function slug(texto) {
  return String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escaparXml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Genera la foto del producto: un PNG con el nombre y el subtipo escritos.
 * No pretende ser una foto real - es un placeholder legible para poder probar
 * el flujo completo (el cliente recibe una imagen, no un texto suelto) sin
 * depender de un banco de imagenes externo.
 */
async function generarFoto(producto, subtipo, rubro) {
  const archivo = `catalogo-${slug(subtipo)}-${slug(producto.nombre)}.png`;
  const destino = path.join(UPLOADS_DIR, archivo);
  const fondo = COLORES_FONDO[subtipo] || '#3a3f47';
  const colorVariante = (producto.variantes[0] && producto.variantes[0].atributos.Color) || '';

  // El nombre se parte en lineas para que entre en la imagen.
  const palabras = producto.nombre.split(' ');
  const lineas = [];
  let actual = '';
  for (const p of palabras) {
    if ((actual + ' ' + p).trim().length > 18) { lineas.push(actual.trim()); actual = p; } else { actual += ' ' + p; }
  }
  if (actual.trim()) lineas.push(actual.trim());

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
  <rect width="800" height="800" fill="${fondo}"/>
  <rect x="40" y="40" width="720" height="720" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="3"/>
  <text x="400" y="150" font-family="Arial, sans-serif" font-size="30" fill="rgba(255,255,255,0.75)" text-anchor="middle">${escaparXml(rubro.toUpperCase())}</text>
  <text x="400" y="200" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="rgba(255,255,255,0.9)" text-anchor="middle">${escaparXml(subtipo)}</text>
  ${lineas.map((l, i) => `<text x="400" y="${380 + i * 62}" font-family="Arial, sans-serif" font-size="52" font-weight="bold" fill="#ffffff" text-anchor="middle">${escaparXml(l)}</text>`).join('\n  ')}
  <text x="400" y="660" font-family="Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.85)" text-anchor="middle">${escaparXml(colorVariante)}</text>
  <text x="400" y="715" font-family="Arial, sans-serif" font-size="30" fill="rgba(255,255,255,0.7)" text-anchor="middle">Bs ${producto.precio}.00</text>
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(destino);
  return `${BASE_URL}/uploads/${archivo}`;
}

/** Crea la categoria si no existe; si existe la reutiliza tal cual. */
async function asegurarCategoria(empresaId, nombre, padreId, orden) {
  const existente = await prisma.categoria.findFirst({ where: { empresaId, nombre } });
  if (existente) {
    // Se fuerza el padre que corresponde, incluido el caso "sin padre". Ojo
    // con esto: si la condicion solo mira `padreId` (truthy), una categoria
    // que ya existia como SUBcategoria nunca se promueve a rubro, y termina
    // apareciendo en el menu en dos lugares a la vez. Paso de verdad con
    // "Pantalones", que ya colgaba de "Prendas de abajo".
    const deseado = padreId || null;
    if ((existente.padreId || null) !== deseado) {
      await prisma.categoria.update({ where: { id: existente.id }, data: { padreId: deseado } });
      console.log(`     (se reubico "${existente.nombre}": ahora ${deseado ? 'cuelga del rubro' : 'es rubro de primer nivel'})`);
    }
    return { categoria: existente, creada: false };
  }
  const creada = await prisma.categoria.create({ data: { empresaId, nombre, padreId: padreId || null, orden } });
  return { categoria: creada, creada: true };
}

/** Deja los atributos del subtipo como los necesita el flujo del agente. */
async function asegurarAtributos(categoriaId) {
  const actuales = await prisma.categoriaAtributo.findMany({ where: { categoriaId } });
  const porNombre = new Map(actuales.map((a) => [a.nombre, a]));
  for (const attr of ATRIBUTOS_SUBTIPO) {
    const existente = porNombre.get(attr.nombre);
    if (existente) {
      if (existente.nivel !== attr.nivel || existente.esDeVariante !== attr.esDeVariante) {
        await prisma.categoriaAtributo.update({ where: { id: existente.id }, data: { nivel: attr.nivel, esDeVariante: attr.esDeVariante } });
      }
      continue;
    }
    await prisma.categoriaAtributo.create({ data: { categoriaId, ...attr } });
  }
}

async function main() {
  // Categoria tiene @@unique([empresaId, nombre]): dos subtipos con el mismo
  // nombre NO pueden convivir, aunque cuelguen de rubros distintos. Sin esta
  // guarda el script "funcionaba" pero el segundo se robaba la categoria del
  // primero (paso de verdad: "Manga larga" de Poleras y de Camisas quedaron
  // en la misma fila, y Poleras perdio su subtipo).
  const nombres = CATALOGO.flatMap((g) => [g.rubro, ...g.subtipos.map((s) => s.nombre)]);
  const repetidos = nombres.filter((n, i) => nombres.indexOf(n) !== i);
  if (repetidos.length) {
    console.error(`Hay nombres de categoria repetidos: ${[...new Set(repetidos)].join(', ')}.`);
    console.error('Los nombres son unicos por empresa: renombralos antes de seguir.');
    process.exit(1);
  }

  const empresa = await prisma.empresa.findUnique({ where: { slug: SLUG_EMPRESA } });
  if (!empresa) {
    console.error(`No existe una empresa con slug "${SLUG_EMPRESA}". Nada que hacer.`);
    process.exit(1);
  }
  console.log(`Empresa: ${empresa.nombre} (id ${empresa.id})`);
  console.log(`URL base de las fotos: ${BASE_URL}`);
  if (/localhost|127\.0\.0\.1/.test(BASE_URL)) {
    console.log('  AVISO: es una URL local. WhatsApp no va a poder bajar estas fotos.');
    console.log('  En produccion corre el script con APP_BASE_URL=https://tu-dominio');
  }

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  let ordenRubro = 10;
  let totalProductos = 0;
  let totalFotos = 0;

  for (const grupo of CATALOGO) {
    const { categoria: rubro, creada } = await asegurarCategoria(empresa.id, grupo.rubro, null, ordenRubro);
    ordenRubro += 1;
    console.log(`\n${creada ? 'Creado' : 'Ya existia'} el rubro "${rubro.nombre}" (id ${rubro.id})`);

    for (const [i, sub] of grupo.subtipos.entries()) {
      const { categoria, creada: subCreada } = await asegurarCategoria(empresa.id, sub.nombre, rubro.id, i + 1);
      await asegurarAtributos(categoria.id);
      console.log(`  ${subCreada ? '+' : '='} ${rubro.nombre} > ${categoria.nombre} (id ${categoria.id})`);

      // Idempotencia: se borran solo los productos de ESTE subtipo antes de
      // recrearlos, para no acumular duplicados al correr el script de nuevo.
      const borrados = await prisma.producto.deleteMany({ where: { empresaId: empresa.id, categoriaId: categoria.id } });
      if (borrados.count) console.log(`     (se reemplazan ${borrados.count} productos anteriores)`);

      for (const p of sub.productos) {
        const url = await generarFoto(p, sub.nombre, grupo.rubro);
        totalFotos += 1;
        await prisma.producto.create({
          data: {
            empresaId: empresa.id,
            categoriaId: categoria.id,
            nombre: p.nombre,
            descripcion: p.descripcion,
            precio: p.precio,
            // El stock real vive en las variantes (asi lo espera el motor).
            stock: 0,
            activo: true,
            fotos: [url],
            caracteristicas: p.caracteristicas,
            atributos: { ...p.atributos, Genero: p.genero },
            variantes: { create: p.variantes.map((v) => ({ atributos: v.atributos, stock: v.stock, activa: true })) },
          },
        });
        totalProductos += 1;
        console.log(`     ✓ ${p.nombre} — ${p.variantes.length} variantes, genero ${p.genero}`);
      }
    }
  }

  console.log(`\nListo: ${totalProductos} productos y ${totalFotos} fotos en ${CATALOGO.length} rubros.`);
  console.log('"Zapatillas urbanas" no se toco.');
}

main()
  .catch((err) => {
    console.error('Error en el seeder de catalogo:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
