// "Primeros pasos" de la pantalla de Inicio: lo minimo que un negocio nuevo
// tiene que hacer para que el agente empiece a vender. Funcion pura: recibe
// lo que ya esta hecho y devuelve la lista para mostrar.

/**
 * @param {{ productos:number, whatsappConectado:boolean, agenteActivo:boolean }} estado
 * @returns {{ pasos:Array<{clave:string,titulo:string,detalle:string,href:string,boton:string,hecho:boolean}>, hechos:number, total:number, completo:boolean, siguiente:object|null }}
 */
function pasosIniciales({ productos, whatsappConectado, agenteActivo }) {
  const pasos = [
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
