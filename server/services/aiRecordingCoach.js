const fs = require('fs');
const path = require('path');
const recordingRepo = require('../repositories/recordingRepo');
const calls = require('../repositories/callRepo');
const prospects = require('../repositories/prospectRepo');
const settings = require('../repositories/settingsRepo');
const chatRepo = require('../repositories/recordingChatRepo');
const { recordingsDir } = require('../config/env');
const { DEFAULT_SALES_SCRIPT } = require('../config/defaults');
const { ApiError } = require('../middleware/errorHandler');

const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash';

function safeAudioPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const base = path.basename(filename);
  const resolved = path.join(recordingsDir, base);
  if (!resolved.startsWith(recordingsDir)) return null;
  return resolved;
}

/**
 * Executes an AI coaching turn for a call recording.
 * Ingests raw audio natively via Google Gemini Flash, compares against the target script,
 * evaluates diversion, tone, and objection handling, and persists chat history.
 */
async function processCoachingTurn({
  callId,
  chatId = null,
  message,
  script = null,
  quickAction = 'freeform',
  apiKey = null,
  model = null,
} = {}) {
  const cid = Number(callId);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw ApiError.badRequest('Invalid call ID');
  }

  // 1. Verify recording exists
  const rec = recordingRepo.getByCallId(cid);
  if (!rec) {
    throw ApiError.notFound('No recording found for this call');
  }

  const audioPath = safeAudioPath(rec.filename);
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw ApiError.notFound('Audio recording file is missing from local disk');
  }

  // 2. Fetch call & prospect context
  const callRow = calls.get(cid) || {};
  const prospectRow = callRow.prospect_id ? prospects.get(callRow.prospect_id) : null;
  const prospectContext = {
    name: prospectRow?.name || 'Unknown Prospect',
    company: prospectRow?.company || 'Unknown Company',
    title: prospectRow?.title || 'Unknown Title',
    phone: prospectRow?.phone || callRow?.caller_id || '',
    durationSec: rec.duration_sec || callRow?.duration_sec || 0,
    outcome: callRow?.outcome || 'unclassified',
    direction: callRow?.direction || 'outbound',
  };

  // 3. Resolve active API key & model
  const activeKey = apiKey || settings.get('ai_api_key') || process.env.GEMINI_API_KEY || '';
  if (!activeKey) {
    return {
      success: false,
      needsKey: true,
      message: 'Google Gemini API key is required to analyze call recordings with AI. Add your key in Settings or enter it above.',
    };
  }

  const activeModel = model || settings.get('ai_model') || GEMINI_DEFAULT_MODEL;
  const activeScript = (script || settings.get('sales_script') || DEFAULT_SALES_SCRIPT).trim();

  // 4. Resolve or create chat session
  let activeChat = chatId ? chatRepo.getChat(chatId) : null;
  if (!activeChat) {
    const defaultTitle = quickAction === 'adherence'
      ? 'Script Adherence Audit'
      : quickAction === 'good_wrong'
        ? 'Call Quality Review'
        : quickAction === 'objections'
          ? 'Objection Handling'
          : quickAction === 'followup'
            ? 'Follow-up Email Draft'
            : (message.length > 30 ? message.slice(0, 30) + '…' : message);

    activeChat = chatRepo.createChat(cid, defaultTitle);
  }

  // Save the user's message in history
  const userMsgRecord = chatRepo.createMessage(activeChat.id, {
    role: 'user',
    content: message,
    meta: { quickAction },
  });

  // 5. Read audio file into base64 with payload size guard
  const stats = fs.statSync(audioPath);
  if (stats.size > 15 * 1024 * 1024) {
    return {
      success: false,
      chatId: activeChat.id,
      error: `Audio recording (${Math.round(stats.size / 1024 / 1024)}MB) exceeds Gemini's 15MB inline payload limit.`,
    };
  }

  const audioBuffer = fs.readFileSync(audioPath);
  const base64Audio = audioBuffer.toString('base64');
  let mimeType = rec.mime_type || 'audio/webm';
  if (audioPath.endsWith('.wav')) mimeType = 'audio/wav';
  else if (audioPath.endsWith('.mp3')) mimeType = 'audio/mp3';
  else if (audioPath.endsWith('.ogg')) mimeType = 'audio/ogg';

  // 6. Assemble Gemini system prompt and multimodal parts
  const systemInstruction = `You are an elite, highly perceptive B2B Cold Call Sales Coach and Performance Auditor.
You analyze real phone call audio recordings to coach sales reps and account executives.

CALL CONTEXT:
- Prospect: ${prospectContext.name} (${prospectContext.title}) at ${prospectContext.company}
- Phone Number: ${prospectContext.phone}
- Call Duration: ${prospectContext.durationSec}s
- Direction: ${prospectContext.direction}
- Recorded Outcome: ${prospectContext.outcome}

OFFICIAL SALES SCRIPT & OBJECTION BATTLLECARDS:
${activeScript}

YOUR OBJECTIVES:
1. Listen closely to the exact audio recording: rep and prospect spoken words, vocal tone, speed, pauses, interruptions, hesitation, and closing attempts.
2. Evaluate adherence to the provided sales script:
   - Provide an exact "Script Adherence Score" from 0% to 100%.
   - Identify precise timestamps where the rep followed the script vs. diverted or missed key hooks/qualifications.
3. Highlight:
   - **What Went Good**: Specific positive moments, strong tonality, rapport, active listening.
   - **What Went Wrong / Missed Opportunities**: Premature pitching, weak objection handling, rushing, filler words.
4. Deliver actionable coaching: Give the exact words/lines the rep should have said instead.
5. Format your output clearly in clean, beautiful GitHub markdown with bold headers, bullet points, and timestamp markers (e.g. \`[0:24]\`).`;

  // Build conversational turns for Gemini ensuring strict role alternation (user <-> model)
  const existingMessages = (activeChat.messages || []).filter((m) => m.id !== userMsgRecord.id);
  const contents = [];

  // Turn 1 always contains the audio and the initial context
  const turn1Parts = [
    {
      inlineData: {
        mimeType,
        data: base64Audio,
      },
    },
    {
      text: `[SYSTEM CONTEXT & SCRIPT]\n${systemInstruction}\n\n[USER INSTRUCTION]\n${existingMessages.length > 0 ? existingMessages[0].content : message}`,
    },
  ];

  contents.push({ role: 'user', parts: turn1Parts });

  if (existingMessages.length > 0) {
    // Collect turns and collapse consecutive same-role messages so Gemini never returns 400
    for (let i = 1; i < existingMessages.length; i++) {
      const m = existingMessages[i];
      const role = m.role === 'assistant' ? 'model' : 'user';
      const lastTurn = contents[contents.length - 1];

      if (lastTurn && lastTurn.role === role) {
        lastTurn.parts.push({ text: m.content });
      } else {
        contents.push({
          role,
          parts: [{ text: m.content }],
        });
      }
    }

    // Append the current user turn
    const lastTurn = contents[contents.length - 1];
    if (lastTurn && lastTurn.role === 'user') {
      lastTurn.parts.push({ text: message });
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: message }],
      });
    }
  }

  // 7. Execute call to Google Gemini
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;
  const body = {
    contents,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2500,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': activeKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000), // audio analysis can take 10-25s
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Google Gemini returned status ${res.status}: ${errText.slice(0, 240)}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('Empty response from Google Gemini');

    // Extract an estimated adherence score if mentioned
    let adherenceScore = null;
    const scoreMatch = rawText.match(/(?:adherence|score)[^\d]*(\d{1,3})\s*%/i) || rawText.match(/(\d{1,3})\s*%\s*(?:adherence|on-script)/i);
    if (scoreMatch) {
      const parsed = parseInt(scoreMatch[1], 10);
      if (parsed >= 0 && parsed <= 100) adherenceScore = parsed;
    }

    const meta = {
      model: activeModel,
      quickAction,
      adherenceScore,
    };

    // Save assistant message in DB
    const assistantMsg = chatRepo.createMessage(activeChat.id, {
      role: 'assistant',
      content: rawText,
      meta,
    });

    return {
      success: true,
      chatId: activeChat.id,
      message: assistantMsg,
      meta,
    };
  } catch (err) {
    return {
      success: false,
      chatId: activeChat.id,
      error: err.message,
    };
  }
}

module.exports = {
  processCoachingTurn,
  safeAudioPath,
};
