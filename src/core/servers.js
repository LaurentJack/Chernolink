'use strict';

const a2s = require('./a2s');

// Liste maître publique (communautaires + officiels) maintenue par DZSA Launcher.
const MASTER_URL = 'https://dayzsalauncher.com/api/v1/launcher/servers/dayz';
const QUERY_URL = (ip, port) => `https://dayzsalauncher.com/api/v1/query/${ip}/${port}`;

// Le jeu n'envoie plus « no3rd » de façon fiable (même les officiels 1PP ne l'envoient pas) :
// on se rabat sur le nom du serveur, sauf s'il mentionne aussi la 3ème personne.
const FIRST_PERSON_NAME = /\b(1\s*pp|fpp|1st[\s-]*person|first[\s-]*person|1(è|e)re\s*personne)\b/i;
const THIRD_PERSON_NAME = /\b(3\s*pp|tpp|3rd[\s-]*person|third[\s-]*person|3(è|e)me\s*personne)\b/i;

function isFirstPersonOnly(s) {
  if (s.firstPersonOnly) return true;
  const name = s.name || '';
  return FIRST_PERSON_NAME.test(name) && !THIRD_PERSON_NAME.test(name);
}

function normalize(s, source) {
  const ip = s.endpoint ? s.endpoint.ip : s.ip;
  const queryPort = s.endpoint ? s.endpoint.port : s.queryPort;
  const gamePort = s.gamePort || queryPort;
  return {
    id: `${ip}:${gamePort}`,
    ip,
    gamePort,
    queryPort,
    name: s.name || `${ip}:${gamePort}`,
    map: (s.map || '').toLowerCase(),
    players: s.players || 0,
    maxPlayers: s.maxPlayers || 0,
    queue: s.queue || 0,
    password: !!s.password,
    version: s.version || '',
    firstPersonOnly: isFirstPersonOnly(s),
    battlEye: s.battlEye !== false,
    time: s.time || '',
    official: s.shard === 'public',
    mods: (s.mods || []).map((m) => ({ id: String(m.steamWorkshopId), name: m.name })),
    source,
    ping: s.ping ?? null,
  };
}

async function fetchMasterList() {
  const res = await fetch(MASTER_URL, { headers: { 'User-Agent': 'DayZ-Launcher/1.0' } });
  if (!res.ok) throw new Error(`Liste des serveurs indisponible (HTTP ${res.status})`);
  const data = await res.json();
  if (data.status !== 0 || !Array.isArray(data.result)) throw new Error('Réponse de la liste maître invalide');
  return data.result.map((s) => normalize(s, 'master'));
}

/** Rafraîchit un serveur : ping + infos via A2S, mods via A2S_RULES (repli sur l'API DZSA). */
async function refreshServer(ip, queryPort, source = 'manual') {
  const info = await a2s.queryInfo(ip, queryPort, 3000);
  let mods = await a2s.queryMods(ip, queryPort, 3000);
  if (mods === null && source !== 'lan') {
    try {
      const res = await fetch(QUERY_URL(ip, queryPort));
      const data = await res.json();
      if (data.result) mods = data.result.mods;
    } catch { /* on garde une liste vide */ }
  }
  return normalize({ ...info, ip, queryPort, mods: mods || [] }, source);
}

/** Ping de plusieurs serveurs en parallèle limitée. */
async function pingMany(list, concurrency = 48) {
  const out = {};
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const s = list[i++];
      try {
        const info = await a2s.queryInfo(s.ip, s.queryPort, 2000);
        out[s.id] = { ping: info.ping, players: info.players, maxPlayers: info.maxPlayers, queue: info.queue || 0 };
      } catch {
        out[s.id] = { ping: -1 };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}

async function scanLan() {
  const found = await a2s.discoverLan();
  return Promise.all(found.map(async (s) => {
    const mods = await a2s.queryMods(s.ip, s.queryPort, 2000);
    return normalize({ ...s, mods: mods || [] }, 'lan');
  }));
}

module.exports = { fetchMasterList, refreshServer, pingMany, scanLan, normalize };
