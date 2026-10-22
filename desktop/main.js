// The desktop supervisor: one window, one headless SIP daemon, no second app to switch to.
//
// Pulse Dialer is a local server plus a page. This file makes it a Mac app with a *native* phone:
// it starts `desktop/daemon`, tells the server a native phone exists, and pipes JSON both ways.
//
//   renderer ──ipc('sip:command')──▶ main ──stdin──▶ pulse-sip-daemon ──UDP SIP──▶ carrier
//   renderer ◀──ipc('sip:event')──── main ◀──stdout── pulse-sip-daemon ◀──CoreAudio── mic/spk
//
// Three rules shaped it:
//   1. The daemon is a child process, not a service: it dies with the app, restarts with backoff
//      if it crashes, and never outlives the window that spawned it.
//   2. The SIP secret never passes through this file — the daemon reads it from the local API
//      itself (desktop/daemon/lib/credentials.js), so a bug here cannot leak it into a log.
//   3. The server learns the truth by heartbeat, not by configuration. While this process beats
//      the in-app phone is native; the moment it stops, the app falls back to the browser engine.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureServer, stopServer } = require('./lib/serverProcess');

// Electron is required lazily and defensively so this file can also be loaded by a plain Node
// process — which is exactly what `test/unit/desktop-supervisor.test.js` does to prove the
// daemon is really spawned, really answered and really stopped, on a machine with no Electron
// installed. In the app itself the require always succeeds.
let electron = null;
function el() {
  if (!electron) { try { electron = require('electron'); } catch { electron = {}; } }
  return electron;
}
const app = { whenReady: () => Promise.resolve(), on: () => {}, exit: () => {}, quit: () => {}, dock: null };

const REPO = path.join(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const DAEMON_MAIN = path.join(__dirname, 'daemon', 'main.js');
// A compiled launcher, if `desktop/scripts/build-daemon.sh` produced one. Optional: Electron can
// run the daemon's JavaScript directly, which is what happens in development.
const DAEMON_BIN = path.join(__dirname, 'bin', 'pulse-sip-daemon');

const PORT = Number(process.env.PORT || 3001);
const API_BASE = process.env.PULSE_API_BASE || `http://127.0.0.1:${PORT}`;
const HEARTBEAT_MS = 10000;         // the server treats 45 s of silence as "the daemon is gone"
const COMMAND_TIMEOUT_MS = 10000;
const RESTART_DELAYS_MS = [500, 1500, 4000, 10000, 30000];
const DAEMON_VERSION = '1.0.0';

let win = null;
let daemon = null;
let serverChild = null;      // non-null only when this app started the API server itself
let heartbeat = null;
let nextId = 1;
let quitting = false;
let restarts = 0;
let restartTimer = null;
let audioName = '';
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
    pid: daemon?.pid || 0,
    version: DAEMON_VERSION,
    audio: audioName,
  });
  if (res?.ok === false && win && !win.isDestroyed()) {
    win.webContents.send('sip:event', { event: 'supervisor', error: res.error || 'The Pulse API is not answering.' });
  }
  return res;
}

// Beat at once, then every HEARTBEAT_MS — the first beat is what flips the server's in-app engine
// to native, so it must not wait out an interval. And only while a daemon exists: claiming a phone
// that cannot answer is exactly the lie this design prevents.
const startHeartbeat = () => {
  if (heartbeat) clearInterval(heartbeat);
  beat();
  heartbeat = setInterval(() => { if (daemon) beat(); }, HEARTBEAT_MS);
};

/**
 * Ask the server to forget the native phone, so the browser engine takes over immediately instead
 * of 45 s later. The opt-in itself is left set: running the app again is the whole of re-enabling.
 */
async function releasePhone() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  return api('POST', '/api/telephony/native-heartbeat', { clear: true });
}

// --------------------------------------------------------------------------- the daemon
function daemonCommand() {
  // A compiled arm64 launcher wins in a packaged app; otherwise run the daemon's JavaScript with
  // the Electron binary in Node mode — no second runtime to install, no PATH to guess at.
  if (fs.existsSync(DAEMON_BIN)) return { file: DAEMON_BIN, args: [] };
  return { file: process.execPath, args: [DAEMON_MAIN], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function sendToDaemon(payload) {
  if (!daemon || !daemon.stdin.writable) return false;
  try { daemon.stdin.write(`${JSON.stringify(payload)}\n`); return true; } catch { return false; }
}

/**
 * One command, one answer. Events are not answers: they carry no `id`.
 *
 * The daemon echoes `id` back as a *string* (protocol.js normalises it, so a controller cannot be
 * bitten by 1 !== "1"), so the pending map is keyed on the string form too — otherwise every
 * command would time out while the answer sat unread.
 */
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
  let msg = null;
  try { msg = JSON.parse(text); } catch { return; }        // a stray console.log is not a protocol
  const replyId = msg.id === undefined || msg.id === null ? '' : String(msg.id);
  const entry = replyId ? pending.get(replyId) : null;
  if (entry) { pending.delete(replyId); clearTimeout(entry.timer); entry.resolve(msg); return; }
  if (msg.event === 'ready') audioName = msg.audio?.name || '';
  forward(msg);
}

function startDaemon() {
  if (daemon || quitting) return null;
  const { file, args, env } = daemonCommand();
  const child = spawn(file, args, {
    cwd: __dirname,
    env: { ...process.env, ...(env || {}), PULSE_API_BASE: API_BASE },
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
  child.stderr.on('data', (chunk) => process.stderr.write(`[sip] ${chunk}`));

  child.on('error', (e) => forward({ event: 'error', message: `Could not start the SIP daemon: ${e.message}` }));
  child.on('exit', (code, signal) => {
    daemon = null;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: 'The SIP daemon exited.' });
    }
    pending.clear();
    forward({ event: 'shutdown', reason: signal || `exit ${code}` });
    if (quitting) return;
    // A daemon that dies mid-shift must come back, but not in a tight loop: the delays grow, and
    // the renderer is told, so a silent phone is never mistaken for a quiet one.
    const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)];
    restarts += 1;
    forward({ event: 'supervisor', restarting: true, attempt: restarts, delayMs: delay });
    restartTimer = setTimeout(() => { restartTimer = null; startDaemon(); }, delay);
  });

  startHeartbeat();
  return child;
}

