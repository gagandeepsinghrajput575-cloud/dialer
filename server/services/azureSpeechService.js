// Azure Neural Speech Synthesis Service with SSML Prosody, Sentence Buffering,
// Channel Audio Formatting, and Conversational Acronym Handling.
'use strict';

const fs = require('fs');
const path = require('path');
const settings = require('../repositories/settingsRepo');

// Default neural voices
const DEFAULT_VOICES = {
  'da-DK': 'da-DK-ChristelNeural', // Danish female neural voice (conversational & natural)
  'da-DK-male': 'da-DK-JeppeNeural', // Danish male neural voice
  'en-US': 'en-US-JennyNeural',
  'en-US-casual': 'en-US-AriaNeural',
  'en-GB': 'en-GB-SoniaNeural',
};

// Channel-specific audio formats to avoid downsampling distortion
const AUDIO_FORMATS = {
  // 1. Telephony (FlyNumber / SIP trunks / PSTN)
  telephony: 'riff-8khz-16bit-mono-pcm', // Riff8Khz16BitMonoPcm
  telephony_mulaw: 'audio-8khz-16bit-32kbps-mono-mulaw', // Audio8Khz16Bit32KbpsMonoMulaw

  // 2. WebRTC / LiveKit in-browser streams
  webrtc: 'raw-16khz-16bit-mono-pcm', // Raw16Khz16BitMonoPcm
  webrtc_24k: 'raw-24khz-16bit-mono-pcm', // Raw24Khz16BitMonoPcm

  // 3. High-Fidelity Web / Desktop / Mobile Playback
  web: 'audio-24khz-160kbitrate-mono-mp3', // Audio24Khz160KBitRateMonoMp3
  web_high: 'raw-48khz-16bit-mono-pcm', // Raw48Khz16BitMonoPcm
  web_wav: 'riff-24khz-16bit-mono-pcm',
};

// Common conversational acronyms in Danish and English cold calling
const CONVERSATIONAL_ACRONYMS = {
  VVS: 'V V S',
  CVR: 'C V R',
  CPR: 'C P R',
  B2B: 'B 2 B',
  B2C: 'B 2 C',
  CEO: 'C E O',
  CTO: 'C T O',
  CFO: 'C F O',
  SDR: 'S D R',
  BDR: 'B D R',
  CRM: 'C R M',
  API: 'A P I',
  URL: 'U R L',
  SMS: 'S M S',
  SEO: 'S E O',
  DK: 'Danmark',
  DKK: 'kroner',
};

/**
 * Escapes characters for XML/SSML safe inclusion.
 */
function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Expands colloquial abbreviations, numbers, and acronyms for natural spoken cadence.
 */
function expandConversationalText(text) {
  if (!text) return '';
  let expanded = String(text);

  // Expand known uppercase acronyms with spaced letter breaks unless inside words
  for (const [acronym, replacement] of Object.entries(CONVERSATIONAL_ACRONYMS)) {
    const regex = new RegExp(`\\b${acronym}\\b`, 'g');
    expanded = expanded.replace(regex, replacement);
  }

  // Format Danish phone numbers (+45 XX XX XX XX) into groups for speech cadence
  expanded = expanded.replace(/(\+45|\b45)?\s*(\d{2})\s*(\d{2})\s*(\d{2})\s*(\d{2})\b/g, (m, p1, a, b, c, d) => {
    return `${p1 ? 'plus fem og fyrre, ' : ''}${a}, ${b}, ${c}, ${d}`;
  });

  return expanded;
}

/**
 * Builds Azure-compliant Speech Synthesis Markup Language (SSML) with:
 * - Subdued, conversational speaking rate (-4% default)
 * - Slightly lowered pitch (-2% default) to avoid robotic bright timbre
 * - 180ms breath breaks between sentences
 * - 120ms clause breaks after commas and semicolons
 */
function buildSsml(rawText, options = {}) {
  const lang = options.lang || 'da-DK';
  const voice = options.voice || DEFAULT_VOICES[lang] || DEFAULT_VOICES['da-DK'];
  const rate = options.rate || '-4%'; // -3% to -6% sounds conversational
  const pitch = options.pitch || '-2%'; // -2% drops unnatural acoustic tension

  const cleaned = expandConversationalText(rawText);

  // Inject natural breath pauses into punctuation while preserving words
  // 1. Break after sentence endings (. ! ?) -> 180ms breath pause
  // 2. Break after clauses (, ; :) -> 120ms subtle pause
  const sentences = cleaned
    .replace(/([.!?])(\s+|$)/g, '$1 <break time="180ms"/> ')
    .replace(/([,;:])(\s+)/g, '$1 <break time="120ms"/> ')
    .trim();

  // Escape XML text outside of inserted tags
  // Split on <break ... /> tags so we only escape user text
  const parts = sentences.split(/(<break\s+time="[^"]+"\s*\/>)/g);
  const formattedContent = parts
    .map((p) => (p.startsWith('<break') ? p : escapeXml(p)))
    .join('');

  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${voice}">` +
    `<prosody rate="${rate}" pitch="${pitch}">` +
    `${formattedContent}` +
    `</prosody>` +
    `</voice>` +
    `</speak>`
  );
}

