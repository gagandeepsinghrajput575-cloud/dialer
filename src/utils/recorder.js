// Local call recording for the browser engine.
//
// Everything the agent hears in a browser call is mixed here — the microphone track and the far
// end's audio — and handed to MediaRecorder, so a call can be attached to its ledger row and
// transcribed later. Extracted from useWebRtc.js so the engine hook stays about the call itself.
//
// Two honest limitations, both stated rather than papered over:
//   * no MediaRecorder, no AudioContext, no recording. jsdom and the native engine fall in here;
//   * the native SIP engine has no MediaStream at all (the desktop daemon owns CoreAudio), so it
//     reports `recording.supported === false` instead of producing a silent file.
import { audioContextCtor } from './tones.js';

/** A mimeType the browser will actually accept, best first. */
function pickMimeType() {
  const supported = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
    ? MediaRecorder.isTypeSupported : () => false;
  if (supported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (supported('audio/webm')) return 'audio/webm';
  return 'audio/ogg';
}

/** Can this environment record a call at all? */
export function recordingSupported() {
  return typeof window !== 'undefined' && typeof window.MediaRecorder === 'function' && !!audioContextCtor();
}

/**
 * Start recording.
 *
 * @param {{current: MediaStream|null}} localStream  - the microphone
 * @param {{current: {srcObject?: MediaStream}|null}} remoteAudio - the <audio> holding the far end
 * @param {string|number|null} callId
 * @returns {object|null} the session, or null when recording is impossible here
 */
export function startCallRecorder(localStream, remoteAudio, callId) {
  if (!recordingSupported()) return null;
  const Ctx = audioContextCtor();
  try {
    const ctx = new Ctx();
    const dest = ctx.createMediaStreamDestination();
    const mix = (stream) => {
      if (!stream || !stream.getAudioTracks().length) return;
      try { ctx.createMediaStreamSource(stream).connect(dest); } catch { /* one leg is enough */ }
    };
    mix(localStream?.current);
    mix(remoteAudio?.current?.srcObject);

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(dest.stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const startedAt = Date.now();
    recorder.start(1000);
    return {
      recorder, ctx, chunks, mimeType, startedAt, callId,
      stop: () => { try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ } },
    };
  } catch {
    return null;
  }
}

/**
 * Stop a session and assemble the blob.
 *
 * @param {object} session - what startCallRecorder returned
 * @param {(r: {blob: Blob, durationSec: number, callId: *}) => void} onReady
 */
export function stopCallRecorder(session, onReady) {
  if (!session) return;
  try {
    session.recorder.onstop = () => {
      try {
        const durationSec = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
        const blob = new Blob(session.chunks, { type: session.mimeType });
        if (blob.size > 0) onReady?.({ blob, durationSec, callId: session.callId });
      } catch { /* ignore assembly errors */ }
      try { session.ctx.close(); } catch { /* ignore */ }
    };
    session.stop();
  } catch {
    try { session.ctx.close(); } catch { /* ignore */ }
  }
}
