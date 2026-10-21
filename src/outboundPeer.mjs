// The outbound peer connection: the microphone goes in, the carrier's audio comes out, and the
// ICE states that may end a call are decided here — in one place, with one policy.
//
// `disconnected` is not `failed`. The WebRTC spec calls it transient: a Wi-Fi roam, a NAT
// rebind, a laptop lid for two seconds. Treating it as a dropped call cut live conversations
// that would have healed on their own, so it gets a grace window and a chance to reconnect.
// `failed` is still fatal, immediately.

export const ICE_GRACE_MS = 5000;

// Telnyx's STUN first; a public fallback second, so a network that blocks the carrier's STUN
// still gathers a candidate set instead of failing to connect.
export const ICE_SERVERS = Object.freeze([
  { urls: 'stun:stun.telnyx.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]);

/**
 * @param {object}   opts
 * @param {function} [opts.RTCPeerConnection] constructor (absent in tests and old browsers)
 * @param {MediaStream} [opts.stream]         microphone to publish
 * @param {{current: HTMLAudioElement|null}} [opts.audioRef] where remote audio is played
 * @param {function} [opts.onLive]  audio is genuinely flowing (once)
 * @param {function} [opts.onFatal] (message) the call is over
 * @param {number}   [opts.graceMs]  how long `disconnected` may last before it is fatal
 * @param {{set: Function, clear: Function}} [opts.timers] injectable clock
 * @returns {{pc: RTCPeerConnection, close: function}|null}
 */
export function createOutboundPeer({
  RTCPeerConnection, stream, audioRef, onLive = () => {}, onFatal = () => {},
  graceMs = ICE_GRACE_MS, timers,
} = {}) {
  if (typeof RTCPeerConnection !== 'function') return null;
  const clock = timers || { set: setTimeout, clear: clearTimeout };
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS.map((s) => ({ ...s })) });
  let grace = null;
  let live = false;
  let dead = false;

  const isClosed = () => pc.signalingState === 'closed' || pc.connectionState === 'closed';
  const clearGrace = () => { if (grace !== null) { clock.clear(grace); grace = null; } };
  const endCall = (message) => {
    if (dead || isClosed()) return;
    dead = true;
    clearGrace();
    onFatal(message);
  };

  pc.ontrack = (ev) => {
    const [remote] = ev.streams || [];
    if (audioRef?.current && remote) {
      audioRef.current.srcObject = remote;
      audioRef.current.play?.().catch(() => {});
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (dead || isClosed()) return;
    const state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      clearGrace();
      if (!live) { live = true; onLive(); }
    } else if (state === 'failed') {
      endCall('The audio connection dropped.');
    } else if (state === 'disconnected' && grace === null) {
      grace = clock.set(() => { grace = null; endCall('The audio connection dropped.'); }, graceMs);
    }
  };

  for (const track of stream?.getTracks?.() || []) pc.addTrack(track, stream);
  return { pc, close() { clearGrace(); dead = true; try { pc.close(); } catch { /* already closed */ } } };
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
