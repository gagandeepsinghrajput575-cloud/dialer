// SIP client transactions: RFC 3261 T1 doubling (500 ms, 1 s, 2 s, 4 s …) until a response
// arrives. UDP loses packets; without this an INVITE can vanish and the phone never rings.
const { header } = require('./message');

class TransactionTable {
  constructor({ send, t1 = 500, onTimeout = () => {} } = {}) {
    this.send = send;
    this.t1 = Number(t1) || 500;
    this.onTimeout = onTimeout;
    this.entries = new Map();
    this.timers = new Set();
  }

  add(callId, seq, method, text) {
    const key = `${callId}|${seq}`;
    const tx = { key, method, text, attempts: 1, timer: null };
    this.entries.set(key, tx);
    tx.timer = this.schedule(key);
    return tx;
  }

  schedule(key, delay) {
    const tx = this.entries.get(key);
    if (!tx) return null;
    const wait = delay || Math.min(this.t1 * (2 ** (tx.attempts - 1)), 4000);
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      this.retransmit(key);
    }, Math.max(1, wait));
    if (handle.unref) handle.unref();
    this.timers.add(handle);
    tx.timer = handle;
    return handle;
  }

  retransmit(key) {
    const tx = this.entries.get(key);
    if (!tx) return;
    tx.attempts += 1;
    this.send(tx.text);
    if (tx.attempts < 8) this.schedule(key);
    else {
      this.remove(key);
      this.onTimeout(tx.method, key);
    }
  }

  resolve(msg) {
    const parts = header(msg, 'cseq').split(/\s+/);
    const key = `${header(msg, 'call-id')}|${parts[0] || ''}`;
    const tx = this.entries.get(key);
    if (tx) this.remove(key);
    return { method: tx ? tx.method : (parts[1] || '').toUpperCase(), seq: Number(parts[0]) || 0 };
  }

  remove(key) {
    const tx = this.entries.get(key);
    if (!tx) return;
    if (tx.timer) {
      clearTimeout(tx.timer);
      this.timers.delete(tx.timer);
    }
    this.entries.delete(key);
  }

  stop() {
    for (const handle of this.timers) clearTimeout(handle);
    this.timers.clear();
    this.entries.clear();
  }
}

module.exports = { TransactionTable };
