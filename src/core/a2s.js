'use strict';

/**
 * Requêtes Steam A2S (UDP) : A2S_INFO pour le ping/infos et A2S_RULES pour
 * récupérer la liste des mods d'un serveur DayZ (utilisé pour le LAN et
 * les serveurs ajoutés manuellement).
 */
const dgram = require('dgram');

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const A2S_INFO = Buffer.concat([HEADER, Buffer.from('TSource Engine Query\0', 'latin1')]);

class Reader {
  constructor(buf, offset = 0) { this.buf = buf; this.o = offset; }
  eof() { return this.o >= this.buf.length; }
  u8() { return this.buf.readUInt8(this.o++); }
  u16() { const v = this.buf.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.buf.readBigUInt64LE(this.o); this.o += 8; return v; }
  str() {
    const end = this.buf.indexOf(0, this.o);
    const stop = end === -1 ? this.buf.length : end;
    const s = this.buf.toString('utf8', this.o, stop);
    this.o = stop + 1;
    return s;
  }
}

function parseInfo(buf) {
  const r = new Reader(buf, 4);
  if (r.u8() !== 0x49) throw new Error('Réponse A2S_INFO invalide');
  const info = {
    protocol: r.u8(),
    name: r.str(),
    map: r.str(),
    folder: r.str(),
    game: r.str(),
    appId: r.u16(),
    players: r.u8(),
    maxPlayers: r.u8(),
    bots: r.u8(),
    serverType: String.fromCharCode(r.u8()),
    environment: String.fromCharCode(r.u8()),
    password: r.u8() === 1,
    vac: r.u8() === 1,
    version: r.str(),
  };
  if (!r.eof()) {
    const edf = r.u8();
    if (edf & 0x80) info.gamePort = r.u16();
    if (edf & 0x10) info.steamId = r.u64().toString();
    if (edf & 0x40) { info.tvPort = r.u16(); info.tvName = r.str(); }
    if (edf & 0x20) info.keywords = r.str();
    if (edf & 0x01) info.gameId = r.u64().toString();
  }
  // DayZ encode des informations utiles dans les mots-clés.
  const kw = (info.keywords || '').split(',');
  info.battlEye = kw.includes('battleye');
  info.firstPersonOnly = kw.includes('no3rd');
  // Les serveurs officiels utilisent la hive publique ; les communautaires annoncent « privHive ».
  info.shard = kw.includes('privHive') ? 'private' : 'public';
  const time = kw.find((k) => /^\d{1,2}:\d{2}$/.test(k));
  if (time) info.time = time;
  const lqs = kw.find((k) => k.startsWith('lqs'));
  if (lqs) info.queue = Number(lqs.slice(3)) || 0;
  return info;
}

/** Envoie une requête et attend une réponse ; gère le challenge (0x41). */
function request(host, port, payload, { timeout = 2500, expect } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    let sentAt = 0;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* déjà fermé */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Délai dépassé')), timeout);
    const send = (buf) => { sentAt = Date.now(); sock.send(buf, port, host, (e) => e && finish(e)); };

    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      if (msg.length < 5) return;
      const type = msg.readUInt8(4);
      if (type === 0x41) {
        const challenge = msg.subarray(5, 9);
        send(payload(challenge));
        return;
      }
      if (type === expect) finish(null, { msg, rtt: Date.now() - sentAt });
    });
    send(payload(null));
  });
}

async function queryInfo(host, port, timeout) {
  const { msg, rtt } = await request(
    host, port,
    (ch) => (ch ? Buffer.concat([A2S_INFO, ch]) : A2S_INFO),
    { timeout, expect: 0x49 },
  );
  return { ...parseInfo(msg), ping: rtt };
}

async function queryRules(host, port, timeout) {
  const { msg } = await request(
    host, port,
    (ch) => Buffer.concat([HEADER, Buffer.from([0x56]), ch || Buffer.from([0xff, 0xff, 0xff, 0xff])]),
    { timeout, expect: 0x45 },
  );
  const r = new Reader(msg, 5);
  const count = r.u16();
  const rules = [];
  for (let n = 0; n < count && !r.eof(); n++) {
    // Les clés DayZ des mods sont binaires : on garde les octets bruts.
    const kStart = r.o;
    const kEnd = msg.indexOf(0, kStart);
    const key = msg.subarray(kStart, kEnd);
    r.o = kEnd + 1;
    const vStart = r.o;
    const vEnd = msg.indexOf(0, vStart);
    const value = msg.subarray(vStart, vEnd);
    r.o = vEnd + 1;
    rules.push({ key, value });
  }
  return rules;
}

