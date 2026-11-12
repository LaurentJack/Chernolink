'use strict';

/* global api */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Traduction (dictionnaires chargés par les <script> de src/locales/)
// ---------------------------------------------------------------------------
const LOCALES = window.CHERNOLINK_LOCALES || {};
let lang = 'fr';
let t = window.chernolinkTranslate.createTranslator(LOCALES, lang);

function setLanguage(code) {
  lang = LOCALES[code] ? code : 'en';
  t = window.chernolinkTranslate.createTranslator(LOCALES, lang);
  document.documentElement.lang = lang;
  applyStaticTranslations();
}

function applyStaticTranslations(root = document) {
  $$('[data-i18n]', root).forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-placeholder]', root).forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  $$('[data-i18n-title]', root).forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

// Langue provisoire (celle du système) en attendant les paramètres du processus principal.
setLanguage(window.chernolinkTranslate.resolveLanguage('auto', navigator.language));

const MAP_NAMES = {
  chernarusplus: 'Chernarus', enoch: 'Livonia', sakhal: 'Sakhal', deerisle: 'Deer Isle', namalsk: 'Namalsk',
  takistanplus: 'Takistan', banov: 'Banov', esseker: 'Esseker', chiemsee: 'Chiemsee', rostow: 'Rostow',
  valning: 'Valning', iztek: 'Iztek', pripyat: 'Pripyat', swansisland: 'Swans Island', anastara: 'Anastara',
};
const mapName = (m) => MAP_NAMES[m] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : '—');

