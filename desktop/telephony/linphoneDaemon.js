// Supervisor for the in-app telephony engine.
//
// `linphone-daemon` (or `linphonec`) is a headless SIP user agent: no window, no menu bar, and
// its media path is CoreAudio with Opus/G.711, a hardware jitter buffer and echo cancellation.
// Pulse spawns it as a hidden child of the desktop shell, registers it over stdin, and maps its
// output onto the same events the browser engine emits. From the cockpit's point of view the
// two engines are indistinguishable — which is the point: the CRM does not care where the
// audio comes from, only that answering a call actually answers it.
const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn } = require('child_process');
const protocol = require('./daemonProtocol');

const BINARY_NAMES = ['linphone-daemon', 'linphonec'];

const BUNDLED = process.resourcesPath ? path.join(process.resourcesPath, 'linphone', 'bin', 'linphone-daemon') : '';

const BINARY_CANDIDATES = [
  BUNDLED,
  path.join(__dirname, '..', 'bin', 'linphone-daemon'),
  '/opt/homebrew/bin/linphone-daemon',
  '/usr/local/bin/linphone-daemon',
  '/opt/homebrew/bin/linphonec',
  '/usr/local/bin/linphonec',
].filter(Boolean);

function resolveBinary({ exists = fs.existsSync, env = process.env, platform = process.platform } = {}) {
  const candidates = [...BINARY_CANDIDATES];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of BINARY_NAMES) candidates.push(path.join(dir, platform === 'win32' ? `${name}.exe` : name));
  }
  const hit = candidates.find((candidate) => candidate && exists(candidate));
  return hit || null;
}

class LinphoneDaemon {
  constructor({ config = {}, binary = null, spawn = defaultSpawn, onEvent = () => {}, restartDelayMs = 1500, maxRestarts = 1, now = Date.now } = {}) {
    this.cfg = { user: '', domain: 'sip.telnyx.com', password: '', ...config };
    this.binary = binary;
    this.spawnChild = spawn;
    this.onEvent = onEvent;
    this.restartDelayMs = restartDelayMs;
    this.maxRestarts = maxRestarts;
    this.now = now;

    this.child = null;
    this.stopping = false;
    this.restarts = 0;
    this.buffers = { stdout: '', stderr: '' };
    this.registered = false;
    this.state = 'idle';
    this.callId = null;
    this.direction = null;
    this.peer = '';
    this.answeredAt = 0;
    this.localTerminate = false;
    this.expectOutbound = false;
  }

  get available() {
    return !!this.binary;
  }

  // Same observer contract as the SIP user agent, so the bridge does not care which engine runs.
  on(listener) {
    this.listeners = this.listeners || new Set();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start() {
    if (!this.available) {
      this.emit({ type: 'engine', state: 'unavailable', reason: 'linphone-daemon not found' });
      return false;
    }
    this.stopping = false;
    this.child = this.spawnChild(this.binary, this.args(), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LINPHONE_AUTOSTART: '1' },
    });
    this.child.stdout?.on('data', (chunk) => this.consume('stdout', chunk));
    this.child.stderr?.on('data', (chunk) => this.consume('stderr', chunk));
    this.child.on?.('error', (err) => this.emit({ type: 'engine', state: 'failed', reason: err.message }));
    this.child.on?.('exit', (code) => this.onExit(code));

