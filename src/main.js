'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, utilityProcess } = require('electron');

const steam = require('./core/steam');
const servers = require('./core/servers');
const mods = require('./core/mods');
const { launchGame } = require('./core/launcher');
const { Store, DEFAULTS } = require('./core/store');

// Le nom affiché a changé : on conserve le dossier de données d'origine (favoris, paramètres).
app.setPath('userData', path.join(app.getPath('appData'), 'dayz-launcher'));
app.setAppUserModelId('com.chernolink.launcher');

const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');

let win;
let store;
let install = {};

// ---------------------------------------------------------------------------
// Worker Steamworks (processus séparé, relancé à la demande)
// ---------------------------------------------------------------------------
let worker = null;
let jobSeq = 0;
const jobs = new Map();

function getWorker() {
  if (worker) return worker;
  worker = utilityProcess.fork(path.join(__dirname, 'core', 'workshop-worker.js'), [], {
    serviceName: 'Chernolink Workshop',
    cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
  });
  worker.on('message', (msg) => {
    if (msg.type === 'progress' || msg.type === 'item-done') send('workshop:progress', msg);
    const job = jobs.get(msg.jobId);
    if (!job) return;
    if (msg.type === 'states') job.result = msg.states;
    if (msg.type === 'result') job.result = msg.data;
    if (msg.type === 'done') { jobs.delete(msg.jobId); job.resolve(job.result); }
    if (msg.type === 'error') { jobs.delete(msg.jobId); job.reject(new Error(msg.message)); }
  });
  worker.on('exit', () => {
    worker = null;
    for (const [id, job] of jobs) { job.reject(new Error('Le processus Workshop s\'est arrêté')); jobs.delete(id); }
  });
  return worker;
}

