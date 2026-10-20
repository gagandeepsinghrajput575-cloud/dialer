// BrowserWindow factory. Two details carry the whole fix for the browser failure mode:
//   1. `autoplayPolicy: 'no-user-gesture-required'` — the renderer's AudioContext is never
//      suspended, so remote RTP has an output device the instant it arrives.
//   2. `backgroundThrottling: false` — a call does not stutter when the window is hidden.
const path = require('path');
const { BrowserWindow, session, systemPreferences, shell } = require('electron');

const PRELOAD = path.join(__dirname, 'preload.js');
const originFor = (port) => `http://127.0.0.1:${port}`;

function createWindow({ port, show = true }) {
  const origin = originFor(port);
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  win.loadURL(origin);
  win.once('ready-to-show', () => { if (show) win.show(); });

  // The shell is an app, not a browser: links open outside, and nothing can navigate away
  // from the local instance (a phished link must not replace the CRM with a lookalike).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });

  return win;
}

// Microphone access is granted to this app's own origin only, once, at startup.
function grantMicrophone(port) {
  const origin = originFor(port);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requesting = (details && details.requestingUrl) || (webContents && webContents.getURL()) || '';
    callback(permission === 'media' && requesting.startsWith(origin));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    permission === 'media' && String(requestingOrigin || '').startsWith(origin)
  ));
  if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }
}

module.exports = { createWindow, grantMicrophone, originFor, PRELOAD };
