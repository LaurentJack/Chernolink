'use strict';

const fs = require('fs');
const path = require('path');
const { parseVdf } = require('./vdf');

const DETAILS_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
// Dossier de jonctions créé dans le dossier de DayZ (chemins courts et sans espaces pour -mod=).
const LINK_DIR = '!dzl';

function readCppValue(file, key) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^";\\r\\n]*)"?\\s*;`, 'mi'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readWorkshopManifest(manifestPath) {
  try {
    const acf = parseVdf(fs.readFileSync(manifestPath, 'utf8')).AppWorkshop || {};
    return acf.WorkshopItemsInstalled || {};
  } catch {
    return {};
  }
}

/** Liste les mods Workshop téléchargés localement. */
function listInstalled(install) {
  if (!install.workshopPath || !fs.existsSync(install.workshopPath)) return [];
  const manifest = readWorkshopManifest(install.workshopManifest);
  const mods = [];
  for (const id of fs.readdirSync(install.workshopPath)) {
    if (!/^\d+$/.test(id)) continue;
    const dir = path.join(install.workshopPath, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const entry = manifest[id] || {};
    mods.push({
      id,
      name: readCppValue(path.join(dir, 'meta.cpp'), 'name')
        || readCppValue(path.join(dir, 'mod.cpp'), 'name')
        || id,
      path: dir,
      size: Number(entry.size) || 0,
      // Absent du manifeste : dossier resté sur le disque après un désabonnement.
      tracked: !!manifest[id],
      localUpdated: Number(entry.timeupdated) || Math.floor(fs.statSync(dir).mtimeMs / 1000),
    });
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name));
}

/** Détails publics des items Workshop (aucune clé API requise). */
async function fetchDetails(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const body = new URLSearchParams({ itemcount: String(batch.length) });
    batch.forEach((id, n) => body.append(`publishedfileids[${n}]`, id));
    const res = await fetch(DETAILS_URL, { method: 'POST', body });
    if (!res.ok) throw new Error(`API Steam Workshop indisponible (HTTP ${res.status})`);
    const data = await res.json();
    for (const d of data.response.publishedfiledetails || []) {
      if (d.result !== 1) { out[d.publishedfileid] = { missing: true }; continue; }
      out[d.publishedfileid] = {
        title: d.title,
        remoteUpdated: d.time_updated,
        size: Number(d.file_size) || 0,
        preview: d.preview_url,
        subscriptions: d.lifetime_subscriptions,
      };
    }
  }
  return out;
}

/** Fusionne l'état local et distant pour signaler les mises à jour. */
async function checkUpdates(install) {
  const local = listInstalled(install);
  const details = await fetchDetails(local.map((m) => m.id)).catch(() => ({}));
  return local.map((m) => {
    const d = details[m.id] || {};
    return {
      ...m,
      name: m.name === m.id && d.title ? d.title : m.name,
      size: m.size || d.size || 0,
      orphan: !m.tracked,
      remoteUpdated: d.remoteUpdated || null,
      preview: d.preview || null,
      removed: !!d.missing,
      outdated: m.tracked && !!d.remoteUpdated && d.remoteUpdated > m.localUpdated,
    };
  }).sort((a, b) => (b.outdated - a.outdated) || (a.orphan - b.orphan) || a.name.localeCompare(b.name));
}

/** Statut des mods requis par un serveur : installé / à mettre à jour / manquant. */
async function resolveServerMods(install, serverMods) {
  const ids = serverMods.map((m) => m.id);
  const localById = Object.fromEntries(listInstalled(install).map((m) => [m.id, m]));
  const details = await fetchDetails(ids).catch(() => ({}));
  return serverMods.map((m) => {
    const local = localById[m.id];
    const d = details[m.id] || {};
    let status = 'missing';
    if (local) status = d.remoteUpdated && d.remoteUpdated > local.localUpdated ? 'outdated' : 'ok';
    return { ...m, status, size: d.size || (local && local.size) || 0, removed: !!d.missing };
  });
}

/**
 * Crée des jonctions DayZ\!dzl\@<id> → dossier Workshop et renvoie la valeur du paramètre -mod.
 * Repli sur les chemins absolus si le dossier du jeu n'est pas accessible en écriture.
 */
function buildModParam(install, ids) {
  const linkRoot = path.join(install.dayzPath, LINK_DIR);
  const parts = [];
  let canLink = true;
  try { fs.mkdirSync(linkRoot, { recursive: true }); } catch { canLink = false; }

  for (const id of ids) {
    const target = path.join(install.workshopPath, id);
    if (!fs.existsSync(target)) throw new Error(`Le mod ${id} n'est pas téléchargé`);
    if (canLink) {
      const link = path.join(linkRoot, `@${id}`);
      try {
        let current = null;
        try { current = fs.readlinkSync(link); } catch { /* inexistant */ }
        if (!current || path.resolve(current) !== path.resolve(target)) {
          if (current !== null || fs.existsSync(link)) fs.rmSync(link, { recursive: false, force: true });
          fs.symlinkSync(target, link, 'junction');
        }
        parts.push(`${LINK_DIR}\\@${id}`);
        continue;
      } catch { /* repli ci-dessous */ }
    }
    parts.push(target);
  }
  return parts.join(';');
}

/** Supprime les jonctions qui pointent vers des mods désinstallés. */
function cleanupLinks(install) {
  const linkRoot = path.join(install.dayzPath || '', LINK_DIR);
  if (!install.dayzPath || !fs.existsSync(linkRoot)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(linkRoot)) {
    const link = path.join(linkRoot, name);
    try {
      if (!fs.existsSync(fs.readlinkSync(link))) { fs.rmSync(link, { force: true }); removed++; }
    } catch { /* pas une jonction */ }
  }
  return removed;
}

/** Supprime du disque des dossiers orphelins (non suivis par Steam). */
function removeOrphans(install, ids) {
  const tracked = new Set(listInstalled(install).filter((m) => m.tracked).map((m) => m.id));
  for (const id of ids) {
    if (!/^d+$/.test(id) || tracked.has(id)) continue;
    fs.rmSync(path.join(install.workshopPath, id), { recursive: true, force: true });
  }
  cleanupLinks(install);
}

module.exports = { removeOrphans, listInstalled, fetchDetails, checkUpdates, resolveServerMods, buildModParam, cleanupLinks, LINK_DIR };
