'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  init: () => invoke('app:init'),
  servers: {
    master: () => invoke('servers:master'),
    ping: (list) => invoke('servers:ping', list),
    lan: () => invoke('servers:lan'),
    refresh: (s) => invoke('servers:refresh', s),
    addManual: (ip, queryPort) => invoke('servers:addManual', { ip, queryPort }),
    removeManual: (ip, queryPort) => invoke('servers:removeManual', { ip, queryPort }),
    loadManual: () => invoke('servers:loadManual'),
  },
  favorites: { toggle: (s) => invoke('favorites:toggle', s) },
  history: { clear: () => invoke('history:clear') },
  presets: {
    save: (name, ids) => invoke('presets:save', { name, ids }),
    delete: (name) => invoke('presets:delete', name),
  },
  offline: { remember: (opts) => invoke('offline:remember', opts) },
  mods: {
    list: () => invoke('mods:list'),
    resolve: (m) => invoke('mods:resolve', m),
    download: (ids) => invoke('mods:download', ids),
    remove: (ids) => invoke('mods:remove', ids),
    withDependencies: (list) => invoke('mods:withDependencies', list),
    openFolder: (id) => invoke('mods:openFolder', id),
    openPage: (id) => invoke('mods:openPage', id),
  },
  game: { join: (opts) => invoke('game:join', opts) },
  settings: {
    save: (s) => invoke('settings:save', s),
    pickDayzPath: () => invoke('settings:pickDayzPath'),
  },
  openDayz: () => invoke('shell:openDayz'),
  on: (channel, cb) => {
    const allowed = ['workshop:progress', 'join:status'];
    if (!allowed.includes(channel)) return () => {};
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