/**
 * Décode le bloc binaire des mods envoyé par DayZ dans A2S_RULES.
 * Les règles dont la clé fait 2 octets sont des fragments (index, total)
 * à concaténer, puis à « dé-échapper » (0x01 0x01 → 0x01, 0x01 0x02 → 0x00, 0x01 0x03 → 0xFF).
 */
function decodeDayzMods(rules) {
  const chunks = rules
    .filter((r) => r.key.length === 2 && r.key[0] >= 1 && r.key[1] >= 1 && r.key[0] <= r.key[1])
    .sort((a, b) => a.key[0] - b.key[0])
    .map((r) => r.value);
  if (!chunks.length) return [];

  const raw = Buffer.concat(chunks);
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x01 && i + 1 < raw.length) {
      const n = raw[++i];
      bytes.push(n === 0x01 ? 0x01 : n === 0x02 ? 0x00 : n === 0x03 ? 0xff : n);
    } else {
      bytes.push(raw[i]);
    }
  }
  const buf = Buffer.from(bytes);
  const r = new Reader(buf);
  r.u8(); // version du protocole
  r.u8(); // drapeaux de débordement
  const dlcFlags = r.u16();
  // Un hash de 4 octets par DLC actif.
  for (let b = dlcFlags; b; b &= b - 1) r.o += 4;

  const mods = [];
  const modCount = r.u8();
  for (let n = 0; n < modCount && r.o < buf.length; n++) {
    r.o += 4; // hash du mod
    const infoByte = r.u8();
    const isDlc = (infoByte & 0x10) !== 0;
    const idLen = infoByte & 0x0f;
    let id = 0n;
    for (let k = 0; k < idLen; k++) id |= BigInt(r.u8()) << BigInt(8 * k);
    const nameLen = r.u8();
    const name = buf.toString('utf8', r.o, r.o + nameLen);
    r.o += nameLen;
    if (!isDlc) mods.push({ name, steamWorkshopId: id.toString() });
  }
  return mods;
}

async function queryMods(host, port, timeout) {
  try {
    return decodeDayzMods(await queryRules(host, port, timeout));
  } catch {
    return null;
  }
}

/**
 * Découverte LAN : diffuse A2S_INFO sur le réseau local et collecte les réponses.
 */
function discoverLan({ ports = [27016, 27017, 27018, 27019, 27020, 2303, 2305, 2307], duration = 2500 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    const sentAt = Date.now();

    sock.on('message', (msg, rinfo) => {
      try {
        if (msg.readUInt8(4) === 0x41) {
          sock.send(Buffer.concat([A2S_INFO, msg.subarray(5, 9)]), rinfo.port, rinfo.address);
          return;
        }
        const info = parseInfo(msg);
        if (info.appId && info.appId !== 221100 && info.folder !== 'dayz') return;
        found.set(`${rinfo.address}:${rinfo.port}`, {
          ...info,
          ip: rinfo.address,
          queryPort: rinfo.port,
          ping: Date.now() - sentAt,
        });
      } catch { /* paquet non A2S */ }
    });
    sock.on('error', () => { /* ignore : on renvoie ce qu'on a */ });
    sock.bind(() => {
      sock.setBroadcast(true);
      for (const p of ports) sock.send(A2S_INFO, p, '255.255.255.255');
      // Les serveurs lancés sur la même machine ne répondent pas toujours au broadcast.
      for (const p of ports) sock.send(A2S_INFO, p, '127.0.0.1');
    });
    setTimeout(() => {
      try { sock.close(); } catch { /* déjà fermé */ }
      resolve([...found.values()]);
    }, duration);
  });
}

module.exports = { queryInfo, queryRules, queryMods, decodeDayzMods, discoverLan, parseInfo };