function runWorkshop(cmd, ids) {
  return new Promise((resolve, reject) => {
    const jobId = ++jobSeq;
    jobs.set(jobId, { resolve, reject });
    getWorker().postMessage({ jobId, cmd, ids });
  });
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function detect() {
  install = await steam.detectInstall();
  const custom = store.get('settings').dayzPath;
  if (custom && fs.existsSync(path.join(custom, 'DayZ_x64.exe'))) {
    install.dayzPath = custom;
    // Le Workshop reste dans la bibliothèque Steam qui contient le jeu.
    const lib = path.resolve(custom, '..', '..');
    const ws = path.join(lib, 'workshop', 'content', '221100');
    if (fs.existsSync(ws)) {
      install.workshopPath = ws;
      install.workshopManifest = path.join(lib, 'workshop', 'appworkshop_221100.acf');
    }
  }
  return install;
}

const removedFromWorkshop = new Set();
const isRemovedFromWorkshop = (id) => removedFromWorkshop.has(id);

function serverSnapshot(s) {
  return { id: s.id, ip: s.ip, gamePort: s.gamePort, queryPort: s.queryPort, name: s.name, map: s.map, official: s.official, source: s.source };
}

/** Télécharge / met à jour les mods nécessaires puis lance le jeu. */
async function joinServer({ server, password, extraMods = [] }) {
  const settings = store.get('settings');
  let required = server ? server.mods : [];
  if (server && server.source !== 'master') {
    // Infos fraîches pour les serveurs LAN / manuels / favoris.
    try { required = (await servers.refreshServer(server.ip, server.queryPort, server.source)).mods; } catch { /* garder la liste connue */ }
  }
  required = [...required, ...extraMods.filter((id) => !required.some((m) => m.id === id)).map((id) => ({ id, name: id }))];

  send('join:status', { step: 'check', message: 'Vérification des mods…' });
  const resolved = await mods.resolveServerMods(install, required);
  const removed = resolved.filter((m) => m.removed && m.status === 'missing');
  if (removed.length) throw new Error(`Mods retirés du Workshop : ${removed.map((m) => m.name).join(', ')}`);

  const toFetch = resolved.filter((m) => m.status === 'missing' || (settings.autoUpdateMods && m.status === 'outdated'));
  if (toFetch.length) {
    send('join:status', { step: 'download', message: `Téléchargement de ${toFetch.length} mod(s) via Steam…`, mods: toFetch });
    await runWorkshop('download', toFetch.map((m) => m.id));
  }

  send('join:status', { step: 'launch', message: 'Lancement de DayZ…' });
  const modParam = required.length ? mods.buildModParam(install, required.map((m) => m.id)) : '';
  const result = await launchGame(install, { server, modParam, password, settings });

  if (server) {
    const history = store.get('history').filter((h) => h.id !== server.id);
    history.unshift({ ...serverSnapshot(server), lastPlayed: Date.now() });
    store.set('history', history.slice(0, 50));
  }
  send('join:status', { step: 'done', message: 'DayZ est lancé. Bon jeu !' });
  return result;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('app:init', async () => {
    await detect();
    return {
      install,
      buildId: install.dayzPath ? steam.readGameVersion(install.dayzPath) : null,
      settings: store.get('settings'),
      favorites: store.get('favorites'),
      history: store.get('history'),
      manualServers: store.get('manualServers'),
      version: app.getVersion(),
    };
  });

  handle('servers:master', () => servers.fetchMasterList());
  handle('servers:ping', (list) => servers.pingMany(list));
  handle('servers:lan', () => servers.scanLan());
  handle('servers:refresh', (s) => servers.refreshServer(s.ip, s.queryPort, s.source));

  handle('servers:addManual', async ({ ip, queryPort }) => {
    const s = await servers.refreshServer(ip, Number(queryPort), 'manual');
    const list = store.get('manualServers').filter((m) => !(m.ip === ip && m.queryPort === Number(queryPort)));
    list.push({ ip, queryPort: Number(queryPort) });
    store.set('manualServers', list);
    return s;
  });
  handle('servers:removeManual', ({ ip, queryPort }) => store.set(
    'manualServers',
    store.get('manualServers').filter((m) => !(m.ip === ip && m.queryPort === queryPort)),
  ));
  handle('servers:loadManual', () => Promise.all(store.get('manualServers').map(async (m) => {
    try { return await servers.refreshServer(m.ip, m.queryPort, 'manual'); } catch {
      return servers.normalize({ ip: m.ip, queryPort: m.queryPort, name: `${m.ip}:${m.queryPort} (hors ligne)`, ping: -1 }, 'manual');
    }
  })));

  handle('favorites:toggle', (server) => {
    const favs = store.get('favorites');
    const exists = favs.some((f) => f.id === server.id);
    return store.set('favorites', exists ? favs.filter((f) => f.id !== server.id) : [...favs, serverSnapshot(server)]);
  });
  handle('history:clear', () => store.set('history', []));

  handle('mods:list', async () => {
    const list = await mods.checkUpdates(install);
    for (const m of list) if (m.removed) removedFromWorkshop.add(m.id);
    return list;
  });
  handle('mods:resolve', (serverMods) => mods.resolveServerMods(install, serverMods));
  handle('mods:download', (ids) => runWorkshop('download', ids));
  handle('mods:remove', async (ids) => {
    const tracked = new Set(mods.listInstalled(install).filter((m) => m.tracked).map((m) => m.id));
    const subscribed = ids.filter((id) => tracked.has(id));
    let notUnsubscribed = [];
    if (subscribed.length) {
      try {
        // Échecs tolérés : un mod retiré du Workshop ne peut parfois plus être désabonné.
        notUnsubscribed = (await runWorkshop('unsubscribe', subscribed)).failed;
      } catch (e) {
        // Steam injoignable : ne pas supprimer les mods abonnés, Steam les retéléchargerait.
        const r = mods.removeFolders(install, ids.filter((id) => !tracked.has(id)));
        r.failed.push(...subscribed.map((id) => ({ id, error: e.message })));
        return r;
      }
    }
    // Steam ne nettoie pas toujours les dossiers désabonnés : on les supprime nous-mêmes.
    // Un mod encore abonné mais retiré du Workshop ne peut plus être retéléchargé : suppression sans risque.
    return mods.removeFolders(install, ids.filter((id) => !notUnsubscribed.includes(id) || isRemovedFromWorkshop(id)));
  });
  handle('mods:openFolder', (id) => shell.openPath(path.join(install.workshopPath, id)));
  handle('mods:openPage', (id) => shell.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`));

  handle('game:join', (opts) => joinServer(opts));

  handle('settings:save', async (settings) => {
    store.set('settings', { ...store.get('settings'), ...settings });
    await detect();
    return { settings: store.get('settings'), install };
  });
  handle('settings:pickDayzPath', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Dossier d\'installation de DayZ', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (!fs.existsSync(path.join(r.filePaths[0], 'DayZ_x64.exe'))) throw new Error('DayZ_x64.exe introuvable dans ce dossier');
    return r.filePaths[0];
  });
  handle('shell:openDayz', () => install.dayzPath && shell.openPath(install.dayzPath));
}

// ---------------------------------------------------------------------------
// Fenêtre
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#101214',
    title: 'Chernolink',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'launcher.json'), DEFAULTS);
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  if (worker) worker.kill();
  app.quit();
});