const fmtSize = (b) => {
  if (!b) return '—';
  const u = t('units.size').split(',');
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (sec) => (sec ? new Date(sec * 1000).toLocaleDateString(lang, { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const state = {
  init: null,
  master: [],
  lan: [],
  manual: [],
  pings: {},
  tab: 'official',
  sort: { key: 'players', dir: -1 },
  filtered: [],
  selected: null,
  favorites: [],
  history: [],
  currentVersion: '',
  mods: [],
  modSelection: new Set(),
};

// ---------------------------------------------------------------------------
// Toasts & overlay
// ---------------------------------------------------------------------------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4500);
}

const overlay = {
  open(title, message) {
    $('#ov-title').textContent = title;
    $('#ov-message').textContent = message || '';
    $('#ov-detail').textContent = '';
    $('#ov-close').classList.add('hidden');
    this.indeterminate(true);
    $('#overlay').classList.remove('hidden');
  },
  message(m) { $('#ov-message').textContent = m; },
  detail(d) { $('#ov-detail').textContent = d; },
  indeterminate(on) { $('.progress', $('#overlay')).classList.toggle('indeterminate', on); if (on) $('#ov-bar').style.width = ''; },
  progress(p) { this.indeterminate(false); $('#ov-bar').style.width = `${Math.max(0, Math.min(100, p))}%`; },
  fail(m) { this.message(m); this.indeterminate(false); $('#ov-bar').style.width = '0'; $('#ov-close').classList.remove('hidden'); },
  close() { $('#overlay').classList.add('hidden'); },
};
$('#ov-close').addEventListener('click', () => overlay.close());

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
$$('.nav-item').forEach((b) => b.addEventListener('click', () => {
  $$('.nav-item').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${b.dataset.view}`));
  if (b.dataset.view === 'mods' && !state.mods.length) loadMods();
}));

// ---------------------------------------------------------------------------
// Serveurs
// ---------------------------------------------------------------------------
function currentSource() {
  switch (state.tab) {
    case 'official': return state.master.filter((s) => s.official);
    case 'community': return state.master.filter((s) => !s.official);
    case 'lan': return mergeUnique([...state.lan, ...state.manual]);
    case 'favorites': return state.favorites.map(resolveKnown);
    case 'history': return state.history.map(resolveKnown);
    default: return [];
  }
}

function mergeUnique(list) {
  const seen = new Map();
  for (const s of list) if (!seen.has(s.id)) seen.set(s.id, s);
  return [...seen.values()];
}

/** Retrouve les infos à jour d'un favori/historique dans les listes connues. */
function resolveKnown(snap) {
  const known = state.master.find((s) => s.id === snap.id)
    || state.lan.find((s) => s.id === snap.id)
    || state.manual.find((s) => s.id === snap.id);
  return known || { players: 0, maxPlayers: 0, mods: [], ...snap, offline: true, lastPlayed: snap.lastPlayed };
}

function readFilters() {
  return {
    q: $('#f-search').value.trim().toLowerCase(),
    map: $('#f-map').value,
    hideEmpty: $('#f-hide-empty').checked,
    hideFull: $('#f-hide-full').checked,
    noPass: $('#f-no-pass').checked,
    persp: $('#f-persp').value,
    mods: $('#f-mods').value,
    sameVersion: $('#f-same-version').checked,
  };
}

function applyFilters() {
  const f = readFilters();
  const applyVersion = f.sameVersion && state.currentVersion && (state.tab === 'official' || state.tab === 'community');
  let list = currentSource().filter((s) => {
    if (f.map && s.map !== f.map) return false;
    if (f.hideEmpty && !s.players) return false;
    if (f.hideFull && s.maxPlayers && s.players >= s.maxPlayers) return false;
    if (f.noPass && s.password) return false;
    if (f.persp === '1pp' && !s.firstPersonOnly) return false;
    if (f.persp === '3pp' && s.firstPersonOnly) return false;
    if (f.mods === 'vanilla' && s.mods.length) return false;
    if (f.mods === 'modded' && !s.mods.length) return false;
    if (applyVersion && s.version && s.version !== state.currentVersion) return false;
    if (f.q) {
      const hay = `${s.name} ${s.ip}:${s.gamePort} ${s.map} ${s.mods.map((m) => m.name).join(' ')}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });

  const { key, dir } = state.sort;
  const val = (s) => {
    switch (key) {
      case 'name': return s.name.toLowerCase();
      case 'map': return s.map;
      case 'players': return s.players + (s.queue || 0);
      case 'ping': { const p = pingOf(s); return p == null || p < 0 ? 99999 * -dir : p; }
      case 'mods': return s.mods.length;
      case 'time': return s.time || '';
      default: return 0;
    }
  };
  if (state.tab === 'history') {
    list.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  } else {
    list.sort((a, b) => { const x = val(a); const y = val(b); return x < y ? -dir : x > y ? dir : 0; });
  }
  state.filtered = list;
  $$('.table-head [data-sort]').forEach((el) => el.classList.toggle('sorted', el.dataset.sort === key));
  renderServers(true);
}

const pingOf = (s) => (state.pings[s.id] ? state.pings[s.id].ping : s.ping);

function pingClass(p) {
  if (p == null) return '';
  if (p < 0) return 'ping-bad';
  return p < 80 ? 'ping-good' : p < 150 ? 'ping-mid' : 'ping-bad';
}

function rowHtml(s, idx) {
  const fav = state.favorites.some((f) => f.id === s.id);
  const p = pingOf(s);
  const live = state.pings[s.id] || {};
  const players = live.players ?? s.players;
  const max = live.maxPlayers ?? s.maxPlayers;
  const queue = live.queue ?? s.queue;
  const full = max && players >= max;
  return `<div class="server-row${state.selected && state.selected.id === s.id ? ' selected' : ''}" data-idx="${idx}" style="top:${idx * 34}px">
    <span><button class="star${fav ? ' on' : ''}" data-fav="${idx}" title="${esc(t('row.favorite'))}">★</button></span>
    <span class="name-cell">
      ${s.official ? `<span class="tag official">${esc(t('row.official'))}</span>` : ''}
      <span class="n" title="${esc(s.name)}">${esc(s.name)}</span>
      ${s.firstPersonOnly ? '<span class="tag pp1">1PP</span>' : ''}
      ${s.password ? `<span class="tag lock" title="${esc(t('row.password'))}">🔒</span>` : ''}
      ${s.offline ? `<span class="tag">${esc(t('row.notListed'))}</span>` : ''}
    </span>
    <span>${esc(mapName(s.map))}</span>
    <span class="num ${full ? 'players-full' : ''}">${players}/${max}${queue ? ` <small>+${queue}</small>` : ''}</span>
    <span class="num ${pingClass(p)}">${p == null ? '…' : p < 0 ? '—' : p}</span>
    <span class="num">${s.mods.length || ''}</span>
    <span class="num">${esc(s.time || '')}</span>
  </div>`;
}

let renderQueued = false;
function renderServers(resetScroll) {
  const body = $('#server-list');
  const spacer = $('#server-spacer');
  if (resetScroll) body.scrollTop = 0;
  spacer.style.height = `${state.filtered.length * 34}px`;
  const start = Math.max(0, Math.floor(body.scrollTop / 34) - 10);
  const end = Math.min(state.filtered.length, start + Math.ceil(body.clientHeight / 34) + 20);
  let html = '';
  for (let i = start; i < end; i++) html += rowHtml(state.filtered[i], i);
  spacer.innerHTML = html;

  const empty = $('#server-empty');
  empty.classList.toggle('hidden', state.filtered.length > 0);
  if (!state.filtered.length) {
    const key = { lan: 'empty.lan', favorites: 'empty.favorites', history: 'empty.history' }[state.tab]
      || (state.master.length ? 'empty.noMatch' : 'empty.loading');
    empty.textContent = t(key);
  }
  const total = currentSource().length;
  const players = state.filtered.reduce((n, s) => n + (s.players || 0), 0);
  $('#server-foot').textContent = [
    t('foot.servers', { shown: state.filtered.length, total }),
    t('foot.players', { n: players }),
    state.currentVersion ? t('foot.version', { v: state.currentVersion }) : '',
  ].filter(Boolean).join(' — ');
  schedulePing(start, end);
}

$('#server-list').addEventListener('scroll', () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderServers(false); });
});