function stopDaemon() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const child = daemon;
  daemon = null;
  if (!child) return;
  // Ask politely first (the daemon sends BYE for a live call and unregisters), then insist.
  try { child.stdin.write(`${JSON.stringify({ action: 'shutdown' })}\n`); } catch { /* already gone */ }
  const kill = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, 400);
  kill.unref?.();
}

// --------------------------------------------------------------------------- the window
function createWindow() {
  const { BrowserWindow, shell } = el();
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, show: false,
    backgroundColor: '#0b1020',
    title: 'Pulse Dialer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,      // the renderer talks to the daemon through one narrow bridge
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The preload cannot see this process's environment, so the API origin is passed as an
      // argument. It is what src/api.js prefixes requests with when the page is not served from
      // that origin (a packaged app loading dist/ straight off disk, for instance).
      additionalArguments: [`--pulse-api-base=${API_BASE}`],
    },
  });
  win.once('ready-to-show', () => win?.show());
  // External links belong in the agent's browser, not in a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  if (fs.existsSync(path.join(DIST, 'index.html'))) {
    // The built app is served by the local API server, so every /api call is same-origin and the
    // renderer needs no absolute base. `npm run build` first — the supervisor says so if not.
    win.loadURL(`${API_BASE}/`);
  } else {
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(NO_DIST_PAGE)}`);
  }
  return win;
}

// Shown instead of a blank window when `npm run build` has not run: the three commands that fix
// it, on the page, so nobody has to go looking in a terminal scrollback.
const NO_DIST_PAGE = `<!doctype html><meta charset="utf-8"><title>Pulse Dialer</title><style>
body{background:#0b1020;color:#e6edf3;font:15px/1.7 -apple-system,sans-serif;margin:0;padding:14vh 8vw}
code{background:#161b22;padding:2px 6px;border-radius:6px}p{color:#9fb0c3}</style>
<h1>Pulse Dialer is not built yet</h1><p>In the repository root, then reopen the app:</p>
<p><code>npm install &amp;&amp; npm run build</code></p><p><code>npm start</code> (the API server on port ${PORT})</p>
<p><code>npm run desktop</code></p>`;

// --------------------------------------------------------------------------- lifecycle
function boot() {
  const { app, ipcMain, BrowserWindow } = el();

  // A second launch focuses the running app instead of starting a second daemon on the same
  // microphone — one audio device means one call, and one supervisor means one registration.
  if (app.requestSingleInstanceLock?.() === false) { app.quit(); return; }
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    // The point of the whole exercise: the phone is the app. No dock icon bouncing for a call, no
    // menubar item, no second window — and the daemon itself has no UI at all.
    if (process.platform === 'darwin' && typeof app.dock?.hide === 'function') app.dock.hide();
    app.setLoginItemSettings?.({ openAtLogin: false });

    // Start the API server if nobody else already did, then load its origin (see lib/serverProcess).
    ensureServer(API_BASE, REPO)
      .then((r) => { serverChild = r.child; createWindow(); startDaemon(); })
      .catch((e) => { process.stderr.write(`[supervisor] ${e?.message || e}\n`); createWindow(); startDaemon(); });

    ipcMain.handle('sip:command', (_event, action, payload) => command(String(action || ''), payload || {}));
    ipcMain.handle('sip:status', () => ({
      running: !!daemon, pid: daemon?.pid || null, apiBase: API_BASE, version: DAEMON_VERSION,
      platform: process.platform, arch: process.arch, audio: audioName, restarts,
      binary: fs.existsSync(DAEMON_BIN) ? DAEMON_BIN : null,
    }));
    ipcMain.handle('sip:restart', () => {
      stopDaemon();
      restarts = 0;
      return startDaemon() ? { ok: true } : { ok: false };
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else win?.show();
    });
  });

  app.on('window-all-closed', () => {
    // Closing the window ends the shift: the daemon must not keep a registration (and a
    // microphone) alive with nobody looking at the cockpit. On macOS the app stays resident.
    stopDaemon();
    releasePhone();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', (event) => {
    // Synchronous on purpose: once this returns the process is gone and the server would keep
    // believing a native phone exists for another 45 seconds.
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

// Only the real Electron main process wires the app lifecycle; anything that requires this file
// (a test, a script) gets the supervisor's parts without booting an app.
if (require.main === module) boot();

module.exports = {
  boot, startDaemon, stopDaemon, command, beat, releasePhone, releasePhoneSync, api, forward,
  createWindow, API_BASE, DAEMON_VERSION, DAEMON_BIN, HEARTBEAT_MS,
  // The value the server compares against `native_sip_engine`, re-exported so a test can assert
  // the two sides agree without reaching into the server module.
  NATIVE_ENGINE_NAME: require('../server/services/carrierAccount').NATIVE_ENGINE,
  isRunning: () => !!daemon, pid: () => daemon?.pid || null, restartCount: () => restarts,
  setWindow: (w) => { win = w; },
};
