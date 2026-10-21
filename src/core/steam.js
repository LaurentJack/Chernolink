'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseVdf } = require('./vdf');

const DAYZ_APPID = 221100;

function readRegistry(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`));
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function findSteamPath() {
  const candidates = [
    await readRegistry('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    await readRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    await readRegistry('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'steamapps'))) return path.normalize(c);
  }
  return null;
}

function listLibraries(steamPath) {
  const libs = new Set([path.join(steamPath, 'steamapps')]);
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  try {
    const data = parseVdf(fs.readFileSync(vdfPath, 'utf8'));
    const root = data.libraryfolders || data.LibraryFolders || {};
    for (const entry of Object.values(root)) {
      const p = typeof entry === 'string' ? entry : entry && entry.path;
      if (p) libs.add(path.join(p, 'steamapps'));
    }
  } catch { /* fichier absent : bibliothèque par défaut uniquement */ }
  return [...libs].filter((p) => fs.existsSync(p));
}

/** Repère l'installation de DayZ et son dossier Workshop. */
async function detectInstall() {
  const steamPath = await findSteamPath();
  if (!steamPath) return { steamPath: null, dayzPath: null, workshopPath: null };
  for (const lib of listLibraries(steamPath)) {
    if (!fs.existsSync(path.join(lib, `appmanifest_${DAYZ_APPID}.acf`))) continue;
    let installDir = 'DayZ';
    try {
      const acf = parseVdf(fs.readFileSync(path.join(lib, `appmanifest_${DAYZ_APPID}.acf`), 'utf8'));
      installDir = acf.AppState.installdir || installDir;
    } catch { /* garder la valeur par défaut */ }
    return {
      steamPath,
      dayzPath: path.join(lib, 'common', installDir),
      workshopPath: path.join(lib, 'workshop', 'content', String(DAYZ_APPID)),
      workshopManifest: path.join(lib, 'workshop', `appworkshop_${DAYZ_APPID}.acf`),
    };
  }
  return { steamPath, dayzPath: null, workshopPath: null };
}

function readGameVersion(dayzPath) {
  // La version exacte n'est exposée que dans le binaire ; on se contente du buildid Steam.
  try {
    const lib = path.resolve(dayzPath, '..', '..');
    const acf = parseVdf(fs.readFileSync(path.join(lib, `appmanifest_${DAYZ_APPID}.acf`), 'utf8'));
    return acf.AppState.buildid || null;
  } catch {
    return null;
  }
}

function isProcessRunning(exeName) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(exeName.toLowerCase()));
    });
  });
}

module.exports = { DAYZ_APPID, detectInstall, listLibraries, readGameVersion, isProcessRunning };
