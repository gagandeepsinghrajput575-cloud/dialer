process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/pulse-ai-coach-');
process.env.PULSE_TEST = '1';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { db } = require('../../server/db');
const migrate = require('../../server/db/migrate');
migrate.run();

const prospects = require('../../server/repositories/prospectRepo');
const calls = require('../../server/repositories/callRepo');
const recordingRepo = require('../../server/repositories/recordingRepo');
const settings = require('../../server/repositories/settingsRepo');
const chatRepo = require('../../server/repositories/recordingChatRepo');
const aiRecordingCoach = require('../../server/services/aiRecordingCoach');
const { recordingsDir } = require('../../server/config/env');

let passed = 0;
const ok = (msg) => { passed++; console.log(`    ✓ ${msg}`); };

async function run() {
  console.log('--- Unit: AI Recording Coach & Multimodal Script Auditor ---');

  // 1. Schema check
  const chatCols = db.prepare('PRAGMA table_info(recording_chats)').all().map((c) => c.name);
  assert.ok(chatCols.includes('call_id'), 'recording_chats.call_id exists');
  assert.ok(chatCols.includes('title'), 'recording_chats.title exists');

  const msgCols = db.prepare('PRAGMA table_info(recording_chat_messages)').all().map((c) => c.name);
  assert.ok(msgCols.includes('chat_id'), 'recording_chat_messages.chat_id exists');
  assert.ok(msgCols.includes('role'), 'recording_chat_messages.role exists');
  assert.ok(msgCols.includes('content'), 'recording_chat_messages.content exists');
  assert.ok(msgCols.includes('meta'), 'recording_chat_messages.meta exists');
  ok('Migration 11 created recording_chats and recording_chat_messages tables');

  // 2. Fixture setup
  const p = prospects.insert({
    name: 'Henrik Jensen',
    company: 'A/S BRDR. JENSEN VVS',
    phone: '+45 45 87 80 88',
    title: 'Direktør',
    stage: 'meeting',
  });

  const c = calls.insert({
    prospect_id: p.id,
    status: 'completed',
    dry_run: 0,
    direction: 'outbound',
    duration_sec: 134,
  });

  // Create real synthetic audio file on disk
  const filename = `call-${c.id}-test.wav`;
  const audioFilePath = path.join(recordingsDir, filename);
  fs.writeFileSync(audioFilePath, Buffer.from('RIFF....WAVEfmt ....data....test-audio-bytes'));

  recordingRepo.insert({
    callId: c.id,
    prospectId: p.id,
    filename,
    durationSec: 134,
    sizeBytes: 1024,
    mimeType: 'audio/wav',
  });
  ok('fixtures created with local audio recording');

  // 3. chatRepo session management
  const session1 = chatRepo.createChat(c.id, 'First Call Audit');
  assert.ok(session1.id > 0);
  assert.strictEqual(session1.title, 'First Call Audit');
  assert.strictEqual(session1.call_id, c.id);

  const m1 = chatRepo.createMessage(session1.id, {
    role: 'user',
    content: 'How was my opening hook?',
  });
  assert.strictEqual(m1.role, 'user');
  assert.strictEqual(m1.content, 'How was my opening hook?');

  const m2 = chatRepo.createMessage(session1.id, {
    role: 'assistant',
    content: 'Your opening was crisp and polite at [0:04].',
    meta: { adherenceScore: 88 },
  });
  assert.strictEqual(m2.role, 'assistant');
  assert.strictEqual(m2.meta.adherenceScore, 88);

  const reloaded = chatRepo.getChat(session1.id);
  assert.strictEqual(reloaded.messages.length, 2);
  assert.strictEqual(reloaded.messages[0].content, 'How was my opening hook?');
  assert.strictEqual(reloaded.messages[1].meta.adherenceScore, 88);
  ok('chatRepo persists multi-turn coaching sessions and messages');

  // 4. Test without API key returns needsKey gracefully
  const savedEnvKey = process.env.GEMINI_API_KEY;
  const savedDbKey = settings.get('ai_api_key');
  delete process.env.GEMINI_API_KEY;
  settings.set('ai_api_key', '');
  let noKey;
  try {
    noKey = await aiRecordingCoach.processCoachingTurn({
      callId: c.id,
      message: 'Audit my script adherence',
      apiKey: '',
    });
  } finally {
    if (savedEnvKey) process.env.GEMINI_API_KEY = savedEnvKey;
    if (savedDbKey) settings.set('ai_api_key', savedDbKey);
  }
  assert.strictEqual(noKey.needsKey, true);
  assert.strictEqual(noKey.success, false);
  ok('returns needsKey flag when Gemini API key is unconfigured');

  // 5. Test with mocked Gemini multimodal audio response
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      assert.ok(url.includes('generateContent'));
      assert.strictEqual(opts.headers['x-goog-api-key'], 'test-gemini-key');

      const body = JSON.parse(opts.body);
      assert.ok(body.contents.length >= 1);
      // Turn 1 must contain inlineData with audio
      const inlineData = body.contents[0].parts.find((p) => p.inlineData);
      assert.ok(inlineData, 'first turn contains inline audio data');
      assert.strictEqual(inlineData.inlineData.mimeType, 'audio/wav');
      assert.ok(inlineData.inlineData.data.length > 0, 'audio buffer converted to base64');

      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: [
                      '# Call Coaching Review',
                      '**Script Adherence Score: 85%**',
                      '',
                      '### What Went Good:',
                      '- [0:06] Strong opening hook asking for 30 seconds.',
                      '- [0:42] Handled the "too busy" objection smoothly.',
                      '',
                      '### Missed Opportunities:',
                      '- [1:12] Diverted from qualifying question before securing the meeting date.',
                      '',
                      '### Recommended Next Pitch:',
                      'Follow up with a 10-minute Google Meet link.',
                    ].join('\n'),
                  },
                ],
              },
            },
          ],
        }),
      };
    };

    const aiRes = await aiRecordingCoach.processCoachingTurn({
      callId: c.id,
      message: 'Audit script adherence',
      script: 'Hej [Navn]... Har du 30 sekunder?',
      quickAction: 'adherence',
      apiKey: 'test-gemini-key',
    });

    assert.strictEqual(aiRes.success, true);
    assert.strictEqual(aiRes.meta.adherenceScore, 85);
    assert.ok(aiRes.message.content.includes('Script Adherence Score: 85%'));
    assert.ok(aiRes.message.content.includes('[0:06] Strong opening hook'));

    const chats = chatRepo.listChats(c.id);
    assert.ok(chats.length >= 2, 'session auto-created and listed');
    ok('successfully processes multimodal audio turn with Gemini and extracts adherence metrics');
  } finally {
    global.fetch = originalFetch;
  }

  // 6. Cascade delete: deleting a call cascades and cleans up recording, chats, and messages
  const c2 = calls.insert({
    prospect_id: p.id,
    status: 'completed',
    dry_run: 0,
    direction: 'inbound',
  });
  recordingRepo.insert({
    callId: c2.id,
    filename: 'dummy.wav',
  });
  const c2Session = chatRepo.createChat(c2.id, 'Temporary Session');
  chatRepo.createMessage(c2Session.id, { role: 'user', content: 'test message' });

  assert.strictEqual(chatRepo.listChats(c2.id).length, 1);
  assert.strictEqual(chatRepo.listMessages(c2Session.id).length, 1);

  // Delete call
  calls.remove(c2.id);
  assert.strictEqual(recordingRepo.getByCallId(c2.id), null, 'recording cascaded');
  assert.strictEqual(chatRepo.listChats(c2.id).length, 0, 'chats cascaded on call delete');
  assert.strictEqual(chatRepo.listMessages(c2Session.id).length, 0, 'messages cascaded on call delete');
  ok('foreign-key cascade cleanly deletes recording, chats and messages when call is deleted');

  console.log(`\nAll ${passed} AI Recording Coach & Multimodal checks passed!\n`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
