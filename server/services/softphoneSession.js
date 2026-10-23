// One in-app softphone, two engines, one descriptor.
//
// `telephonyService.webrtcSession()` describes the browser engine (sip.js over the carrier's
// WebSocket gateway). `carrierAccount.webrtcSession()` describes the native engine — the
// headless SIP daemon under `desktop/` that talks UDP SIP and CoreAudio, which is the only way
// to dial a trunk like FlyNumber without leaving the app.
//
// Every caller (the cockpit, the test-launch endpoint, the dial path) asks *this* module which
// engine is in charge, so nothing downstream has to know the second contract exists, and a
// server with no desktop app attached gets the browser descriptor byte-for-byte as before.
//
// Lives outside both services on purpose: telephonyService.js sits at its line ceiling and
// carrierAccount.js must not require the module that delegates to it.
'use strict';

const telephony = require('./telephonyService');
const { NATIVE_ENGINE, DESCRIPTOR_ENGINE } = require('./carrierAccount');

/** The descriptor for whichever engine currently owns the in-app phone. */
function resolve() {
  const carrier = require('./carrierAccount');
  return carrier.isActive() ? carrier.webrtcSession() : telephony.webrtcSession();
}

/**
 * Which engine a descriptor came from. Keyed on `engine`, with `transport` as a second witness,
 * so a browser descriptor can never be mistaken for a native one (it has neither field).
 *
 * The primary witness accepts BOTH native identities: `DESCRIPTOR_ENGINE` is what the renderer-facing
 * `webrtcSession()` emits, `NATIVE_ENGINE` is what the daemon-facing `credentials()` emits. It used to
 * test only the latter, so on a real descriptor the primary witness was always false and the decision
 * rode entirely on the `transport === 'udp'` fallback — a fallback that would silently stop covering
 * the moment a descriptor carried any other transport. test/unit/engine-descriptor.test.js deletes
 * both fallback witnesses so this comparison has to stand on its own.
 */
const isNative = (session) => !!session
  && (session.engine === DESCRIPTOR_ENGINE || session.engine === NATIVE_ENGINE
    || session.transport === 'udp' || session.wsUrlSource === 'native_daemon');

/**
 * The engine identity to record for a descriptor. Returns the DESCRIPTOR value, because that is what
 * every consumer already writes: the descriptor itself, callService's call-history row, and
 * src/nativeSip.js's own record. Returning NATIVE_ENGINE here disagreed with all three.
 */
const engineOf = (session) => (isNative(session) ? DESCRIPTOR_ENGINE : 'webrtc');

module.exports = { resolve, engineOf, isNative, NATIVE_ENGINE };
