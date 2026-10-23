// The carrier account the headless native SIP daemon registers with.
//
// Pulse has two in-app calling engines behind one settings screen:
//   * the browser engine (sip.js over `wss://`) — needs a WebRTC gateway on the carrier side;
//   * the native daemon (`desktop/daemon`) — plain SIP over UDP straight to the carrier, with
//     CoreAudio for the microphone and speaker. For a trunk like FlyNumber, which publishes no
//     WebSocket gateway, this is the only way to dial without leaving the app.
//
// Both read the same table. This module decides which account the native engine gets and
// whether that engine is actually alive, so `webrtcSession()` can hand back one shape whichever
// engine wins — and stays byte-for-byte the browser descriptor while no daemon is running.
//
// Secret rule: the SIP password is released only by `GET /api/telephony/carrier-credentials`,
// which demands the session token and is read by the local supervisor process. It is never put
// in the renderer's session descriptor, so "this secret does not reach the browser" still holds.
'use strict';

const settings = require('../repositories/settingsRepo');
const telephony = require('./telephonyService');

const ENGINE_KEY = 'native_sip_engine';
// Two different identities that used to be conflated, which is why the descriptor's engine field and
// softphoneSession's witness disagreed:
//   NATIVE_ENGINE     is the SETTINGS VALUE — what `native_sip_engine` stores and what the
//                     daemon-facing credential object reports as itself.
//   DESCRIPTOR_ENGINE is the DESCRIPTOR FIELD VALUE — what `webrtcSession()` puts in `engine` and
//                     what the renderer's own isNativeSession() in src/nativeSip.js tests for.
// They are not the same string and never were. Naming both is the fix; comparing one against the
// other was BUG 18.
const NATIVE_ENGINE = 'pulse-sip-daemon';
const DESCRIPTOR_ENGINE = 'native';
// The supervisor beats every 10 s while it holds the daemon; 45 s of silence means the process
// is gone (crashed, quit, never started) and the app must stop claiming a native phone exists.
const HEARTBEAT_TTL_MS = 45000;

const hostOf = (raw) => String(raw || '').trim().replace(/^sips?:\/?\/?/i, '').replace(/:\d+$/, '').replace(/\/+$/, '');
const portOf = (raw) => parseInt(String(raw || '').match(/:(\d+)$/)?.[1] || '', 10) || 0;

/**
 * Which trunk the daemon should register. FlyNumber wins whenever its SIP user and password are
 * saved — that is the account this feature exists for. The legacy Telnyx SIP settings are kept
 * (never deleted, still dormant for the browser path) and reused here only as a fallback, so a
 * Telnyx-only install gets a native phone too instead of an empty dialog.
 */
function activeAccount() {
  const flyHost = hostOf(settings.get('flynumber_sip_server')) || telephony.FLYNUMBER_SIP_DEFAULT;
  const flyUser = String(settings.get('flynumber_sip_user') || '').trim();
  const flyPassword = String(settings.get('flynumber_sip_password') || '').trim();
  const flyDid = telephony.normalizePhone(settings.get('flynumber_did') || telephony.COPENHAGEN_DEFAULT_DID);
  if (flyUser && flyPassword) {
    return {
      carrier: 'flynumber',
      carrierName: 'FlyNumber',
      domain: flyHost,
      port: portOf(settings.get('flynumber_sip_server')) || 5060,
      transport: 'udp',
      user: flyUser,
      password: flyPassword,
      // The DID is the number the carrier expects in From; fall back to the rotating pool so a
      // multi-DID install still shows the caller ID it would have shown in the browser.
      callerId: flyDid || telephony.nextCallerId().callerId || '',
      did: flyDid || '',
    };
  }

  const telUser = String(settings.get('telnyx_sip_user') || '').trim();
  return {
    carrier: 'telnyx',
    carrierName: 'Telnyx',
    domain: hostOf(telephony.sipServer()) || telephony.TELNYX_SIP_DOMAIN,
    port: portOf(telephony.sipServer()) || 5060,
    transport: 'udp',
    user: telUser,
    password: String(settings.get('telnyx_sip_password') || '').trim(),
    callerId: telephony.normalizePhone(settings.get('caller_id')) || telephony.nextCallerId().callerId || '',
    did: telephony.normalizePhone(settings.get('caller_id')) || '',
  };
}

/** Is the daemon installed *and* asked for? Both halves are off by default. */
const engineSelected = () => String(settings.get(ENGINE_KEY) || '').trim() === NATIVE_ENGINE;

function heartbeat() {
  const at = Number(settings.get('native_daemon_last_seen') || 0);
  const ageMs = at > 0 ? Date.now() - at : Infinity;
  return {
    at,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    alive: at > 0 && ageMs < HEARTBEAT_TTL_MS,
    pid: Number(settings.get('native_daemon_pid') || 0) || null,
    version: String(settings.get('native_daemon_version') || ''),
    audio: String(settings.get('native_daemon_audio') || ''),
  };
}

const isActive = () => engineSelected() && heartbeat().alive;

/**
 * What is missing before the native engine could carry a call. Mirrors `webrtcReadiness()` so
 * the cockpit can render one list either way — and so a dial attempt can say why it refused.
 */
