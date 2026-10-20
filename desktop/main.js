// Electron entry point. Boots the same Express + SQLite backend on loopback, opens the React
// bundle in a native window, and owns the telephony bridge for the lifetime of the app.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, ipcMain, dialog, shell, clipboard } = require('electron');

// Must precede any require of server/*: env.js resolves DATA_DIR and PORT at module load.
process.env.DATA_DIR = process.env.DATA_DIR || path.join(app.getPath('userData'), 'data');
process.env.PORT = process.env.PORT || process.env.PULSE_DESKTOP_PORT || '3001';

const { createWindow, grantMicrophone } = require('./window');
const { buildMenu, setBadge, notifyIncoming } = require('./menu');
const { TelephonyBridge } = require('./bridge');
const { LedgerClient } = require('./ledger');
const { SipTransport } = require('./sip/transport');
const { SipUserAgent } = require('./sip/ua');
const { LinphoneDaemon, resolveBinary } = require('./telephony/linphoneDaemon');
const { CARRIER, parseDeepLink, sipUri } = require('./config');

const PORT = Number(process.env.PORT) || 3001;
// auto (default): the in-app Linphone engine when its binary is present, otherwise the
// in-window WebRTC engine. Both carry audio inside the app; native-sip is signalling-only and
// must be asked for explicitly.
const REQUESTED_ENGINE = String(process.env.PULSE_DESKTOP_ENGINE || 'auto').toLowerCase();
const ENGINE = ['auto', 'linphone', 'webrtc', 'native-sip'].includes(REQUESTED_ENGINE) ? REQUESTED_ENGINE : 'auto';

let win = null;
let bridge = null;
let ua = null;
let server = null;

const isDev = !app.isPackaged;
const sendToRenderer = (payload) => {
  if (win && !win.isDestroyed() && win.webContents) win.webContents.send(payload.type ? 'pulse:event' : 'pulse:command', payload);
};
const sendCommand = (action, payload = {}) => {
  if (win && !win.isDestroyed()) win.webContents.send('pulse:command', { action, ...payload });
};
const openExternalUri = (uri) => { if (uri) shell.openExternal(uri).catch(() => {}); };

function localAddress() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function carrierCredentials() {
  const settings = require('../server/repositories/settingsRepo');
  return {
    user: String(settings.get('telnyx_sip_user') || '').trim() || CARRIER.user,
    password: String(settings.get('telnyx_sip_password') || ''),
    domain: String(settings.get('telnyx_sip_server') || '').trim() || CARRIER.domain,
  };
}

// The in-app engine: a headless Linphone child process whose media path is CoreAudio. This is
// the engine that can actually answer a call with two-way audio inside the app.
function createLinphoneEngine(binary) {
  const config = carrierCredentials();
  const daemon = new LinphoneDaemon({
    config,
    binary,
    onEvent: (event) => {
      if (event.type === 'engine') sendToRenderer(event);
    },
  });
  const engine = new TelephonyBridge({
    ua: daemon,
    media: true,
    ledger: new LedgerClient({ baseUrl: `http://127.0.0.1:${PORT}` }),
    emit: (event) => {
      sendToRenderer(event);
      if (event.type === 'incoming_call') { setBadge(1); notifyIncoming(event); }
      if (event.type === 'ended') setBadge(0);
    },
    forward: sendCommand,
    handoff: openExternalUri,
  }).start();
  daemon.start();
  return engine;
}

// Native signalling engine: real REGISTER/INVITE over UDP 5060. Media is delegated to the OS
// softphone, because a CoreAudio RTP pipeline cannot be built in this toolchain.
function createNativeEngine() {
  // Required lazily: the database (and therefore the credential) only exists after boot.
  const { user, password, domain } = carrierCredentials();

  const transport = new SipTransport({ host: domain, port: CARRIER.port, protocol: 'udp', onError: (err) => sendToRenderer({ type: 'transport_error', message: err.message }) });
  ua = new SipUserAgent({
    config: { user, password, domain, transport: 'udp', displayName: 'Pulse Dialer', contactHost: localAddress() },
    transport,
  });
  const nativeBridge = new TelephonyBridge({
    ua,
    media: false,          // signalling-only: audio is handed to Linphone, never faked
    ledger: new LedgerClient({ baseUrl: `http://127.0.0.1:${PORT}` }),
    emit: (event) => {
      sendToRenderer(event);
      if (event.type === 'incoming_call') { setBadge(1); notifyIncoming(event); }
      if (event.type === 'ended') setBadge(0);
    },
    forward: sendCommand,
    handoff: openExternalUri,
  }).start();
  ua.start();
  return nativeBridge;
}