$('#server-list').addEventListener('click', async (e) => {
  const favBtn = e.target.closest('[data-fav]');
  if (favBtn) {
    e.stopPropagation();
    await toggleFavorite(state.filtered[Number(favBtn.dataset.fav)]);
    return;
  }
  const row = e.target.closest('.server-row');
  if (row) selectServer(state.filtered[Number(row.dataset.idx)]);
});
$('#server-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.server-row');
  if (row) joinSelected();
});

$$('.table-head [data-sort]').forEach((el) => el.addEventListener('click', () => {
  const key = el.dataset.sort;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (key === 'name' || key === 'map' || key === 'ping' ? 1 : -1) };
  applyFilters();
}));

let filterTimer;
$$('.filters input, .filters select').forEach((el) => el.addEventListener(el.type === 'search' ? 'input' : 'change', () => {
  if (!el.closest('#view-servers')) return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilters, 120);
}));

$$('#server-tabs .tab').forEach((t) => t.addEventListener('click', () => {
  state.tab = t.dataset.tab;
  $$('#server-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#lan-bar').classList.toggle('hidden', state.tab !== 'lan');
  if (state.tab === 'lan' && !state.lan.length && !state.lanScanned) scanLan();
  applyFilters();
}));

function updateCounts() {
  const counts = {
    official: state.master.filter((s) => s.official).length,
    community: state.master.filter((s) => !s.official).length,
    lan: mergeUnique([...state.lan, ...state.manual]).length,
    favorites: state.favorites.length,
    history: state.history.length,
  };
  for (const [k, v] of Object.entries(counts)) $(`[data-count="${k}"]`).textContent = v || '';
}

function fillMapFilter() {
  const sel = $('#f-map');
  const current = sel.value;
  const maps = [...new Set(state.master.map((s) => s.map).filter(Boolean))]
    .sort((a, b) => mapName(a).localeCompare(mapName(b)));
  sel.innerHTML = `<option value="">${esc(t('filters.allMaps'))}</option>`
    + maps.map((m) => `<option value="${esc(m)}">${esc(mapName(m))}</option>`).join('');
  sel.value = current;
}

async function loadMaster() {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  try {
    state.master = await api.servers.master();
    // Version courante = version majoritaire des serveurs officiels.
    const counts = {};
    for (const s of state.master) if (s.official && s.version) counts[s.version] = (counts[s.version] || 0) + 1;
    state.currentVersion = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    state.pings = {};
    fillMapFilter();
    updateCounts();
    applyFilters();
  } catch (e) {
    toast(e.message, 'error');
    applyFilters();
  } finally {
    btn.disabled = false;
  }
}

// ----- Ping des lignes visibles -----
let pingTimer;
const pingInFlight = new Set();
function schedulePing(start, end) {
  if (!state.init?.settings.pingOnLoad) return;
  clearTimeout(pingTimer);
  pingTimer = setTimeout(async () => {
    const batch = state.filtered.slice(start, end)
      .filter((s) => !state.pings[s.id] && !pingInFlight.has(s.id) && s.queryPort);
    if (!batch.length) return;
    batch.forEach((s) => pingInFlight.add(s.id));
    try {
      const res = await api.servers.ping(batch.map((s) => ({ id: s.id, ip: s.ip, queryPort: s.queryPort })));
      Object.assign(state.pings, res);
    } catch { /* pas bloquant */ }
    batch.forEach((s) => pingInFlight.delete(s.id));
    renderServers(false);
    if (state.selected) renderDetailsStats();
  }, 250);
}

// ----- LAN -----
async function scanLan() {
  state.lanScanned = true;
  const btn = $('#btn-lan-scan');
  btn.disabled = true;
  $('#lan-hint').textContent = t('lan.searching');
  try {
    const [lan, manual] = await Promise.all([api.servers.lan(), api.servers.loadManual()]);
    state.lan = lan;
    state.manual = manual;
    $('#lan-hint').textContent = t('lan.found', { lan: lan.length, manual: manual.length });
  } catch (e) {
    $('#lan-hint').textContent = '';
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    updateCounts();
    applyFilters();
  }
}
$('#btn-lan-scan').addEventListener('click', scanLan);

