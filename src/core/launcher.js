'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isProcessRunning } = require('./steam');

/**
 * Lance DayZ. Avec BattlEye, on passe par DayZ_BE.exe comme le launcher officiel
 * (« <mode> 1 <BE> -exe DayZ_x64.exe <args> ») ; sans, on lance DayZ_x64.exe directement
 * (utile pour les serveurs LAN sans BattlEye).
 */
async function launchGame(install, { server, modParam, password, settings }) {
  if (!install.dayzPath) throw new Error('Installation de DayZ introuvable');
  if (!(await isProcessRunning('steam.exe'))) throw new Error('Steam doit être lancé pour jouer à DayZ');
  if (await isProcessRunning('DayZ_x64.exe')) throw new Error('DayZ est déjà en cours d\'exécution');

  const args = ['-nolauncher', '-nosplash', '-skipIntro', '-world=empty'];
  if (settings.profileName) args.push(`-name=${settings.profileName}`);
  if (server) {
    args.push(`-connect=${server.ip}`, `-port=${server.gamePort}`);
    if (password) args.push(`-password=${password}`);
  }
  if (modParam) args.push(`-mod=${modParam}`);
  if (settings.extraArgs) args.push(...settings.extraArgs.split(/\s+/).filter(Boolean));

  const useBE = settings.battlEye !== false && (!server || server.battlEye !== false);
  const beExe = path.join(install.dayzPath, 'DayZ_BE.exe');
  const gameExe = path.join(install.dayzPath, 'DayZ_x64.exe');

  let exe;
  let fullArgs;
  if (useBE && fs.existsSync(beExe)) {
    exe = beExe;
    fullArgs = ['0', '1', '1', '-exe', 'DayZ_x64.exe', ...args];
  } else {
    exe = gameExe;
    fullArgs = args;
  }

  const child = spawn(exe, fullArgs, { cwd: install.dayzPath, detached: true, stdio: 'ignore' });
  child.unref();
  return { exe, args: fullArgs.map((a) => (a.startsWith('-password=') ? '-password=***' : a)) };
}

module.exports = { launchGame };
