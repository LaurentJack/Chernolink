'use strict';

const fs = require('fs');
const path = require('path');

/** Petit stockage JSON persistant (paramètres, favoris, historique, serveurs LAN/manuels). */
class Store {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { /* premier lancement */ }
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

const DEFAULTS = {
  settings: {
    profileName: '',
    battlEye: true,
    extraArgs: '',
    dayzPath: '',
    autoUpdateMods: true,
    pingOnLoad: true,
  },
  favorites: [],
  history: [], // { id, ip, gamePort, queryPort, name, lastPlayed }
  manualServers: [], // { ip, queryPort }
  modPresets: [], // { name, ids: [] } — sélections de mods pour lancer hors serveur
  offlineLaunch: { ids: [], battlEye: false }, // dernière sélection utilisée

};

module.exports = { Store, DEFAULTS };
