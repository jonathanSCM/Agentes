// "Primeros pasos" de la pantalla de Inicio: lo minimo que un negocio nuevo
// tiene que hacer para que el agente empiece a vender. Funcion pura: recibe
// lo que ya esta hecho y devuelve la lista para mostrar.

/**
 * @param {{ productos:number, whatsappConectado:boolean, agenteActivo:boolean }} estado
 * @returns {{ pasos:Array<{clave:string,titulo:string,detalle:string,href:string,boton:string,hecho:boolean}>, hechos:number, total:number, completo:boolean, siguiente:object|null }}
 */
function pasosIniciales({ productos, whatsappConectado, agenteActivo, modelo = 'PRODUCTOS', servicios = 0, recursos = 0, horarios = 0 }) {
  const conectar = {
    clave: 'whatsapp',
    titulo: 'Conectá tu WhatsApp',
    detalle: 'Así tus clientes te escriben al número de siempre y el agente les responde.',
    href: '/panel/whatsapp',
    boton: 'Conectar WhatsApp',
    hecho: Boolean(whatsappConectado),
  };
  const activar = {
    clave: 'agente',
    titulo: 'Activá tu agente',
    detalle: 'Mientras esté en borrador no contesta a nadie. Cuando todo esté listo, ponelo en activo.',
    href: '/panel/configuracion',
    boton: 'Activar agente',
    hecho: Boolean(agenteActivo),
  };
  const pasos = modelo === 'CITAS' ? [
    { clave: 'servicios', titulo: 'Cargá lo que agendás', detalle: 'Los servicios con su duración y precio: es lo que tus clientes van a poder reservar. Si querés, empezá con los datos de ejemplo de tu rubro.', href: '/panel/atencion/servicios', boton: 'Cargar servicios', hecho: servicios > 0 },
    { clave: 'equipo', titulo: 'Armá tu equipo', detalle: 'Quién (o qué sala o mesa) atiende. Con uno alcanza para empezar.', href: '/panel/atencion/equipo', boton: 'Armar equipo', hecho: recursos > 0 },
    { clave: 'horarios', titulo: 'Definí tus horarios', detalle: 'Los días y horas en que atendés. El agente solo ofrece horarios libres de verdad.', href: '/panel/atencion/horarios', boton: 'Definir horarios', hecho: horarios > 0 },
    conectar,
    activar,
  ] : [
    {
      clave: 'producto',
      titulo: 'Agregá tu primer producto',
      detalle: 'Es lo que tu agente va a ofrecer. Solo necesitás nombre, precio y una foto.',
      href: '/panel/productos/nuevo',
      boton: 'Agregar producto',
      hecho: productos > 0,
    },
    {
      clave: 'whatsapp',
      titulo: 'Conectá tu WhatsApp',
      detalle: 'Así tus clientes te escriben al número de siempre y el agente les responde.',
      href: '/panel/whatsapp',
      boton: 'Conectar WhatsApp',
      hecho: Boolean(whatsappConectado),
    },
    {
      clave: 'agente',
      titulo: 'Activá tu agente',
      detalle: 'Mientras esté en borrador no contesta a nadie. Cuando todo esté listo, ponelo en activo.',
      href: '/panel/configuracion',
      boton: 'Activar agente',
      hecho: Boolean(agenteActivo),
    },
  ];
  const hechos = pasos.filter((p) => p.hecho).length;
  return {
    pasos,
    hechos,
    total: pasos.length,
    completo: hechos === pasos.length,
    siguiente: pasos.find((p) => !p.hecho) || null,
  };
}

module.exports = { pasosIniciales };
