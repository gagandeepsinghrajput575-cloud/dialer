// The local API server, as the desktop app sees it.
//
// Pulse Dialer is a server plus a page. In a browser the human starts the server (`npm start`)
// and the tab follows. In the desktop app that is two terminal windows too many, so the
// supervisor settles it here:
//
//   * something already answers on the API port → use it, and leave it alone on quit. That is a
//     `npm run dev` server, or a second window, and killing it would be rude;
//   * nothing answers → start `server/index.js` as a child of the app, and stop it on the way out.
//
// Either way the window loads the *server's* origin, so every `/api` call in the renderer is
// same-origin and needs no absolute base URL.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PROBE_MS = 1200;
const PROBE_TRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does something already serve the API? Never throws: "no" is a perfectly good answer. */
async function probe(apiBase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_MS);
  try {
    const res = await fetch(`${apiBase}/api/session`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} apiBase  e.g. http://127.0.0.1:3001
 * @param {string} repo     the repository root (server/index.js lives there)
 * @returns {Promise<{external: boolean, child: object|null}>}
 */
async function ensureServer(apiBase, repo) {
  for (let i = 0; i < PROBE_TRIES; i++) {
    if (await probe(apiBase)) return { external: true, child: null };
    await sleep(400);
  }

  const entry = path.join(repo, 'server', 'index.js');
  const nodeBin = process.env.NODE_BINARY || '/Users/gaganrajput11/.nvm/versions/node/v24.16.0/bin/node';
  const child = spawn(nodeBin, [entry], {
    cwd: repo,
    // Node mode: this file runs inside Electron, which is not a Node binary by default.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  child.on('error', (e) => process.stderr.write(`[server] could not start: ${e.message}\n`));

  // Migrations plus better-sqlite3 opening the database take a moment on a cold start.
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) break;
    if (await probe(apiBase)) return { external: false, child };
    await sleep(250);
  }
  return { external: false, child };
}

/** Stop a server we started, and only one we started. */
function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2500);
  force.unref?.();
}

module.exports = { ensureServer, stopServer, probe, PROBE_MS, PROBE_TRIES };
