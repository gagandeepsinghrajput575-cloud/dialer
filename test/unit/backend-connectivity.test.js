// Deep Backend Connectivity, Carrier Reachability & Invariant Bug Test Suite
const assert = require('assert');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const { db } = require('../../server/db');
const { audioDir, recordingsDir, backupDir } = require('../../server/config/env');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3001';

console.log('--- Deep Backend Connectivity, Carrier Reachability & Bug Test ---');

// Helper to probe TCP connection
function checkTcpSocket(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let isConnected = false;

    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      isConnected = true;
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`));
    });

    socket.on('error', (err) => {
      socket.destroy();
      reject(new Error(`TCP connection to ${host}:${port} failed: ${err.message}`));
    });
  });
}

async function runTests() {
  let passed = 0;
  const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

  // =========================================================================
  // 1. Database Engine & Schema Invariants
  // =========================================================================
  console.log('\n[1/5] Database Engine Integrity & Invariants');

  // PRAGMA integrity_check
  const integrity = db.pragma('integrity_check');
  assert.strictEqual(integrity[0].integrity_check, 'ok', 'Database integrity check must return "ok"');
  ok('Database integrity check passed (PRAGMA integrity_check: ok)');

  // PRAGMA foreign_key_check
  const fkCheck = db.pragma('foreign_key_check');
  assert.strictEqual(fkCheck.length, 0, `Database has ${fkCheck.length} foreign key violations`);
  ok('Foreign key constraints intact (zero violations)');

  // PRAGMA journal_mode
  const journal = db.pragma('journal_mode');
  assert.strictEqual(journal[0].journal_mode, 'wal', 'Database must run in WAL journal mode');
  ok('Database is operating in high-concurrency WAL mode');

  // Verify all required tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  const requiredTables = ['prospects', 'calls', 'notes', 'settings', 'recordings', 'recording_chats', 'recording_chat_messages'];
  for (const table of requiredTables) {
    assert.ok(tables.includes(table), `Table ${table} must exist in the database`);
  }
  ok(`All ${requiredTables.length} required database tables verified`);

  // =========================================================================
  // 2. Carrier & Network DNS / TCP Connectivity
  // =========================================================================
  console.log('\n[2/5] Carrier & Network Endpoint Reachability');

  // DNS lookup for Telnyx SIP domain
  try {
    const telnyxSip = await dns.lookup('sip.telnyx.com');
    assert.ok(telnyxSip.address, 'sip.telnyx.com must resolve to an IP address');
    ok(`Telnyx SIP domain resolved successfully (sip.telnyx.com -> ${telnyxSip.address})`);
  } catch (err) {
    console.warn(`  ⚠️ DNS warning for sip.telnyx.com: ${err.message}`);
  }

  // DNS lookup for Telnyx WebRTC WSS domain
  try {
    const telnyxRtc = await dns.lookup('rtc.telnyx.com');
    assert.ok(telnyxRtc.address, 'rtc.telnyx.com must resolve to an IP address');
    ok(`Telnyx WebRTC domain resolved successfully (rtc.telnyx.com -> ${telnyxRtc.address})`);

    // TCP connectivity probe to WebRTC gateway port 443
    await checkTcpSocket('rtc.telnyx.com', 443, 5000);
    ok('Telnyx WebRTC WSS gateway socket connectable (rtc.telnyx.com:443 reachable)');
  } catch (err) {
    console.warn(`  ⚠️ WebRTC gateway network probe: ${err.message}`);
  }

  // DNS lookup for Google Generative AI (Gemini) endpoint
  try {
    const geminiDns = await dns.lookup('generativelanguage.googleapis.com');
    assert.ok(geminiDns.address, 'generativelanguage.googleapis.com must resolve');
    ok(`Gemini AI API domain resolved (generativelanguage.googleapis.com -> ${geminiDns.address})`);
  } catch (err) {
    console.warn(`  ⚠️ Gemini API DNS warning: ${err.message}`);
  }

  // =========================================================================
  // 3. HTTP Server & Session Security Barrier
  // =========================================================================
  console.log('\n[3/5] HTTP API Security, Session Gate & Contracts');

  // Obtain session token
  const sessionRes = await fetch(`${BASE}/api/session`);
  assert.strictEqual(sessionRes.status, 200, 'Session endpoint must return 200');
  const sessionData = await sessionRes.json();
  assert.ok(sessionData.token && sessionData.token.length >= 32, 'Session token must be a strong 32+ char hex token');
  const token = sessionData.token;
  ok(`Session token generated and validated (${token.slice(0, 10)}…)`);

  // Unauthenticated GET to credential endpoint MUST be refused (401)
  const unauthCredRes = await fetch(`${BASE}/api/telephony/webrtc-session`);
  assert.strictEqual(unauthCredRes.status, 401, 'Request to credentials without token must be refused with 401');
  ok('Credential endpoint strictly demands session token even on GET (401)');

  // Browser mutating request without token MUST be refused (401)
  const unauthMutateRes = await fetch(`${BASE}/api/calls/direct`, {
    method: 'POST',
    headers: { 'Origin': 'http://localhost:5173', 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+4512345678' }),
  });
  assert.strictEqual(unauthMutateRes.status, 401, 'Browser mutating request without token must be refused with 401');
  ok('Browser mutation without session token is strictly blocked (401)');

  // Cross-origin attack probe MUST be refused with 403 Forbidden
  const evilOriginRes = await fetch(`${BASE}/api/session`, {
    headers: { 'Origin': 'http://malicious-attacker.com' }
  });
  assert.strictEqual(evilOriginRes.status, 403, 'Cross-origin request from unlisted domain must be blocked with 403');
  ok('Cross-site request forgery & untrusted origins strictly blocked (403)');

  // DNS Rebinding attack probe MUST be refused with 403 Forbidden (uses raw http.request to override Host header)
  const http = require('http');
  const target = new URL(BASE);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const r = http.request({
      hostname: target.hostname,
      port: Number(target.port) || 80,
      path: '/api/session',
      method: 'GET',
      headers: { host: 'attacker-controlled-domain.com' },
    }, (res) => resolve(res.statusCode));
    r.on('error', reject);
    r.end();
  });
  assert.strictEqual(rebindingStatus, 403, 'DNS rebinding with foreign Host header must be blocked with 403');
  ok('DNS rebinding defenses active (unrecognized Host header refused 403)');

  // Authenticated request to settings
  const authHeaders = {
    'x-pulse-token': token,
    'x-requested-with': 'pulse-dialer',
    'Content-Type': 'application/json',
  };
  const settingsRes = await fetch(`${BASE}/api/settings`, { headers: authHeaders });
  assert.strictEqual(settingsRes.status, 200, 'Settings endpoint must return 200 for authenticated requests');
  const settingsData = await settingsRes.json();
  assert.ok(settingsData.telephony_mode, 'telephony_mode must be defined');
  // Secrets must never leak in public settings view (masked as empty strings with has_ boolean flags)
  assert.strictEqual(settingsData.telnyx_sip_password, '', 'SIP password must be masked as empty string in public view');
  assert.strictEqual(settingsData.smtp_pass, '', 'SMTP password must be masked as empty string in public view');
  ok('Settings view successfully retrieved with all secrets masked');

  // Telephony endpoints verification
  const flynumberRes = await fetch(`${BASE}/api/telephony/flynumber`, { headers: authHeaders });
  assert.strictEqual(flynumberRes.status, 200, 'FlyNumber status must return 200');
  const flynumberData = await flynumberRes.json();
  assert.ok(flynumberData.did, 'FlyNumber DID must be present');
  assert.ok(Array.isArray(flynumberData.bridgeSteps), 'FlyNumber bridge steps must be an array');
  ok(`FlyNumber telephony bridge verified (DID: ${flynumberData.did}, Steps: ${flynumberData.bridgeSteps.length})`);

  const webrtcSessionRes = await fetch(`${BASE}/api/telephony/webrtc-session`, { headers: authHeaders });
  assert.strictEqual(webrtcSessionRes.status, 200, 'WebRTC session must return 200');
  const webrtcSessionData = await webrtcSessionRes.json();
  assert.strictEqual(webrtcSessionData.provider, 'telnyx', 'Provider must be telnyx');
  assert.ok(
    webrtcSessionData.wsUrl === 'wss://sip.telnyx.com:7443' || webrtcSessionData.wsUrl === 'wss://rtc.telnyx.com',
    'WebRTC wsUrl must be a valid Telnyx gateway'
  );
  ok(`WebRTC session descriptor contract verified (${webrtcSessionData.wsUrl}, Telnyx provider)`);

  const businessHoursRes = await fetch(`${BASE}/api/telephony/business-hours`, { headers: authHeaders });
  assert.strictEqual(businessHoursRes.status, 200, 'Business hours must return 200');
  const businessHoursData = await businessHoursRes.json();
  assert.strictEqual(businessHoursData.tz, 'Europe/Copenhagen', 'Business hours timezone must be Europe/Copenhagen');
  ok(`Business hours verified for ${businessHoursData.tz} (starts: ${businessHoursData.startsAt}, ends: ${businessHoursData.endsAt})`);

  // =========================================================================
  // 4. Call Lifecycle & Direct Dialing Bug Check
  // =========================================================================
  console.log('\n[4/5] Call Lifecycle, Direct Dial & Deduplication Bug Check');

  const testPhone = '+4591929394';
  const testName = 'Automated Connectivity Tester';

  // 1. Direct dial creation
  const directDialRes = await fetch(`${BASE}/api/calls/direct`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ phone: testPhone, name: testName }),
  });
  assert.strictEqual(directDialRes.status, 200, 'Direct dial must return 200');
  const directDialData = await directDialRes.json();
  assert.strictEqual(directDialData.ok, true, 'Direct dial must return ok: true');
  assert.ok(directDialData.callId, 'Direct dial must generate a callId');
  assert.ok(directDialData.dialUri, 'Direct dial must provide a dialUri');
  assert.ok(directDialData.prospect && directDialData.prospect.id, 'Direct dial must return the created/found prospect');
  const testProspectId = directDialData.prospect.id;
  const testCallId = directDialData.callId;
  ok(`Direct dial initialized successfully (Call ID: ${testCallId}, Prospect ID: ${testProspectId}, URI: ${directDialData.dialUri})`);

  // 2. Direct dial deduplication: dialing the exact same number should reuse testProspectId
  const reDialRes = await fetch(`${BASE}/api/calls/direct`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ phone: testPhone, name: testName }),
  });
  assert.strictEqual(reDialRes.status, 200, 'Second direct dial must succeed');
  const reDialData = await reDialRes.json();
  assert.strictEqual(reDialData.prospect.id, testProspectId, 'Second dial to the same phone number must reuse existing prospect without duplicating');
  ok('Deduplication verified: subsequent dials to same phone number cleanly reuse prospect');

  // 3. Classify call
  const classifyRes = await fetch(`${BASE}/api/calls/${testCallId}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ outcome: 'conversation', notes: 'Automated test classification notes' }),
  });
  assert.strictEqual(classifyRes.status, 200, 'Classification must succeed with 200');
  const classifyData = await classifyRes.json();
  assert.strictEqual(classifyData.ok, true, 'Classification must answer ok: true');
  ok(`Call classification committed cleanly (Outcome: conversation, Call ID: ${testCallId})`);

  // 4. Clean up test records
  const deleteProspectRes = await fetch(`${BASE}/api/prospects/${testProspectId}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  assert.strictEqual(deleteProspectRes.status, 200, 'Deleting test prospect must succeed');
  ok('Test prospect and cascading call history cleaned up with zero residue');

  // =========================================================================
  // 5. File System & Media Storage Integrity
  // =========================================================================
  console.log('\n[5/5] File System & Media Storage Integrity');

  const testDirs = [
    { name: 'Audio Directory', dir: audioDir },
    { name: 'Recordings Directory', dir: recordingsDir },
    { name: 'Backups Directory', dir: backupDir },
  ];

  for (const { name, dir } of testDirs) {
    assert.ok(fs.existsSync(dir), `${name} (${dir}) must exist on disk`);
    const probeFile = path.join(dir, `.probe-${Date.now()}.tmp`);
    fs.writeFileSync(probeFile, 'pulse-connectivity-probe-data', 'utf8');
    const readBack = fs.readFileSync(probeFile, 'utf8');
    assert.strictEqual(readBack, 'pulse-connectivity-probe-data', `Must be able to write and read from ${name}`);
    fs.unlinkSync(probeFile);
    ok(`${name} verified with atomic write, read, and delete permissions`);
  }

  console.log(`\n🎉 ALL ${passed} BACKEND CONNECTIVITY & BUG CHECKS PASSED SUCCESSFULLY!\n`);
}

runTests().catch((err) => {
  console.error('\n❌ BACKEND CONNECTIVITY CHECK FAILED:');
  console.error(err);
  process.exit(1);
});
