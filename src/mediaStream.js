// The microphone the cockpit opened for the call in progress.
//
// sip.js resolves the factory from `sessionDescriptionHandlerFactory`, and that accessor on a
// Session is GETTER-ONLY (sip.js 0.21 `session.js`: `get sessionDescriptionHandlerFactory()`).
// Assigning to it on an Invitation throws `TypeError: Cannot set property ... which has only a
// getter`, which is exactly how every answered inbound call used to die before any 200 OK was
// sent. The supported seam is the UserAgent's configuration factory plus this per-call slot.
let activeLocalStream = null;

export function setActiveLocalStream(stream) {
  activeLocalStream = stream || null;
}

export function clearActiveLocalStream() {
  activeLocalStream = null;
}

export function mediaStreamFactory(constraints) {
  if (activeLocalStream && activeLocalStream.getAudioTracks) {
    const live = activeLocalStream.getAudioTracks().some((track) => track.readyState === 'live');
    if (live) return Promise.resolve(activeLocalStream);
  }
  if (!navigator?.mediaDevices?.getUserMedia) return Promise.reject(new Error('Media devices are unavailable in this context.'));
  return navigator.mediaDevices.getUserMedia(constraints || { audio: true, video: false });
}

