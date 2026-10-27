// Electron supervisor for the API, one window, and a child SIP daemon. A per-process capability
// reaches only the daemon; heartbeat controls which in-app engine the server exposes.
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { ensureServer, stopServer } = require('./lib/serverProcess');

// Lazy import keeps the supervisor testable in plain Node, without Electron installed.
let electron = null;
function el() {
  if (!electron) { try { electron = require('electron'); } catch { electron = {}; } }
  return electron;
}
const app = { whenReady: () => Promise.resolve(), on: () => {}, exit: () => {}, quit: () => {}, dock: null };

const REPO = path.join(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const DAEMON_MAIN = path.join(__dirname, 'daemon', 'main.js');
// The build script may produce a compiled launcher; otherwise Electron runs the JS daemon.
const DAEMON_BIN = path.join(__dirname, 'bin', 'pulse-sip-daemon');

const PORT = Number(process.env.PORT || 3001);
const API_BASE = process.env.PULSE_API_BASE || `http://127.0.0.1:${PORT}`;
const HEARTBEAT_MS = 10000;         // the server treats 45 s of silence as "the daemon is gone"
const COMMAND_TIMEOUT_MS = 10000;
const RESTART_DELAYS_MS = [500, 1500, 4000, 10000, 30000];
const DAEMON_VERSION = '1.0.0';
const DAEMON_TOKEN = crypto.randomBytes(32).toString('hex');

let win = null;
let daemon = null;
let daemonWanted = false;         // explicit stops (window closed/restart) must not look like crashes
let serverChild = null;      // non-null only when this app started the API server itself
let heartbeat = null;
let nextId = 1;
let quitting = false;
let restarts = 0;
let restartTimer = null;
let audioName = '';
let audioErrors = [];
const pending = new Map();          // command id -> { resolve, timer }

// --------------------------------------------------------------------------- local API
async function api(method, urlPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const headers = { 'content-type': 'application/json' };
  try {
    headers['x-pulse-token'] = (await fetch(`${API_BASE}/api/session`, { signal: controller.signal }).then((r) => r.json()))?.token || '';
    const res = await fetch(`${API_BASE}${urlPath}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally { clearTimeout(timer); }
}

/**
 * Tell the server a native phone exists. This is the opt-in as well as the liveness beat: the
 * server switches the in-app engine to native on the first beat and switches back when they stop.
 */
async function beat() {
  const res = await api('POST', '/api/telephony/native-heartbeat', {
    engine: 'pulse-sip-daemon',
    daemonToken: DAEMON_TOKEN,
    pid: daemon?.pid || 0,
    version: DAEMON_VERSION,
    audio: audioName,
  });
  if (res?.ok === false && win && !win.isDestroyed()) {
    win.webContents.send('sip:event', { event: 'supervisor', error: res.error || 'The Pulse API is not answering.' });
  }
  return res;
}

// Beat immediately, then every 10 s while a daemon exists; a missing beat returns ownership.
const startHeartbeat = () => {
  if (heartbeat) clearInterval(heartbeat);
  beat();
  heartbeat = setInterval(() => { if (daemon) beat(); }, HEARTBEAT_MS);
};

/** Clear liveness now; keep the opt-in so the next app launch restores native mode. */
async function releasePhone() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  return api('POST', '/api/telephony/native-heartbeat', { clear: true });
}

// --------------------------------------------------------------------------- the daemon
function daemonCommand() {
  // Prefer the packaged launcher; development runs daemon JS through system Node.
  if (fs.existsSync(DAEMON_BIN)) return { file: DAEMON_BIN, args: [] };
  const nodeBin = process.env.NODE_BINARY || '/Users/gaganrajput11/.nvm/versions/node/v24.16.0/bin/node';
  return { file: nodeBin, args: [DAEMON_MAIN], env: {} };
}

function sendToDaemon(payload) {
  if (!daemon || !daemon.stdin.writable) return false;
  try { daemon.stdin.write(`${JSON.stringify(payload)}\n`); return true; } catch { return false; }
}

/** Match each command reply by its normalized string id; events have no id. */
function command(action, payload = {}) {
  return new Promise((resolve) => {
    if (!daemon) { resolve({ ok: false, error: 'The SIP daemon is not running.' }); return; }
    const id = String(nextId++);
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, error: `The SIP daemon did not answer "${action}" in time.` });
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    if (!sendToDaemon({ id, action, ...payload })) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: 'Could not write to the SIP daemon.' });
    }
  });
}

function forward(event) {
  if (win && !win.isDestroyed()) win.webContents.send('sip:event', event);
}

function onDaemonLine(line) {
  const text = String(line || '').trim();
  if (!text) return;
  try { fs.appendFileSync(path.join(REPO, 'data', 'daemon.log'), `[event] ${text}\n`); } catch { }
  let msg = null;
  try { msg = JSON.parse(text); } catch { return; }        // a stray console.log is not a protocol
  const replyId = msg.id === undefined || msg.id === null ? '' : String(msg.id);
  const entry = replyId ? pending.get(replyId) : null;
  if (entry) { pending.delete(replyId); clearTimeout(entry.timer); entry.resolve(msg); return; }
  if (msg.event === 'ready') { audioName = msg.audio?.name || ''; audioErrors = msg.audioErrors || []; }
  forward(msg);
}

function settlePending(message) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: message });
  }
  pending.clear();
}

function scheduleDaemonRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)];
  restarts += 1;
  forward({ event: 'supervisor', restarting: true, attempt: restarts, delayMs: delay });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (daemonWanted && !quitting) startDaemon();
  }, delay);
}

function startDaemon() {
  if (quitting) return null;
  daemonWanted = true;
  if (daemon) return null;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const { file, args, env } = daemonCommand();
  const child = spawn(file, args, {
    cwd: __dirname,
    env: {
      ...process.env,
      ...(env || {}),
      PULSE_API_BASE: process.env.PULSE_API_BASE !== undefined ? process.env.PULSE_API_BASE : API_BASE,
      PULSE_DAEMON_TOKEN: DAEMON_TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  daemon = child;

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) onDaemonLine(line);
  });
  // The daemon logs on stderr *only*, so the JSON on stdout stays a clean protocol.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[sip] ${chunk}`);
    try { fs.appendFileSync(path.join(REPO, 'data', 'daemon.log'), `[sip] ${chunk}`); } catch { }
  });

  let exited = false;
  const finish = (code, signal, reason) => {
    if (exited) return;
    exited = true;
    // Ignore stale child exits so they cannot clear a replacement or trigger a restart.
    if (daemon !== child) return;
    daemon = null;
    settlePending(reason || 'The SIP daemon exited.');
    forward({ event: 'shutdown', reason: signal || reason || `exit ${code}` });
    if (quitting || !daemonWanted) return;
    // Recover crashes with capped backoff and tell the renderer.
    scheduleDaemonRestart();
  };

  child.on('error', (e) => {
    forward({ event: 'error', message: `Could not start the SIP daemon: ${e.message}` });
    finish(null, null, e.message);
  });
  child.on('exit', (code, signal) => finish(code, signal, 'The SIP daemon exited.'));

  startHeartbeat();
  return child;
}

