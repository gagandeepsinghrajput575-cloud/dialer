// SIP-over-WebSocket signalling adapter.
//
// This is the ONLY module that knows how a call is actually set up on the wire. Everything
// else — microphone, levels, mute, touch-tones, the state machine — lives in useWebRtc.js and
// is independent of it. That boundary exists so the SIP stack can be swapped without touching
// the cockpit.
//
// ## Status: wired, not verified against a live PBX
//
// The stack is sip.js, bundled lazily (the chunk is only fetched when a live call is placed).
// The dialer is honest about what it can guarantee: registration and media are handled here,
// but until the credentials point at a reachable gateway nothing can prove the far end answers.
// If the stack cannot be loaded at all, this throws a message the agent can act on instead of
// letting the cockpit pretend a call is up.

const INSTALL_HINT = 'The in-browser softphone needs its SIP stack. Run: npm install sip.js';

// Resolve the SIP library. The specifiers are written out as literals on purpose: the bundler
// only code-splits an import it can see, and a bare specifier left in the output is something
// no browser can resolve. Never throws — an unreachable chunk (offline, blocked, unbuilt) is a
// normal failure mode that has to surface as a message, not as a background exception.
export async function loadSipStack() {
  try {
    const core = await import('sip.js');
    if (!core?.UserAgent) return null;
    // sip.js keeps the WebRTC session-description handler in its platform layer, not the root
    // export (0.21.x). Needed only to point the media path at the microphone we already hold.
    let SessionDescriptionHandler = core.SessionDescriptionHandler;
    if (!SessionDescriptionHandler) {
      try { SessionDescriptionHandler = (await import('sip.js/lib/platform/web/index.js')).SessionDescriptionHandler; }
      catch { /* without it the media path falls back to the stack's own capture */ }
    }
    return { ...core, SessionDescriptionHandler };
  } catch {
    return null;
  }
}

export async function sipStackAvailable() {
  return (await loadSipStack()) !== null;
}

/**
 * Drive one outbound SIP call.
 *
 * @param {object}   opts
 * @param {object}   opts.session      descriptor from GET /api/telephony/webrtc-session
 * @param {string}   opts.remoteNumber E.164 number to dial
 * @param {function} opts.onState      (state) => void   — registering | dialing | ringing | active | ended
 * @param {function} opts.onError      (message) => void
 * @param {function} opts.onActive     () => void
 * @param {MediaStream} [opts.localStream] microphone the engine already opened
 * @param {RTCPeerConnection} [opts.pc]   the engine's peer connection, if it made one
 * @returns {Promise<{stop: function}>}
 */
export async function startSignalling({ session, remoteNumber, onState, onError, onActive, localStream }) {
  const sip = await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);

  const { UserAgent, Registerer, Inviter, SessionState, SessionDescriptionHandler } = sip;
  const server = session.server;
  if (!server) throw new Error('No SIP server is configured (Settings → Telephony).');

  const uri = UserAgent.makeURI(`sip:${session.username}@${server}`);
  if (!uri) throw new Error(`"${session.username}@${server}" is not a usable SIP address.`);

  const ua = new UserAgent({
    uri,
    transportOptions: { server: session.wsUrl },
    authorizationUsername: session.username,
    authorizationPassword: session.password,
    displayName: session.username,
    logLevel: 'error',
  });

  let stopped = false;
  let inviter = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { inviter?.dispose?.(); } catch { /* ignore */ }
    try { ua.stop?.(); } catch { /* ignore */ }
  };

  try {
    await ua.start();
  } catch (e) {
    stop();
    throw new Error(`Could not reach the SIP gateway at ${session.wsUrl} — ${e?.message || e}`);
  }

  // Register so the provider recognises the extension before we invite.
  const registerer = new Registerer(ua);
  try {
    await registerer.register();
  } catch (e) {
    stop();
    throw new Error(`SIP registration for ${session.username} was refused — ${e?.message || e}`);
  }

  onState('dialing');

  const target = UserAgent.makeURI(`sip:${remoteNumber}@${server};transport=ws`);
  if (!target) { stop(); throw new Error(`"${remoteNumber}" is not a usable SIP destination.`); }

  inviter = new Inviter(ua, target, {
    sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    // Reuse the microphone the engine already opened so there is exactly one capture path
    // and mute behaves identically in both modes. sip.js still builds the media path and the
    // remote audio element; this only redirects where the outgoing audio comes from.
    // Best-effort by design: if a future sip.js changes the handler's shape, the call still
    // works on sip.js's own capture.
    ...(localStream && SessionDescriptionHandler ? {
      sessionDescriptionHandlerFactory: (sess, options) => {
        const sdh = new SessionDescriptionHandler(sess, options);
        const attach = () => {
          try {
            const conn = sdh.peerConnection;
            if (!conn) return false;
            for (const sender of conn.getSenders()) if (sender.track) conn.removeTrack(sender);
            for (const t of localStream.getTracks()) conn.addTrack(t, localStream);
            return true;
          } catch { return false; }
        };
        if (!attach()) setTimeout(attach, 0);
        return sdh;
      },
    } : {}),
  });

  inviter.stateChange.addListener((s) => {
    if (s === SessionState.Establishing) onState('ringing');
    else if (s === SessionState.Established) { onState('active'); onActive?.(); }
    else if (s === SessionState.Terminated) onState('ended');
  });

  try {
    await inviter.invite();
  } catch (e) {
    stop();
    // Rejections here are the useful ones: 401/403 means credentials, 404 means the number.
    const msg = String(e?.message || e);
    throw new Error(/401|403/.test(msg)
      ? 'The provider rejected the SIP credentials — check the username and password.'
      : /404/.test(msg)
        ? `The provider does not recognise ${remoteNumber}.`
        : `The call could not be placed — ${msg}`);
  }

  return { stop, userAgent: ua, inviter, registerer };
}
