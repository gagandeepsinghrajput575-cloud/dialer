// The outbound call's media policy, applied to the peer connection that actually carries it.
//
// A note on which peer that is: sip.js's session description handler creates the
// RTCPeerConnection that negotiates SDP with the carrier. The engine must not create a second
// one and quietly listen to its ICE events — that peer never receives a remote description,
// so its ICE never leaves `new`, and any policy attached to it is decoration.
//
// `disconnected` is not `failed`: the WebRTC spec calls it transient (Wi-Fi roam, NAT rebind,
// a laptop lid). It gets a grace window. `failed` is fatal immediately. The listener is
// registered with `addEventListener`, never by assigning `oniceconnectionstatechange`, because
// sip.js owns that property.

export const ICE_GRACE_MS = 5000;

/**
 * @param {RTCPeerConnection} pc  the SIP session's peer connection
 * @param {object}   [opts]
 * @param {function} [opts.onFatal] (message) the audio path is gone for good
 * @param {number}   [opts.graceMs] how long `disconnected` may last
 * @param {{set: Function, clear: Function}} [opts.timers] injectable clock
 * @returns {function} unsubscribe
 */
export function watchIceConnection(pc, { onFatal, graceMs = ICE_GRACE_MS, timers } = {}) {
  if (!pc?.addEventListener) return () => {};
  const clock = timers || { set: setTimeout, clear: clearTimeout };
  let grace = null;
  let dead = false;

  const isClosed = () => pc.signalingState === 'closed' || pc.connectionState === 'closed';
  const clearGrace = () => { if (grace !== null) { clock.clear(grace); grace = null; } };
  const endCall = (message) => {
    if (dead || isClosed()) return;
    dead = true;
    clearGrace();
    onFatal?.(message);
  };
  const onIceChange = () => {
    if (dead || isClosed()) return;
    const state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') clearGrace();
    else if (state === 'failed') endCall('The audio connection dropped.');
    else if (state === 'disconnected' && grace === null) {
      grace = clock.set(() => { grace = null; endCall('The audio connection dropped.'); }, graceMs);
    }
  };

  pc.addEventListener('iceconnectionstatechange', onIceChange);
  // A connection that is already dead when we attach must not wait five seconds to say so.
  if (pc.iceConnectionState === 'failed') endCall('The audio connection dropped.');
  return () => {
    clearGrace();
    pc.removeEventListener?.('iceconnectionstatechange', onIceChange);
  };
}

/**
 * Move the carrier's audio into the element the agent is listening to.
 *
 * sip.js exposes the remote stream on the session description handler; older builds only leave
 * the tracks on the peer connection's receivers. Both are tried, in that order.
 *
 * @param {object} opts
 * @param {object} [opts.sessionDescriptionHandler] sip.js SDH (may hold `remoteMediaStream`)
 * @param {object} [opts.sipPc]                      the SIP session's RTCPeerConnection
 * @param {{current: HTMLAudioElement|null}} [opts.audioRef]
 */
export function attachRemoteAudio({ sessionDescriptionHandler, sipPc, audioRef } = {}) {
  const play = (stream) => {
    if (!audioRef?.current || !stream) return;
    audioRef.current.srcObject = stream;
    audioRef.current.play?.().catch(() => {});
  };
  const tracks = sessionDescriptionHandler?.remoteMediaStream?.getAudioTracks?.() || [];
  if (tracks.length > 0) return play(sessionDescriptionHandler.remoteMediaStream);
  const Stream = globalThis.MediaStream;
  if (!sipPc?.getReceivers || typeof Stream !== 'function') return undefined;
  const remote = new Stream();
  for (const receiver of sipPc.getReceivers()) {
    if (receiver.track?.kind === 'audio') remote.addTrack(receiver.track);
  }
  return remote.getAudioTracks().length > 0 ? play(remote) : undefined;
}

// Carrier audio that arrives before the 200 OK (ringback, "nummeret er ikke i brug") is real
// audio and worth hearing — but it is not worth hearing at full volume in a headset while the
// network plays its 425 Hz ringback. It is played gently, then restored the moment the call is
// established. The local pickup chime is a separate Web Audio path, so ducking never touches it.
export const EARLY_MEDIA_VOLUME = 0.45;

/**
 * @param {object} opts
 * @param {object} [opts.sessionDescriptionHandler] the provisional SDH sip.js created for 183
 * @param {{current: HTMLAudioElement|null}} [opts.audioRef]
 * @param {number} [opts.volume]
 */
export function playEarlyMedia({ sessionDescriptionHandler, audioRef, volume = EARLY_MEDIA_VOLUME } = {}) {
  attachRemoteAudio({ sessionDescriptionHandler, audioRef });
  if (audioRef?.current) {
    try { audioRef.current.volume = volume; } catch { /* a muted element still plays later */ }
  }
}