/**
 * Strips internal reasoning, <think> tags, and meta-commentary so the TTS engine
 * never speaks internal thoughts or LLM reasoning artifacts.
 */
function stripThinkingAndMeta(text) {
  if (!text) return '';
  return String(text)
    // Strip <think>...</think> tags completely
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Strip unclosed <think> block at beginning
    .replace(/^<think>[\s\S]*?$/gi, '')
    // Strip [Thinking: ...] or (thought: ...) blocks
    .replace(/\[(?:thinking|thought|internal|reasoning)[\s\S]*?\]/gi, '')
    .replace(/\((?:thinking|thought|internal|reasoning)[\s\S]*?\)/gi, '')
    // Strip "Thinking Process:" or "Reasoning:" prefixes
    .replace(/(?:\*\*|__)?(?:thinking|thought|reasoning)(?:\s+process)?(?:\*\*|__)?:\s*[\s\S]*?(?=\n\n|$)/gi, '')
    // Strip repetitive echoing of the prospect's query
    .replace(/^(?:so\s+)?(?:you\s+are\s+asking|you\s+asked\s+about|repeating:?)\s+/i, '')
    .trim();
}

/**
 * SentenceBuffer: Buffers streamed LLM tokens (e.g. from DeepSeek, Gemini, Claude)
 * until a sentence boundary is encountered before passing to TTS.
 * Filters out <think> internal monologues, deduplicates repeated sentences,
 * and caps output to short, impactful turns.
 */
class SentenceBuffer {
  constructor(onSentenceReady, options = {}) {
    this.buffer = '';
    this.onSentenceReady = onSentenceReady || (() => {});
    this.boundaryRegex = /([.!?]+[\s\n]+)/;
    this.inThinkingBlock = false;
    this.recentSentences = [];
    this.maxSentencesPerTurn = options.maxSentences || Infinity;
    this.sentencesEmittedThisTurn = 0;
  }

  /**
   * Pushes a new token or text chunk.
   * Discards tokens inside <think>...</think> blocks, and flushes valid sentences.
   */
  push(token) {
    if (!token) return [];

    let raw = token;

    // Handle entering or exiting streaming thinking blocks
    if (!this.inThinkingBlock && raw.includes('<think>')) {
      this.inThinkingBlock = true;
      const parts = raw.split('<think>');
      this.buffer += parts[0]; // keep anything before <think>
      raw = parts.slice(1).join('<think>');
    }

    if (this.inThinkingBlock) {
      if (raw.includes('</think>')) {
        const after = raw.split('</think>').slice(1).join('</think>');
        this.inThinkingBlock = false;
        raw = after;
      } else {
        // Discard token inside thinking block
        return [];
      }
    }

    this.buffer += raw;
    const readySentences = [];

    let match;
    while ((match = this.boundaryRegex.exec(this.buffer)) !== null) {
      const splitIdx = match.index + match[0].length;
      let sentence = this.buffer.slice(0, splitIdx).trim();
      this.buffer = this.buffer.slice(splitIdx);

      // Clean thinking / meta leftovers
      sentence = stripThinkingAndMeta(sentence);

      if (sentence && !this.isRepetition(sentence)) {
        if (this.sentencesEmittedThisTurn < this.maxSentencesPerTurn) {
          readySentences.push(sentence);
          this.recentSentences.push(sentence.toLowerCase());
          if (this.recentSentences.length > 5) this.recentSentences.shift();
          this.sentencesEmittedThisTurn++;
          this.onSentenceReady(sentence);
        }
      }
    }
    return readySentences;
  }

