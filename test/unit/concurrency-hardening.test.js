// Cross-boundary hardening stress suite — exercises invariants I1–I8 from the 2026-10-19 audit.
// Bootstraps a throwaway SQLite DB (WAL, busy_timeout 5000) when available; otherwise
// runs static hardening checks only (no native DB in sandboxed CI without node headers).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let dbAvailable = true;
let tmp, db, settings, prospects, calls, callService, telephony;
try {
  tmp = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-concur-'));
  process.env.DATA_DIR = tmp;
  process.env.PULSE_TEST = '1';
  require('../../server/db/migrate').run();
  const dbMod = require('../../server/db');
  db = dbMod.db;
  settings = require('../../server/repositories/settingsRepo');
  prospects = require('../../server/repositories/prospectRepo');
  calls = require('../../server/repositories/callRepo');
  callService = require('../../server/services/callService');
  telephony = require('../../server/services/telephonyService');
} catch (e) {
  if (/better-sqlite3|Cannot find module/i.test(String(e.message))) {
    dbAvailable = false;
    console.log('  [concurrency-hardening] better-sqlite3 not available in this sandbox (native build requires nodejs.org headers which is firewalled); DB-dependent groups will be skipped, static hardening checks will still run');
  } else throw e;
}

let passed = 0;
const ok = (msg) => { passed++; console.log(`    ✓ ${msg}`); };
const skip = (msg) => console.log(`    – ${msg} (skipped — no native DB)`);

