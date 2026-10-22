#!/usr/bin/env node
// pulse-sip-daemon — headless SIP + CoreAudio user agent for Pulse Dialer.
//
// Runs with no window, no dock icon and no menubar item: it is a child process whose entire
// interface is JSON lines on stdin/stdout. Executed either by Electron itself
// (ELECTRON_RUN_AS_NODE=1, which is what desktop/bin/pulse-sip-daemon does) or by any Node 18+.
//
//   --api-base URL      fetch carrier credentials from the local API (recommended)
//   --user/--password/--domain/--port/--caller-id
//                       inline credentials, for a manual run or a carrier the API does not know
//   --audio BACKEND     coreaudio | portaudio | null | auto   (default auto)
//   --control-port N    also accept the same protocol on 127.0.0.1:N (debugging)
//   --log-level L       debug | info | warn | error          (default info)
//   --sip-port N        local SIP port (0 = ephemeral; a trunk behind NAT usually wants this)
'use strict';

const net = require('net');
const { Transport } = require('./lib/transport');
const { UserAgent } = require('./lib/ua');
const { Protocol } = require('./lib/protocol');
const audio = require('./lib/audio');
const credentials = require('./lib/credentials');

const VERSION = '1.0.0';

function parseArgs(argv) {
  const out = {
    apiBase: process.env.PULSE_API_BASE || '', audio: 'auto', controlPort: 0,
    logLevel: 'info', sipPort: 0, publicIp: process.env.PULSE_PUBLIC_IP || '',
    // A supervised daemon dies with its supervisor: stdin closing means Electron is gone.
    // Tests and manual runs pass --keep-alive to stay up without a controlling parent.
    exitOnEof: true,
    account: {},
  };
  const alias = { user: 'user', password: 'password', domain: 'domain', port: 'port', 'caller-id': 'callerId', transport: 'transport' };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = (eq < 0 ? arg : arg.slice(0, eq)).slice(2);
    const value = eq >= 0 ? arg.slice(eq + 1) : String(argv[++i] ?? '');
    switch (name) {
      case 'api-base': out.apiBase = value; break;
      case 'audio': out.audio = value; break;
      case 'control-port': out.controlPort = parseInt(value, 10) || 0; break;
      case 'log-level': out.logLevel = value; break;
      case 'sip-port': out.sipPort = parseInt(value, 10) || 0; break;
      case 'public-ip': out.publicIp = value; break;
      case 'keep-alive': out.exitOnEof = false; break;
      case 'help': out.help = true; break;
      default: {
        const key = alias[name];
        if (key) out.account[key] = key === 'port' ? parseInt(value, 10) || 5060 : value;
        break;
      }
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { process.stderr.write(HELP); return 0; }

  const chosen = audio.load(opts.audio);
  const transport = new Transport({ sipPort: opts.sipPort });
  await transport.open();

  // `ua` and `protocol` reference each other, so both are declared before either is used: the
  // closures below run on the first line of input, never during construction.
  let ua = null;
  const protocol = new Protocol({
    dispatch: (action, msg) => dispatch(action, msg, { get ua() { return ua; }, opts, chosen }),
    onEof: () => { if (opts.exitOnEof) shutdown('stdin closed'); },
  });
  protocol.level = opts.logLevel;

  ua = new UserAgent({
    transport,
    audio: chosen.backend,
    account: { transport: 'udp', ...opts.account },
    publicIp: opts.publicIp,
    log: (scope, message) => protocol.log('debug', `[${scope}] ${message}`),
  });

  // Daemon -> controller. `ended` and `registered` are the two the UI cannot function without.
  // 'error' must be in this list for a second reason: an EventEmitter that emits 'error' with no
  // listener throws it as an uncaught exception, so a media fault would take the daemon down
  // instead of reaching the screen.
  const forward = ['registered', 'unregistered', 'registering', 'registration_failed', 'incoming',
    'ringing', 'dialing', 'provisional', 'connected', 'ended', 'mute', 'dtmf', 'audio_level',
    'state', 'rejected_incoming', 'error', 'media_timeout'];
  for (const name of forward) ua.on(name, (data) => protocol.emit(name, data || {}));

  protocol.start();
  protocol.emit('ready', {
    pid: process.pid, version: VERSION, audio: chosen.backend.describe?.() || { name: chosen.name },
    audioErrors: chosen.errors, transport: { host: transport.host, port: transport.port },
  });

  const control = opts.controlPort ? openControlSocket(opts.controlPort, protocol) : null;

  // Credentials arrive async: the API may still be booting when Electron spawns us.
  if (opts.apiBase) {
    hydrate(opts, ua, protocol).catch((e) => protocol.emit('registration_failed', { reason: String(e?.message || e) }));
  } else if (ua.validateAccount().length === 0) {
    ua.register();
  } else {
    protocol.emit('registration_failed', { reason: 'No credentials: pass --api-base or --domain/--user/--password.' });
  }

  function shutdown(why) {
    protocol.log('info', `shutting down (${why})`);
    try { ua.close(); } catch { /* already down */ }
    try { control?.close(); } catch { /* already down */ }
    protocol.emit('shutdown', { reason: why });
    setTimeout(() => process.exit(0), 30).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => {
    protocol.emit('error', { message: String(e?.message || e), stack: String(e?.stack || '').split('\n')[1] || '' });
    protocol.log('error', `uncaught: ${e?.message || e}`);
  });
  return 0;
}

function applyAccount(ua, creds, inline = {}) {
  // Command-line credentials win: they are how an operator debugs one account against a trunk.
  ua.setAccount({
    domain: inline.domain || creds.domain,
    port: inline.port || creds.port || 5060,
    user: inline.user || creds.user,
    password: inline.password || creds.password,
    callerId: inline.callerId || creds.callerId || creds.did || '',
    transport: creds.transport || 'udp',
    expires: creds.expires || 300,
  });
  return ua.account;
}

async function hydrate(opts, ua, protocol) {
  const { credentials: creds } = await credentials.load(opts.apiBase);
  const account = applyAccount(ua, creds, opts.account);
  protocol.emit('account', { carrier: creds.carrier, account: `${account.user}@${account.domain}`, callerId: account.callerId });
  ua.register();
  return account;
}

async function dispatch(action, msg, { ua, opts, chosen }) {
  switch (action) {
    case 'hello': return { version: VERSION, audio: chosen.name, actions: [...require('./lib/protocol').ACTIONS] };
    case 'register': {
      if (msg.domain || msg.user || msg.password) {
        ua.setAccount({
          domain: msg.domain, port: Number(msg.port) || 5060, user: msg.user, password: msg.password,
          callerId: msg.callerId || ua.account.callerId, transport: msg.transport || 'udp',
          expires: Number(msg.expires) || 300,
        });
      } else if (opts.apiBase) {
        const { credentials: creds } = await credentials.load(opts.apiBase);
        applyAccount(ua, creds, {});
      }
      return ua.register({ expires: Number(msg.expires) || undefined });
    }
    case 'unregister': return ua.unregister();
    case 'dial': return ua.dial(msg.number, { callId: msg.callId ?? null });
    case 'answer': return ua.answer(msg.callId);
    case 'reject': return ua.reject(msg.callId, Number(msg.code) || 486);
    case 'hangup': return ua.hangup(msg.callId);
    case 'mute': return ua.setMute(msg.enabled === undefined ? !ua.muted : !!msg.enabled);
    case 'dtmf': return ua.sendDtmf(msg.digit);
    case 'status': return ua.status();
    case 'devices': return chosen.backend.devices?.() || { inputs: [], outputs: [] };
    case 'audio': return chosen.backend.describe?.() || { name: chosen.name };
    case 'log-level': return { level: msg.level };
    case 'shutdown': process.kill(process.pid, 'SIGTERM'); return { ok: true };
    default: return { ok: false, error: `Unknown action "${action}"` };
  }
}

// The same protocol on loopback, for a second controller or a manual `nc` session. Opt-in and
// bound to 127.0.0.1 only: a SIP daemon that accepts commands from the network is a wiretap.
function openControlSocket(port, protocol) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) protocol.handleLine(line);
    });
    socket.on('error', () => {});
  });
  server.on('error', (e) => protocol.log('warn', `control socket unavailable: ${e.message}`));
  server.listen(port, '127.0.0.1');
  return server;
}

const HELP = `pulse-sip-daemon ${VERSION} — headless SIP audio daemon for Pulse Dialer
Usage: pulse-sip-daemon [--api-base URL] [--audio coreaudio|portaudio|null|auto]
                        [--domain HOST --port N --user U --password P --caller-id +45...]
                        [--sip-port N] [--control-port N] [--log-level debug|info|warn|error]
                        [--keep-alive]   stay up when stdin closes (tests, manual runs)
Commands (JSON, one per line on stdin): register, dial, answer, reject, hangup, mute, dtmf,
                                        status, devices, audio, unregister, shutdown
`;

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e?.stack || e}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, dispatch, VERSION, HELP };
