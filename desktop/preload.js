// The only door between the renderer and the native SIP daemon.
//
// `contextIsolation` is on and `nodeIntegration` is off, so the page cannot reach `ipcRenderer`,
// the filesystem or the child process. What it gets is exactly this object — four functions and
// two strings — which is the whole surface a softphone UI needs:
//
//   window.pulseNativeSip.command(action, payload) -> Promise<reply>   one command, one answer
//   window.pulseNativeSip.onEvent(fn)              -> unsubscribe      the daemon's event stream
//   window.pulseNativeSip.status()                 -> Promise<info>    is the daemon alive?
//   window.pulseNativeSip.restart()                -> Promise<ok>      after a crash or a config change
//   window.pulseNativeSip.apiBase                                      the local API origin
//   window.pulseNativeSip.available                                    always true in here
//
// `src/nativeSip.js` is the only consumer. In a plain browser tab none of this exists, which is
// how the renderer decides to use the browser engine instead — no flag to configure, no way to
// get it wrong.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const COMMAND_TIMEOUT_MS = 15000;   // a little longer than the supervisor's own timeout, so the
                                    // renderer hears the daemon's answer rather than its own guess

/**
 * Every listener gets both the daemon's events and the supervisor's own notices
 * (`{ event: 'supervisor', … }`), because "the daemon is restarting" is something the cockpit
 * has to be able to say out loud.
 */
function onEvent(listener) {
  if (typeof listener !== 'function') return () => {};
  const handler = (_event, payload) => {
    try { listener(payload); } catch { /* a throwing UI handler must not kill the stream */ }
  };
  ipcRenderer.on('sip:event', handler);
  return () => { try { ipcRenderer.removeListener('sip:event', handler); } catch { /* already gone */ } };
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `The desktop app did not answer "${what}" in time.` }), ms)),
  ]);
}

contextBridge.exposeInMainWorld('pulseNativeSip', {
  available: true,
  // Filled in by the supervisor before the page loads (see `webPreferences.additionalArguments`
  // in desktop/main.js) and read by src/api.js, which prefixes every request with it when the
  // page is not served from the API's own origin.
  apiBase: (() => {
    const arg = process.argv.find((a) => String(a).startsWith('--pulse-api-base='));
    return arg ? String(arg).slice('--pulse-api-base='.length) : '';
  })(),
  platform: process.platform,
  arch: process.arch,
  command: (action, payload) => withTimeout(
    ipcRenderer.invoke('sip:command', String(action || ''), payload || {}), COMMAND_TIMEOUT_MS, action,
  ),
  status: () => withTimeout(ipcRenderer.invoke('sip:status'), COMMAND_TIMEOUT_MS, 'status'),
  restart: () => withTimeout(ipcRenderer.invoke('sip:restart'), COMMAND_TIMEOUT_MS, 'restart'),
  onEvent,
});