$('#btn-add-manual').addEventListener('click', async () => {
  let ip = $('#manual-ip').value.trim();
  let port = $('#manual-port').value.trim();
  const m = ip.match(/^(.+):(\d+)$/);
  if (m) { ip = m[1]; port = port || m[2]; }
  if (!ip) return toast(t('lan.enterAddress'), 'error');
  port = Number(port || 27016);
  $('#lan-hint').textContent = t('lan.querying', { addr: `${ip}:${port}` });
  try {
    const s = await api.servers.addManual(ip, port);
    state.manual = mergeUnique([s, ...state.manual]);
    $('#manual-ip').value = '';
    $('#manual-port').value = '';
    $('#lan-hint').textContent = t('lan.added', { name: s.name });
    updateCounts();
    applyFilters();
    selectServer(s);
  } catch (e) {
    $('#lan-hint').textContent = '';
    toast(t('lan.unreachable', { error: e.message }), 'error');
  }
});

// ----- Favoris -----
async function toggleFavorite(s) {
  if (!s) return;
  state.favorites = await api.favorites.toggle(s);
  updateCounts();
  if (state.tab === 'favorites') applyFilters(); else renderServers(false);
  if (state.selected && state.selected.id === s.id) renderDetails();
}

// ---------------------------------------------------------------------------
// Détails d'un serveur
// ---------------------------------------------------------------------------
let detailsToken = 0;
async function selectServer(s) {
  if (!s) return;
  state.selected = s;
  renderServers(false);
  renderDetails();
  const token = ++detailsToken;

  // Infos fraîches pour les serveurs hors liste maître (LAN, manuels, favoris absents).
  if (s.source !== 'master' || s.offline) {
    try {
      const fresh = await api.servers.refresh(s);
      if (token !== detailsToken) return;
      state.selected = { ...s, ...fresh, offline: false };
      renderDetails();
    } catch { /* serveur hors ligne */ }
  }
  if (!state.selected.mods.length) return;
  try {
    const resolved = await api.mods.resolve(state.selected.mods);
    if (token !== detailsToken) return;
    state.selected.resolvedMods = resolved;
    renderDetails();
  } catch { /* statut indisponible */ }
}

function renderDetailsStats() {
  const s = state.selected;
  if (!s) return;
  const p = pingOf(s);
  const el = $('#d-ping');
  if (el) { el.textContent = p == null ? '…' : p < 0 ? t('details.unreachable') : `${p} ms`; el.className = pingClass(p); }
}

