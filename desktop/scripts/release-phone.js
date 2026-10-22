// Tell the server the native phone is gone — synchronously, on the way out.
//
// `desktop/main.js` calls this from Electron's will-quit handler, which cannot await. Without it
// the server would keep believing a native phone exists for another HEARTBEAT_TTL_MS (45 s), and
// an inbound call in that window would ring into a process that no longer exists.
//
// It clears the heartbeat only. The opt-in (`native_sip_engine`) is deliberately left alone:
// running the desktop app again is the whole of re-enabling the native phone, and a test asserts
// that quitting does not silently undo the agent's choice.
'use strict';

const base = String(process.argv[2] || process.env.PULSE_API_BASE || 'http://127.0.0.1:3001').replace(/\/+$/, '');

async function main() {
  const session = await fetch(`${base}/api/session`).then((r) => r.json()).catch(() => null);
  await fetch(`${base}/api/telephony/native-heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pulse-token': session?.token || '' },
    body: JSON.stringify({ clear: true }),
  }).catch(() => null);
}

main().then(() => process.exit(0), () => process.exit(0));
// A hung socket must not hold the app open: the server's TTL catches it either way.
setTimeout(() => process.exit(0), 2500).unref?.();
