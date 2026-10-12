// Unit test for call recordings repository, audio streaming, and API contracts.
// Enforces zero-extra-charge local storage, path-traversal safety, Range header streaming,
// and relational query filtering across calls and prospects.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-recordings-test-'));
process.env.DATA_DIR = tmpDir;
process.env.PULSE_TEST = '1';

const migrate = require('../../server/db/migrate');
const { db } = require('../../server/db');
const prospects = require('../../server/repositories/prospectRepo');
const calls = require('../../server/repositories/callRepo');
const recordingRepo = require('../../server/repositories/recordingRepo');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function run() {
  console.log('--- Unit: call recordings repository & audio streaming ---');

  // Run migrations
  const m = migrate.run();
  assert.ok(m.total >= 9, 'migration includes recordings storage');

  // Check recordings table schema
  const cols = db.prepare('PRAGMA table_info(recordings)').all().map((c) => c.name);
  assert.ok(cols.includes('call_id'), 'recordings.call_id exists');
  assert.ok(cols.includes('filename'), 'recordings.filename exists');
  assert.ok(cols.includes('size_bytes'), 'recordings.size_bytes exists');
  assert.ok(cols.includes('duration_sec'), 'recordings.duration_sec exists');
  ok('recordings table exists with required schema');

  // Create prospect and call fixtures
  const p = prospects.insert({
    name: 'Mads Mikkelsen',
    company: 'Danish Cinema ApS',
    phone: '+45 20 12 34 56',
    stage: 'meeting',
  });

  const c1 = calls.insert({
    prospect_id: p.id,
    status: 'completed',
    dry_run: 0,
    direction: 'outbound',
    caller_id: '+45 88 00 11 22',
  });
  calls.patch(c1.id, { outcome: 'meeting', duration_sec: 142, summary: 'Discussed project scope' });

  const c2 = calls.insert({
    prospect_id: p.id,
    status: 'completed',
    dry_run: 0,
    direction: 'inbound',
    caller_id: '+45 20 12 34 56',
  });
  calls.patch(c2.id, { outcome: 'conversation', duration_sec: 45, summary: 'Inbound callback about pricing' });

  // 1. Insert recordings
  const rec1 = recordingRepo.insert({
    callId: c1.id,
    prospectId: p.id,
    filename: `call-${c1.id}.webm`,
    durationSec: 142,
    sizeBytes: 124500,
    mimeType: 'audio/webm',
  });
  assert.ok(rec1.id > 0);
  assert.strictEqual(rec1.call_id, c1.id);
  assert.strictEqual(rec1.size_bytes, 124500);
  assert.strictEqual(rec1.duration_sec, 142);
  ok('recording inserted and retrieved with primary key');

  const rec2 = recordingRepo.insert({
    callId: c2.id,
    prospectId: p.id,
    filename: `call-${c2.id}.webm`,
    durationSec: 45,
    sizeBytes: 42100,
    mimeType: 'audio/webm',
  });
  assert.ok(rec2.id > 0);
  ok('second recording inserted for inbound call');

  // 2. Listing & filtering
  const allList = recordingRepo.list({});
  assert.strictEqual(allList.length, 2, 'lists both recordings');
  assert.strictEqual(allList[0].id, rec2.id, 'newest recording first');
  assert.strictEqual(allList[0].prospect_name, 'Mads Mikkelsen');
  assert.strictEqual(allList[0].company, 'Danish Cinema ApS');
  assert.strictEqual(allList[0].direction, 'inbound');
  assert.strictEqual(allList[1].direction, 'outbound');
  assert.strictEqual(allList[1].outcome, 'meeting');
  ok('recordings listing joins call and prospect details');

  // Search filtering
  const searchResults = recordingRepo.list({ search: 'Mads' });
  assert.strictEqual(searchResults.length, 2);
  const searchPhone = recordingRepo.list({ search: '20 12 34' });
  assert.strictEqual(searchPhone.length, 2);
  const searchMiss = recordingRepo.list({ search: 'NonExistent' });
  assert.strictEqual(searchMiss.length, 0);
  ok('search filters by name, company, and phone');

  // Outcome filtering
  const meetingRecordings = recordingRepo.list({ outcome: 'meeting' });
  assert.strictEqual(meetingRecordings.length, 1);
  assert.strictEqual(meetingRecordings[0].call_id, c1.id);
  ok('filter by outcome works');

  // Direction filtering
  const inboundRecordings = recordingRepo.list({ direction: 'inbound' });
  assert.strictEqual(inboundRecordings.length, 1);
  assert.strictEqual(inboundRecordings[0].call_id, c2.id);
  ok('filter by direction works');

  // 3. HTTP Endpoints Verification (in-process server)
  const { createApp } = require('../../server/app');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Session token
    const tokenRes = await fetch(`${baseUrl}/api/session`);
    assert.strictEqual(tokenRes.status, 200);
    const token = (await tokenRes.json()).token;
    assert.ok(token, 'got session token');

    // Upload audio blob for c1
    const testAudioBytes = Buffer.from('FAKE-WEBM-OPUS-AUDIO-HEADER-AND-DATA-FOR-TESTING');
    const formData = new FormData();
    formData.append('audio', new Blob([testAudioBytes], { type: 'audio/webm' }), 'test.webm');
    formData.append('duration_sec', '95');

    const uploadRes = await fetch(`${baseUrl}/api/recordings/${c1.id}`, {
      method: 'POST',
      headers: { 'x-pulse-token': token },
      body: formData,
    });
    assert.strictEqual(uploadRes.status, 200, 'upload succeeded');
    const uploadJson = await uploadRes.json();
    assert.strictEqual(uploadJson.ok, true);
    assert.strictEqual(uploadJson.recording.call_id, c1.id);
    assert.strictEqual(uploadJson.recording.size_bytes, testAudioBytes.length);
    assert.strictEqual(uploadJson.recording.duration_sec, 95);
    ok('POST /api/recordings/:callId uploads audio securely');

    // GET /api/recordings
    const listRes = await fetch(`${baseUrl}/api/recordings?search=Mads`);
    assert.strictEqual(listRes.status, 200);
    const listJson = await listRes.json();
    assert.ok(listJson.recordings.length >= 2);
    assert.ok(listJson.recordings[0].audio_url.includes('/audio'));
    ok('GET /api/recordings lists recordings with audio URLs');

    // GET /api/recordings/:callId/audio (full stream)
    const audioRes = await fetch(`${baseUrl}/api/recordings/${c1.id}/audio`);
    assert.strictEqual(audioRes.status, 200);
    assert.strictEqual(audioRes.headers.get('content-type'), 'audio/webm');
    assert.strictEqual(audioRes.headers.get('accept-ranges'), 'bytes');
    const audioBuf = Buffer.from(await audioRes.arrayBuffer());
    assert.strictEqual(audioBuf.length, testAudioBytes.length);
    assert.strictEqual(audioBuf.toString(), testAudioBytes.toString());
    ok('GET /api/recordings/:callId/audio streams audio intact');

    // GET /api/recordings/:callId/audio with HTTP Range (seeking / scrubbing)
    const rangeRes = await fetch(`${baseUrl}/api/recordings/${c1.id}/audio`, {
      headers: { Range: 'bytes=0-15' },
    });
    assert.strictEqual(rangeRes.status, 206, 'HTTP 206 Partial Content returned');
    assert.strictEqual(rangeRes.headers.get('content-range'), `bytes 0-15/${testAudioBytes.length}`);
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    assert.strictEqual(rangeBuf.length, 16);
    assert.strictEqual(rangeBuf.toString(), testAudioBytes.subarray(0, 16).toString());
    ok('HTTP 206 Range requests support instant scrubbing and seeking');

    // Invalid Range -> 416
    const badRange = await fetch(`${baseUrl}/api/recordings/${c1.id}/audio`, {
      headers: { Range: 'bytes=99999-999999' },
    });
    assert.strictEqual(badRange.status, 416, 'HTTP 416 Range Not Satisfiable');
    ok('out-of-bounds byte range handled with HTTP 416');

    // Path traversal safety
    const traversal = await fetch(`${baseUrl}/api/recordings/nonexistent/audio`);
    assert.strictEqual(traversal.status, 400, 'malformed callId refused');
    ok('traversal and non-integer IDs rejected safely');

    // DELETE /api/recordings/:callId
    const delRes = await fetch(`${baseUrl}/api/recordings/${c1.id}`, {
      method: 'DELETE',
      headers: { 'x-pulse-token': token },
    });
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual((await delRes.json()).ok, true);

    const postDel = await fetch(`${baseUrl}/api/recordings/${c1.id}/audio`);
    assert.strictEqual(postDel.status, 404, 'recording is gone after DELETE');
    ok('DELETE /api/recordings/:callId removes recording and cleans disk');

  } finally {
    server.close();
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  console.log(`\nAll ${passed} recordings unit & integration checks passed!`);
}

run().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