function renderDetails() {
  const s = state.selected;
  const box = $('#details');
  if (!s) { box.innerHTML = `<div class="details-empty">${esc(t('details.empty'))}</div>`; return; }
  const fav = state.favorites.some((f) => f.id === s.id);
  const mods = s.resolvedMods || s.mods.map((m) => ({ ...m, status: 'unknown' }));
  const missing = mods.filter((m) => m.status === 'missing');
  const outdated = mods.filter((m) => m.status === 'outdated');
  const dlSize = [...missing, ...outdated].reduce((n, m) => n + (m.size || 0), 0);
  const live = state.pings[s.id] || {};

  box.innerHTML = `
    <div class="d-head">
      <h2>${esc(s.name)}</h2>
      <div class="d-addr">${esc(s.ip)}:${esc(s.gamePort)} <span title="${esc(t('details.queryPort'))}">(query ${esc(s.queryPort)})</span></div>
    </div>
    <div class="d-grid">
      <div><small>${t('details.map')}</small>${esc(mapName(s.map))}</div>
      <div><small>${t('details.players')}</small>${live.players ?? s.players}/${live.maxPlayers ?? s.maxPlayers}${(live.queue ?? s.queue) ? ` ${t('details.queue', { n: live.queue ?? s.queue })}` : ''}</div>
      <div><small>${t('details.ping')}</small><span id="d-ping"></span></div>
      <div><small>${t('details.time')}</small>${esc(s.time || '—')}</div>
      <div><small>${t('details.perspective')}</small>${s.firstPersonOnly ? t('filters.persp1') : t('details.bothPersp')}</div>
      <div><small>${t('details.version')}</small>${esc(s.version || '—')}</div>
      <div><small>${t('details.type')}</small>${t(s.official ? 'type.official' : s.source === 'lan' ? 'type.lan' : 'type.community')}</div>
      <div><small>${t('details.battlEye')}</small>${t(s.battlEye ? 'common.yes' : 'common.no')}</div>
    </div>
    <div class="d-mods-title"><span>${esc(t('cols.mods'))} (${mods.length})</span><span>${s.resolvedMods ? t('details.modsStatus', { missing: missing.length, outdated: outdated.length }) : mods.length ? t('details.checking') : ''}</span></div>
    <div class="d-mods">
      ${mods.length ? mods.map((m) => `
        <div class="d-mod" title="${esc(m.name)} — ${esc(m.id)}">
          <span class="dot ${esc(m.status)}"></span>
          <span class="n">${esc(m.name)}</span>
          <a data-open-mod="${esc(m.id)}">${esc(t('mods.workshopPage'))} ↗</a>
        </div>`).join('') : `<div class="d-note" style="padding:6px 8px">${esc(t('details.vanilla'))}</div>`}
    </div>
    <div class="d-foot">
      ${s.password ? `<input type="password" id="d-password" placeholder="${esc(t('details.password'))}">` : ''}
      ${(missing.length || outdated.length) ? `<div class="d-note">${esc(t('details.willDownload', { n: missing.length + outdated.length, size: dlSize ? ` (${fmtSize(dlSize)})` : '' }))}</div>` : ''}
      <div class="row">
        <button class="btn btn-lg" id="d-join" style="flex:1">${esc(t('details.join'))}</button>
        <button class="btn btn-ghost" id="d-fav" title="${esc(t('row.favorite'))}">${esc(t(fav ? 'details.unfav' : 'details.fav'))}</button>
        ${s.source === 'manual' ? `<button class="btn btn-danger" id="d-remove" title="${esc(t('details.removeManual'))}">✕</button>` : ''}
      </div>
    </div>`;
  renderDetailsStats();
  $('#d-join').addEventListener('click', joinSelected);
  $('#d-fav').addEventListener('click', () => toggleFavorite(s));
  $('#d-remove')?.addEventListener('click', async () => {
    await api.servers.removeManual(s.ip, s.queryPort);
    state.manual = state.manual.filter((m) => m.id !== s.id);
    state.selected = null;
    renderDetails();
    updateCounts();
    applyFilters();
  });
  $$('[data-open-mod]', box).forEach((a) => a.addEventListener('click', () => api.mods.openPage(a.dataset.openMod)));
}

// ---------------------------------------------------------------------------
// Rejoindre / lancer
// ---------------------------------------------------------------------------
const dlProgress = {};
api.on('workshop:progress', (p) => {
  if (p.type === 'item-done') return;
  dlProgress.current = p;
  const pct = p.totalBytes ? (p.current / p.totalBytes) * 100 : 0;
  const overall = ((p.index + pct / 100) / p.total) * 100;
  overlay.progress(overall);
  overlay.detail(t('progress.mod', {
    i: p.index + 1, total: p.total, id: p.id,
    progress: p.totalBytes ? `${fmtSize(p.current)} / ${fmtSize(p.totalBytes)}` : t('progress.waitingSteam'),
  }));
});
api.on('join:status', (st) => {
  overlay.message(st.message);
  if (st.step !== 'download') overlay.indeterminate(true);
  if (st.step === 'done') setTimeout(() => overlay.close(), 1500);
});

async function joinSelected() {
  const s = state.selected;
  if (!s) return;
  const pwInput = $('#d-password');
  const password = pwInput ? pwInput.value : '';
  if (s.password && !password) { pwInput.focus(); return toast(t('join.needPassword'), 'error'); }
  overlay.open(t('join.connecting', { name: s.name }), t('join.preparing'));
  try {
    await api.game.join({ server: { ...s, resolvedMods: undefined }, password });
    const init = await api.init();
    state.history = init.history;
    updateCounts();
  } catch (e) {
    overlay.fail(e.message);
  }
}

// ---------------------------------------------------------------------------
// Lancement hors serveur avec une sélection de mods (éditeur, hors-ligne…)
// ---------------------------------------------------------------------------
const offline = { selected: [], presets: [], depsToken: 0 };

async function openOffline(preselect) {
  if (!state.mods.length) {
    try { state.mods = await api.mods.list(); } catch (e) { toast(e.message, 'error'); }
  }
  const remembered = state.init?.offlineLaunch || { ids: [], battlEye: false };
  const known = new Set(state.mods.map((m) => m.id));
  offline.selected = (preselect || remembered.ids).filter((id) => known.has(id));
  $('#off-be').checked = !!remembered.battlEye;
  $('#off-search').value = '';
  renderPresets();
  renderOffline();
  $('#offline').classList.remove('hidden');
  $('#off-search').focus();
}

function closeOffline() { $('#offline').classList.add('hidden'); }

