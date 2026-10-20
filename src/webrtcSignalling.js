// SIP-over-WebSocket signalling adapter.
//
// This is the ONLY module that knows how a call is actually set up on the wire. Everything
// else — microphone, levels, mute, touch-tones, the state machine — lives in useWebRtc.js and
// is independent of it. That boundary exists so the SIP stack can be swapped without touching
// the cockpit.
//
// ## Standby: one registration, held open
//
// A softphone that only registers when you dial cannot receive a call: nobody is listening
// when the INVITE arrives. So the UserAgent is a *singleton session* that stays registered
// while the tab is open (`initStandbySession`), the INVITE is picked up by the delegate, and
// an outbound dial reuses the registration that is already up instead of performing a second
// handshake. `disposeStandbySession` is the way back out — switching modes or closing the tab.

const INSTALL_HINT = 'The in-browser softphone needs its SIP stack. Run: npm install sip.js';

export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.telnyx.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

// Ask for a short registration and refresh it well before it lapses. A stale registration is
// the quiet failure mode of a standby softphone: the tab looks ready and simply stops ringing.
export const REGISTER_EXPIRES = 300;
const REGISTER_REFRESH_MS = 240000;
const RETRY_MS = [5000, 10000, 20000, 45000];

// Sanitize a dial target or Caller-ID strictly to clean E.164 / URI-safe characters before
// passing into `sip:<target>@sip.telnyx.com;transport=ws` or SIP `P-Asserted-Identity` headers.
export function sanitizeSipNumber(raw, defaultCountryCode = '45') {
  if (raw === null || raw === undefined) return '';
  const cleaned = String(raw)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (/@/.test(cleaned) || /^sip:/i.test(cleaned)) {
    return cleaned.replace(/[\s()[\]{}<>"']/g, '');
  }
  const hasPlus = cleaned.startsWith('+');
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';
  const cc = String(defaultCountryCode || '45').replace(/\D/g, '');
  if (hasPlus || digits.startsWith('00')) {
    const intl = digits.startsWith('00') ? digits.slice(2) : digits;
    return intl ? `+${intl}` : '';
  }
  const national = digits.replace(/^0+/, '');
  if (cc && national.length === 8 && cc === '45') return `+45${national}`;
  if (cc && national.startsWith(cc) && national.length >= cc.length + 5) return `+${national}`;
  return `+${digits}`;
}

// Decode SIP 4xx/5xx/6xx final rejection responses into actionable sales diagnostics & CRM outcomes.
export function decodeSipRejection(sipCode, reasonPhrase = '') {
  const code = Number(sipCode) || 0;
  const phrase = String(reasonPhrase || '').trim();

  if (code === 404 || code === 410 || code === 484) {
    return {
      sipCode: code,
      reasonPhrase: phrase,
      reason: 'Number disconnected or not found',
      autoOutcome: 'bad_number',
      modalOutcome: 'wrong_number',
      isCarrierError: false,
    };
  }
  if (code === 486 || code === 600 || code === 603) {
    return {
      sipCode: code,
      reasonPhrase: phrase,
      reason: 'Line is busy / Call rejected by prospect',
      autoOutcome: 'busy',
      modalOutcome: 'hung_up',
      isCarrierError: false,
    };
  }
  if (code === 408 || code === 480 || code === 487) {
    return {
      sipCode: code,
      reasonPhrase: phrase,
      reason: 'No answer after timeout',
      autoOutcome: 'no_answer',
      modalOutcome: 'no_answer',
      isCarrierError: false,
    };
  }
  if (code === 401 || code === 403 || code === 407 || code === 502 || code === 503 || code === 504 || code >= 500) {
    return {
      sipCode: code,
      reasonPhrase: phrase,
      reason: 'Carrier error: Telnyx rejected Caller ID or trunk unavailable',
      autoOutcome: null,
      modalOutcome: 'no_answer',
      isCarrierError: true,
    };
  }
  return {
    sipCode: code,
    reasonPhrase: phrase,
    reason: phrase ? `Call rejected (${code} ${phrase})` : `Call rejected (${code})`,
    autoOutcome: 'no_answer',
    modalOutcome: 'no_answer',
    isCarrierError: false,
  };
}

// Send an out-of-band SIP DTMF digit via either high-level `session.sendDTMF(digit)` or
// SIP.js 0.21 RFC 2976 `session.info` (`application/dtmf-relay`).
export async function sendSipSessionDtmf(session, digit) {
  if (!session) return false;
  const key = String(digit);
  if (typeof session.sendDTMF === 'function') {
    await session.sendDTMF(key);
    return true;
  }
  if (typeof session.info === 'function') {
    await session.info({
      requestOptions: {
        body: {
          contentDisposition: 'render',
          contentType: 'application/dtmf-relay',
          content: `Signal=${key}\r\nDuration=160\r\n`,
        },
      },
    });
    return true;
  }
  return false;
}

// Active per-call media bridge read by the UserAgent's sessionDescriptionHandlerFactory at
// SDP negotiation time so neither inbound Invitation nor outbound Inviter ever mutates
// getter-only Session properties after INVITE parsing or adds duplicate sender tracks.
let activeCallMedia = {
  localStream: null,
  onTrack: null,
  onPeerConnection: null,
};

// Resolve the SIP library. The specifiers are written out as literals on purpose: the bundler
// only code-splits an import it can see, and a bare specifier left in the output is something
// no browser can resolve. Never throws — an unreachable chunk (offline, blocked, unbuilt) is a
// normal failure mode that has to surface as a message, not as a background exception.
export async function loadSipStack() {
  try {
    const core = await import('sip.js');
    if (!core?.UserAgent) return null;
    // sip.js keeps the WebRTC session-description handler in its platform layer, not the root
    // export (0.21.x). Needed to bind pre-opened microphone tracks and remote track listeners.
    let SessionDescriptionHandler = core.SessionDescriptionHandler;
    let defaultSessionDescriptionHandlerFactory = core.defaultSessionDescriptionHandlerFactory;
    if (!SessionDescriptionHandler || !defaultSessionDescriptionHandlerFactory) {
      try {
        const web = await import('sip.js/lib/platform/web/index.js');
        SessionDescriptionHandler = SessionDescriptionHandler || web.SessionDescriptionHandler;
        defaultSessionDescriptionHandlerFactory = defaultSessionDescriptionHandlerFactory || web.defaultSessionDescriptionHandlerFactory;
      } catch { /* without it the media path falls back to the stack's own capture */ }
    }
    return { ...core, SessionDescriptionHandler, defaultSessionDescriptionHandlerFactory };
  } catch {
    return null;
  }
}

export async function sipStackAvailable() {
  return (await loadSipStack()) !== null;
}

// Build a single SIP.js 0.21.x compliant SessionDescriptionHandlerFactory registered once on
// UserAgent construction:
//   1. Calls new SessionDescriptionHandler(logger, mediaStreamFactory, sdhConfiguration)
//      using the exact 3-arg signature expected by sip.js/lib/platform/web.
//   2. Attaches remote audio track listeners on peerConnection IMMEDIATELY upon creation,
//      before setDescription(offer/answer) runs, so early remote RTP tracks are never missed.
//   3. Wraps getDescription to ensure local microphone tracks are bound once (never calling
//      pc.addTrack twice for the same track) and audio transceivers carry sendrecv direction.
export function buildSessionDescriptionHandlerFactory(sip) {
  const SDH = sip?.SessionDescriptionHandler;
  if (!SDH) return undefined;

  return (sess, options = {}) => {
    const hooks = activeCallMedia;
    const logger = sess.userAgent.getLogger('sip.SessionDescriptionHandler');
    const sdhConfig = {
      iceGatheringTimeout: options?.iceGatheringTimeout ?? 1000,
      peerConnectionConfiguration: {
        iceServers: DEFAULT_ICE_SERVERS,
        ...(options?.peerConnectionConfiguration || {}),
      },
    };
    const mediaStreamFactory = (constraints) => {
      if (hooks.localStream) return Promise.resolve(hooks.localStream);
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        return navigator.mediaDevices.getUserMedia(constraints || { audio: true, video: false });
      }
      return Promise.resolve(new MediaStream());
    };

    const sdh = new SDH(logger, mediaStreamFactory, sdhConfig);
    const pc = sdh.peerConnection;
    const seenTrackIds = new Set();

    const notifyRemoteTrack = (event) => {
      const track = event?.track || event?.streams?.[0]?.getAudioTracks?.()?.[0];
      if (!track || (track.kind && track.kind !== 'audio')) return;
      const key = track.id || track;
      if (seenTrackIds.has(key)) return;
      seenTrackIds.add(key);
      try { hooks.onTrack?.(track, event); } catch { /* audio hook must never break SIP */ }
    };

    // Wire remote track listeners BEFORE setDescription / getDescription execute.
    if (pc) {
      const prevDelegate = sdh.peerConnectionDelegate;
      sdh.peerConnectionDelegate = {
        ...(prevDelegate || {}),
        ontrack: (ev) => {
          prevDelegate?.ontrack?.(ev);
          notifyRemoteTrack(ev);
        },
      };
      if (typeof pc.addEventListener === 'function') {
        pc.addEventListener('track', notifyRemoteTrack);
      }
      try { hooks.onPeerConnection?.(pc, sdh); } catch { /* non-fatal */ }
    }

    const ensureBidirectionalTracks = (callOpts) => {
      const conn = sdh.peerConnection;
      if (!conn) return;
      const stream = hooks.localStream;
      if (stream) {
        const senders = conn.getSenders ? conn.getSenders() : [];
        for (const track of stream.getAudioTracks()) {
          const existing = senders.find((s) => s.track === track || s.track?.kind === 'audio');
          if (!existing) {
            conn.addTrack(track, stream);
          } else if (existing.track !== track && typeof existing.replaceTrack === 'function') {
            try { existing.replaceTrack(track); } catch { /* ignore */ }
          }
        }
      }
      // Guarantee active audio transceivers negotiate sendrecv unless explicitly placed on hold
      if (!callOpts?.hold && typeof conn.getTransceivers === 'function') {
        for (const tr of conn.getTransceivers()) {
          if (tr && tr.direction && tr.direction !== 'stopped' && tr.direction !== 'sendrecv') {
            tr.direction = 'sendrecv';
          }
        }
      }
    };

    const origGetDescription = sdh.getDescription.bind(sdh);
    sdh.getDescription = async (...args) => {
      ensureBidirectionalTracks(args[0]);
      return origGetDescription(...args);
    };

    return sdh;
  };
}

function sessionKey(session) {
  return `${session?.server || ''}|${session?.username || ''}|${session?.wsUrl || ''}`;
}

// A live registration, if this tab has one. Module scope on purpose: an inbound INVITE and an
// outbound dial must reach the same UserAgent, or the tab rings on a session it cannot answer.
let standby = null;

export function extractCallerNumber(invitation) {
  if (!invitation) return 'Unknown';

  const parseSipUriUser = (rawVal) => {
    if (!rawVal) return '';
    const str = String(rawVal);
    const m = str.match(/sip(?:s)?:([^@>;]+)/i);
    if (m && m[1]) {
      const u = m[1].trim();
      if (u && !['anonymous', 'unknown'].includes(u.toLowerCase())) return u;
    }
    return '';
  };

  const getHdr = (name) => {
    try {
      if (typeof invitation.request?.getHeader === 'function') {
        const v = invitation.request.getHeader(name);
        if (v) return v;
      }
      if (typeof invitation.incomingInviteRequest?.message?.getHeader === 'function') {
        const v = invitation.incomingInviteRequest.message.getHeader(name);
        if (v) return v;
      }
    } catch { /* ignore */ }
    return null;
  };

  // 1. Asserted Identity (P-Asserted-Identity parsed by sip.js)
  const assertedUser = invitation.assertedIdentity?.uri?.user;
  if (assertedUser && !['anonymous', 'unknown'].includes(String(assertedUser).toLowerCase())) {
    return String(assertedUser).trim();
  }

  // 2. Explicit P-Asserted-Identity / Remote-Party-ID / Diversion headers
  for (const h of ['P-Asserted-Identity', 'Remote-Party-ID', 'Diversion']) {
    const raw = getHdr(h);
    const parsed = parseSipUriUser(raw);
    if (parsed) return parsed;
  }

  // 3. Remote Identity URI user (From user parsed by sip.js)
  const remoteUser = invitation.remoteIdentity?.uri?.user;
  if (remoteUser && !['anonymous', 'unknown'].includes(String(remoteUser).toLowerCase())) {
    return String(remoteUser).trim();
  }

  // 4. Raw From header
  const rawFrom = getHdr('From');
  const fromUser = parseSipUriUser(rawFrom);
  if (fromUser) return fromUser;

  // 5. Display names if they contain digits or useful identity
  const remoteDisplay = invitation.remoteIdentity?.displayName;
  if (remoteDisplay && remoteDisplay.trim() && !['anonymous', 'unknown'].includes(remoteDisplay.toLowerCase())) {
    return remoteDisplay.trim();
  }
  const assertedDisplay = invitation.assertedIdentity?.displayName;
  if (assertedDisplay && assertedDisplay.trim() && !['anonymous', 'unknown'].includes(assertedDisplay.toLowerCase())) {
    return assertedDisplay.trim();
  }

  return (remoteUser && String(remoteUser).trim()) || 'Unknown';
}

/**
 * Bind the INVITE handler. Everything the engine needs to decide about the call is distilled
 * to plain values here (a caller string and a normalised session state) so that sip.js types
 * never leak past this module.
 *
 * @param {object} ua                 sip.js UserAgent
 * @param {function} onIncomingCall   ({ invitation, callerNumber, accept, reject, terminate, onStateChange }) => void
 */
export function setupInboundListener(ua, onIncomingCall) {
  ua.delegate = {
    __incomingPending: false,
    onInvite(invitation) {
      const callerNumber = extractCallerNumber(invitation);
      const listeners = new Set();
      let terminatedEmitted = false;
      ua.delegate.__incomingPending = true;

      try {
        invitation.stateChange?.addListener?.((state) => {
          const s = String(state).toLowerCase();
          const normalized = s === 'established' ? 'established' : s === 'terminated' ? 'terminated' : 'progress';
          if (normalized === 'established' || normalized === 'terminated') {
            ua.delegate.__incomingPending = false;
          }
          if (normalized === 'terminated' && terminatedEmitted) return;
          if (normalized === 'terminated') terminatedEmitted = true;
          for (const fn of listeners) { try { fn(normalized, state); } catch { /* a listener must never break signalling */ } }
        });
      } catch { /* no state machine: the engine falls back to the accept/reject it called */ }

      onIncomingCall({
        invitation,
        callerNumber,
        sendDtmf: (digit) => sendSipSessionDtmf(invitation, digit),
        onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        // 486 Busy Here when another tab owns the audio; 603 Decline when the agent said no.
        reject: (options) => {
          ua.delegate.__incomingPending = false;
          try { invitation.reject(options || { statusCode: 486 }); } catch { /* already gone */ }
        },
        terminate: () => {
          ua.delegate.__incomingPending = false;
          try {
            // UAS must not cancel; if established BYE, else reject. cancel() belongs to UAC (Inviter) (G-2).
            if (typeof invitation.bye === 'function' && String(invitation.state).toLowerCase() === 'established') invitation.bye();
            else if (typeof invitation.reject === 'function') invitation.reject({ statusCode: 486 });
            else invitation.dispose?.();
          } catch { /* the session is already down */ }
        },
        accept: async (localStream, mediaHooks = {}) => {
          ua.delegate.__incomingPending = false;
          if (String(invitation.state).toLowerCase() === 'terminated') {
            throw new Error('Call already terminated (caller hung up)');
          }

          activeCallMedia = {
            localStream: localStream || null,
            onTrack: mediaHooks?.onTrack || null,
            onPeerConnection: mediaHooks?.onPeerConnection || null,
          };

          await invitation.accept({
            sessionDescriptionHandlerOptions: {
              constraints: { audio: true, video: false },
              iceGatheringTimeout: 1000,
              peerConnectionConfiguration: {
                iceServers: DEFAULT_ICE_SERVERS,
              },
            },
          });
          return invitation;
        },
      });
    },
  };
}

/**
 * Open (or reuse) the tab's persistent registration.
 *
 * @param {object} opts
 * @param {object} opts.session          descriptor from GET /api/telephony/webrtc-session
 * @param {function} opts.onIncomingCall INVITE handler (see setupInboundListener)
 * @param {function} [opts.onState]      ('registering'|'ready'|'retrying'|'unavailable', detail) => void
 * @param {object} [opts.sipStack]       optional injected SIP stack (for unit testing)
 * @returns {Promise<object>} the standby session
 */
export async function initStandbySession({ session, onIncomingCall, onState, sipStack } = {}) {
  if (!session?.server) throw new Error('No SIP server is configured (Settings → Telephony).');
  const key = sessionKey(session);
  if (standby && standby.key === key && standby.ua) return standby;
  if (standby) await disposeStandbySession();

  const sip = sipStack || await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  const { UserAgent, Registerer } = sip;

  const uri = UserAgent.makeURI(`sip:${session.username}@${session.server}`);
  if (!uri) throw new Error(`"${session.username}@${session.server}" is not a usable SIP address.`);

  const sdhFactory = buildSessionDescriptionHandlerFactory(sip);

  const ua = new UserAgent({
    uri,
    transportOptions: { server: session.wsUrl, keepAliveInterval: 30, traceSip: false },
    authorizationUsername: session.username,
    authorizationPassword: session.password,
    displayName: session.username,
    logLevel: 'error',
    ...(sdhFactory ? { sessionDescriptionHandlerFactory: sdhFactory } : {}),
    sessionDescriptionHandlerFactoryOptions: {
      peerConnectionConfiguration: {
        iceServers: DEFAULT_ICE_SERVERS,
      },
      iceGatheringTimeout: 1000,
    },
  });

  const self = { key, ua, sip, registerer: null, stopped: false, refresh: null, retry: null, keepAlive: null, session };
  standby = self;

  // Transport liveness: detect half-open WebSocket (sleep, Wi-Fi roam, NAT rebinding).
  // sip.js transport emits onDisconnect; fallback to raw WebSocket close listener.
  const onTransportDisconnect = () => {
    if (self.stopped) return;
    clearTimeout(self.refresh);
    clearTimeout(self.retry);
    onState?.('retrying', 'WebSocket disconnected — re-registering…');
    refreshStandby(self, onState, 0);
  };
  try {
    ua.transport?.onDisconnect?.(onTransportDisconnect);
    const rawWs = ua.transport?._ws || ua.transport?.ws;
    if (rawWs?.addEventListener) rawWs.addEventListener('close', onTransportDisconnect);
  } catch {}

  onState?.('registering');
  try {
    await ua.start();
  } catch (e) {
    await disposeStandbySession();
    throw new Error(`Could not reach the SIP gateway at ${session.wsUrl} — ${e?.message || e}`);
  }

  self.registerer = new Registerer(ua, { expires: REGISTER_EXPIRES });
  try {
    self.registerer.stateChange?.addListener?.((s) => {
      if (String(s).toLowerCase().includes('terminated') && !self.stopped) {
        onState?.('retrying', 'Registration terminated — retrying…');
        refreshStandby(self, onState, 0);
      }
    });
  } catch {}
  try {
    await registerStandby(self, onState);
  } catch (e) {
    await disposeStandbySession();
    throw new Error(`SIP registration for ${session.username} was refused — ${e?.message || e}`);
  }

  setupInboundListener(ua, onIncomingCall);
  onState?.('ready');
  return self;
}

async function registerStandby(self, onState) {
  await self.registerer.register({ expires: REGISTER_EXPIRES });
  if (self.stopped) return;
  onState?.('ready');
  clearTimeout(self.refresh);
  // Keep the registration alive for as long as the tab is: this is what makes the number ring
  // in the browser rather than in whatever desktop softphone happens to be open.
  self.refresh = setTimeout(() => { refreshStandby(self, onState, 0); }, REGISTER_REFRESH_MS);
  // Heartbeat: poll transport liveness; if socket silently died, next register will enter retry
  clearInterval(self.keepAlive);
  self.keepAlive = setInterval(() => {
    try {
      if (self.stopped) return;
      const t = self.ua?.transport;
      const ws = t?._ws || t?.ws || t?._socket;
      if (ws && typeof ws.readyState === 'number' && ws.readyState !== 1) {
        clearInterval(self.keepAlive);
        if (self.refresh) clearTimeout(self.refresh);
        onState?.('retrying', 'WebSocket not open — re-registering…');
        refreshStandby(self, onState, 0);
      }
    } catch {}
  }, 30000);
}

function refreshStandby(self, onState, attempt) {
  if (self.stopped) return;
  registerStandby(self, onState).catch((e) => {
    if (self.stopped) return;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    onState?.('retrying', `Registration refresh failed (${e?.message || e}) — retrying in ${Math.round(wait / 1000)}s.`);
    self.retry = setTimeout(() => refreshStandby(self, onState, attempt + 1), wait);
  });
}

export async function disposeStandbySession() {
  const self = standby;
  standby = null;
  activeCallMedia = { localStream: null, onTrack: null, onPeerConnection: null };
  if (!self) return;
  self.stopped = true;
  clearTimeout(self.refresh);
  clearTimeout(self.retry);
  clearInterval(self.keepAlive);
  try { await self.registerer?.unregister(); } catch { /* already unregistered */ }
  try { self.ua?.stop?.(); } catch { /* already stopped */ }
}

export function standbySession() {
  return standby;
}

/**
 * Place an outbound call on the tab's existing registration.
 *
 * @param {object} opts
 * @param {string} opts.remoteNumber E.164 number to dial
 * @param {function} opts.onState    (state) => void — registering | dialing | ringing | active | ended
 * @param {function} [opts.onActive] () => void
 * @param {MediaStream} [opts.localStream] microphone the engine already opened
 * @param {function} [opts.onTrack]  (track, event) => void invoked before SDP completes
 * @param {function} [opts.onPeerConnection] (pc, sdh) => void invoked when RTCPeerConnection opens
 * @returns {Promise<{stop: function, inviter: object, userAgent: object}>}
 */
export async function dialOutbound({
  remoteNumber,
  callerId,
  onState,
  onActive,
  onEnded,
  onProgress,
  onAnswered,
  onRejected,
  localStream,
  onTrack,
  onPeerConnection,
} = {}) {
  const self = standby;
  if (!self?.ua) throw new Error('The in-browser softphone is not registered yet.');
  // Glare guard: if an inbound INVITE arrived <1 s ago, do not start outbound
  if (self.ua.delegate?.__incomingPending) throw new Error('Incoming call in progress — cannot dial now (glare).');
  const sip = self.sip || await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  const { UserAgent, Inviter, SessionState } = sip;

  const server = self.session.server || 'sip.telnyx.com';
  const sanitizedTarget = sanitizeSipNumber(remoteNumber);
  if (!sanitizedTarget) throw new Error(`"${remoteNumber}" is not a usable SIP destination.`);
  const targetUriString = /@/.test(sanitizedTarget)
    ? `${sanitizedTarget.replace(/;transport=ws$/i, '')};transport=ws`
    : `sip:${sanitizedTarget}@${server};transport=ws`;
  const target = UserAgent.makeURI(targetUriString);
  if (!target) throw new Error(`"${remoteNumber}" is not a usable SIP destination.`);

  const cleanCli = sanitizeSipNumber(callerId ?? self.session?.callerId ?? '');
  const cliHeaders = cleanCli
    ? [
        `P-Asserted-Identity: <sip:${cleanCli}@${server}>`,
        `P-Preferred-Identity: <sip:${cleanCli}@${server}>`,
        `X-Pulse-Caller-ID: ${cleanCli}`,
      ]
    : [];

  activeCallMedia = {
    localStream: localStream || null,
    onTrack: onTrack || null,
    onPeerConnection: onPeerConnection || null,
  };

  const inviter = new Inviter(self.ua, target, {
    extraHeaders: cliHeaders,
    ...(cleanCli ? { fromDisplayName: cleanCli } : {}),
    sessionDescriptionHandlerOptions: {
      constraints: { audio: true, video: false },
      iceGatheringTimeout: 1000,
      peerConnectionConfiguration: {
        iceServers: DEFAULT_ICE_SERVERS,
      },
    },
  });

  let stopped = false;
  let endedNotified = false;
  let rejectionMeta = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (inviter.state === SessionState.Established && typeof inviter.bye === 'function') inviter.bye();
      else if (typeof inviter.cancel === 'function') inviter.cancel();
      else inviter.dispose?.();
    } catch { /* already gone */ }
  };

  inviter.stateChange.addListener((s) => {
    const name = String(s);
    if (name === SessionState.Establishing || name === 'Establishing') {
      onState?.('ringing');
    } else if (name === SessionState.Established || name === 'Established') {
      onState?.('active');
      onActive?.();
    } else if ((name === SessionState.Terminated || name === 'Terminated') && !stopped && !endedNotified) {
      endedNotified = true;
      onState?.('ended', rejectionMeta || undefined);
      onEnded?.(rejectionMeta || undefined);
    }
  });

  onState?.('dialing');
  try {
    await inviter.invite({
      ...(cliHeaders.length ? { requestOptions: { extraHeaders: cliHeaders } } : {}),
      requestDelegate: {
        onProgress: (response) => {
          const statusCode = response?.message?.statusCode || 180;
          const reasonPhrase = response?.message?.reasonPhrase || '';
          const body = String(response?.message?.body || '');
          const hasEarlyMedia = /\bm=audio\b/i.test(body) || /^v=0/m.test(body);
          onProgress?.({ statusCode, reasonPhrase, hasEarlyMedia });
          onState?.('ringing');
        },
        onAccept: (response) => {
          const statusCode = response?.message?.statusCode || 200;
          onAnswered?.({ statusCode });
        },
        onReject: (response) => {
          const statusCode = response?.message?.statusCode || 480;
          const reasonPhrase = response?.message?.reasonPhrase || '';
          const decoded = decodeSipRejection(statusCode, reasonPhrase);
          rejectionMeta = decoded;
          onRejected?.(decoded);
          if (!stopped && !endedNotified) {
            endedNotified = true;
            onState?.('ended', decoded);
            onEnded?.(decoded);
          }
        },
      },
    });
  } catch (e) {
    stop();
    // Rejections here are the useful ones: 401/403 means credentials, 404 means the number.
    const msg = String(e?.message || e);
    if (/491/.test(msg)) throw new Error('Glare: another call is being set up — try again in 2 seconds.');
    throw new Error(/401|403/.test(msg)
      ? 'The provider rejected the SIP credentials — check the username and password.'
      : /404/.test(msg)
        ? `The provider does not recognise ${remoteNumber}.`
        : `The call could not be placed — ${msg}`);
  }

  const sendDtmf = (digit) => sendSipSessionDtmf(inviter, digit);

  return {
    stop,
    bye: stop,
    sendDtmf,
    inviter,
    userAgent: self.ua,
    registerer: self.registerer,
    reusedRegistration: true,
  };
}

/**
 * Drive one outbound SIP call.
 *
 * Registers if the tab is not registered yet, then dials on that registration. Kept as the
 * single entry point the engine calls, so "is the softphone standing by?" stays an
 * implementation detail of this module rather than a question the cockpit has to ask.
 */
export async function startSignalling({
  session,
  remoteNumber,
  callerId,
  onState,
  onError,
  onActive,
  onEnded,
  onProgress,
  onAnswered,
  onRejected,
  localStream,
  onTrack,
  onPeerConnection,
  onIncomingCall,
} = {}) {
  const sip = await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  if (!session?.server) throw new Error('No SIP server is configured (Settings → Telephony).');

  await initStandbySession({
    session,
    onIncomingCall: onIncomingCall || (() => {}),
    onState: (s, detail) => { if (s !== 'ready') onError?.(detail || 'The in-browser softphone lost its registration.'); },
  });

  return dialOutbound({
    remoteNumber,
    callerId,
    onState,
    onActive,
    onEnded,
    onProgress,
    onAnswered,
    onRejected,
    localStream,
    onTrack,
    onPeerConnection,
  });
}