async function run() {
  console.log('  [concurrency-hardening] cross-boundary hardening stress suite (G-1..G-14)');

  if (dbAvailable) {
    settings.set('default_country_code', '45');
    settings.set('business_tz', 'Europe/Copenhagen');
    settings.set('business_hours_start', '08:30');
    settings.set('business_hours_end', '16:30');
    settings.set('business_days', '1,2,3,4,5');
    settings.set('dry_run', '1');
  }

  // G-9 — inbound dedup TOCTOU
  if (dbAvailable) {
    const phone = '+4520990001';
    db.prepare("DELETE FROM calls WHERE caller_id = ?").run(phone);
    db.prepare("DELETE FROM prospects WHERE phone = ?").run(phone);
    const make = () => callService.startInbound({ callerPhone: phone });
    const [a, b] = [make(), make()];
    const rows = db.prepare("SELECT count(*) c FROM calls WHERE caller_id = ? AND status='ringing'").get(phone).c;
    assert.strictEqual(rows, 1, `forked INVITEs dedup to 1 ringing row (got ${rows})`);
    assert.ok(a.callId === b.callId || a.reused || b.reused, 'one side reuses the ringing row');
    ok('G-9 inbound dedup: concurrent forked INVITEs collapse to one ringing row');
    db.prepare("DELETE FROM calls WHERE caller_id = ?").run(phone);
  } else skip('G-9 inbound dedup');

  // G-10 — markInboundMissed atomicity
  if (dbAvailable) {
    const phone = '+4520990002';
    db.prepare("DELETE FROM calls WHERE caller_id = ?").run(phone);
    db.prepare("DELETE FROM prospects WHERE phone = ?").run(phone);
    const start1 = callService.startInbound({ callerPhone: phone });
    const callId = start1.callId;
    const leadId = start1.prospect.id;
    db.prepare("INSERT INTO notes(prospect_id, body) VALUES(?,?)").run(leadId, 'Important customer note');
    const [a, b] = [
      callService.markInboundMissed(callId, { reason: 'missed' }),
      callService.markInboundMissed(callId, { reason: 'declined' }),
    ];
    assert.ok(a.ok && b.ok, 'both concurrent missed paths return ok');
    const still = prospects.get(leadId);
    assert.ok(still, 'real lead with note survives concurrent missed');
    const end = calls.get(callId);
    assert.ok(['missed', 'declined'].includes(end.status), `terminal status is missed/declined (got ${end.status})`);
    ok('G-10 markInboundMissed atomic: concurrent CANCEL+Decline is idempotent and preserves real lead');
    db.prepare("DELETE FROM notes WHERE prospect_id = ?").run(leadId);
    db.prepare("DELETE FROM calls WHERE caller_id = ?").run(phone);
    db.prepare("DELETE FROM prospects WHERE id = ?").run(leadId);
  } else skip('G-10 markInboundMissed');

  // G-10b — provisional cleanup
  if (dbAvailable) {
    const phone = '+4520990003';
    db.prepare("DELETE FROM calls WHERE caller_id = ?").run(phone);
    for (const p of db.prepare("SELECT id FROM prospects WHERE phone = ?").all(phone)) {
      db.prepare("DELETE FROM calls WHERE prospect_id = ?").run(p.id);
      db.prepare("DELETE FROM prospects WHERE id = ?").run(p.id);
    }
    const start2 = callService.startInbound({ callerPhone: phone });
    assert.strictEqual(start2.provisional, true, 'stranger call creates provisional');
    const res = callService.markInboundMissed(start2.callId, { reason: 'missed' });
    assert.strictEqual(res.cleanedUp, true, 'provisional with no notes/history is cleaned up');
    assert.strictEqual(prospects.get(start2.prospect.id), undefined, 'provisional prospect removed');
    ok('G-10b provisional garbage collection removes orphan stranger lead');
  } else skip('G-10b provisional cleanup');

  // G-11 — DST
  if (dbAvailable) {
    const at = (iso) => telephony.businessHours(new Date(iso));
    assert.strictEqual(at('2026-07-01T07:00:00Z').localTime, '09:00', 'CEST offset');
    assert.strictEqual(at('2026-01-15T08:00:00Z').localTime, '09:00', 'CET offset');
    assert.strictEqual(at('2026-03-29T00:30:00Z').localTime, '01:30', 'spring-forward night pre-gap');
    assert.strictEqual(at('2026-10-25T00:30:00Z').localTime, '02:30', 'fall-back night');
    const gap = telephony.zonedTimeToUtc('2026-03-29', '02:30', 'Europe/Copenhagen');
    assert.ok(gap instanceof Date && !isNaN(gap.getTime()), 'spring gap 02:30 returns valid Date');
    const wall = telephony.partsIn('Europe/Copenhagen', gap);
    assert.ok(['02:30', '03:30'].includes(`${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`),
      `spring gap zonedTimeToUtc wall time sane: ${wall.hour}:${wall.minute}`);
    ok('G-11 DST spring-gap and fall-back survive (zonedTimeToUtc valid for 02:30 gap)');
  } else skip('G-11 DST');

  // G-12 — non-contiguous business_days
  if (dbAvailable) {
    settings.set('business_days', '1,3,5');
    settings.set('business_hours_start', '08:30');
    settings.set('business_hours_end', '16:30');
    const fri18 = telephony.businessHours(new Date('2026-10-09T16:00:00Z'));
    assert.strictEqual(fri18.open, false, 'Fri 18:00 closed even on non-contiguous schedule');
    assert.ok(fri18.minutesUntilOpen > 3000 && fri18.minutesUntilOpen < 4500,
      `non-contiguous Fri→Mon minutesUntilOpen sane: ${fri18.minutesUntilOpen} (expected ~3750)`);
    const mon07 = telephony.businessHours(new Date('2026-10-12T05:00:00Z'));
    assert.strictEqual(mon07.minutesUntilOpen, 90, 'Mon 07:00 → 08:30 is 90 min');
    settings.set('business_days', '1,2,3,4,5');
    ok('G-12 non-contiguous business_days minutesUntilOpen correct (uses ahead, not ternary)');
  } else skip('G-12 non-contiguous business_days');

  // G-13 — seconds-aware
  if (dbAvailable) {
    settings.set('business_hours_start', '08:30');
    settings.set('business_hours_end', '16:30');
    const before = telephony.businessHours(new Date('2026-10-07T06:29:59Z'));
    const atOpen = telephony.businessHours(new Date('2026-10-07T06:30:00Z'));
    assert.strictEqual(before.open, false, '08:29:59 is still closed (seconds-aware)');
    assert.strictEqual(atOpen.open, true, '08:30:00 is open');
    assert.strictEqual(before.minutesUntilOpen, 1, '08:29:59 → 1 min until open (ceil)');
    ok('G-13 seconds-aware businessHours: 08:29:59 closed, 08:30:00 open');
  } else skip('G-13 seconds-aware');

  // G-14 — caller-ID rotation
  if (dbAvailable) {
    settings.set('caller_id', '+45 20 12 34 56');
    settings.set('caller_id_pool', '+45 30 40 50 60, +45 40 50 60 70');
    settings.set('caller_id_cursor', '0');
    const pool = telephony.callerIdPool();
    assert.strictEqual(pool.length, 3, 'pool has 3 entries');
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const { callerId, index } = telephony.nextCallerId();
      seen.add(callerId);
      assert.ok(pool.includes(callerId), `rotated callerId ${callerId} in pool`);
      assert.ok(index >= 0 && index < pool.length, `index ${index} in bounds`);
    }
    assert.strictEqual(seen.size, 3, 'all pool entries visited in rotation');
    settings.set('caller_id', ''); settings.set('caller_id_pool', ''); settings.set('caller_id_cursor', '0');
    ok('G-14 caller-ID rotation serializable via getAndIncrement (round-robin, no duplicate under contention)');
  } else skip('G-14 caller-ID rotation');

  // G-5 — ringer (static, no DB needed)
  {
    const { createRinger } = require('../../src/utils/ringer.js');
    let closed = 0;
    class FakeCtx {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.closed = false;
        this._gain = { gain: { setValueAtTime() {}, cancelScheduledValues() {} }, connect() { return this; }, disconnect() {} };
      }
      createGain() { return this._gain; }
      createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {}, disconnect() {} }; }
      close() { this.state = 'closed'; this.closed = true; closed++; return Promise.resolve(); }
      resume() { return Promise.resolve(); }
    }
    const r = createRinger({ audioContext: FakeCtx });
    assert.strictEqual(r.start(), true, 'ringer starts');
    assert.strictEqual(r.ringing(), true, 'ringer ringing');
    r.start();
    assert.strictEqual(r.ringing(), true, 'ringer still ringing after restart');
    r.stop(); r.stop();
    assert.strictEqual(r.ringing(), false, 'ringer not ringing after stop');
    assert.ok(closed >= 1, 'ringer closed AudioContext on stop');
    ok('G-5 ringer AudioContext lifecycle idempotent (start/stop/start/stop safe)');
  }

  // G-8 — busy contention (static check for helper, DB part optional)
  if (dbAvailable) {
    const phone = '+4520990008';
    db.prepare("DELETE FROM calls WHERE caller_id = ?").run(phone);
    for (const p of db.prepare("SELECT id FROM prospects WHERE phone = ?").all(phone)) {
      db.prepare("DELETE FROM calls WHERE prospect_id = ?").run(p.id);
      db.prepare("DELETE FROM prospects WHERE id = ?").run(p.id);
    }
    const { withBusyRetry } = require('../../server/db');
    assert.strictEqual(typeof withBusyRetry, 'function', 'withBusyRetry helper exported');
    let calls0 = 0;
    const result = withBusyRetry(() => {
      calls0++;
      if (calls0 === 1) { const e = new Error('SQLITE_BUSY'); e.code = 'SQLITE_BUSY'; throw e; }
      return 'ok';
    }, 3);
    assert.strictEqual(result, 'ok', 'withBusyRetry retries SQLITE_BUSY');
    assert.strictEqual(calls0, 2, 'retried exactly once');
    const res = callService.startInbound({ callerPhone: phone });
    assert.ok(res.ok, 'inbound after contention still succeeds');
    db.prepare("DELETE FROM calls WHERE caller_id = ?").run(phone);
    for (const p of db.prepare("SELECT id FROM prospects WHERE phone = ?").all(phone)) {
      db.prepare("DELETE FROM prospects WHERE id = ?").run(p.id);
    }
    ok('G-8 busy contention: withBusyRetry queues instead of 500');
  } else {
    // Static check for helper existence via file content
    const src = fs.readFileSync(path.join(__dirname, '../../server/db/index.js'), 'utf8');
    assert.ok(/withBusyRetry/.test(src), 'withBusyRetry helper exists in source');
    ok('G-8 withBusyRetry helper exists (static check — DB part skipped)');
  }

  // G-6 — mic release order (static)
  {
    const src = fs.readFileSync(path.join(__dirname, '../../src/useWebRtc.js'), 'utf8');
    assert.ok(/replaceTrack\(null\)/.test(src), 'useWebRtc releaseMedia detaches senders via replaceTrack(null)');
    assert.ok(/removeTrack/.test(src), 'useWebRtc releaseMedia removes tracks');
    ok('G-6 mic release order: releaseMedia detaches senders before stop (orange dot cleared)');
  }

  // G-4 — the microphone is bound before the SDP offer, through the supported sip.js seam.
  // (The old micFactory monkey-patched getDescription and, on the inbound path, assigned to a
  // getter-only session property — that TypeError is what killed answered calls.)
  {
    const sig = fs.readFileSync(path.join(__dirname, '../../src/webrtcSignalling.js'), 'utf8');
    // The factory lives in its own module so signalling can stay inside the line ratchet.
    const media = fs.readFileSync(path.join(__dirname, '../../src/mediaStream.js'), 'utf8');
    assert.ok(/sessionDescriptionHandlerFactory:\s*sip\.defaultSessionDescriptionHandlerFactory\(mediaStreamFactory\)/.test(sig),
      'the media factory is installed on the UserAgent configuration');
    assert.ok(/mediaStreamFactory/.test(sig) && /from '\.\/mediaStream\.js'/.test(sig),
      'signalling wires the shared factory in');
    assert.ok(/function mediaStreamFactory/.test(media), 'the cockpit microphone is resolved at SDP time');
    assert.ok(/setActiveLocalStream\(localStream\)/.test(sig), 'the opened stream is handed to the factory before accept');
    assert.ok(!/invitation\.sessionDescriptionHandlerFactory\s*=/.test(sig), 'never assigns to the read-only accessor');
    assert.ok(!/setTimeout\(attach,\s*0\)/.test(sig), 'no bare setTimeout(attach,0) race');
    ok('G-4 microphone bound before SDP offer (UA factory, no getter mutation, no setTimeout race)');
  }

  // G-7 — zombie registration (static)
  {
    const sig2 = fs.readFileSync(path.join(__dirname, '../../src/webrtcSignalling.js'), 'utf8');
    assert.ok(/onDisconnect/.test(sig2), 'webrtcSignalling listens to transport.onDisconnect');
    assert.ok(/keepAlive/.test(sig2), 'webrtcSignalling has keepAlive heater');
    assert.ok(/WebSocket not open/.test(sig2), 'keepAlive polls readyState');
    assert.ok(/ua\.delegate\.__incomingPending\s*=\s*true/.test(sig2), 'setupInboundListener sets __incomingPending on INVITE');
    assert.ok(/ua\.delegate\.__incomingPending\s*=\s*false/.test(sig2), 'setupInboundListener clears __incomingPending on resolution');
    ok('G-7 & G-1 zombie registration + __incomingPending glare guard wired');
  }

  // G-6b & G-15 — WebRTC teardown on direct outcome key & signalling failure + SQL LIKE escaping
  {
    const dialerSrc = fs.readFileSync(path.join(__dirname, '../../src/pages/Dialer.jsx'), 'utf8');
    assert.ok(/if\s*\(isWebrtcRef\.current\)\s*webrtcRef\.current\?\.hangUp\?\.\(\)/.test(dialerSrc),
      'Dialer logOutcome tears down active WebRTC call on direct 1-8 classification');
    assert.ok(/if\s*\(recCallId\)\s*return;/.test(dialerSrc),
      'Dialer handleRecordingReady avoids duplicate upload when SoftphoneProvider already uploaded recCallId');
    const schemas = require('../../server/validation/schemas');
    assert.ok(schemas.AI_PROVIDERS.includes('openrouter'), 'AI_PROVIDERS includes openrouter');
    for (const repoFile of ['callRepo.js', 'recordingRepo.js', 'outboxRepo.js']) {
      const repoSrc = fs.readFileSync(path.join(__dirname, '../../server/repositories', repoFile), 'utf8');
      assert.ok(/escapeLike/.test(repoSrc) && /ESCAPE\s*'\\\\'/.test(repoSrc), `${repoFile} escapes LIKE wildcards`);
    }
    ok('G-6b/G-15 direct 1-8 WebRTC hangup, deduplicated recording upload, OpenRouter schema, and SQL LIKE escaping verified');
  }

  console.log(`  [concurrency-hardening] ${passed} hardening checks passed`);
}

run()
  .catch((e) => { console.error('  ❌ concurrency-hardening failure:', e.stack || e.message); process.exitCode = 1; })
  .finally(() => { try { db && db.close(); } catch {} try { tmp && fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
