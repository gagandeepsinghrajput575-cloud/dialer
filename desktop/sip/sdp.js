// Audio SDP for the native signalling leg. Pulse advertises PCMU/PCMA plus RFC 4733 DTMF.
// Port 0 is an explicit hold: the native engine does the signalling and the OS softphone
// (Linphone, Option E/A) carries the media, so no port is ever claimed silently.
function buildSdp({ host = '0.0.0.0', port = 0, sessionId = Date.now(), version = 1 } = {}) {
  return [
    'v=0',
    `o=- ${sessionId} ${version} IN IP4 ${host}`,
    's=Pulse Dialer',
    `c=IN IP4 ${host}`,
    't=0 0',
    `m=audio ${port} RTP/AVP 0 8 101`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    port ? 'a=sendrecv' : 'a=inactive',
    '',
  ].join('\r\n');
}

const mediaPort = (sdp) => {
  const match = /^m=audio\s+(\d+)/im.exec(String(sdp || ''));
  return match ? Number(match[1]) : 0;
};

const isHold = (sdp) => mediaPort(sdp) === 0;

module.exports = { buildSdp, mediaPort, isHold };