function createWebRtcBridge() {
  // Audio stays in the renderer; the shell mirrors state for the dock and relays menu commands.
  return new TelephonyBridge({
    ledger: null,
    forward: sendCommand,
    emit: () => {},
    handoff: openExternalUri,
  }).start();
}

function registerIpc() {
  ipcMain.handle('pulse:status', () => ({ ...bridge.status(), requestedEngine: ENGINE, shell: 'desktop' }));
  ipcMain.handle('pulse:dial', (_event, payload) => bridge.dial(payload || {}));
  ipcMain.handle('pulse:answer', () => bridge.answer());
  ipcMain.handle('pulse:decline', () => bridge.decline());
  ipcMain.handle('pulse:hangup', () => bridge.hangup());
  ipcMain.handle('pulse:dtmf', (_event, payload) => bridge.dtmf(payload || {}));
  ipcMain.handle('pulse:open-softphone', (_event, payload) => bridge.openSoftphone((payload && payload.phone) || '', (payload && payload.protocol) || 'sip'));
  ipcMain.handle('pulse:state', (_event, state) => {
    if (!state) return { ok: false };
    if (state.type === 'incoming') { setBadge(1); notifyIncoming(state); }
    if (state.type === 'idle' || state.type === 'ended') setBadge(0);
    return { ok: true };
  });
}

function routeDeepLink(url) {
  const link = parseDeepLink(url);
  if (!link) return;
  if (win && !win.isDestroyed()) win.show();
  sendCommand('dial', { phone: link.phone });
}

function bootTelephony() {
  const binary = resolveBinary();
  if (ENGINE === 'linphone' || (ENGINE === 'auto' && binary)) {
    bridge = createLinphoneEngine(binary);
  } else if (ENGINE === 'native-sip') {
    bridge = createNativeEngine();
  } else {
    if (ENGINE !== 'auto') console.warn('[desktop] linphone-daemon not found — falling back to the in-window engine');
    bridge = createWebRtcBridge();
  }
  registerIpc();
  buildMenu({
    send: sendCommand,
    openSoftphone: (phone) => {
      const number = phone || String(clipboard.readText() || '').trim();
      if (number) openExternalUri(sipUri(number));
    },
    isDev,
  });
}

async function boot() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', (_event, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    const deepLink = argv.find((arg) => String(arg).startsWith('pulse://'));
    if (deepLink) routeDeepLink(deepLink);
  });

  await app.whenReady();
  app.setAsDefaultProtocolClient('pulse');
  grantMicrophone(PORT);

  if (!fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html'))) {
    dialog.showErrorBox('Pulse Dialer is not built', 'Run `npm run build` before starting the desktop shell.');
    app.quit();
    return;
  }

  const backend = require('../server/index');
  server = await backend.main();

  bootTelephony();
  win = createWindow({ port: PORT });
  win.webContents.once('did-finish-load', () => sendToRenderer({ type: 'engine', ...bridge.status() }));
  win.on('closed', () => { win = null; });

  app.on('activate', () => { if (!win) win = createWindow({ port: PORT }); });
  app.on('open-url', (event, url) => { event.preventDefault(); routeDeepLink(url); });
  app.on('before-quit', () => {
    if (bridge) bridge.stop();
    if (ua) ua.stop();
    if (server) server.close();
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
boot().catch((err) => {
  console.error('[desktop] failed to start:', err);
  dialog.showErrorBox('Pulse Dialer failed to start', String((err && err.message) || err));
  app.quit();
});
