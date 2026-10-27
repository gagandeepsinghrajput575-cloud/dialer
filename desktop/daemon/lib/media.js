// The media path: RTP sockets, the 20 ms send pump and the receive-to-speaker side.
//
// One socket per call leg, latched onto the address the audio actually arrives from. That
// latch is the whole trick of SIP media: carriers routinely signal one host and send RTP from
// a media relay, and a stack that insists on the SDP address produces one-way audio, which is
// the single most common "it connects but nobody can hear anything" report.
'use strict';

const dgram = require('dgram');
const sdpLib = require('./sdp');
const rtp = require('./rtp');
const g711 = require('./g711');
const { CallRecorder, uploadOrSaveRecording } = require('./recorder');
const srtp = require('./srtp');
const stun = require('./stun');

const LEVEL_INTERVAL_MS = 120;

/** Attach media behaviour to a user agent ({ transport, audio, emit, log }). */
function attach(ua) {
  ua.mediaSockets = ua.mediaSockets || [];
  ua.levels = ua.levels || { input: 0, output: 0, at: 0 };
  ua.pump = null;

  ua.dialogForMedia = function dialogForMedia(media) {
    if (ua.active?.media === media) return ua.active;
    if (ua.pump?.media === media) return ua.pump;
    if (ua.dialogs) {
      for (const d of ua.dialogs.values()) {
        if (d.media === media) return d;
      }
    }
    return ua.pump || ua.active || null;
  };

  ua.openMediaSocket = async function openMediaSocket() {
    const socket = dgram.createSocket('udp4');
    const port = await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, ua.transport.localAddress || '0.0.0.0', () => resolve(socket.address().port));
    });
    socket.removeAllListeners('error');
    socket.on('error', () => { /* a media socket error ends the call's audio, not the daemon */ });
    // Behind CGNAT a public IP with our local port is a black hole: the ISP rewrites the source
    // port per socket, and the carrier sends media exactly where the offer says. Ask STUN from this
    // socket, so the offer carries the mapping that actually exists.
    let mapped = null;
    if (ua.transport?.mode === 'tls') {
      try { mapped = await stun.discover(socket); } catch { mapped = null; }
      ua.log('media', mapped ? `STUN mapped ${mapped.ip}:${mapped.port}`
        : 'STUN discovery failed; the offer will use the configured public IP');
    }
    const session = rtp.createSession({ payloadType: sdpLib.PT_PCMU });
    const media = {
      socket, port, session, mapped, muted: false,
      // Where our audio goes. Starts empty and is filled from the peer's SDP; the receive
      // path may then re-latch it onto the address the media actually arrives from.
      target: { host: '', port: 0 },
      codec: sdpLib.PT_PCMU, remotePt: sdpLib.PT_PCMU, remoteDtmfPt: 0,
      stats: { sent: 0, received: 0, dtmf: 0, writeFailures: 0 },
      reorder: null,
      send(buf) {
        // Read through `media.target`, never a captured local: SDP replaces the whole object,
        // and a stale closure here means a connected call that sends no audio at all.
        const { host, port } = media.target;
        if (!host || !port) return false;
        const wire = media.srtpOut ? media.srtpOut.protect(buf) : buf;
        socket.send(wire, port, host, (err) => { if (err) media.stats.sendErrors = (media.stats.sendErrors || 0) + 1; });
        media.stats.sent += 1;
        return true;
      },
      setMuted(m) { media.muted = !!m; },
      dtmf(digit) { return rtp.dtmfPackets({ session, digit, payloadType: media.remoteDtmfPt || sdpLib.PT_DTMF }); },
      close() {
        if (media.reorder) {
          media.reorder.clear();
        }
        try { socket.close(); } catch { /* already closed */ }
      },
    };
    media.reorder = new rtp.ReorderBuffer({
      capacity: 8,
      maxHoldMs: 25,
      onPacket: (pkt) => {
        ua.processRtpPacket(media, pkt);
      },
    });
    socket.on('message', (buf, rinfo) => {
      media.stats.wire = (media.stats.wire || 0) + 1;
      if (media.target.host !== rinfo.address || media.target.port !== rinfo.port) {
        media.target = { host: rinfo.address, port: rinfo.port };
      }
      ua.onRtp(media, buf);
    });
    ua.mediaSockets.push(media);
    return media;
  };

  ua.onRtp = function onRtp(media, buf) {
    let packetBuf = buf;
    if (media.srtpIn) {
      // A trunk switched to secure media must never fall back to playing ciphertext: a failed tag
      // means the packet is dropped, not decoded.
      packetBuf = media.srtpIn.unprotect(buf);
      if (!packetBuf) {
        media.stats.authFail = (media.stats.authFail || 0) + 1;
        return;
      }
    }
    if (rtp.isRtcp(packetBuf)) return;
    if (!media.loggedFirstPacket) {
      media.loggedFirstPacket = true;
      const b0 = packetBuf[0];
      // One line that answers "why is the audio noise": payload type, extension bit, CSRC count.
      ua.log('media', `first RTP: pt=${packetBuf[1] & 0x7f} ext=${(b0 & 0x10) ? 1 : 0} `
        + `cc=${b0 & 0x0f} len=${packetBuf.length} srtp=${media.srtpIn ? 1 : 0}`);
    }
    const packet = rtp.parse(packetBuf);
    if (!packet) return;
    media.stats.received += 1;
    if (media.remoteDtmfPt && packet.payloadType === media.remoteDtmfPt) {
      const code = packet.payload?.[0];
      const digit = Object.keys(rtp.DTMF_CODES).find((k) => rtp.DTMF_CODES[k] === code);
      // Only the end-of-event packet is reported, or one keypress becomes four.
      if (digit && packet.payload[1] & 0x80) { media.stats.dtmf += 1; ua.emit('dtmf', { digit }); }
      return;
    }
    if (media.reorder) {
      media.reorder.push(packet);
    } else {
      ua.processRtpPacket(media, packet);
    }
  };

  ua.processRtpPacket = function processRtpPacket(media, packet) {
    if (packet.payloadType !== media.remotePt) return;   // a codec we did not agree to
    const pcm = g711.decode(packet.payload, packet.payloadType);
    const dialog = ua.dialogForMedia(media);

    // Early media suppression: mute incoming audio to local speaker while in early states
    // (calling, early, proceeding). This silences telecom in-band ringback tones while
    // instantly passing the prospect's live voice when answered (confirmed).
    const isEarlyMedia = dialog && (dialog.state === 'early' || dialog.state === 'calling' || dialog.state === 'proceeding');
    const shouldPlayToSpeaker = !isEarlyMedia;

    let writeOk = true;
    if (shouldPlayToSpeaker) {
      try {
        if (ua.audio?.write) {
          const res = ua.audio.write(pcm);
          if (res === false) {
            writeOk = false;
          }
        }
      } catch {
        writeOk = false;
      }
    }
    if (!writeOk) {
      media.stats.writeFailures = (media.stats.writeFailures || 0) + 1;
      ua.levels.output = 0;
      ua.emit('error', {
        message: 'Audio output device write failed',
        scope: 'media',
        type: 'audio_write_failure',
        callId: dialog?.id,
      });
      return;
    }
    if (dialog?.recorder) dialog.recorder.pushRemote(pcm);
    ua.levels.output = shouldPlayToSpeaker ? g711.level(pcm) : 0;
    ua.maybeEmitLevels();
  };

  ua.maybeEmitLevels = function maybeEmitLevels() {
    const now = Date.now();
    if (now - ua.levels.at < LEVEL_INTERVAL_MS) return;
    ua.levels.at = now;
    // `wire` and `authFail` are diagnostic, not cosmetic: when a secure call has no audio, the
    // only question that matters is whether packets arrived and were rejected (SRTP/key problem)
    // or never arrived at all (NAT/address problem).
    const stats = ua.active?.media?.stats || {};
    ua.emit('audio_level', {
      input: ua.levels.input,
      output: ua.levels.output,
      wire: stats.wire || 0,
      received: stats.received || 0,
      authFail: stats.authFail || 0,
    });
  };

  // Open the sound card, once. CoreAudio's start() refuses to run before open() — it has no
  // AudioUnit to drive — while null and portaudio create what they need inside start() and treat
  // open() as a no-op. Nothing in the daemon used to call this, so a Mac with the addon built
  // correctly still threw 'coreaudio: open() first' on the first call, the throw escaped
  // onCallConfirmed before it could emit 'connected', and both directions were silent. The flag
  // makes the retry-on-next-call path cheap.
  ua.audioOpened = false;
  ua.ensureAudioOpen = async function ensureAudioOpen() {
    if (ua.audioOpened) return true;
    if (!ua.audio?.open) { ua.audioOpened = true; return true; }
    try {
      const inputDevice = ua.audioDevices?.inputDevice || '';
      const outputDevice = ua.audioDevices?.outputDevice || '';
      await ua.audio.open({ inputDevice, outputDevice });
      ua.audioOpened = true;
      return true;
    } catch (e) {
      ua.log('media', `could not open the audio device: ${e?.message || e}`);
      return false;
    }
  };

  // No RTP from the far end this many seconds after the call is confirmed means the media path is
  // not there, however healthy the signalling looks. Reported once, never acted on: tearing down a
  // call that may be one-way audio would hang up on a customer who can still hear the agent.
  const MEDIA_WATCHDOG_MS = 12000;

  // The audio device is the clock: one 160-sample frame in, one RTP packet out, every 20 ms.
  // Returns a promise (opening the device is async) that never rejects — a dead sound card is an
  // error the agent can see, not an exception thrown into the dialog layer mid-200-OK.
  ua.startPump = function startPump(dialog) {
    ua.stopPump();
    let armed = dialog;
    if (!dialog.recorder) {
      dialog.recorder = new CallRecorder({ callId: dialog.id, externalId: dialog.externalId });
    }
    const onFrame = (frame) => {
      if (!armed) return;
      const pcm = frame instanceof Int16Array
        ? frame
        : (Buffer.isBuffer(frame)
          ? new Int16Array(frame.buffer, frame.byteOffset, Math.floor(frame.byteLength / 2))
          : (frame instanceof Float32Array ? g711.toInt16(frame) : frame));
      ua.levels.input = g711.level(pcm);
      const media = armed.media;
      if (armed.recorder) armed.recorder.recordFrame(pcm, !!media?.muted);
      if (!media || media.muted) return;
      media.send(media.session.packet(g711.encode(pcm, media.codec), media.stats.sent === 0));
      ua.maybeEmitLevels();
    };
    const fail = (message) => {
      if (ua.pump !== dialog) return;          // the call already ended; nothing left to report
      ua.log('media', message);
      ua.emit('error', { message, scope: 'media', callId: dialog.id });
    };
    ua.pump = dialog;
    return Promise.resolve()
      .then(() => ua.ensureAudioOpen())
      .then((opened) => {
        if (ua.pump !== dialog) return;        // hung up while the device was opening
        if (!ua.audio?.start) return;          // no backend at all: the null path is silent by design
        if (!opened) { fail('The audio device would not open, so this call has no sound.'); return; }
        try { ua.audio.start(onFrame); } catch (e) {
          // Reset so the next call tries again — a transient device busy must not be permanent.
          ua.audioOpened = false;
          fail(`The audio device would not start: ${e?.message || e}`);
          return;
        }
        // Overridable so the test suite can prove the watchdog in milliseconds, not 12 s.
        const ms = ua.mediaWatchdogMs || MEDIA_WATCHDOG_MS;
        dialog.mediaWatchdog = setTimeout(() => {
          if (ua.pump !== dialog || !dialog.media) return;
          const { sent, received } = dialog.media.stats;
          if (received > 0) return;
          ua.log('media', `no RTP from the far end after ${ms / 1000}s (sent ${sent})`);
          ua.emit('media_timeout', {
            callId: dialog.id, sent, received: 0, seconds: ms / 1000,
            reason: sent > 0
              ? 'The call is up and this end is sending audio, but nothing has come back — the media path is one-way or blocked.'
              : 'The call is up but no audio has moved in either direction.',
          });
        }, ms);
      })
      .catch((e) => fail(`The audio pump stopped: ${e?.message || e}`));
  };

  ua.stopPump = function stopPump() {
    const dialog = ua.pump;
    ua.pump = null;
    if (dialog?.mediaWatchdog) { clearTimeout(dialog.mediaWatchdog); dialog.mediaWatchdog = null; }
    try { ua.audio?.stop?.(); } catch { /* nothing running */ }
  };

  // 183 with SDP: the far end is playing ringback, so wire the receive path early.
  ua.startEarlyMedia = function startEarlyMedia(dialog) {
    ua.applyRemoteSdp(dialog);
    if (!dialog.recorder) {
      dialog.recorder = new CallRecorder({ callId: dialog.id, externalId: dialog.externalId });
    }
    if (dialog.media && !ua.pump) ua.startPump(dialog);
  };

  ua.applyRemoteSdp = function applyRemoteSdp(dialog) {
    const remote = dialog.remoteSdp;
    if (!remote?.ip || !remote.port || !dialog.media) return false;
    const chosen = sdpLib.negotiate(remote);
    if (!chosen) return false;
    dialog.media.target = { host: remote.ip, port: remote.port };
    dialog.media.codec = chosen.pt;
    dialog.media.remotePt = chosen.pt;
    dialog.media.remoteDtmfPt = remote.dtmfPt || 0;
    dialog.media.session.payloadType = chosen.pt;
    dialog.codec = chosen.name;

    // Secure media: our key came from the offer, theirs from the answer (SDES is per-direction).
    ua.log('media', `remote sdp: crypto=${remote.crypto ? 'yes' : 'no'} key=${dialog.srtpKey ? 'yes' : 'no'}`);
    if (dialog.srtpKey && remote.crypto) {
      const theirs = srtp.parseCrypto(remote.crypto);
      if (theirs) {
        dialog.media.srtpOut = new srtp.SrtpContext({ key: dialog.srtpKey, suite: theirs.suite });
        dialog.media.srtpIn = new srtp.SrtpContext({ key: theirs.key, suite: theirs.suite });
        ua.log('media', `SRTP active (${theirs.suite})`);
      } else {
        ua.log('media', `unusable crypto line from the carrier: ${String(remote.crypto).slice(0, 40)}`);
      }
    } else if (remote.crypto && !dialog.srtpKey) {
      ua.log('media', 'carrier offered secure media but this side has no key — audio will not flow');
    }

    // FlyNumber Symmetric RTP NAT Latching: transmit 3 consecutive silent G.711 RTP packets immediately
    const silentPackets = rtp.createSilentNatPackets(dialog.media.session, 3, chosen.pt);
    for (const pkt of silentPackets) {
      dialog.media.send(pkt);
    }

    return true;
  };

  ua.releaseMedia = function releaseMedia(dialog) {
    if (dialog.recorder) {
      const rec = dialog.recorder;
      dialog.recorder = null;
      try {
        const final = rec.finalize();
        if (final.totalSamples > 0) {
          uploadOrSaveRecording({
            wavBuffer: final.wavBuffer,
            durationSec: final.durationSec,
            callId: final.callId,
            externalId: dialog.externalId || final.externalId,
            apiBase: ua.apiBase,
            log: (scope, msg) => ua.log(scope, msg),
          }).catch(() => {});
          ua.emit('recording', {
            callId: dialog.externalId || final.callId,
            dialogId: final.callId,
            externalId: dialog.externalId || final.externalId,
            durationSec: final.durationSec,
            sizeBytes: final.sizeBytes,
            mimeType: 'audio/wav',
            wavBase64: final.sizeBytes <= 2 * 1024 * 1024 ? final.wavBuffer.toString('base64') : null,
          });
        }
      } catch (e) {
        ua.log('media', `recorder finalize error: ${e?.message || e}`);
      }
    }
    if (!dialog.media) return;
    dialog.media.close();
    ua.mediaSockets = ua.mediaSockets.filter((m) => m !== dialog.media);
    dialog.media = null;
  };

  return ua;
}

module.exports = { attach, LEVEL_INTERVAL_MS };
