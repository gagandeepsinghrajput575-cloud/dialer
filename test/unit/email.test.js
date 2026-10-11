// Email verification + composition unit tests.
//
// The MX layer performs real DNS lookups, so these use domains whose behaviour is stable:
// gmail.com/outlook.com always have mail servers, mailinator.com is always throwaway, and a
// deliberately nonsense .com never resolves. Run: DATA_DIR=$(mktemp -d) node test/unit/email.test.js
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/pulse-email-');
process.env.PULSE_TEST = '1';

const assert = require('assert');
const email = require('../../server/services/emailService');
const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
const settingsRepo = require('../../server/repositories/settingsRepo');

migrate.run();   // the SMTP half of this file needs real tables

let passed = 0;
const failures = [];
const ok = (m) => { passed++; console.log(`  \u2713 ${m}`); };
const bad = (m) => { failures.push(m); console.log(`  \u274C ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

(async () => {
  console.log('\n[email] address verification');

  // ---- syntax ----
  for (const junk of ['not-an-email', 'a@b', '@no-local.com', 'no-domain@', 'spaces in@x.com', '', 'a@@b.com']) {
    const r = await email.verify(junk);
    if (r.level !== 'invalid') { bad(`"${junk}" should be invalid, got ${r.level}`); }
  }
  ok('7 malformed addresses all rejected as invalid');

  const long = `${'a'.repeat(300)}@gmail.com`;
  check((await email.verify(long)).level === 'invalid', 'a 300-char local part is rejected (RFC 5321 bound)');

  // ---- throwaway inboxes ----
  for (const d of ['mailinator.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com']) {
    const r = await email.verify(`someone@${d}`);
    if (r.level !== 'invalid' || !r.checks.disposable) bad(`${d} should be flagged disposable`);
  }
  ok('throwaway inbox domains are caught and marked invalid');

  // ---- role mailboxes are real but advisory ----
  const role = await email.verify('info@maersk.com');
  check(role.checks.role === true, 'info@ is recognised as a department mailbox');
  check(role.level === 'risky' || role.level === 'invalid', 'a role address is never reported as plainly valid');

  // ---- typo suggestions ----
  const typo = await email.verify('soren@gmial.com');
  check(typo.suggestion === 'soren@gmail.com', `gmial.com suggests gmail.com (got ${typo.suggestion})`);
  const typo2 = await email.verify('jens@hotmial.com');
  check(typo2.suggestion === 'jens@hotmail.com', `hotmial.com suggests hotmail.com (got ${typo2.suggestion})`);
  const typo3 = await email.verify('henrik@yahoo.co');
  check(typo3.suggestion === 'henrik@yahoo.com', `yahoo.co suggests yahoo.com (got ${typo3.suggestion})`);

  // A known-good domain must never be "corrected" — that was a real bug: gmail.com -> mail.com.
  for (const good of ['a@gmail.com', 'b@outlook.com', 'c@hotmail.com', 'd@live.dk', 'e@proton.me']) {
    const r = await email.verify(good);
    if (r.suggestion) bad(`${good} must not be second-guessed, suggested ${r.suggestion}`);
    if (r.checks.typo) bad(`${good} must not be flagged as a typo`);
  }
  ok('known-good domains are never suggested back at the user');

  // ---- live MX ----
  const good = await email.verify('mette.jensen@gmail.com');
  check(good.level === 'valid' && good.ok === true, 'a real gmail address verifies as valid');
  check(Array.isArray(good.mx.exchanges) && good.mx.exchanges.length > 0, 'MX exchanges are returned');

  const dead = await email.verify('peter@thisdomaindoesnotexist-zzz123.com');
  check(dead.level === 'invalid' && dead.ok === false, 'a nonexistent domain is invalid');
  check(/does not exist/.test(dead.reasons[0]), 'the fatal reason leads the list');

  // ---- batch ----
  const many = await email.verifyMany(['a@gmail.com', 'b@mailinator.com', 'c@nodomain-zzz9.com']);
  check(many.length === 3, 'batch returns one verdict per address, in order');
  check(many[0].level === 'valid' && many[1].level === 'invalid' && many[2].level === 'invalid', 'batch verdicts are correct');

  // ---- SMTP config + secret masking ----
  console.log('\n[email] SMTP configuration');
  settingsRepo.set('smtp_host', 'smtp.gmail.com');
  settingsRepo.set('smtp_port', '587');
  settingsRepo.set('smtp_user', 'agent@firma.dk');
  settingsRepo.set('smtp_pass', 'super-secret-app-password');

  const cfg = email.smtpConfig();
  check(cfg.configured === true, 'SMTP reports configured once host+user+pass are set');
  check(cfg.port === 587, 'the port is coerced to a number');
  check(cfg.from === 'agent@firma.dk', 'From falls back to the username');

  const pub = settingsRepo.publicView();
  check(pub.smtp_pass === '', 'the SMTP password is masked out of the API response');
  check(pub.has_smtp_pass === true, 'has_smtp_pass tells the UI a password is stored');

  settingsRepo.set('smtp_from', 'Mette <mette@firma.dk>');
  check(email.smtpConfig().from === 'Mette <mette@firma.dk>', 'an explicit From wins over the username');

  settingsRepo.set('smtp_host', '');
  check(email.smtpConfig().configured === false, 'clearing the host makes SMTP unconfigured again');
  settingsRepo.set('smtp_host', 'smtp.gmail.com');

  // ---- send() refuses bad input before touching the network ----
  console.log('\n[email] send() input guards');
  const attempt = async (payload) => {
    try { await email.send(payload); return 'SENT'; }
    catch (e) { return `${e.status || 'err'}:${String(e.message).slice(0, 40)}`; }
  };
  check(/^400/.test(await attempt({ to: ['a@gmail.com'], subject: '', body: 'x' })), 'an empty subject is refused');
  check(/^400/.test(await attempt({ to: ['not-an-email'], subject: 's', body: 'x' })), 'a malformed recipient is refused');
  check(/^400/.test(await attempt({ to: [], subject: 's', body: 'x' })), 'no recipients is refused');
  check(/^400/.test(await attempt({ to: [undefined], subject: 's', body: 'x' })), 'an undefined recipient never becomes the string "undefined"');

  // ---- header injection: a subject is attacker-controlled text, not a header ----
  console.log('\n[email] header sanitisation');
  const injected = email.sanitizeHeader('Hej\r\nBcc: attacker@evil.dk');
  check(!injected.includes('\r') && !injected.includes('\n'), 'CRLF in a header value is neutralised');
  check(injected === 'Hej Bcc: attacker@evil.dk', 'the injected text survives as inert body text, not a header');
  check(!email.sanitizeHeader('a\u0000b\u001fc').match(/[\u0000-\u001f]/), 'control characters are stripped');
  check(email.sanitizeHeader('x'.repeat(500), 300).length === 300, 'header length is capped');
  check(email.sanitizeHeader(null) === '' && email.sanitizeHeader(undefined) === '', 'null/undefined headers become empty strings');

  // ---- pooled transport: reuse unless the settings actually change ----
  console.log('\n[email] transporter reuse');
  const cfgA = { host: 'smtp.a.dk', port: 587, secure: false, user: 'u', pass: 'p', from: 'u@a.dk' };
  const cfgB = { ...cfgA, host: 'smtp.b.dk' };
  check(email.transportFor(cfgA) === email.transportFor(cfgA), 'identical settings reuse the same pooled transport');
  const changed = email.transportFor(cfgB);
  check(changed !== email.transportFor(cfgA), 'a changed host builds a new transport');
  email.invalidateTransport();
  check(email.transportFor(cfgB) !== changed, 'invalidateTransport() forces a rebuild (an edited password takes effect)');

  // ---- a credential must never reach the client or the log ----
  console.log('\n[email] credential redaction');
  const red = email.redact('535 auth failed for agent@firma.dk using super-secret-app-password', { user: 'agent@firma.dk', pass: 'super-secret-app-password' });
  check(!red.includes('super-secret-app-password'), 'the SMTP password is redacted out of an error message');
  check(!red.includes('agent@firma.dk'), 'the SMTP username is redacted too');

  // ---- the activity ledger line is specified, so pin its shape ----
  console.log('\n[email] activity ledger');
  const notesRepo = require('../../server/repositories/noteRepo');
  const prospectRepo = require('../../server/repositories/prospectRepo');
  const p = prospectRepo.insert({ name: 'Mette', email: 'mette@firma.dk' });
  const logged = notesRepo.logEmail(p.id, { subject: 'Opfølgning — Firma', recipients: ['mette@firma.dk'], attachmentCount: 2 });
  check(logged.body === '📧 Sent email: "Opfølgning — Firma" to mette@firma.dk (attachments: 2)',
    `the ledger line matches the specified format (got ${JSON.stringify(logged.body)})`);
  check(notesRepo.logEmail(p.id, { subject: 'Hej', recipients: ['a@b.dk'] }).body.endsWith('(attachments: 0)'),
    'a send with no attachments records (attachments: 0)');
  check(notesRepo.logEmail(p.id, { subject: 'Quote " here', recipients: ['a@b.dk', 'c@d.dk'] }).body.includes('a@b.dk, c@d.dk'),
    'multiple recipients join with a comma and quotes in the subject cannot break the line');
  check(notesRepo.listByProspect(p.id).some((n) => n.id === logged.id), 'the logged email appears in the prospect notes feed');

  // ---- {{meet_link}} and {{agent_name}} are real placeholders ----
  console.log('\n[email] template placeholders');
  const followUp = require('../../server/services/followUpService');
  settingsRepo.set('meet_link', 'https://meet.google.com/abc-defg-hij');
  settingsRepo.set('agent_name', 'Gagan');
  settingsRepo.set('followup_email_template', 'Hej {{name}} fra {{company}} ({{title}})\nMøde: {{meet_link}}\n/ {{agent_name}}');
  const draft = followUp.renderEmail(p.id, { noteText: 'Snakkede om priser' });
  check(draft.body.includes('https://meet.google.com/abc-defg-hij'), '{{meet_link}} is substituted');
  check(draft.body.includes('Gagan'), '{{agent_name}} is substituted');
  check(!/\{\{/.test(draft.body), 'no placeholder is left literal in the rendered body');
  const emptyMeet = (() => { settingsRepo.set('meet_link', ''); const d = followUp.renderEmail(p.id); settingsRepo.set('meet_link', 'https://meet.google.com/abc-defg-hij'); return d; })();
  check(!/\{\{meet_link\}\}/.test(emptyMeet.body), 'an unset meeting link renders empty, not as a literal placeholder');

  db.close();
  console.log(`\n  [email] ${passed} checks passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
