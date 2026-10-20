// The desktop shell writes to exactly the same CRM ledger as the browser tab. It reads the
// session token from /api/session over loopback and echoes it on every write, so the guard in
// server/middleware/guard.js stays authoritative even for the native process.
class LedgerClient {
  constructor({ baseUrl = 'http://127.0.0.1:3001', fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.tokenPromise = null;
  }

  token() {
    if (!this.tokenPromise) {
      this.tokenPromise = Promise.resolve(this.fetchImpl(`${this.baseUrl}/api/session`))
        .then((res) => res.json())
        .then((body) => (body && body.token) || '')
        .catch((err) => { this.tokenPromise = null; throw err; });
    }
    return this.tokenPromise;
  }

  async request(method, path, payload) {
    const token = await this.token();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    if (timer && timer.unref) timer.unref();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-pulse-token': token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) throw new Error(`ledger ${method} ${path} -> ${res.status}`);
      return res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  inbound({ callerPhone }) { return this.request('POST', '/api/calls/inbound', { callerPhone }); }
  answered(callId) { return this.request('PATCH', `/api/calls/${callId}`, { status: 'connected' }); }
  ended(callId, { durationSec = 0, outcome = 'conversation' } = {}) {
    return this.request('PATCH', `/api/calls/${callId}`, { status: 'completed', duration_sec: Math.round(durationSec), outcome });
  }
  missed(callId, { reason = 'missed' } = {}) {
    return this.request('POST', `/api/calls/${callId}/missed`, { reason, duration_sec: 0 });
  }
}

module.exports = { LedgerClient };
