// The control protocol: one JSON object per line.
//
// stdin  — commands from the supervisor (Electron main, or a human with a pipe)
// stdout — events and command results, and *only* that. A stray console.log here corrupts
//          every consumer, so logs go to stderr through `log()`.
//
// Every command is answered with `{ id, ok, … }`, which is what lets the controller treat a
// write as a request instead of hoping: a dial that failed says so, with a reason the UI can
// show verbatim.
'use strict';

const readline = require('readline');

const MAX_LINE = 256 * 1024;

// The commands the daemon accepts. Anything else is refused rather than ignored, because an
// unimplemented action that silently does nothing is how a UI ends up waiting forever.
const ACTIONS = new Set([
  'hello', 'register', 'unregister', 'dial', 'answer', 'reject', 'hangup',
  'mute', 'dtmf', 'status', 'devices', 'audio', 'log-level', 'shutdown',
]);

class Protocol {
  /**
   * @param {object} o
   * @param {WritableStream} [o.input]   defaults to process.stdin
   * @param {WritableStream} [o.output]  defaults to process.stdout
   * @param {WritableStream} [o.errorOutput] defaults to process.stderr
   * @param {(action:string, payload:object)=>any} o.dispatch
   */
  constructor({ input, output, errorOutput, dispatch, onEof } = {}) {
    this.input = input || process.stdin;
    this.output = output || process.stdout;
    this.errorOutput = errorOutput || process.stderr;
    this.dispatch = dispatch;
    this.onEof = onEof || (() => {});
    this.level = 'info';
    this.closed = false;
    this.received = 0;
    this.parseErrors = 0;
    this.rl = null;
  }

  start() {
    this.rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    this.rl.on('close', () => { if (!this.closed) { this.closed = true; this.onEof(); } });
    return this;
  }

  stop() {
    this.closed = true;
    try { this.rl?.close(); } catch { /* already closed */ }
  }

  handleLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    this.received += 1;
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      this.parseErrors += 1;
      return this.send({ ok: false, error: `Malformed JSON on the control channel: ${e.message}` });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.parseErrors += 1;
      return this.send({ ok: false, error: 'A command must be a JSON object.' });
    }
    const action = String(msg.action || '').trim();
    const id = msg.id === undefined ? null : String(msg.id);
    if (!action) return this.send({ id, ok: false, error: 'A command needs an "action".' });
    if (!ACTIONS.has(action)) return this.send({ id, ok: false, error: `Unknown action "${action}".` });
    let result;
    try {
      result = this.dispatch(action, msg);
    } catch (e) {
      return this.send({ id, ok: false, error: String(e?.message || e) });
    }
    // A handler may be sync or async; both answer on the same channel.
    Promise.resolve(result)
      .then((value) => this.send({ id, ok: true, ...(isObject(value) ? value : { result: value }) }))
      .catch((e) => this.send({ id, ok: false, error: String(e?.message || e) }));
    return undefined;
  }

  send(payload) {
    let line;
    try {
      line = JSON.stringify(payload);
    } catch (e) {
      // A payload that cannot be serialized (a timer handle, a socket, a circular object) must
      // still produce an answer on the channel — otherwise the controller waits forever for a
      // reply that was silently dropped. Say what happened, without the offending value.
      try {
        this.output.write(`${JSON.stringify({
          id: payload?.id ?? null,
          event: payload?.event,
          ok: false,
          error: `Could not serialize this reply: ${e.message}`,
        })}\n`);
      } catch { /* stdout is gone; nothing left to do */ }
      return null;
    }
    try {
      this.output.write(`${line}\n`);
    } catch { /* a closed stdout must not take the daemon down */ }
    return payload;
  }

  emit(event, data = {}) {
    return this.send({ event, ...data });
  }

  log(level, message, extra) {
    const order = { debug: 10, info: 20, warn: 30, error: 40 };
    if ((order[level] || 20) < (order[this.level] || 20)) return;
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    try { this.errorOutput.write(`${line}\n`); } catch { /* stderr can be closed on Windows */ }
    if (level !== 'debug') this.emit('log', { level, message, ...(extra || {}) });
  }
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

module.exports = { Protocol, ACTIONS, MAX_LINE };
