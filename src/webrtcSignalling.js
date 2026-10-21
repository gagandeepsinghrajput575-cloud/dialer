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
//
// ## Status: wired, not verified against a live PBX
//
// The stack is sip.js, bundled lazily (the chunk is only fetched when the softphone is used).
// The dialer is honest about what it can guarantee: registration, media and the INVITE
// delegate are handled here, but until the credentials point at a reachable gateway nothing
// can prove the far end answers. If the stack cannot be loaded at all, this throws a message
// the agent can act on instead of letting the cockpit pretend a call is up.

import { inviteWithDelegate, rejectionDelegate } from './outboundFailure.mjs';
import { WEBRTC_PEER_CONFIGURATION } from './webrtcConfig.mjs';
import { callerIdHeaders, extractCallerNumber } from './callerNumber.mjs';
import { clearActiveLocalStream, mediaStreamFactory, setActiveLocalStream } from './mediaStream.js';
import { isEarlyMedia } from './outboundPeer.mjs';

const INSTALL_HINT = 'The in-browser softphone needs its SIP stack. Run: npm install sip.js';

// Ask for a short registration and refresh it well before it lapses. A stale registration is
// the quiet failure mode of a standby softphone: the tab looks ready and simply stops ringing.
export const REGISTER_EXPIRES = 300;
const REGISTER_REFRESH_MS = 240000;
const RETRY_MS = [5000, 10000, 20000, 45000];

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

// Answer an INVITE without ever touching a read-only accessor. Exported so the regression is
// pinned by a test that supplies an invitation whose factory getter has no setter — the exact
// shape sip.js presents.
export async function acceptInvitation(invitation, localStream, options = {}) {
  if (!invitation || typeof invitation.accept !== 'function') throw new Error('No invitation to accept.');
  if (String(invitation.state || '').toLowerCase() === 'terminated') {
    throw new Error('Call already terminated (caller hung up)');
  }
  setActiveLocalStream(localStream);
  return invitation.accept({
    sessionDescriptionHandlerOptions: {
      constraints: { audio: true, video: false },
      // 1 s was too aggressive: a slow STUN round trip produced an answer with no candidates,
      // and the carrier tore the call down a couple of seconds after the 200 OK.
      iceGatheringTimeout: 3000,
      peerConnectionConfiguration: WEBRTC_PEER_CONFIGURATION,
      ...options,
    },
  });
}

function sessionKey(session) {
  return `${session?.server || ''}|${session?.username || ''}|${session?.wsUrl || ''}`;
}

