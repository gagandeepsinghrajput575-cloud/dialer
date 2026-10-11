// Hardening unit layer: adversarial input, timezone maths, injection defence and the
// fault-tolerance guards added by the bug-hunt pass. In-process, throwaway database.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-hard-'));
process.env.DATA_DIR = tmp;

require('../../server/db/migrate').run();
const { db } = require('../../server/db');
const backup = require('../../server/db/backup');
const settings = require('../../server/repositories/settingsRepo');
const prospects = require('../../server/repositories/prospectRepo');
const calls = require('../../server/repositories/callRepo');
const telephony = require('../../server/services/telephonyService');
const copilot = require('../../server/services/copilotService');
const callService = require('../../server/services/callService');
const followUps = require('../../server/services/followUpService');
const csvService = require('../../server/services/csvService');
const rateLimit = require('../../server/middleware/rateLimit');
const { parseSqlTime } = require('../../server/services/format');

let passed = 0;
const ok = (msg) => { passed++; console.log(`    \u2713 ${msg}`); };

async function run() {
  console.log('  [hardening] adversarial input, timezones, injection defence, fault tolerance');
  settings.set('default_country_code', '45');
  settings.set('business_tz', 'Europe/Copenhagen');

  // ---- 1. Danish normalization under fuzzing ------------------------------------
  const table = [
    // [input, expected]
    ['20123456', '+4520123456'], ['31123456', '+4531123456'], ['80123456', '+4580123456'],
    ['20 12 34 56', '+4520123456'], ['+45 20 12 34 56', '+4520123456'], ['+45 (20) 12-34-56', '+4520123456'],
    ['+45.20.12.34.56', '+4520123456'], ['004520123456', '+4520123456'], ['04520123456', '+4520123456'],
    ['020123456', '+4520123456'], ['4520123456', '+4520123456'],
    // too short for Denmark -> rejected instead of stored as a bogus number
    ['+45 123', ''], ['+45 12 34', ''], ['+45201234567', ''], ['1234', ''],
    // junk and non-phones
    [null, ''], [undefined, ''], ['N/A', ''], ['abcde', ''], ['', ''], ['   ', ''], [0, ''],
    // other countries are never mangled by the Danish default
    ['+447911123456', '+447911123456'], ['+14155552671', '+14155552671'],
    ['+4915123456789', '+4915123456789'], ['004915123456789', '+4915123456789'],
    // an unrecognised national format is preserved verbatim, never given an invented
    // country code and never stripped of its trunk prefix
    ['07911123456', '07911123456'], ['123456', '123456'],
    // SIP addresses and dial URIs pass straight through
    ['anders@sip.voip.so', 'anders@sip.voip.so'], ['sip:anders@sip.voip.so', 'sip:anders@sip.voip.so'],
  ];
  for (const [input, expected] of table) {
    assert.strictEqual(telephony.normalizePhone(input), expected, `normalizePhone(${JSON.stringify(input)})`);
  }
  // objects/arrays must not blow up or leak "[object Object]"
  for (const weird of [{}, [], true, NaN, Infinity, new Date(0)]) {
    const out = telephony.normalizePhone(weird);
    assert.strictEqual(typeof out, 'string');
    assert.ok(!/object Object/.test(out), `normalizePhone(${String(weird)}) stays clean`);
  }
  ok(`phone normalization survives ${table.length + 6} adversarial inputs (+45 strict, foreign numbers untouched)`);

  // ---- 2. caller-ID pool with malformed entries ----------------------------------
  settings.set('caller_id', '');
  settings.set('caller_id_pool', '+4511, , +4522, +45 20 12 34 56, +4520123456 ; +4531456789');
  const pool = telephony.callerIdPool();
  assert.deepStrictEqual(pool, ['+4520123456', '+4531456789'], 'junk and empty tokens dropped, duplicates merged');
  settings.set('caller_id', '+45 50 67 89 01');
  assert.deepStrictEqual(telephony.callerIdPool(), ['+4550678901', '+4520123456', '+4531456789'], 'primary leads the pool');
  settings.set('caller_id', '');
  settings.set('caller_id_pool', '');
  assert.deepStrictEqual(telephony.nextCallerId(), { callerId: '', poolSize: 0, index: 0 }, 'empty pool degrades cleanly');
  settings.set('caller_id_pool', Array.from({ length: 40 }, (_, i) => `+45 20 12 34 ${String(10 + i).padStart(2, '0')}`).join(','));
  assert.strictEqual(telephony.callerIdPool().length, telephony.MAX_POOL, 'absurd pools are capped');
  settings.set('caller_id', '');
  settings.set('caller_id_pool', '');
  ok('caller-ID pool strips junk, merges duplicates, caps size and survives being empty');

  // ---- 3. business hours: midnight, weekend and DST ------------------------------
  const at = (iso) => telephony.businessHours(new Date(iso));
  const wed10 = at('2026-10-07T08:00:00Z'); // 10:00 Copenhagen, Wednesday
  assert.strictEqual(wed10.open, true);
  assert.strictEqual(wed10.minutesUntilClose, 390);
  assert.strictEqual(wed10.minutesUntilOpen, null);

  const wed18 = at('2026-10-07T16:00:00Z'); // 18:00 Copenhagen — window closed
  assert.strictEqual(wed18.open, false);
  assert.strictEqual(wed18.minutesUntilOpen, 870, 'after close it counts forward to tomorrow 08:30, not to zero');

  const sat12 = at('2026-10-10T10:00:00Z'); // Saturday 12:00 Copenhagen
  assert.strictEqual(sat12.open, false);
  assert.strictEqual(sat12.minutesUntilOpen, 2670, 'Saturday noon -> Monday 08:30 is 44.5h');

  const midnight = at('2026-10-07T23:30:00Z'); // 01:30 Thursday Copenhagen
  assert.strictEqual(midnight.localDate, '2026-10-08', 'date rolls over in Copenhagen, not UTC');
  assert.strictEqual(midnight.minutesUntilOpen, 420);

  // DST: Copenhagen is UTC+2 in summer and UTC+1 in winter
  assert.strictEqual(at('2026-07-01T07:00:00Z').localTime, '09:00', 'CEST offset applied');
  assert.strictEqual(at('2026-07-01T07:00:00Z').open, true);
  assert.strictEqual(at('2026-01-15T08:00:00Z').localTime, '09:00', 'CET offset applied');
  assert.strictEqual(at('2026-03-29T00:30:00Z').localTime, '01:30', 'the night the clocks jump forward');
  assert.strictEqual(at('2026-10-25T00:30:00Z').localTime, '02:30', 'the night the clocks fall back');

  // an empty business_days must fall back to weekdays, never "never open"
  settings.set('business_days', '');
  assert.deepStrictEqual(at('2026-10-07T08:00:00Z').businessDays, [1, 2, 3, 4, 5]);
  settings.set('business_days', '3,1,1');
  assert.deepStrictEqual(at('2026-10-07T08:00:00Z').businessDays, [1, 3], 'duplicates dropped, sorted');
  settings.set('business_days', '1,2,3,4,5');
  ok('business hours handle midnight, weekends, both DST transitions and an empty weekday list');

  // ---- 4. wall-clock <-> UTC conversion across DST -------------------------------
  assert.strictEqual(telephony.zonedTimeToUtc('2026-07-01', '09:30', 'Europe/Copenhagen').toISOString(), '2026-07-01T07:30:00.000Z');
  assert.strictEqual(telephony.zonedTimeToUtc('2026-01-15', '09:30', 'Europe/Copenhagen').toISOString(), '2026-01-15T08:30:00.000Z');
  // +N days is calendar arithmetic: adding N*24h across the spring change would skip a day
  assert.strictEqual(telephony.zonedDate(3, 'Europe/Copenhagen', new Date('2026-03-27T22:00:00Z')), '2026-03-30');
  assert.strictEqual(telephony.zonedDate(3, 'Europe/Copenhagen', new Date('2026-02-27T12:00:00Z')), '2026-03-02');
  const followUp = callService.suggestFollowUp('voicemail', new Date('2026-10-07T12:00:00Z'));
  const wall = telephony.partsIn('Europe/Copenhagen', parseSqlTime(followUp));
  assert.strictEqual(`${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`, '09:30',
    'callbacks are booked for 09:30 Copenhagen no matter where the server runs');
  ok(`follow-up scheduler books 09:30 Copenhagen (stored as ${followUp} UTC)`);

  // ---- 5. timestamp parsing must never produce NaN -------------------------------
  assert.strictEqual(parseSqlTime('2026-10-07 10:00:00').toISOString(), '2026-10-07T10:00:00.000Z');
  assert.strictEqual(parseSqlTime('2026-10-07T10:00:00.000Z').toISOString(), '2026-10-07T10:00:00.000Z', 'no double Z');
  assert.strictEqual(parseSqlTime('2026-10-07T10:00:00+02:00').toISOString(), '2026-10-07T08:00:00.000Z');
  for (const junk of ['not-a-date!!', '', null, undefined, 'garbage']) assert.strictEqual(parseSqlTime(junk), null, JSON.stringify(junk));
  // a stored ISO timestamp must not silently demote the prospect in the queue
  const iso = prospects.insert({ name: 'Iso Row', phone: '+4531123456' });
  prospects.update(iso.id, { last_called_at: '2026-10-01T10:00:00.000Z', last_outcome: 'no_answer', call_count: 1 });
  const ranked = require('../../server/services/prospectService').rankProspect(prospects.get(iso.id), Date.parse('2026-10-07T12:00:00Z'));
  assert.strictEqual(ranked.reason, 'no_answer_retry', 'an ISO timestamp is aged correctly instead of reading as NaN');
  ok('SQL and ISO timestamps both parse; an ISO last_called_at still ranks as a retry');

  // ---- 6. CSV export: formula injection + UTF-8 BOM ------------------------------
  const evil = prospects.insert({ name: '=HYPERLINK("http://evil.dk")', phone: '+4531123457', company: '@SUM(A1)', email: 'x@y.dk' });
  const { csv } = csvService.toCsv();
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF, 'export starts with a UTF-8 BOM so Excel reads ø/å/æ');
  const row = csv.split('\r\n').find((l) => l.startsWith(`${evil.id},`));
  assert.ok(row.includes('"\'=HYPERLINK'), `formula neutralized: ${row.slice(0, 60)}`);
  assert.ok(row.includes("'@SUM(A1)"), 'leading @ neutralized too');
  assert.ok(!/"=/.test(row.replace(/""/g, '')), 'no cell still starts with =');
  assert.strictEqual(csvService.neutralizeFormula('-2+3'), "'-2+3");
  assert.strictEqual(csvService.neutralizeFormula('Almindelig tekst'), 'Almindelig tekst', 'normal text untouched');
  ok('CSV export is BOM-prefixed and neutralizes = + - @ formula injection');

  // ---- 7. backup file names cannot escape the backup folder -----------------------
  assert.strictEqual(backup.safeReason('../../../../../../tmp/PWNED'), 'tmp-pwned');
  assert.strictEqual(backup.safeReason('../../../etc/passwd'), 'etc-passwd');
  assert.strictEqual(backup.safeReason('   '), 'manual');
  const escapeTarget = path.join(os.tmpdir(), 'pulse-traversal-check.db');
  fs.rmSync(escapeTarget, { force: true }); // start clean: this test must prove nothing is written
  const snap = await backup.create(`../../../../../../${escapeTarget.replace(/\.db$/, '')}`);
  assert.strictEqual(path.dirname(path.join(tmp, 'backups', snap.file)), path.join(tmp, 'backups'), 'snapshot stays in data/backups');
  assert.ok(!fs.existsSync(escapeTarget), 'nothing written outside the backup directory');
  assert.ok(fs.existsSync(path.join(tmp, 'backups', snap.file)), 'the snapshot itself was written');
  ok('snapshot reasons are slugified — no path traversal, nothing written outside data/backups');

  // ---- 8. repository column allowlists + LIKE escaping ----------------------------
  const victim = prospects.insert({ name: 'Allowlist', phone: '+4531123458' });
  prospects.update(victim.id, { name: 'Renamed', 'stage = "lost" --': 'x', 'id': 9999, 'name); DROP TABLE prospects; --': 'x' });
  const after = prospects.get(victim.id);
  assert.strictEqual(after.name, 'Renamed');
  assert.strictEqual(after.id, victim.id, 'id cannot be overwritten');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prospects'").get(), 'table survives');
  calls.patch(1, { outcome: 'conversation', 'outcome = "dnc" --': 'x' });
  assert.strictEqual(prospects.escapeLike('100%'), '100\\%');
  assert.strictEqual(prospects.escapeLike('a_b'), 'a\\_b');
  ok('unknown column names are dropped by both repositories and LIKE wildcards are escaped');

  // ---- 9. copilot with missing / zero data ---------------------------------------
  const empty = prospects.insert({ name: '', phone: '+4531123459' });
  const base = copilot.localSummary({ prospect: prospects.get(empty.id), call: { outcome: 'no_answer', duration_sec: 0 }, notes: [] });
  assert.match(base.summary, /nobody picked up after 0s/);
  assert.deepStrictEqual(base.nextSteps, []);
  assert.ok(base.followUpSuggested, 'a callback is still suggested');
  for (const args of [{}, { prospect: null, call: null, notes: null }, { prospect: undefined, call: undefined }]) {
    const r = await copilot.summarize(args);
    assert.strictEqual(r.provider, 'local');
    assert.strictEqual(typeof r.summary, 'string');
    assert.ok(r.summary.length > 0, 'a placeholder summary instead of a TypeError');
  }
  const notes = [{ body: 'Vil gerne have en demo i næste uge' }, null, { body: undefined }];
  const withNotes = copilot.localSummary({ prospect: { name: 'X' }, call: { outcome: 'conversation', duration_sec: 5 }, notes });
  assert.deepStrictEqual(withNotes.nextSteps, ['Vil gerne have en demo i næste uge'], 'sparse note rows are skipped');
  ok('copilot returns a clean summary for 0-second calls, no notes and missing rows');

  // ---- 10. follow-up email placeholders + due() robustness ------------------------
  const p2 = prospects.insert({ name: 'Mette Jensen', phone: '+4531123460', company: 'ApS' });
  settings.set('followup_email_template', 'Hej {{name}} {{constructor}} {{toString}} {{company}} {{missing}}');
  const email = followUps.renderEmail(p2.id, { noteText: 'Tak for snakken' });
  assert.ok(email.body.includes('Hej Mette '), 'own placeholders resolve');
  assert.ok(email.body.includes('{{constructor}}'), 'prototype keys are left alone');
  assert.ok(!/function Object/.test(email.body), 'no function source leaks into the email');
  prospects.update(p2.id, { follow_up_at: '2020-01-01 09:00:00' });
  const due = followUps.due();
  const mine = due.find((d) => d.id === p2.id);
  assert.ok(mine && Number.isFinite(mine.overdueHours), 'overdueHours is a number, never NaN/null');
  ok('email template ignores prototype placeholders; due() reports finite overdue hours');

  // ---- 11. rate limiter cannot grow without bound --------------------------------
  rateLimit.clear();
  const res = () => ({ setHeader() {}, status(c) { this.code = c; return this; }, json() { return this; } });
  const limit = rateLimit.rateLimit({ windowMs: 30, max: 2, name: 'unit' });
  const burst = res();
  limit({ ip: '10.0.0.1' }, burst, () => {});
  limit({ ip: '10.0.0.1' }, burst, () => {});
  limit({ ip: '10.0.0.1' }, burst, () => {});
  assert.strictEqual(burst.code, 429, 'the third request inside the window is refused');

  // Fill the map with distinct clients, let the window expire, then add one more: the
  // limiter must reclaim the stale entries instead of keeping one per IP forever.
  rateLimit.clear();
  const short = rateLimit.rateLimit({ windowMs: 5, max: 100000, name: 'fill' });
  for (let i = 0; i < rateLimit.MAX_KEYS; i++) short({ ip: `192.168.${i % 256}.${(i / 256) | 0}` }, res(), () => {});
  assert.strictEqual(rateLimit.size(), rateLimit.MAX_KEYS, 'one bucket per client, capped at MAX_KEYS');
  // Wait past the *longest* window in play: a limiter sweeps with its own windowMs, so a
  // bucket from a shorter-window limiter is reclaimed once this one's window has passed too.
  await new Promise((r) => setTimeout(r, 60));
  limit({ ip: '10.9.9.9' }, res(), () => {});
  assert.ok(rateLimit.size() <= rateLimit.MAX_KEYS + 1, `map stays bounded (now ${rateLimit.size()})`);
  assert.strictEqual(rateLimit.size(), 1, `all ${rateLimit.MAX_KEYS} expired buckets were reclaimed, only the new one is left`);
  rateLimit.clear();
  assert.strictEqual(rateLimit.size(), 0);
  ok('rate limiter refuses bursts and reclaims expired buckets instead of leaking one per IP');

  // ---- static: no JSX tag may be unbound ------------------------------------------------
  // A component referenced in JSX but never imported builds fine and dies at render time, in
  // the browser, on the one screen nobody opened in CI. That happened: a new "fix the leads
  // without a number" button used <Users/>, which was not imported, and no gate noticed.
  {
    const path = require('path');
    const srcRoot = path.join(__dirname, '..', '..', 'src');
    const files = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(e.name)) files.push(full);
    });
    walk(srcRoot);
    assert.ok(files.length > 10, `the scan actually found the app source (${files.length} files)`);
    const unbound = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const bound = new Set();
      for (const m of src.matchAll(/import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([\s\S]*?)\})?\s*from\s*['"][^'"]+['"]/g)) {
        if (m[1]) bound.add(m[1]);
        if (m[2]) m[2].split(',').forEach((raw) => {
          const name = raw.trim().split(/\s+as\s+/).pop().trim();
          if (name) bound.add(name);
        });
      }
      // Locally defined components and destructuring aliases: function Foo(), const Foo =,
      // and { icon: Icon } in a parameter list.
      for (const m of src.matchAll(/(?:function\s+([A-Z][A-Za-z0-9]*)|const\s+([A-Z][A-Za-z0-9]*)\s*=|([A-Za-z0-9_$]+)\s*:\s*([A-Z][A-Za-z0-9]*)\s*[,}]\s*[,)]?\s*=>)/g)) {
        bound.add(m[1] || m[2] || m[4]);
      }
      for (const m of src.matchAll(/([A-Za-z0-9_$]+)\s*:\s*([A-Z][A-Za-z0-9]*)/g)) bound.add(m[2]);
      for (const tag of new Set([...src.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]))) {
        if (!bound.has(tag)) unbound.push(`${path.relative(srcRoot, file)} <${tag}>`);
      }
    }
    assert.deepStrictEqual(unbound, [], `every JSX tag in src/ is imported or defined (${unbound.join(', ')})`);
    ok(`static scan: all ${files.length} source files render only bound JSX tags`);
  }

  console.log(`  [hardening] ${passed} hardening checks passed`);
}

run()
  .catch((e) => { console.error('  \u274C hardening failure:', e.stack || e.message); process.exitCode = 1; })
  .finally(() => { try { db.close(); } catch { /* ignore */ } fs.rmSync(tmp, { recursive: true, force: true }); });