function readiness() {
  const account = activeAccount();
  const beat = heartbeat();
  const missing = [];
  if (!account.domain) missing.push('server');
  if (!account.user) missing.push('user');
  if (!account.password) missing.push('password');
  if (!engineSelected()) missing.push('engine');
  if (!beat.alive) missing.push('daemon');
  return { ...account, hasPassword: !!account.password, missing, configured: missing.length === 0, daemon: beat };
}

/**
 * The drop-in replacement for `webrtcSession()` while a live daemon holds the phone. Same keys
 * the browser descriptor already has (so nothing downstream has to learn a second contract),
 * plus the ones a native bridge needs. No password: the daemon fetches that itself.
 */
function webrtcSession() {
  const r = readiness();
  const legacy = telephony.webrtcReadiness();
  const active = engineSelected() && r.daemon.alive;
  return {
    mode: 'webrtc', // still "the call happens in-app", which is the distinction this field makes
    engine: DESCRIPTOR_ENGINE,
    active,
    provider: r.carrier,
    carrierName: r.carrierName,
    configured: r.configured,
    missing: r.missing,
    transport: r.transport,
    domain: r.domain,
    port: r.port,
    // Reported so an existing UI that prints the gateway shows the real endpoint instead of a
    // stale Telnyx URL. The browser gateway stays in `webrtcWsUrl` for when the app runs in a
    // plain tab with no supervisor.
    wsUrl: `sip:${r.domain}:${r.port}`,
    wsUrlSource: 'native_daemon',
    webrtcWsUrl: legacy.wsUrl,
    server: r.domain,
    username: r.user,
    callerId: r.callerId,
    did: r.did,
    password: '',
    hasPassword: r.hasPassword,
    credentialHandoff: false,
    // The daemon holds the secret, so no handoff is needed: a configured native engine can
    // register, which is exactly what the browser engine could not do without one.
    canRegister: r.configured,
    daemon: r.daemon,
    micDevice: String(settings.get('webrtc_mic_device') || ''),
    speakerDevice: String(settings.get('webrtc_speaker_device') || ''),
    credentialsUrl: '/api/telephony/carrier-credentials',
    hint: hintText(r),
  };
}

// The one-line explanation the cockpit and the test-launch endpoint show. Same three cases the
// browser descriptor has (ready / blocked / missing), worded for an engine that owns the audio
// device instead of the tab.
function hintText(r) {
  if (!r.configured) {
    const why = r.missing.filter((m) => m !== 'engine');
    if (why.includes('daemon')) return 'Start the desktop app — the headless SIP daemon is not running.';
    return `The native softphone is missing: ${why.join(', ') || 'credentials'}. Add it in Settings → Telephony.`;
  }
  return `Ready — the native softphone dials ${r.transport.toUpperCase()} SIP to ${r.domain}:${r.port} `
    + `as ${r.user || r.callerId}, with macOS handling the microphone and speaker.`;
}

/** The message `POST /api/settings/test-softphone` should show for a sample number. */
function testMessage(sample) {
  const r = readiness();
  return r.configured
    ? `Ready — the desktop daemon will dial ${sample} over ${r.transport.toUpperCase()} SIP to ${r.domain}:${r.port}.`
    : hintText(r);
}

/**
 * The full account, secret included. Only ever served behind the session token, to a local
 * process; `includeSecret: false` is what a diagnostic caller should ask for.
 */
function credentials({ includeSecret = true } = {}) {
  const r = readiness();
  const out = {
    ok: r.configured,
    engine: NATIVE_ENGINE,
    carrier: r.carrier,
    carrierName: r.carrierName,
    domain: r.domain,
    port: r.port,
    transport: r.transport,
    user: r.user,
    callerId: r.callerId,
    did: r.did,
    configured: r.configured,
    missing: r.missing,
    expires: 300,
    daemon: r.daemon,
  };
  if (includeSecret) out.password = r.password;
  else out.hasPassword = r.hasPassword;
  return out;
}

/** The supervisor says hello: record that a native phone exists, and which process holds it. */
function beat({ pid = 0, version = '', audio = '' } = {}) {
  settings.set('native_daemon_last_seen', String(Date.now()));
  if (pid) settings.set('native_daemon_pid', String(pid));
  if (version) settings.set('native_daemon_version', String(version));
  if (audio) settings.set('native_daemon_audio', String(audio));
  return heartbeat();
}

/** The supervisor says goodbye (or simply stopped beating): drop the native claim. */
function clearBeat() {
  settings.set('native_daemon_last_seen', '0');
  settings.set('native_daemon_pid', '0');
  return heartbeat();
}

/** Turn the native engine on or off. Off is the default, and off means "browser, as always". */
function setEngine(enabled) {
  settings.set(ENGINE_KEY, enabled ? NATIVE_ENGINE : '');
  return { engine: enabled ? NATIVE_ENGINE : '', selected: engineSelected() };
}

module.exports = {
  activeAccount, readiness, webrtcSession, credentials, heartbeat, beat, clearBeat, setEngine,
  isActive, engineSelected, hintText, testMessage, ENGINE_KEY, NATIVE_ENGINE, DESCRIPTOR_ENGINE,
  HEARTBEAT_TTL_MS,
};