function stopDaemon() {
  daemonWanted = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const child = daemon;
  daemon = null;                     // mark this child stale before its exit event can run
  settlePending('The SIP daemon was stopped.');
  if (!child) return;
  // Ask politely first (the daemon sends BYE and unregisters), then insist.
  try { child.stdin.write(`${JSON.stringify({ action: 'shutdown' })}\n`); } catch { /* already gone */ }
  const kill = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, 1200);
  kill.unref?.();
}

// --------------------------------------------------------------------------- the window
function createWindow() {
  const { BrowserWindow, shell } = el();
  console.log('[desktop] Creating window...');
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, show: true,
    backgroundColor: '#0b1020',
    title: 'Pulse Dialer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,      // the renderer talks to the daemon through one narrow bridge
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Pass API origin to preload for renderer requests.
      additionalArguments: [`--pulse-api-base=${API_BASE}`],
    },
  });
  win.once('ready-to-show', () => {
    console.log('[desktop] Window ready-to-show');
    win?.show();
    win?.focus();
  });
  const created = win;
  win.on?.('closed', () => { if (win === created) win = null; });
  // External links belong in the agent's browser, not in a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer console ${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`[renderer fail-load] ${code} ${desc} at ${url}`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.error(`[renderer gone]`, details);
  });

  if (fs.existsSync(path.join(DIST, 'index.html'))) {
    // Serve the built renderer from the API origin.
    win.loadURL(`${API_BASE}/`);
  } else {
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(NO_DIST_PAGE)}`);
  }
  return win;
}

// Show actionable build instructions when dist/ is missing.
const NO_DIST_PAGE = `<!doctype html><meta charset="utf-8"><title>Pulse Dialer</title><style>
body{background:#0b1020;color:#e6edf3;font:15px/1.7 -apple-system,sans-serif;margin:0;padding:14vh 8vw}
code{background:#161b22;padding:2px 6px;border-radius:6px}p{color:#9fb0c3}</style>
<h1>Pulse Dialer is not built yet</h1><p>In the repository root, then reopen the app:</p>
<p><code>npm install &amp;&amp; npm run build</code></p><p><code>npm start</code> (the API server on port ${PORT})</p>
<p><code>npm run desktop</code></p>`;

// --------------------------------------------------------------------------- lifecycle
function boot() {
  const { app, ipcMain, BrowserWindow } = el();

  // A second launch focuses this window instead of opening another daemon.
  if (app.requestSingleInstanceLock?.() === false) { app.quit(); return; }
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    // Show in dock on macOS so the window and app icon appear normally
    if (process.platform === 'darwin' && typeof app.dock?.show === 'function') app.dock.show();
    app.setLoginItemSettings?.({ openAtLogin: false });

    // Start the API server if nobody else already did, then load its origin (see lib/serverProcess).
    ensureServer(API_BASE, REPO)
      .then((r) => { serverChild = r.child; createWindow(); startDaemon(); })
      .catch((e) => { process.stderr.write(`[supervisor] ${e?.message || e}\n`); createWindow(); startDaemon(); });

    ipcMain.handle('sip:command', (_event, action, payload) => command(String(action || ''), payload || {}));
    ipcMain.handle('sip:status', () => ({
      running: !!daemon, pid: daemon?.pid || null, apiBase: API_BASE, version: DAEMON_VERSION,
      platform: process.platform, arch: process.arch, audio: audioName, audioErrors, restarts,
      binary: fs.existsSync(DAEMON_BIN) ? DAEMON_BIN : null,
    }));
    ipcMain.handle('sip:restart', () => {
      stopDaemon();
      restarts = 0;
      return startDaemon() ? { ok: true } : { ok: false };
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        startDaemon();
      } else win?.show();
    });
  });

  app.on('window-all-closed', () => {
    // Closing the last window releases the daemon; macOS keeps the app resident.
    stopDaemon();
    releasePhone();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', (event) => {
    // Clear server heartbeat before exit; otherwise native ownership lingers for 45 s.
    quitting = true;
    stopDaemon();
    stopServer(serverChild);
    releasePhoneSync();
    if (typeof event?.preventDefault === 'function') event.preventDefault();
    app.exit(0);
  });
}

/** The will-quit path cannot await, so it shells out to a 20-line script and blocks on it. */
function releasePhoneSync() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  try {
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'release-phone.js'), API_BASE],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', timeout: 3000 });
  } catch { /* the server's heartbeat TTL catches it either way */ }
}

process.on('uncaughtException', (e) => {
  process.stderr.write(`[supervisor] ${e?.stack || e}\n`);
  forward({ event: 'error', message: String(e?.message || e) });
});

// Only Electron's main process wires app lifecycle handlers.
// Note: When Electron 28+ imports packages via dynamic import(), require.main is undefined.
if (require.main === module || !require.main) boot();

module.exports = {
  boot, startDaemon, stopDaemon, command, beat, releasePhone, releasePhoneSync, api, forward,
  createWindow, API_BASE, DAEMON_VERSION, DAEMON_BIN, HEARTBEAT_MS,
  // Shared settings identity, exported for supervisor tests.
  NATIVE_ENGINE_NAME: 'pulse-sip-daemon',
  isRunning: () => !!daemon, pid: () => daemon?.pid || null, restartCount: () => restarts,
  setWindow: (w) => { win = w; },
};
