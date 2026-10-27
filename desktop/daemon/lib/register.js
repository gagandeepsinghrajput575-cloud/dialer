// SIP registration: REGISTER, digest retry, refresh before expiry, capped-backoff recovery.
//
// Kept out of ua.js so the call/media logic stays readable, and because registration has its
// own failure contract: a softphone that looks registered and is not simply stops ringing, so
// every failure is reported with a reason and a retry deadline instead of being swallowed.
'use strict';

const crypto = require('crypto');
const { buildUri, serialize } = require('./sipMessage');
const { branch } = require('./dialog');
const { viaOf, contactOf } = require('./transport');
const digest = require('./digest');

const REGISTER_EXPIRES = 300;
const REFRESH_MARGIN = 0.8;              // refresh at 80% of the granted lifetime
const RETRY_MS = [5000, 10000, 20000, 45000];
const KEEPALIVE_MS = 20000;              // RFC 5626 NAT keep-alive interval (20s) to beat 30s router timeouts

/**
 * Attach registration behaviour to a user agent.
 * @param {object} ua needs { transport, account, cseq, emit, log, userAgent }
 */
function attach(ua) {
  ua.registration = ua.registration || {
    state: 'unregistered', attempt: 0, timer: null, keepaliveTimer: null,
    expires: REGISTER_EXPIRES, account: '',
  };

  ua.sendKeepalive = function sendKeepalive() {
    if (!ua.account?.domain || !ua.account?.port || ua.transport?.closed) return;
    try {
      ua.transport.send(Buffer.from('\r\n\r\n'), { host: ua.account.domain, port: ua.account.port }).catch(() => {});
    } catch { /* best-effort NAT keepalive */ }
  };

  ua.startKeepalive = function startKeepalive() {
    if (ua.registration.keepaliveTimer) return;
    ua.registration.keepaliveTimer = setInterval(() => {
      if (ua.account?.domain && (ua.registration.state === 'registered' || ua.registration.state === 'registering')) {
        ua.sendKeepalive();
      }
    }, KEEPALIVE_MS);
    if (ua.registration.keepaliveTimer?.unref) {
      ua.registration.keepaliveTimer.unref();
    }
  };

  ua.stopKeepalive = function stopKeepalive() {
    if (ua.registration.keepaliveTimer) {
      clearInterval(ua.registration.keepaliveTimer);
      ua.registration.keepaliveTimer = null;
    }
  };

  ua.registerHeaders = function registerHeaders(uri, expires, viaBranch = branch()) {
    const aor = buildUri({ user: ua.account.user, host: ua.account.domain });
    return {
      Via: viaOf(ua.transport, viaBranch),
      'Max-Forwards': '70',
      From: `<${aor}>;tag=${crypto.randomBytes(6).toString('hex')}`,
      To: `<${aor}>`,
      'Call-ID': `${crypto.randomBytes(10).toString('hex')}@${ua.transport.host}`,
      Contact: `${contactOf(ua.transport, { user: ua.account.user, domain: ua.account.domain, port: ua.account.port })};expires=${expires}`,
      Expires: String(expires),
      'User-Agent': ua.userAgent,
    };
  };

  ua.sendRegister = function sendRegister(expires, authHeader, triedAuth = false, onComplete = null) {
    // The REGISTER request-URI is the realm, not a user address (RFC 3261 §10.2).
    const uri = `sip:${ua.account.domain}`;
    ua.cseq += 1;
    const viaBranch = branch();
    const msg = serialize({
      startLine: `REGISTER ${uri} SIP/2.0`,
      headers: {
        ...ua.registerHeaders(uri, expires, viaBranch),
        CSeq: `${ua.cseq} REGISTER`,
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });
    ua.registration.state = 'registering';
    ua.emit('registering', { account: ua.registration.account });
    ua.log('sip', `>> REGISTER ${ua.registration.account} (expires=${expires})`);
    ua.transport.request({
      msg,
      branch: viaBranch,
      method: 'REGISTER',
      target: { host: ua.account.domain, port: ua.account.port },
      invite: false,
      onFinal: (res) => ua.onRegisterResponse(res, { uri, expires, triedAuth, onComplete }),
      onTimeout: () => {
        if (expires === 0) {
          ua.registration.state = 'unregistered';
          onComplete?.({ status: 0, reason: 'no response from the SIP server' });
        } else ua.failRegistration('no response from the SIP server');
      },
    });
  };

  ua.onRegisterResponse = function onRegisterResponse(res, { uri, expires, triedAuth = false, onComplete = null }) {
    if (res.status >= 200 && res.status < 300) {
      // `Expires: 0` is the answer to a de-registration, and 0 is falsy — the old
      // `parseInt(...) || expires || REGISTER_EXPIRES` chain discarded it, fell through the
      // requested 0 and landed on 300, so releasing the phone reported a fresh registration and
      // armed a timer to take it back. Number.isFinite decides; 0 is a value, not an absence.
      const parsed = parseInt(res.first('expires') || '', 10);
      const requested = Number.isFinite(expires) ? expires : REGISTER_EXPIRES;
      const granted = Number.isFinite(parsed) ? parsed : requested;
      if (granted === 0 || requested === 0) {
        ua.stopRegistrationTimer();
        const was = ua.registration.state;
        ua.registration.state = 'unregistered';
        ua.registration.expires = 0;
        if (was !== 'unregistered') ua.emit('unregistered', { account: ua.registration.account });
        onComplete?.(res);
        return;
      }
      ua.registration.state = 'registered';
      ua.registration.attempt = 0;
      ua.registration.expires = granted;
      ua.emit('registered', { account: ua.registration.account, expires: granted });
      ua.scheduleRefresh(granted);
      ua.startKeepalive();
      onComplete?.(res);
      return;
    }
    // 401/407 is the normal first answer: the carrier wants the digest, not a failure report.
    if ((res.status === 401 || res.status === 407) && !triedAuth) {
      const name = res.status === 407 ? 'proxy-authenticate' : 'www-authenticate';
      const challenge = digest.pick(digest.parseChallenges(res.first(name)));
      if (challenge) {
        const header = digest.respond({
          method: 'REGISTER', uri, username: ua.account.user,
          password: ua.account.password, challenge, nc: 1,
        });
        return ua.sendRegister(expires, header, true, onComplete);
      }
    }
    if (expires === 0) {
      ua.stopRegistrationTimer();
      ua.registration.state = 'unregistered';
      onComplete?.(res);
      return;
    }
    ua.failRegistration(`${res.status || 'transport'} ${res.reason || ''}`.trim());
    onComplete?.(res);
  };

  ua.failRegistration = function failRegistration(reason) {
    ua.registration.state = 'failed';
    const delay = RETRY_MS[Math.min(ua.registration.attempt, RETRY_MS.length - 1)];
    ua.registration.attempt += 1;
    ua.log('sip', `registration failed: ${reason} — retry in ${delay}ms`);
    ua.emit('registration_failed', { reason, retryInMs: delay });
    ua.stopRegistrationTimer();
    ua.registration.timer = setTimeout(() => {
      // resetBackoff:false — this IS the backoff. Resetting the counter here made every retry
      // index RETRY_MS[0], so the documented 5/10/20/45 s ladder was dead code and a daemon with
      // bad credentials re-REGISTERed every five seconds until the carrier blocked the account.
      if (ua.registration.state === 'failed') ua.register({ expires: ua.registration.expires, resetBackoff: false });
    }, delay);
  };

  ua.scheduleRefresh = function scheduleRefresh(expires) {
    ua.stopRegistrationTimer();
    const ms = Math.max(10, Math.round(expires * REFRESH_MARGIN)) * 1000;
    ua.registration.timer = setTimeout(() => {
      if (ua.registration.state === 'registered') ua.register({ expires: ua.account.expires || REGISTER_EXPIRES });
    }, ms);
  };

  ua.stopRegistrationTimer = function stopRegistrationTimer() {
    if (ua.registration.timer) { clearTimeout(ua.registration.timer); ua.registration.timer = null; }
  };

  ua.register = function register({ expires = ua.account.expires || REGISTER_EXPIRES, resetBackoff = true } = {}) {
    const missing = ua.validateAccount();
    if (missing.length) {
      const reason = `missing ${missing.join(', ')}`;
      ua.emit('registration_failed', { reason });
      return { ok: false, reason };
    }
    ua.registration.expires = expires;
    // A human pressing "register" starts fresh; an automatic retry keeps climbing the ladder.
    // Success is the only other place attempt is zeroed (onRegisterResponse).
    if (resetBackoff) ua.registration.attempt = 0;
    ua.startKeepalive();
    ua.sendRegister(expires, null);
    return { ok: true, account: ua.registration.account };
  };

  ua.unregister = function unregister() {
    ua.stopRegistrationTimer();
    ua.stopKeepalive();
    if (!ua.account.domain || !ua.account.user) {
      ua.registration.state = 'unregistered';
      ua.emit('unregistered', { account: ua.registration.account });
      return Promise.resolve({ ok: true });
    }
    return new Promise((resolve) => {
      ua.sendRegister(0, null, false, (res) => resolve({
        ok: res.status >= 200 && res.status < 300,
        ...(res.status ? { status: res.status } : {}),
        ...(res.reason ? { error: res.reason } : {}),
      }));
    });
  };

  return ua;
}

module.exports = { attach, REGISTER_EXPIRES, REFRESH_MARGIN, RETRY_MS };
