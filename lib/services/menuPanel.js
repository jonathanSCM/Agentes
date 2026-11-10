'use strict';
// lib/services/menuPanel.js
//
// El MENU LATERAL del panel del cliente, como datos (se prueba solo; la vista solo lo dibuja).
// Decide que ve cada rol segun el modelo de negocio (productos o citas) y los modulos del plan
// (docs/11): lo que el plan no incluye aparece BLOQUEADO con candado, no escondido.

const ICONOS = {
  'inicio': '<path d="M3 11.5 12 4l9 7.5M5 10v9h5v-5h4v5h5v-9"/>',
  'conversaciones': '<path d="M4 4h16v11H8l-4 4V4Z"/>',
  'pedidos': '<path d="M4 5h16l-1.5 9h-13L4 5Z"/><path d="M4 5 3 2H1"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
  'clientes': '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 19c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16 13.7c2.5.3 4.3 2.1 4.8 4.8"/>',
  'calendario': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h2M12 14h2M16 14h2M8 17h2M12 17h2"/>',
  'mi-agenda': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h2M12 14h2M16 14h2M8 17h2M12 17h2"/>',
  'citas': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  'servicios': '<path d="M4 7h16M4 12h16M4 17h10"/>',
  'atencion-equipo': '<circle cx="12" cy="8" r="3.2"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  'horarios': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  'productos': '<path d="M3 8 12 4l9 4-9 4-9-4Z"/><path d="M3 8v8l9 4 9-4V8M12 12v8"/>',
  'categorias': '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  'inventario': '<path d="M4 19V10M10 19V5M16 19v-7M20 19V3"/>',
  'agente': '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V3M9 12h.01M15 12h.01"/>',
  'whatsapp': '<path d="M6.3 17.7 3 21l3.4-1a8.9 8.9 0 1 0-3.3-3.4Z"/><path d="M8.5 8.7c.2-.5.5-.5.8-.5h.6c.2 0 .4 0 .6.4.2.5.7 1.7.7 1.8.1.2.1.3 0 .5-.4.6-.9.9-.6 1.4.7 1.2 1.4 1.7 2.5 2.2.2.1.3.1.5-.1.2-.2.7-.8.9-1.1.2-.2.3-.2.6-.1.2.1 1.5.7 1.8.9.2.1.3.1.4.3 0 .2 0 1-.4 1.5-.4.5-1.3.9-2 .9-.6 0-2-.2-3.8-1.6-1.8-1.5-2.9-3.4-3-3.6-.2-.2-.9-1.2-.9-2.3 0-1.1.5-1.6.7-1.8Z"/>',
  'mensajes': '<path d="M4 5h16v11H9l-5 4V5Z"/>',
  'sin-respuesta': '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5M12 16.5v.1"/>',
  'configuracion': '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.4 7.4 0 0 0 0-3l1.8-1.4-2-3.4-2.1.6a7.4 7.4 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.3a7.4 7.4 0 0 0-2.6 1.5l-2.1-.6-2 3.4L4.6 10.5a7.4 7.4 0 0 0 0 3L2.8 15l2 3.4 2.1-.6c.8.7 1.6 1.2 2.6 1.5l.5 2.3h4l.5-2.3a7.4 7.4 0 0 0 2.6-1.5l2.1.6 2-3.4-1.8-1.5Z"/>',
  'auditoria': '<path d="M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  'resumen': '<path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/>',
  'reportes': '<path d="M4 19h16M6 16V9m6 7V5m6 11v-4"/>',
  'inteligencia': '<path d="M12 2 3 7v6c0 5 4 8.5 9 9 5-.5 9-4 9-9V7l-9-5Z"/><path d="M9 12l2 2 4-4"/>',
  'equipo': '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 19c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16 13.7c2.5.3 4.3 2.1 4.8 4.8"/><path d="M12 5v6M9 8h6" stroke-width="1.4"/>',
  'plan': '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.3 6.8 19.1l1-5.8L3.5 9.2l5.9-.9L12 3Z"/>',
  'consumo': '<path d="M3 10a2 2 0 0 1 0-4h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4Z"/><path d="M10 6v12" stroke-dasharray="2 2"/>',
  'paquetes': '<path d="M12 5v14M5 12h14"/>',
  'compras': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
  'pos': '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M16 11v4"/>',
  'pos-pedidos': '<path d="M5 4h14l-1 11H6L5 4Z"/><path d="M9 20h6M12 15v5"/>',
  'caja': '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M3 11h18M7 15h3"/><path d="M8 7V5h8v2"/>',
  'ventas': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
  'proveedores': '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
  'compras-proveedor': '<path d="M5 8h14l-1.2 11H6.2L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  'cuentas': '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  'candado': '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};

// Iconos de las SECCIONES del menu (cada grupo es un modulo del producto: Agente, Punto de venta, Panel comercial...).
const ICONOS_GRUPO = {
  agente: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V3M9 12h.01M15 12h.01"/>',
  pos: '<path d="M4 5h16l-1.5 9h-13L4 5Z"/><path d="M4 5 3 2H1"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
  catalogo: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  panel: '<path d="M4 19h16M6 16V9m6 7V5m6 11v-4"/>',
  negocio: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  cuenta: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
  mostrador: '<path d="M4 5h16l-1.5 9h-13L4 5Z"/><path d="M4 5 3 2H1"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
};

const ROLES = { OWNER: 'Dueño', ADMIN: 'Administrador', STAFF: 'Colaborador', CAJERO: 'Cajero', PROFESIONAL: 'Profesional', PROSHOP_ADMIN: 'Proshop' };
const etiquetaRol = (rol) => ROLES[rol] || 'Colaborador';

/**
 * @param {{ esCitas?: boolean, rol?: string, modulos?: string[], vocab?: object, badges?: object }} ctx
 * @returns {Array<{ titulo: string|null, items: Array<{ clave, href, etiqueta, icono, modulo: string|null, bloqueado: boolean, badge: number }> }>}
 */
function construirMenu({ esCitas = false, rol = 'OWNER', modulos = ['AGENTE'], vocab = {}, badges = {} } = {}) {
  const esDueno = rol === 'OWNER';
  const esAdmin = rol === 'OWNER' || rol === 'ADMIN';
  const tiene = (m) => !m || modulos.includes(m);

  const item = (clave, href, etiqueta, { modulo = null, badge = 0 } = {}) => ({
    clave, href, etiqueta, icono: ICONOS[clave] || '', modulo, bloqueado: !tiene(modulo), badge: Number(badge) || 0,
  });

  // El profesional solo ve SU agenda (calendario de sus citas).
  if (rol === 'PROFESIONAL') {
    return [{ clave: 'mi-agenda', icono: ICONOS_GRUPO.negocio, titulo: 'Mi agenda', items: [item('mi-agenda', '/panel/mi-agenda', 'Mi calendario')] }];
  }

  // El cajero solo ve el mostrador (el servidor ademas le bloquea todo lo demas).
  if (rol === 'CAJERO') {
    if (esCitas) return [{ clave: 'mostrador', icono: ICONOS_GRUPO.mostrador, titulo: 'Mostrador', items: [item('cuentas', '/panel/cuentas', 'Cuentas', { modulo: 'POS' }), item('caja', '/panel/caja', 'Caja', { modulo: 'POS' }), item('ventas', '/panel/ventas', 'Ventas', { modulo: 'POS' })] }];
    return [{ clave: 'mostrador', icono: ICONOS_GRUPO.mostrador, titulo: 'Mostrador', items: [item('pos', '/panel/pos', 'Punto de venta', { modulo: 'POS' }), item('pos-pedidos', '/panel/pos/pedidos', 'Pedidos por cobrar', { modulo: 'POS' }), item('caja', '/panel/caja', 'Caja', { modulo: 'POS' }), item('ventas', '/panel/ventas', 'Ventas', { modulo: 'POS' })] }];
  }

  const grupos = [
    { titulo: null, items: [item('inicio', '/panel', 'Inicio')] },
    {
      clave: 'agente', icono: ICONOS_GRUPO.agente, titulo: 'Agente',
      items: [
        item('conversaciones', '/panel/conversaciones', 'Conversaciones', { badge: badges.conversaciones }),
        ...(esCitas ? [] : [item('pedidos', '/panel/pedidos', 'Pedidos', { badge: badges.pedidos })]),
        item('clientes', '/panel/clientes', 'Clientes'),
        ...(esAdmin ? [item('agente', '/panel/agente', 'Agente IA')] : []),
        item('mensajes', '/panel/mensajes', 'Mensajes'),
        item('sin-respuesta', '/panel/sin-respuesta', 'Sin respuesta'),
        item('whatsapp', '/panel/whatsapp', 'WhatsApp'),
      ],
    },
  ];

  if (!esCitas && esAdmin) {
    grupos.push({
      clave: 'pos', icono: ICONOS_GRUPO.pos, titulo: 'Punto de venta',
      items: [
        item('pos', '/panel/pos', 'Punto de venta', { modulo: 'POS' }),
        item('pos-pedidos', '/panel/pos/pedidos', 'Pedidos por cobrar', { modulo: 'POS' }),
        item('caja', '/panel/caja', 'Caja', { modulo: 'POS' }),
        item('ventas', '/panel/ventas', 'Ventas', { modulo: 'POS' }),
      ],
    });
  }

  if (esCitas) {
    grupos.push({
      clave: 'negocio', icono: ICONOS_GRUPO.negocio, titulo: 'Mi negocio',
      items: [
        item('citas', '/panel/citas', 'Agenda'),
        item('calendario', '/panel/citas/calendario', 'Calendario'),
        item('servicios', '/panel/atencion/servicios', 'Servicios'),
        item('atencion-equipo', '/panel/atencion/equipo', vocab.profesionales || 'Equipo'),
        item('horarios', '/panel/atencion/horarios', 'Horarios'),
      ],
    });
    // Cobros: la cuenta de cada cliente (servicio de la cita + extras) se cobra de una vez, con caja y ventas.
    if (esAdmin || rol === 'STAFF') {
      grupos.push({
        clave: 'cobros', icono: ICONOS_GRUPO.pos, titulo: 'Cobros',
        items: [
          item('cuentas', '/panel/cuentas', 'Cuentas', { modulo: 'POS' }),
          item('caja', '/panel/caja', 'Caja', { modulo: 'POS' }),
          item('ventas', '/panel/ventas', 'Ventas', { modulo: 'POS' }),
        ],
      });
    }
    // Productos para vender en las cuentas (shampoo, bebidas, accesorios…): catalogo, stock y reposicion.
    if (esAdmin) {
      grupos.push({
        clave: 'catalogo', icono: ICONOS_GRUPO.catalogo, titulo: 'Productos',
        items: [
          item('productos', '/panel/productos', 'Productos'),
          item('inventario', '/panel/inventario', 'Inventario'),
        ],
      });
    }
  } else {
    grupos.push({
      clave: 'catalogo', icono: ICONOS_GRUPO.catalogo, titulo: 'Catálogo',
      items: [
        item('productos', '/panel/productos', 'Productos'),
        item('categorias', '/panel/categorias', 'Categorías'),
        item('inventario', '/panel/inventario', 'Inventario'),
      ],
    });
    grupos.push({
      clave: 'panel', icono: ICONOS_GRUPO.panel, titulo: 'Panel comercial',
      items: [
        ...(esAdmin ? [item('resumen', '/panel/resumen', 'Resumen', { modulo: 'PANEL' })] : []),
        item('reportes', '/panel/reportes', 'Reportes', { modulo: 'PANEL' }),
        item('inteligencia', '/panel/inteligencia', 'Inteligencia', { modulo: 'PANEL' }),
        ...(esAdmin ? [item('auditoria', '/panel/auditoria', 'Auditoría', { modulo: 'PANEL' })] : []),
      ],
    });
  }

  const cuenta = [];
  if (esAdmin) cuenta.push(item('configuracion', '/panel/configuracion', 'Configuración'));
  if (esDueno) {
    cuenta.push(
      item('equipo', '/panel/equipo', 'Mi equipo'),
      item('plan', '/panel/plan', 'Cambiar de plan'),
      item('consumo', '/panel/consumo', 'Mi plan y consumo'),
      item('paquetes', '/panel/paquetes', 'Pedir conversaciones'),
      item('compras', '/panel/compras', 'Mis compras'),
    );
  }
  if (cuenta.length) grupos.push({ clave: 'cuenta', icono: ICONOS_GRUPO.cuenta, titulo: 'Mi cuenta', items: cuenta });
  return grupos;
}

/** Iniciales para el avatar del usuario ("Ana Pérez" -> "AP"). */
function iniciales(nombre) {
  const p = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

module.exports = { ICONOS, ICONOS_GRUPO, construirMenu, etiquetaRol, iniciales };
