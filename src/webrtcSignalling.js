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

import { describeReject, NO_ANSWER } from './sipReject.mjs';

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

// Route the session's outgoing audio through the microphone the engine already opened, so
// there is exactly one capture path and mute means the same thing in both directions.
// Best-effort by design: if a future sip.js changes the handler's shape, the call still works
// on sip.js's own capture.
// Hardened: intercept getDescription to guarantee tracks are attached before SDP offer creation,
// avoiding the setTimeout(0) race that produced m=audio 0 (one-way audio) on slow devices (G-4).
function micFactory(localStream, SessionDescriptionHandler) {
  if (!localStream || !SessionDescriptionHandler) return {};
  return {
    sessionDescriptionHandlerFactory: (sess, options) => {
      const sdh = new SessionDescriptionHandler(sess, options);
      const bindTracks = () => {
        try {
          const conn = sdh.peerConnection;
          if (!conn) return false;
          const senders = conn.getSenders ? conn.getSenders() : [];
          const tracks = localStream.getTracks();
          if (senders.length && senders[0] && senders[0].track) {
            // Prefer replaceTrack to preserve transceiver MID
            for (let i = 0; i < Math.min(senders.length, tracks.length); i++) {
              try { senders[i].replaceTrack(tracks[i]); } catch { try { conn.removeTrack(senders[i]); conn.addTrack(tracks[i], localStream); } catch {} }
            }
            for (let i = tracks.length; i < senders.length; i++) try { conn.removeTrack(senders[i]); } catch {}
            for (let i = senders.length; i < tracks.length; i++) conn.addTrack(tracks[i], localStream);
          } else {
            for (const sender of senders) if (sender.track) try { conn.removeTrack(sender); } catch {}
            for (const t of tracks) conn.addTrack(t, localStream);
          }
          return true;
        } catch { return false; }
      };
      // Try immediate bind; if PC not yet created, hook getDescription to bind just before offer.
      if (!bindTracks()) {
        const orig = sdh.getDescription && sdh.getDescription.bind(sdh);
        if (orig) {
          sdh.getDescription = async (...args) => { bindTracks(); return orig(...args); };
        } else {
          queueMicrotask(bindTracks);
        }
      }
      return sdh;
    },
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
          if (String(invitation.state).toLowerCase() === 'terminated') throw new Error('Call already terminated (caller hung up)');
          const sip = await loadSipStack();
          const { SessionDescriptionHandler, defaultSessionDescriptionHandlerFactory } = sip || {};

          if (localStream) {
            if (typeof defaultSessionDescriptionHandlerFactory === 'function') {
              invitation.sessionDescriptionHandlerFactory = defaultSessionDescriptionHandlerFactory(() => Promise.resolve(localStream));
            } else if (SessionDescriptionHandler) {
              Object.defineProperty(invitation, 'sessionDescriptionHandlerFactory', {
                value: (sess, options) => {
                  const mediaStreamFactory = () => Promise.resolve(localStream);
                  return new SessionDescriptionHandler(sess.userAgent.getLogger('sip.SessionDescriptionHandler'), mediaStreamFactory, options);
                },
                configurable: true,
                writable: true,
              });
            }
          }

          await invitation.accept({
            sessionDescriptionHandlerOptions: {
              constraints: { audio: true, video: false },
              iceGatheringTimeout: 1000,
              peerConnectionConfiguration: {
                iceServers: [
                  { urls: 'stun:stun.telnyx.com:3478' },
                  { urls: 'stun:stun.l.google.com:19302' },
                ],
              },
            },
          });
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
    transportOptions: { server: session.wsUrl, keepAliveInterval: 30, traceSip: false },
    authorizationUsername: session.username,
    authorizationPassword: session.password,
    displayName: session.username,
    logLevel: 'error',
    sessionDescriptionHandlerFactoryOptions: {
      peerConnectionConfiguration: {
        iceServers: [
          { urls: 'stun:stun.telnyx.com:3478' },
          { urls: 'stun:stun.l.google.com:19302' },
        ],
      },
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

// Tear a sip.js session down in the only state where its method is legal. cancel() and bye()
// REJECT with "Invalid session state <state>" anywhere else (sip.js inviter.js / session.js), and
// the old unguarded call left that rejection with nobody listening: the uncaught error that
// crashed call teardown when the carrier had already ended the call. Dispose is the catch-all.
export function endSession(inviter) {
  const settle = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
  try {
    const st = String(inviter?.state);
    if (st === 'Established' && typeof inviter.bye === 'function') settle(inviter.bye());
    else if ((st === 'Initial' || st === 'Establishing') && typeof inviter.cancel === 'function') settle(inviter.cancel());
    else settle(inviter?.dispose?.());
  } catch { /* already gone */ }
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
export async function dialOutbound({ remoteNumber, onState, onActive, onEnded, localStream } = {}) {
  const self = standby;
  if (!self?.ua) throw new Error('The in-browser softphone is not registered yet.');
  // Glare guard: if an inbound INVITE arrived <1 s ago, do not start outbound
  if (self.ua.delegate?.__incomingPending) throw new Error('Incoming call in progress — cannot dial now (glare).');
  const sip = await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  const { UserAgent, Inviter, SessionState, SessionDescriptionHandler } = sip;

  const server = self.session.server;
  const target = UserAgent.makeURI(`sip:${remoteNumber}@${server};transport=ws`);
  if (!target) throw new Error(`"${remoteNumber}" is not a usable SIP destination.`);

  const inviter = new Inviter(self.ua, target, {
    sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    ...micFactory(localStream, SessionDescriptionHandler),
  });

  let stopped = false;
  let answered = false;
  let reported = false;
  let rejectMsg = '';
  const stop = () => {
    if (stopped) return;
    stopped = true;
    endSession(inviter);
  };

  inviter.stateChange.addListener((s) => {
    const name = String(s);
    if (name === SessionState.Establishing || name === 'Establishing') onState?.('ringing');
    else if (name === SessionState.Established || name === 'Established') { answered = true; onState?.('active'); onActive?.(); }
    else if ((name === SessionState.Terminated || name === 'Terminated') && !stopped) {
      // sip.js fires this BEFORE the request delegate hears the final response, so the carrier's
      // reason is not known yet. A microtask lets the delegate run first.
      queueMicrotask(() => {
        if (stopped || reported) return;
        reported = true;
        stopped = true;
        onEnded?.({ answered, reason: answered ? '' : (rejectMsg || NO_ANSWER) });
      });
    }
  });

  onState?.('dialing');
  try {
    await inviter.invite({
      requestDelegate: {
        onReject: (res) => { rejectMsg = describeReject(res?.message?.statusCode, res?.message?.reasonPhrase); },
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
 * @param {function} opts.onActive     () => void
 * @param {MediaStream} [opts.localStream] microphone the engine already opened
 * @param {function} [opts.onIncomingCall] INVITE handler, when the engine wants standby calls
 * @returns {Promise<{stop: function}>}
 */
export async function startSignalling({ session, remoteNumber, onState, onError, onActive, onEnded, localStream, onIncomingCall } = {}) {
  const sip = await loadSipStack();
  if (!sip) throw new Error(INSTALL_HINT);
  if (!session?.server) throw new Error('No SIP server is configured (Settings → Telephony).');

  await initStandbySession({
    session,
    onIncomingCall: onIncomingCall || (() => {}),
    onState: (s, detail) => { if (s !== 'ready') onError?.(detail || 'The in-browser softphone lost its registration.'); },
  });

  return dialOutbound({ remoteNumber, onState, onActive, onEnded, localStream });
}
