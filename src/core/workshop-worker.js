'use strict';

/**
 * Processus utilitaire isolé qui pilote le client Steam via Steamworks
 * (abonnement, téléchargement et mise à jour des mods Workshop).
 * Il s'arrête après une période d'inactivité pour que Steam ne vous
 * affiche pas indéfiniment « en jeu sur DayZ ».
 */
const port = process.parentPort;
const IDLE_EXIT_MS = 30_000;

const STATE = { SUBSCRIBED: 1, INSTALLED: 4, NEEDS_UPDATE: 8, DOWNLOADING: 16, PENDING: 32 };

let client = null;
let busy = false;
const queue = [];
let idleTimer = null;

function post(msg) { port.postMessage(msg); }

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!busy && !queue.length) process.exit(0); }, IDLE_EXIT_MS);
}

function ensureClient() {
  if (client) return client;
  const steamworks = require('steamworks.js');
  client = steamworks.init(221100);
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadOne(id, index, total) {
  const ugc = client.workshop;
  const big = BigInt(id);
  if (!(ugc.state(big) & STATE.SUBSCRIBED)) await ugc.subscribe(big);
  ugc.download(big, true);

  const started = Date.now();
  let lastProgress = Date.now();
  let lastBytes = -1n;
  for (;;) {
    const st = ugc.state(big);
    const info = ugc.downloadInfo(big);
    const current = info ? Number(info.current) : 0;
    const totalBytes = info ? Number(info.total) : 0;
    post({ type: 'progress', id, index, total, current, totalBytes, state: st });

    const done = (st & STATE.INSTALLED) && !(st & (STATE.NEEDS_UPDATE | STATE.DOWNLOADING | STATE.PENDING));
    if (done && Date.now() - started > 800) return;

    if (info && info.current !== lastBytes) { lastBytes = info.current; lastProgress = Date.now(); }
    // Steam peut mettre un moment à démarrer ; au-delà de 3 min sans progrès on abandonne.
    if (Date.now() - lastProgress > 180_000) throw new Error(`Téléchargement bloqué pour le mod ${id}`);
    if (!(st & (STATE.DOWNLOADING | STATE.PENDING)) && !done) ugc.download(big, true);
    await sleep(500);
  }
}

async function handle(job) {
  try {
    ensureClient();
  } catch (e) {
    post({ type: 'error', jobId: job.jobId, message: `Impossible de contacter Steam : lancez Steam et connectez-vous avec le compte qui possède DayZ. (${e.message})` });
    return;
  }
  try {
    if (job.cmd === 'download') {
      for (let n = 0; n < job.ids.length; n++) {
        await downloadOne(job.ids[n], n, job.ids.length);
        post({ type: 'item-done', jobId: job.jobId, id: job.ids[n] });
      }
    } else if (job.cmd === 'unsubscribe') {
      for (const id of job.ids) await client.workshop.unsubscribe(BigInt(id));
    } else if (job.cmd === 'states') {
      const states = {};
      for (const id of job.ids) states[id] = client.workshop.state(BigInt(id));
      post({ type: 'states', jobId: job.jobId, states });
    }
    post({ type: 'done', jobId: job.jobId });
  } catch (e) {
    post({ type: 'error', jobId: job.jobId, message: e.message });
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  clearTimeout(idleTimer);
  while (queue.length) await handle(queue.shift());
  busy = false;
  armIdle();
}

port.on('message', (e) => { queue.push(e.data); pump(); });
armIdle();
