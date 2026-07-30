// Modulo de acceso a datos de leads (mensajes del formulario de contacto).
// Almacenamiento simple en archivo JSON. Facil de migrar a una base de datos luego.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]');
}

function readLeads() {
  ensureStore();
  try {
    const raw = fs.readFileSync(LEADS_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function writeLeads(list) {
  ensureStore();
  fs.writeFileSync(LEADS_FILE, JSON.stringify(list, null, 2));
}

function addLead(data) {
  const list = readLeads();
  const lead = {
    id: crypto.randomUUID(),
    nombre: data.nombre || '',
    email: data.email || '',
    telefono: data.telefono || '',
    servicio: data.servicio || '',
    mensaje: data.mensaje || '',
    estado: 'nuevo', // nuevo | atendido
    fecha: new Date().toISOString(),
    ip: data.ip || '',
  };
  list.push(lead);
  writeLeads(list);
  return lead;
}

function updateLead(id, patch) {
  const list = readLeads();
  const idx = list.findIndex((l) => l.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  writeLeads(list);
  return list[idx];
}

function deleteLead(id) {
  const list = readLeads();
  const next = list.filter((l) => l.id !== id);
  if (next.length === list.length) return false;
  writeLeads(next);
  return true;
}

function stats() {
  const list = readLeads();
  const nuevos = list.filter((l) => l.estado !== 'atendido').length;
  return { total: list.length, nuevos, atendidos: list.length - nuevos };
}

module.exports = { readLeads, addLead, updateLead, deleteLead, stats };