// A live registration, if this tab has one. Module scope on purpose: an inbound INVITE and an
// outbound dial must reach the same UserAgent, or the tab rings on a session it cannot answer.
let standby = null;

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
        accept: async (localStream) => {
          ua.delegate.__incomingPending = false;
          await acceptInvitation(invitation, localStream);
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
 * @returns {Promise<object>} the standby session
 */
export async function initStandbySession({ session, onIncomingCall, onState } = {}) {
  if (!session?.server) throw new Error('No SIP server is configured (Settings → Telephony).');
  const key = sessionKey(session);
  if (standby && standby.key === key && standby.ua) return standby;
  if (standby) await disposeStandbySession();

  const sip = await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  const { UserAgent, Registerer } = sip;

  const uri = UserAgent.makeURI(`sip:${session.username}@${session.server}`);
  if (!uri) throw new Error(`"${session.username}@${session.server}" is not a usable SIP address.`);

  const ua = new UserAgent({
    uri,
    // One capture path for both directions: sip.js asks this factory for the media stream, and
    // it answers with the microphone the cockpit already holds (mute, level meter and the call
    // all agree), or opens its own if the call started on sip.js's terms.
    ...(typeof sip.defaultSessionDescriptionHandlerFactory === 'function'
      ? { sessionDescriptionHandlerFactory: sip.defaultSessionDescriptionHandlerFactory(mediaStreamFactory) }
      : {}),
    transportOptions: { server: session.wsUrl, keepAliveInterval: 30, traceSip: false },
    authorizationUsername: session.username,
    authorizationPassword: session.password,
    displayName: session.username,
    logLevel: 'error',
    sessionDescriptionHandlerFactoryOptions: {
      peerConnectionConfiguration: WEBRTC_PEER_CONFIGURATION,
      iceGatheringTimeout: 1000,
    },
  });

  const self = { key, ua, registerer: null, stopped: false, refresh: null, retry: null, keepAlive: null, session };
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
  clearActiveLocalStream();
  const self = standby;
  standby = null;
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
 * @returns {Promise<{stop: function, inviter: object, userAgent: object}>}
 */
export async function dialOutbound({ remoteNumber, onState, onActive, onError, onEarlyMedia, onRinging, callerId, localStream } = {}) {
  const self = standby;
  if (!self?.ua) throw new Error('The in-browser softphone is not registered yet.');
  // Glare guard: if an inbound INVITE arrived <1 s ago, do not start outbound
  if (self.ua.delegate?.__incomingPending) throw new Error('Incoming call in progress — cannot dial now (glare).');
  const sip = await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  const { UserAgent, Inviter, SessionState } = sip;

  const server = self.session.server;
  // The proxy's address, nothing else: `transport` is a next-hop parameter and our next hop is
  // the WebSocket the UA already holds. Some SBC dial plans match the whole Request-URI.
  const target = UserAgent.makeURI(`sip:${remoteNumber}@${server}`);
  if (!target) throw new Error(`"${remoteNumber}" is not a usable SIP destination.`);

  setActiveLocalStream(localStream);
  let stopped = false;
  let established = false;
  // sip.js reports a rejection only as `Terminated`, indistinguishable from our own hang-up:
  // the status code (486 busy, 404 unknown, 503 no route) is handed to Inviter's private
  // handler and dropped. Reading it here is the only way the agent can be told why.
  const requestDelegate = rejectionDelegate({
    remoteNumber,
    // The far end is ringing. `code` is 180 (no audio yet) or 183 (carrier audio, played by the
    // SDH delegate) — either way the UI leaves "Dialing" the moment this fires.
    onRinging: (code) => { onRinging?.(code); onState?.('ringing'); },
    onReject: (message) => onError?.(message),
  });
  // NOTE: `requestDelegate` is deliberately NOT here. sip.js reads it only from the options
  // object passed to `invite()`, never from the constructor — a delegate put in this bucket is
  // silently ignored, and then no 180/183 or 4xx ever reaches the cockpit.
  const inviter = new Inviter(self.ua, target, {
    // 183 with SDP is played to the agent instead of dropped (see the delegate below). sip.js
    // requires a non-forking INVITE for this; the carrier's PSTN leg does not fork.
    earlyMedia: true,
    extraHeaders: callerIdHeaders(callerId, server),
    sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false }, iceGatheringTimeout: 3000 },
  });
  // Hand the description handler to the engine as soon as it exists: that is what carries the
  // carrier's 183 audio (an intercept message, foreign ringback). The talk timer still waits for
  // the 200 OK — see the state machine below — so this cannot bill a second of silence.
  inviter.delegate = {
    onSessionDescriptionHandler: (sdh, provisional) => { if (isEarlyMedia(provisional, established)) onEarlyMedia?.(sdh); },
  };

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
    // `Establishing` fires when the INVITE leaves the browser, before the carrier has said
    // anything. Ringing is only claimed once a 180/183 actually arrives (see the delegate).
    if (name === SessionState.Establishing || name === 'Establishing') onState?.('dialing');
    else if (name === SessionState.Established || name === 'Established') { established = true; onState?.('active'); onActive?.(); }
    else if ((name === SessionState.Terminated || name === 'Terminated') && !stopped) onState?.('ended');
  });

  onState?.('dialing');
  try {
    await inviteWithDelegate(inviter, requestDelegate);
  } catch (e) {
    // Local failures only (no SDP, no media, a dead socket): carrier rejections arrive later
    // through the delegate above, because `invite()` resolves once the request is *sent*.
    stop();
    throw new Error(`The call could not be placed — ${e?.message || e}`);
  }

  return { stop, inviter, userAgent: self.ua, registerer: self.registerer, reusedRegistration: true };
}

/**
 * Drive one outbound SIP call.
 *
 * Registers if the tab is not registered yet, then dials on that registration. Kept as the
 * single entry point the engine calls, so "is the softphone standing by?" stays an
 * implementation detail of this module rather than a question the cockpit has to ask.
 *
 * @param {object}   opts
 * @param {object}   opts.session      descriptor from GET /api/telephony/webrtc-session
 * @param {string}   opts.remoteNumber E.164 number to dial
 * @param {function} opts.onState      (state) => void   — registering | dialing | ringing | active | ended
 * @param {function} opts.onError      (message) => void
 * @param {function} [opts.onEarlyMedia] (sdh) => void — 183 audio, before the call is up
 * @param {function} [opts.onRinging]  (code) => void — 180/183 arrived, the far end is ringing
 * @param {function} opts.onActive     () => void
 * @param {MediaStream} [opts.localStream] microphone the engine already opened
 * @param {function} [opts.onIncomingCall] INVITE handler, when the engine wants standby calls
 * @returns {Promise<{stop: function}>}
 */
export async function startSignalling({ session, remoteNumber, callerId, onState, onError, onEarlyMedia, onRinging, onActive, localStream, onIncomingCall } = {}) {
  const sip = await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  if (!session?.server) throw new Error('No SIP server is configured (Settings → Telephony).');

  await initStandbySession({
    session,
    onIncomingCall: onIncomingCall || (() => {}),
    // `registering` and `retrying` are the registration healing itself; surfacing them as
    // errors painted a failure over a call that then dialled perfectly well.
    onState: (s, detail) => { if (s === 'unavailable') onError?.(detail || 'The in-browser softphone is unavailable.'); },
  });

  return dialOutbound({ remoteNumber, onRinging, onState, onActive, onError, onEarlyMedia, callerId: callerId || session?.callerId, localStream });
}