  /** Checks if sentence repeats a recently spoken phrase */
  isRepetition(sentence) {
    const norm = sentence.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!norm) return true;
    return this.recentSentences.some((past) => {
      const pastNorm = past.replace(/[^a-z0-9]/g, '');
      return pastNorm === norm || (norm.length > 15 && pastNorm.includes(norm));
    });
  }

  /** Resets turn sentence counter for new conversational turn */
  resetTurn() {
    this.sentencesEmittedThisTurn = 0;
  }

  /**
   * Flushes any remaining incomplete sentence (e.g. at end of stream).
   */
  flush() {
    let remainder = stripThinkingAndMeta(this.buffer.trim());
    this.buffer = '';
    if (remainder && !this.isRepetition(remainder) && this.sentencesEmittedThisTurn < this.maxSentencesPerTurn) {
      this.recentSentences.push(remainder.toLowerCase());
      this.sentencesEmittedThisTurn++;
      this.onSentenceReady(remainder);
      return [remainder];
    }
    return [];
  }
}

/**
 * Returns Azure Speech credentials from environment or settings.
 */
function getAzureConfig() {
  const key =
    process.env.AZURE_SPEECH_KEY ||
    settings.get('azure_speech_key') ||
    '';
  const region =
    process.env.AZURE_SPEECH_REGION ||
    settings.get('azure_speech_region') ||
    'eastus';
  return { key, region };
}

/**
 * Synthesizes text to speech using Azure Cognitive Services Neural TTS.
 * @param {string} text - Plain text or SSML
 * @param {object} options
 * @param {string} [options.channel='web'] - 'telephony', 'webrtc', or 'web'
 * @param {string} [options.lang='da-DK']
 * @param {string} [options.voice]
 * @param {string} [options.rate='-4%']
 * @param {string} [options.pitch='-2%']
 * @returns {Promise<{ audioBuffer: Buffer, contentType: string, format: string, ssml: string }>}
 */
async function synthesizeSpeech(text, options = {}) {
  const { key, region } = getAzureConfig();
  const channel = options.channel || 'web';
  const format = AUDIO_FORMATS[channel] || AUDIO_FORMATS.web;
  const isSsml = String(text || '').trim().startsWith('<speak');
  const ssml = isSsml ? text : buildSsml(text, options);

  let contentType = 'audio/mpeg';
  if (format.includes('pcm') || format.includes('wav')) contentType = 'audio/wav';
  else if (format.includes('mulaw')) contentType = 'audio/basic';

  if (!key) {
    // Graceful offline mock for local dev and tests when Azure Key is not yet populated
    return {
      audioBuffer: Buffer.alloc(160, 0),
      contentType,
      format,
      ssml,
      mock: true,
      hint: 'Azure Speech Key not configured — set AZURE_SPEECH_KEY in .env or Settings',
    };
  }

  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': format,
      'User-Agent': 'PulseDialer-VoiceBridge/1.0',
    },
    body: ssml,
    signal: AbortSignal.timeout(options.timeoutMs || 10000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure Speech API error (${response.status}): ${errorText}`);
  }

  const arrayBuf = await response.arrayBuffer();
  return {
    audioBuffer: Buffer.from(arrayBuf),
    contentType,
    format,
    ssml,
    mock: false,
  };
}

/**
 * Generates and saves a natural Danish voicemail greeting directly in the telephony audio format.
 */
async function generateVoicemailGreeting(greetingText, targetPath = null, options = {}) {
  const defaultDanishText =
    'Hej! Tak fordi du ringede til Scalix Elite. ' +
    'Vi er i øjeblikket optaget i et kundemøde, men læg venligst en besked med dit navn og nummer, ' +
    'så ringer vi tilbage hurtigst muligt.';

  const text = greetingText || defaultDanishText;
  const target = targetPath || path.join(__dirname, '..', '..', 'data', 'audio', 'vm_danish.mp3');

  // Ensure directory exists
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const result = await synthesizeSpeech(text, {
    channel: options.channel || 'web', // mp3 container is standard for vm_danish.mp3
    lang: 'da-DK',
    voice: options.voice || 'da-DK-ChristelNeural',
    rate: '-4%',
    pitch: '-2%',
    ...options,
  });

  fs.writeFileSync(target, result.audioBuffer);
  return {
    saved: true,
    path: target,
    bytes: result.audioBuffer.length,
    ssml: result.ssml,
    format: result.format,
    mock: result.mock,
  };
}

module.exports = {
  DEFAULT_VOICES,
  AUDIO_FORMATS,
  CONVERSATIONAL_ACRONYMS,
  escapeXml,
  expandConversationalText,
  buildSsml,
  stripThinkingAndMeta,
  SentenceBuffer,
  synthesizeSpeech,
  generateVoicemailGreeting,
  getAzureConfig,
};