function renderPresets() {
  $('#off-preset').innerHTML = `<option value="">${esc(t('offline.presets'))}</option>`
    + offline.presets.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${p.ids.length})</option>`).join('');
  $('#off-preset-delete').disabled = true;
}

function renderOffline() {
  const q = $('#off-search').value.trim().toLowerCase();
  const chosen = new Set(offline.selected);
  // Mods cochés en premier, puis ordre alphabétique.
  const list = state.mods
    .filter((m) => !m.removed && (!q || m.name.toLowerCase().includes(q) || m.id.includes(q)))
    .sort((a, b) => (chosen.has(b.id) - chosen.has(a.id)) || a.name.localeCompare(b.name));
  $('#off-list').innerHTML = list.length ? list.map((m) => `
    <label class="off-item${chosen.has(m.id) ? ' on' : ''}">
      <input type="checkbox" data-off="${esc(m.id)}" ${chosen.has(m.id) ? 'checked' : ''}>
      <span class="n" title="${esc(m.name)}">${esc(m.name)}</span>
      ${m.orphan ? `<span class="tag">${esc(t('offline.notSubscribed'))}</span>` : ''}
      <small>${esc(m.id)}</small>
    </label>`).join('') : `<div class="table-empty" style="position:static">${esc(t('offline.noMatch'))}</div>`;
  updateOfflineSummary();
}

function selectedMods() {
  return offline.selected.map((id) => ({ id, name: state.mods.find((m) => m.id === id)?.name || id }));
}

let depsTimer;
function updateOfflineSummary() {
  const box = $('#off-summary');
  $('#off-launch').textContent = offline.selected.length ? t('offline.launchWith', { n: offline.selected.length }) : t('offline.launchVanilla');
  clearTimeout(depsTimer);
  const token = ++offline.depsToken;
  if (!offline.selected.length) { box.textContent = t('offline.noneSelected'); return; }
  box.textContent = t('offline.searchingDeps');
  depsTimer = setTimeout(async () => {
    try {
      const order = await api.mods.withDependencies(selectedMods());
      if (token !== offline.depsToken) return;
      const installed = new Set(state.mods.map((m) => m.id));
      const deps = order.filter((m) => m.dependency);
      const missing = order.filter((m) => !installed.has(m.id));
      box.innerHTML = `${esc(t('offline.loadOrder'))} ${order.map((m) => (m.dependency ? `<span class="dep">${esc(m.name)}</span>` : `<b>${esc(m.name)}</b>`)).join(' → ')}`
        + (deps.length ? `<br><span class="dep">${esc(t('offline.depsAdded', { n: deps.length }))}</span>` : '')
        + (missing.length ? ` — ${esc(t('offline.toDownload', { n: missing.length }))}` : '');
    } catch {
      if (token === offline.depsToken) box.textContent = t('offline.depsUnavailable');
    }
  }, 350);
}

$('#off-list').addEventListener('change', (e) => {
  const id = e.target.dataset.off;
  if (!id) return;
  offline.selected = e.target.checked ? [...offline.selected, id] : offline.selected.filter((x) => x !== id);
  e.target.closest('.off-item').classList.toggle('on', e.target.checked);
  updateOfflineSummary();
});
$('#off-search').addEventListener('input', renderOffline);
$('#off-cancel').addEventListener('click', closeOffline);
$('#offline').addEventListener('click', (e) => { if (e.target.id === 'offline') closeOffline(); });

$('#off-preset').addEventListener('change', (e) => {
  const p = offline.presets.find((x) => x.name === e.target.value);
  $('#off-preset-delete').disabled = !p;
  if (!p) return;
  const known = new Set(state.mods.map((m) => m.id));
  const absent = p.ids.filter((id) => !known.has(id));
  offline.selected = p.ids.filter((id) => known.has(id));
  if (absent.length) toast(t('offline.presetMissing', { n: absent.length }), 'error');
  renderOffline();
});
$('#off-preset-save').addEventListener('click', async () => {
  if (!offline.selected.length) return toast(t('offline.checkOne'), 'error');
  const name = (window.prompt(t('offline.presetName'), $('#off-preset').value || t('offline.presetDefault')) || '').trim();
  if (!name) return;
  offline.presets = await api.presets.save(name, offline.selected);
  renderPresets();
  $('#off-preset').value = name;
  $('#off-preset-delete').disabled = false;
  toast(t('offline.presetSaved', { name }), 'ok');
});
$('#off-preset-delete').addEventListener('click', async () => {
  const name = $('#off-preset').value;
  if (!name || !window.confirm(t('offline.presetDeleteConfirm', { name }))) return;
  offline.presets = await api.presets.delete(name);
  renderPresets();
});

$('#off-launch').addEventListener('click', async () => {
  const battlEye = $('#off-be').checked;
  const opts = { ids: offline.selected, battlEye };
  api.offline.remember(opts).catch(() => {});
  if (state.init) state.init.offlineLaunch = opts;
  closeOffline();
  overlay.open(t('offline.launching'), t(offline.selected.length ? 'offline.preparingMods' : 'offline.noServer'));
  try {
    await api.game.join({ server: null, extraMods: selectedMods(), battlEye });
  } catch (e) {
    overlay.fail(e.message);
  }
});

$('#btn-play-menu').addEventListener('click', () => openOffline());
$('#btn-mods-play').addEventListener('click', () => openOffline([...state.modSelection]));

$('#btn-refresh').addEventListener('click', () => {
  if (state.tab === 'lan') scanLan(); else loadMaster();
});

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------
async function loadMods() {
  $('#mods-summary').textContent = t('mods.analyzing');
  $('#btn-mods-check').disabled = true;
  try {
    state.mods = await api.mods.list();
    state.modSelection.clear();
    renderMods();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    $('#btn-mods-check').disabled = false;
  }
}

function renderMods() {
  const q = $('#m-search').value.trim().toLowerCase();
  const onlyOutdated = $('#m-outdated').checked;
  const list = state.mods.filter((m) => (!onlyOutdated || m.outdated)
    && (!q || m.name.toLowerCase().includes(q) || m.id.includes(q)));
  const outdated = state.mods.filter((m) => m.outdated);
  const orphans = state.mods.filter((m) => m.orphan);
  const total = state.mods.reduce((n, m) => n + m.size, 0);

  // Les modèles de ces clés contiennent du HTML (<b>) : seules les valeurs insérées sont des nombres.
  $('#mods-summary').innerHTML = [
    t('mods.summary', { n: state.mods.length, size: esc(fmtSize(total)) }),
    outdated.length ? t('mods.updatesAvailable', { n: outdated.length }) : esc(t('mods.allUpToDate')),
    orphans.length ? t('mods.orphans', { n: orphans.length }) : '',
  ].filter(Boolean).join(' — ');
  const badge = $('#mods-badge');
  badge.textContent = outdated.length;
  badge.classList.toggle('hidden', !outdated.length);
  $('#btn-mods-update').disabled = !outdated.length;
  $('#btn-mods-remove').disabled = !state.modSelection.size;
  $('#btn-mods-play').disabled = !state.modSelection.size;

  $('#mod-list').innerHTML = list.length ? list.map((m) => {
    const st = m.removed ? ['removed', t('mods.status.removed')]
      : m.orphan ? ['outdated', t('mods.status.orphan')]
        : m.outdated ? ['outdated', t('mods.status.outdated')] : ['ok', t('mods.status.ok')];
    return `<div class="mod-row">
      <span><input type="checkbox" data-sel="${esc(m.id)}" ${state.modSelection.has(m.id) ? 'checked' : ''}></span>
      <span title="${esc(m.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
      <span style="font-family:Consolas,monospace;color:var(--muted)">${esc(m.id)}</span>
      <span class="num">${fmtSize(m.size)}</span>
      <span>${fmtDate(m.remoteUpdated || m.localUpdated)}</span>
      <span class="status ${st[0]}">${esc(st[1])}</span>
      <span class="actions">
        ${m.outdated ? `<button class="btn" data-update="${esc(m.id)}">${esc(t('mods.update'))}</button>` : ''}
        ${m.orphan && !m.removed ? `<button class="btn btn-ghost" data-update="${esc(m.id)}" title="${esc(t('mods.resubscribeTitle'))}">${esc(t('mods.resubscribe'))}</button>` : ''}
        <button class="btn btn-ghost" data-folder="${esc(m.id)}" title="${esc(t('mods.openFolder'))}">📁</button>
        <button class="btn btn-ghost" data-page="${esc(m.id)}" title="${esc(t('mods.workshopPage'))}">↗</button>
      </span>
    </div>`;
  }).join('') : `<div class="table-empty">${esc(t(state.mods.length ? 'mods.noMatch' : 'mods.noneInstalled'))}</div>`;
}

$('#m-search').addEventListener('input', renderMods);
$('#m-outdated').addEventListener('change', renderMods);
$('#m-all').addEventListener('change', (e) => {
  state.modSelection = new Set(e.target.checked ? state.mods.map((m) => m.id) : []);
  renderMods();
});
$('#mod-list').addEventListener('click', async (e) => {
  const target = e.target;
  if (target.dataset.sel) {
    target.checked ? state.modSelection.add(target.dataset.sel) : state.modSelection.delete(target.dataset.sel);
    $('#btn-mods-remove').disabled = !state.modSelection.size;
    $('#btn-mods-play').disabled = !state.modSelection.size;
  } else if (target.dataset.update) {
    await downloadMods([target.dataset.update], t('mods.updatingOne'));
  } else if (target.dataset.folder) {
    api.mods.openFolder(target.dataset.folder);
  } else if (target.dataset.page) {
    api.mods.openPage(target.dataset.page);
  }
});

async function downloadMods(ids, title) {
  overlay.open(title, t('mods.requestingSteam'));
  try {
    await api.mods.download(ids);
    overlay.close();
    toast(t('mods.updatedToast', { n: ids.length }), 'ok');
  } catch (e) {
    overlay.fail(e.message);
  }
  await loadMods();
}

$('#btn-mods-check').addEventListener('click', loadMods);
$('#btn-mods-update').addEventListener('click', () => {
  const ids = state.mods.filter((m) => m.outdated).map((m) => m.id);
  if (ids.length) downloadMods(ids, t('mods.updatingN', { n: ids.length }));
});
$('#btn-mod-add').addEventListener('click', () => {
  const v = $('#m-add-id').value.trim();
  const id = (v.match(/id=(\d+)/) || v.match(/^(\d{6,})$/) || [])[1];
  if (!id) return toast(t('mods.invalidId'), 'error');
  $('#m-add-id').value = '';
  downloadMods([id], t('mods.installing'));
});
$('#btn-mods-remove').addEventListener('click', async () => {
  const ids = [...state.modSelection];
  if (!ids.length) return;
  if (!window.confirm(t('mods.removeConfirm', { n: ids.length }))) return;
  try {
    const r = await api.mods.remove(ids);
    if (r.removed.length) toast(t('mods.removedToast', { n: r.removed.length }), 'ok');
    if (r.failed.length) {
      const names = r.failed.slice(0, 5).map((f) => `${state.mods.find((m) => m.id === f.id)?.name || f.id} : ${f.error}`);
      toast(t('mods.failedToast', { n: r.failed.length, list: names.join(' ; ') }), 'error');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  await loadMods();
});

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------
function fillSettings(s) {
  const f = $('#settings-form');
  for (const [k, v] of Object.entries(s)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  }
}

function fillLanguageSelect(languages = []) {
  $('#language-select').innerHTML = `<option value="auto">${esc(t('settings.languageAuto'))}</option>`
    + languages.map((l) => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
  $('#language-select').value = state.init?.settings.language || 'auto';
}

function renderInstall(init) {
  const el = $('#install-state');
  if (init.install.dayzPath) {
    el.className = 'install-state';
    el.textContent = init.install.dayzPath;
    $('#build-info').textContent = init.buildId ? t('install.build', { id: init.buildId }) : t('install.detected');
  } else {
    el.className = 'install-state bad';
    el.textContent = t('install.notFound');
    $('#build-info').textContent = t('install.notDetected');
  }
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const s = {};
  for (const el of f.elements) {
    if (!el.name) continue;
    s[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  try {
    const previousLanguage = state.init.settings.language || 'auto';
    const r = await api.settings.save(s);
    // Changement de langue : on recharge l'interface pour tout retraduire.
    if ((r.settings.language || 'auto') !== previousLanguage) { window.location.reload(); return; }
    state.init.settings = r.settings;
    state.init.install = r.install;
    renderInstall(state.init);
    toast(t('settings.saved'), 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('#btn-pick-path').addEventListener('click', async () => {
  try {
    const p = await api.settings.pickDayzPath();
    if (p) $('#settings-form').elements.dayzPath.value = p;
  } catch (e) { toast(e.message, 'error'); }
});
$('#btn-open-dayz').addEventListener('click', () => api.openDayz());
$('#btn-clear-history').addEventListener('click', async () => {
  state.history = await api.history.clear();
  updateCounts();
  if (state.tab === 'history') applyFilters();
  toast(t('settings.historyCleared'), 'ok');
});

window.addEventListener('resize', () => renderServers(false));

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
(async function boot() {
  try {
    const init = await api.init();
    state.init = init;
    setLanguage(init.language);
    fillLanguageSelect(init.languages);
    state.favorites = init.favorites;
    offline.presets = init.modPresets || [];
    state.history = init.history;
    fillSettings(init.settings);
    renderInstall(init);
    $('#about').textContent = t('settings.about', { version: init.version, path: init.install.workshopPath || t('common.notFound') });
    updateCounts();
  } catch (e) {
    toast(e.message, 'error');
  }
  await loadMaster();
  // Vérification des mises à jour de mods en arrière-plan pour le badge.
  api.mods.list().then((m) => { state.mods = m; renderMods(); }).catch(() => {});
}());
