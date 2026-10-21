// The local WebRTC configuration used for every peer connection the softphone creates.
//
// Chromium (and sip.js) default `rtcpMuxPolicy` to 'require', then refuse to apply an answer
// whose m= sections lack `a=rtcp-mux`. Some carrier SBC routes answer without mux even though
// we offered it, and the call dies at setRemoteDescription. 'negotiate' still muxes when the
// far end can, but accepts an answer that cannot. Rewriting the answer to add `a=rtcp-mux` (an
// SDP modifier) is not a fix: it claims the far end muxes when it does not, and RTCP is lost.
// Telnyx's STUN is offered first; a public fallback second for networks that block it.

export const WEBRTC_PEER_CONFIGURATION = Object.freeze({
  rtcpMuxPolicy: 'negotiate',
  iceServers: [{ urls: 'stun:stun.telnyx.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }],
});

