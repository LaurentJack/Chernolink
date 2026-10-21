'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseVdf } = require('../src/core/vdf');
const { decodeDayzMods, parseInfo } = require('../src/core/a2s');
const { normalize } = require('../src/core/servers');

test('parseVdf lit les objets imbriqués et les échappements', () => {
  const v = parseVdf(`"libraryfolders"
  {
    "0" { "path" "C:\\\\Steam" "apps" { "221100" "123" } }
    // commentaire
    "1" { "path" "D:\\\\Games" }
  }`);
  assert.strictEqual(v.libraryfolders['0'].path, 'C:\\Steam');
  assert.strictEqual(v.libraryfolders['0'].apps['221100'], '123');
  assert.strictEqual(v.libraryfolders['1'].path, 'D:\\Games');
});

function encodeMods(mods) {
  // Construit le bloc binaire DayZ comme le ferait le serveur.
  const bytes = [1, 0, 0, 0, mods.length];
  for (const m of mods) {
    bytes.push(0xaa, 0xbb, 0xcc, 0xdd);
    let id = BigInt(m.id);
    const idBytes = [];
    while (id > 0n) { idBytes.push(Number(id & 0xffn)); id >>= 8n; }
    bytes.push(idBytes.length, ...idBytes);
    const name = Buffer.from(m.name, 'utf8');
    bytes.push(name.length, ...name);
  }
  // Échappement 0x01 → 01 01, 0x00 → 01 02, 0xFF → 01 03
  const esc = [];
  for (const b of bytes) {
    if (b === 0x01) esc.push(1, 1); else if (b === 0x00) esc.push(1, 2); else if (b === 0xff) esc.push(1, 3); else esc.push(b);
  }
  const buf = Buffer.from(esc);
  const half = Math.ceil(buf.length / 2);
  return [
    { key: Buffer.from([2, 2]), value: buf.subarray(half) },
    { key: Buffer.from('allowedBuild'), value: Buffer.from('0') },
    { key: Buffer.from([1, 2]), value: buf.subarray(0, half) },
  ];
}

test('decodeDayzMods reconstitue la liste des mods fragmentée', () => {
  const mods = [{ id: '1559212036', name: 'CF' }, { id: '2572331007', name: 'DayZ-Expansion-Bundle' }];
  const out = decodeDayzMods(encodeMods(mods));
  assert.deepStrictEqual(out, mods.map((m) => ({ name: m.name, steamWorkshopId: m.id })));
});

test('parseInfo extrait les mots-clés DayZ', () => {
  const parts = [
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    Buffer.from('Mon serveur\0chernarusplus\0dayz\0DayZ\0', 'utf8'),
    Buffer.from([0x6c, 0x08, 5, 60, 0, 0x64, 0x77, 0, 1]),
    Buffer.from('1.30.164078\0', 'utf8'),
    Buffer.from([0xa0, 0xf6, 0x08]),
    Buffer.from('battleye,no3rd,privHive,lqs3,14:05\0', 'utf8'),
  ];
  const info = parseInfo(Buffer.concat(parts));
  assert.strictEqual(info.name, 'Mon serveur');
  assert.strictEqual(info.players, 5);
  assert.strictEqual(info.gamePort, 2294);
  assert.strictEqual(info.firstPersonOnly, true);
  assert.strictEqual(info.shard, 'private');
  assert.strictEqual(info.queue, 3);
  assert.strictEqual(info.time, '14:05');
});

test('normalize classe les serveurs officiels', () => {
  const s = normalize({ endpoint: { ip: '1.2.3.4', port: 27016 }, gamePort: 2302, name: 'DayZ FR 1', shard: 'public', mods: [] }, 'master');
  assert.strictEqual(s.id, '1.2.3.4:2302');
  assert.strictEqual(s.official, true);
});
