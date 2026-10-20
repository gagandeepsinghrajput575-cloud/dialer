// The desktop shell's contract with the OS and with the renderer. Electron itself cannot run in
// this Linux CI, so the parts that would fail silently on a Mac are pinned as source/metadata
// assertions: the preload surface, the autoplay unlock, microphone scoping, the packaging
// entitlements, and a renderer facade that stays inert in a browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('--- Unit: Native desktop shell contract (preload, window, packaging) ---');

(async () => {
  // ---- preload: the only bridge into the renderer -------------------------------------
  const preload = read('desktop/preload.js');
  for (const method of ['status', 'dial', 'answer', 'decline', 'hangup', 'dtmf', 'openSoftphone', 'state', 'onEvent', 'onCommand']) {
    assert.ok(new RegExp(`\\b${method}:`).test(preload), `pulseDesktop.${method} must exist`);
  }
  assert.ok(preload.includes("contextBridge.exposeInMainWorld('pulseDesktop'"), 'the API is exposed through contextBridge');
  assert.ok(preload.includes('Object.freeze'), 'the renderer cannot mutate the bridge');
  assert.ok(!/exposeInMainWorld\('pulseDesktop',\s*ipcRenderer/.test(preload), 'ipcRenderer is never handed to the page');
  console.log('  ✓ preload exposes a frozen, explicit IPC surface and no raw ipcRenderer');

  // ---- window: the actual fix for the browser failure mode ----------------------------
  const windowSource = read('desktop/window.js');
  assert.ok(windowSource.includes("autoplayPolicy: 'no-user-gesture-required'"), 'AudioContext is never suspended');
  assert.ok(windowSource.includes('backgroundThrottling: false'), 'a hidden window keeps the call alive');
  assert.ok(windowSource.includes('contextIsolation: true'));
  assert.ok(windowSource.includes('nodeIntegration: false'));
  assert.ok(windowSource.includes('sandbox: true'));
  assert.ok(windowSource.includes("permission === 'media'"), 'only microphone permission is granted');
  assert.ok(windowSource.includes('setPermissionCheckHandler'), 'permission checks are scoped, not just prompts');
  assert.ok(windowSource.includes('will-navigate'), 'the shell cannot navigate away from the local app');
  console.log('  ✓ BrowserWindow unlocks autoplay, survives backgrounding and scopes microphone access');

  // ---- menu, badge and notifications ---------------------------------------------------
  const menu = read('desktop/menu.js');
  for (const accelerator of ['CmdOrCtrl+Shift+D', 'CmdOrCtrl+Shift+A', 'CmdOrCtrl+Shift+H']) {
    assert.ok(menu.includes(accelerator), `${accelerator} is wired`);
  }
  assert.ok(menu.includes('setBadge') && menu.includes('Notification'), 'dock badge and a native ring exist');
  assert.ok(menu.includes("label: 'Open in Linphone'") || menu.includes('Dial clipboard in Linphone'), 'the E/A handoff is in the menu');
  console.log('  ✓ menu bar carries dial/answer/hangup accelerators, badge, notification and Linphone handoff');

  // ---- main process --------------------------------------------------------------------
  const main = read('desktop/main.js');
  assert.ok(main.includes('requestSingleInstanceLock'), 'one shell instance owns the phone');
  assert.ok(main.includes('setAsDefaultProtocolClient'), 'pulse:// is registered with the OS');
  assert.ok(main.includes("app.on('open-url'"), 'macOS deep links are handled');
  assert.ok(main.includes('PULSE_DESKTOP_ENGINE'), 'the native SIP engine can be selected');
  assert.ok(main.includes('SipTransport') && main.includes('SipUserAgent'), 'the native SIP engine is wired, not stubbed');
  assert.ok(main.includes('LedgerClient'), 'native calls write the CRM ledger');
  assert.ok(main.includes('LinphoneDaemon') && main.includes('resolveBinary'), 'the in-app Linphone engine is wired');
  assert.ok(/ENGINE === 'linphone' \|\| \(ENGINE === 'auto' && binary\)/.test(main), 'auto prefers the in-app engine');
  assert.ok(main.includes("bridge.status(), requestedEngine: ENGINE"), 'status reports the engine actually running');
  assert.ok(main.includes('canAnswer') || main.includes('media: true'), 'the engine advertises whether it can answer');
  console.log('  ✓ main process: single instance, deep links, in-app + native SIP engines, ledger');

  // The renderer must consume the shell's events; a preload API nobody calls is a silent phone.
  const native = read('src/desktop/nativeInbound.mjs');
  assert.ok(native.includes('onEvent'), 'the renderer subscribes to pulse:event');
  assert.ok(read('src/softphone.jsx').includes('useNativeInbound'), 'the cockpit mounts the native inbound hook');
  assert.ok(read('src/softphone.jsx').includes('native.answer'), 'answering a native ring goes through IPC');

  // ---- packaging -----------------------------------------------------------------------
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.main, 'desktop/main.js');
  assert.ok(String(pkg.scripts.desktop).includes('electron'), 'npm run desktop launches the shell');
  assert.ok(String(pkg.scripts['desktop:dist']).includes('electron-builder'), 'npm run desktop:dist packages a DMG');
  assert.ok(String(pkg.scripts['desktop:linphone']).includes('PULSE_DESKTOP_ENGINE=linphone'), 'the in-app engine has its own entry point');
  assert.ok(String(pkg.scripts['desktop:check']).includes('where-is-linphone'), 'the engine can be checked before a call');
  assert.ok(pkg.devDependencies.electron, 'electron is a declared dev dependency');
  assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder is a declared dev dependency');

  const builder = read('electron-builder.yml');
  assert.match(builder, /NSMicrophoneUsageDescription/, 'macOS shows the microphone usage string');
  assert.match(builder, /arm64/);
  assert.match(builder, /x64/, 'both Apple Silicon and Intel are targeted');
  assert.match(builder, /entitlements\.mac\.plist/);
  assert.match(builder, /better-sqlite3/, 'the native SQLite module is unpacked from the asar');
  assert.match(builder, /extraResources/);
  assert.match(builder, /linphone\/bin/, 'the in-app engine ships inside the bundle when present');

  const entitlements = read('desktop/entitlements.mac.plist');
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /com\.apple\.security\.network\.client/);
  assert.match(entitlements, /com\.apple\.security\.network\.server/);
  console.log('  ✓ packaging: signed mic entitlement, x64 + arm64 DMGs, unpacked SQLite');

  // ---- renderer facade: inert on the web, live under the shell ------------------------
  const facade = await import(pathToFileURL(path.join(ROOT, 'src', 'desktop', 'bridge.mjs')).href);
  assert.strictEqual(facade.desktopBridge(), null, 'a browser has no desktop bridge');
  assert.strictEqual(facade.isDesktop(), false);
  assert.strictEqual(typeof facade.onDesktopCommand(() => {}), 'function', 'the no-op unsubscribe is callable');
  assert.doesNotThrow(() => facade.pushDesktopState({ type: 'idle' }));
  assert.strictEqual(facade.openInSoftphone('+4520123456'), false);

  const observed = [];
  let commandHandler = null;
  global.window = {
    pulseDesktop: {
      status: async () => ({ engine: 'webrtc', registered: false }),
      state: (payload) => { observed.push(payload); return Promise.resolve({ ok: true }); },
      openSoftphone: (phone) => { observed.push({ handoff: phone }); return Promise.resolve({ ok: true }); },
      onCommand: (handler) => { commandHandler = handler; return () => { commandHandler = null; }; },
    },
  };
  assert.strictEqual(facade.isDesktop(), true);
  let received = null;
  const unsubscribe = facade.onDesktopCommand((command) => { received = command; });
  assert.strictEqual(typeof commandHandler, 'function', 'the renderer subscribes to menu commands');
  commandHandler({ action: 'dial', phone: '+4520123456' });
  assert.deepStrictEqual(received, { action: 'dial', phone: '+4520123456' });
  facade.pushDesktopState({ type: 'incoming', callerPhone: '+4532331610' });
  assert.strictEqual(facade.openInSoftphone('+4520123456'), true);
  await Promise.resolve();
  assert.deepStrictEqual(observed[0], { type: 'incoming', callerPhone: '+4532331610' });
  assert.deepStrictEqual(observed[1], { handoff: '+4520123456' });
  unsubscribe();
  assert.strictEqual(commandHandler, null);
  delete global.window;
  console.log('  ✓ renderer facade is inert on the web, relays commands and state under Electron');

  console.log('\n🎉 [unit:shell] desktop shell contract checks passed\n');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