    for (const line of protocol.buildRegistration(this.cfg)) this.write(line);
    this.emit({ type: 'engine', state: 'starting', binary: this.binary });
    return true;
  }

  args() {
    const extra = String(process.env.PULSE_LINPHONE_ARGS || '').trim();
    return extra ? extra.split(/\s+/) : [];
  }

  stop() {
    this.stopping = true;
    if (this.child && typeof this.child.kill === 'function') {
      try { this.write('quit'); } catch { /* stdin may already be gone */ }
      try { this.child.kill(); } catch { /* already dead */ }
    }
    this.child = null;
    this.emit({ type: 'engine', state: 'stopped' });
  }

  onExit(code) {
    this.child = null;
    this.registered = false;
    if (this.stopping) return;
    if (this.restarts < this.maxRestarts) {
      this.restarts += 1;
      setTimeout(() => { if (!this.stopping) this.start(); }, this.restartDelayMs);
      this.emit({ type: 'engine', state: 'restarting', code });
      return;
    }
    this.state = 'failed';
    this.callId = null;
    this.emit({ type: 'engine', state: 'failed', reason: `linphone-daemon exited (${code})`, code });
  }

  // ---- stdin ---------------------------------------------------------------------------
  write(line) {
    if (!line || !this.child || !this.child.stdin || this.child.stdin.writable === false) return false;
    this.child.stdin.write(`${line}\n`);
    return true;
  }

  // ---- commands ------------------------------------------------------------------------
  dial(phone) {
    const target = phone && typeof phone === 'object' ? phone.phone : phone;
    const command = protocol.buildCall(target, this.cfg.domain);
    if (!command) return false;
    this.expectOutbound = true;
    return this.write(command);
  }

  answer(callId = this.callId) {
    if (callId === null || callId === undefined) return false;
    // Exactly one command. Answering is never a teardown: no terminate, no reject.
    return this.write(protocol.buildAnswer(callId));
  }

  // The Decline button. Never reachable from answer(): this is an explicit agent decision.
  decline(callId = this.callId) {
    if (callId === null || callId === undefined) return false;
    this.localTerminate = true;
    return this.write(protocol.buildTerminate(callId));
  }

  hangup(callId = this.callId) {
    if (callId === null || callId === undefined) return false;
    this.localTerminate = true;
    return this.write(protocol.buildTerminate(callId));
  }

  dtmf(digit) {
    const command = protocol.buildDtmf(digit);
    return command ? this.write(command) : false;
  }

  mute(on = true) {
    return this.write(protocol.buildMute(on));
  }

  status() {
    return {
      engine: 'linphone',
      binary: this.binary,
      available: this.available,
      registered: this.registered,
      state: this.state,
      callId: this.callId,
      direction: this.direction,
      peer: this.peer,
    };
  }

  // ---- stdout/stderr -------------------------------------------------------------------
  consume(stream, chunk) {
    this.buffers[stream] += String(chunk || '');
    const lines = this.buffers[stream].split(/\r?\n/);
    this.buffers[stream] = lines.pop() || '';
    for (const line of lines) {
      const event = protocol.parseDaemonLine(line);
      if (event) this.apply(event);
    }
  }

  apply(event) {
    switch (event.type) {
      case 'incoming': {
        this.callId = event.callId;
        this.direction = this.expectOutbound ? 'outbound' : 'inbound';
        this.expectOutbound = false;
        this.peer = event.peer;
        this.state = 'ringing';
        this.localTerminate = false;
        this.emit({ type: 'incoming', callerPhone: event.peer, callerName: '', callId: event.callId, direction: this.direction, at: this.now() });
        return;
      }
      case 'ringing': {
        if (this.callId === null) this.callId = event.callId;
        this.peer = event.peer || this.peer;
        this.state = 'ringing';
        this.emit({ type: 'ringing', callId: event.callId, direction: this.direction, at: this.now() });
        return;
      }
      case 'answered': {
        this.callId = event.callId;
        this.state = 'connected';
        this.answeredAt = this.now();
        this.emit({ type: 'answered', callId: event.callId, direction: this.direction || 'inbound', at: this.answeredAt });
        return;
      }
      case 'ended': {
        const reason = this.localTerminate ? 'local' : event.reason;
        const durationSec = this.answeredAt ? Math.max(0, Math.round((this.now() - this.answeredAt) / 1000)) : 0;
        this.emit({ type: 'ended', callId: event.callId, direction: this.direction || 'inbound', reason, durationSec, at: this.now() });
        this.callId = null;
        this.state = 'idle';
        this.answeredAt = 0;
        this.localTerminate = false;
        return;
      }
      case 'registration': {
        this.registered = event.state === 'registered';
        this.emit({ type: 'registration', state: event.state, at: this.now() });
        return;
      }
      default:
        // A prompt is a heartbeat, not a call event.
        this.emit(event);
    }
  }

  emit(event) {
    this.onEvent(event);
    for (const listener of this.listeners || []) {
      // A prompt is a heartbeat; the cockpit has no use for it.
      if (event.type === 'prompt') continue;
      try { listener(event); } catch { /* an observer must never break telephony */ }
    }
  }
}

module.exports = { LinphoneDaemon, resolveBinary, BINARY_CANDIDATES, BINARY_NAMES };
