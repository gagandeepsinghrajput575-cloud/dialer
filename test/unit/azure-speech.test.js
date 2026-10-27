// Unit test suite for Azure Neural Speech Synthesis with SSML prosody,
// sentence-level streaming buffer, channel audio formats, and conversational phrasing.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const azureSpeech = require('../../server/services/azureSpeechService');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
  console.log('--- Unit: Azure Neural Speech & SSML Prosody Optimization ---');

  // 1. SSML Markup & Prosody Builder
  {
    const raw = 'Hej! Tak fordi du ringer. Hvad kan jeg hjælpe dig med i dag?';
    const ssml = azureSpeech.buildSsml(raw, { lang: 'da-DK', voice: 'da-DK-ChristelNeural' });

    assert.ok(ssml.startsWith('<speak version="1.0"'), 'SSML root speak tag');
    assert.ok(ssml.includes('xml:lang="da-DK"'), 'declares language da-DK');
    assert.ok(ssml.includes('<voice name="da-DK-ChristelNeural">'), 'selected voice wrapper');
    assert.ok(ssml.includes('rate="-4%"'), 'lowered speaking rate (-4%) for conversational pacing');
    assert.ok(ssml.includes('pitch="-2%"'), 'lowered pitch (-2%) for natural vocal resonance');
    assert.ok(ssml.includes('<break time="180ms"/>'), 'inserted 180ms breath breaks between sentences');
    ok('SSML builder applies natural prosody (rate: -4%, pitch: -2%) and 180ms breath breaks');
  }

  // 2. Clause Pauses & Conversational Acronym Expansion
  {
    const raw = 'Vi hjælper VVS og CVR registrerede virksomheder, så I sparer tid.';
    const ssml = azureSpeech.buildSsml(raw);

    assert.ok(ssml.includes('V V S'), 'expands VVS acronym to "V V S" for natural speech cadence');
    assert.ok(ssml.includes('C V R'), 'expands CVR acronym to "C V R"');
    assert.ok(ssml.includes('<break time="120ms"/>'), 'inserts 120ms clause pause after comma');
    ok('conversational acronyms (VVS, CVR) expanded and clause break (120ms) inserted');
  }

  // 3. XML Escaping Safeguards
  {
    const unsafe = 'Pris: < 500 DKK & > 200 "special" tilbud.';
    const ssml = azureSpeech.buildSsml(unsafe);

    assert.ok(!ssml.includes('< 500'), 'escapes <');
    assert.ok(ssml.includes('&lt; 500'), 'escaped into &lt;');
    assert.ok(ssml.includes('&amp;'), 'escapes & into &amp;');
    assert.ok(ssml.includes('&quot;special&quot;'), 'escapes quotes');
    ok('user text is strictly XML-escaped without breaking <break> tags');
  }

  // 4. Sentence-Level Stream Buffering
  {
    const emitted = [];
    const buffer = new azureSpeech.SentenceBuffer((sentence) => {
      emitted.push(sentence);
    });

    // Simulate word-by-word streaming from an LLM
    const tokens = ['Hej', ' ', 'med', ' ', 'dig', '!', ' ', 'Hvordan', ' ', 'gar', ' ', 'det', '?', ' ', 'Vi', ' ', 'taler'];
    for (const token of tokens) {
      buffer.push(token);
    }

    assert.strictEqual(emitted.length, 2, 'two complete sentences emitted during streaming');
    assert.strictEqual(emitted[0], 'Hej med dig!');
    assert.strictEqual(emitted[1], 'Hvordan gar det?');

    // Flush remaining fragment
    const remainder = buffer.flush();
    assert.strictEqual(remainder.length, 1);
    assert.strictEqual(remainder[0], 'Vi taler');
    assert.strictEqual(emitted.length, 3, 'flush yields the final clause');
    ok('SentenceBuffer groups word-by-word LLM tokens into complete sentences before TTS');
  }

  // 5. Channel-Specific Audio Formats
  {
    assert.strictEqual(azureSpeech.AUDIO_FORMATS.telephony, 'riff-8khz-16bit-mono-pcm',
      'telephony uses 8kHz PCM to prevent SIP trunk downsampling distortion');
    assert.strictEqual(azureSpeech.AUDIO_FORMATS.telephony_mulaw, 'audio-8khz-16bit-32kbps-mono-mulaw',
      'telephony supports 8kHz G.711 u-law');
    assert.strictEqual(azureSpeech.AUDIO_FORMATS.webrtc, 'raw-16khz-16bit-mono-pcm',
      'WebRTC uses 16kHz PCM for browser/LiveKit channels');
    assert.strictEqual(azureSpeech.AUDIO_FORMATS.web, 'audio-24khz-160kbitrate-mono-mp3',
      'web playback uses high-fidelity 24kHz MP3');
    ok('channel audio formats correctly mapped for FlyNumber SIP, WebRTC, and web playback');
  }

  // 6. Speech Synthesis Execution & Voicemail Greeting Generator
  {
    const tmpAudio = path.join(os.tmpdir(), `test-vm-greeting-${Date.now()}.mp3`);
    const greeting = await azureSpeech.generateVoicemailGreeting('Hej! Læg venligst en besked.', tmpAudio);

    assert.strictEqual(greeting.saved, true, 'voicemail greeting generated and saved');
    assert.ok(fs.existsSync(tmpAudio), 'greeting file written to disk');
    assert.ok(greeting.bytes > 0, 'greeting buffer has content');
    assert.ok(greeting.ssml.includes('da-DK-ChristelNeural'), 'uses Danish neural voice');
    try { fs.unlinkSync(tmpAudio); } catch {}
    ok('voicemail greeting generator synthesizes natural audio file on disk');
  }

  // 7. Internal Thinking & Reasoning Filter
  {
    const withThinking = '<think>Let me figure out what to say. The user wants pricing.</think>Det koster fra to tusind kroner.';
    assert.strictEqual(azureSpeech.stripThinkingAndMeta(withThinking), 'Det koster fra to tusind kroner.',
      'strips <think>...</think> block');

    const emitted = [];
    const buf = new azureSpeech.SentenceBuffer((s) => emitted.push(s));
    buf.push('<think>Wait, analyzing intent...');
    buf.push(' user asked about timeline.</think>');
    buf.push('Vi kan starte i næste uge.');
    buf.flush();

    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0], 'Vi kan starte i næste uge.');
    ok('streaming <think> reasoning tokens are completely filtered and never spoken');
  }

  // 8. Anti-Repetition & Short Impactful Speeches
  {
    const emitted = [];
    const buf = new azureSpeech.SentenceBuffer((s) => emitted.push(s), { maxSentences: 2 });
    buf.push('Første sætning er kort og præcis. ');
    buf.push('Anden sætning fortsætter hvor vi slap. ');
    buf.push('Tredje sætning skal skæres væk for at holde talen kort. ');
    buf.push('Første sætning er kort og præcis. '); // duplicate
    buf.flush();

    assert.strictEqual(emitted.length, 2, 'strictly caps at 2 impactful sentences per turn');
    assert.strictEqual(emitted[0], 'Første sætning er kort og præcis.');
    assert.strictEqual(emitted[1], 'Anden sætning fortsætter hvor vi slap.');
    ok('anti-repetition blocks duplicate phrases and enforces 1-2 sentence maximum per turn');
  }

  console.log(`\n🎉 All ${passed} Azure Speech & Natural Prosody checks passed!`);
}

main().catch((err) => {
  console.error('\n❌ Azure speech test failed:', err);
  process.exit(1);
});
