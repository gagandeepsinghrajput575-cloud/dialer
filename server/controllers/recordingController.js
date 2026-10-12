const fs = require('fs');
const path = require('path');
const recordingRepo = require('../repositories/recordingRepo');
const calls = require('../repositories/callRepo');
const prospects = require('../repositories/prospectRepo');
const chatRepo = require('../repositories/recordingChatRepo');
const aiRecordingCoach = require('../services/aiRecordingCoach');
const settings = require('../repositories/settingsRepo');
const { DEFAULT_SALES_SCRIPT } = require('../config/defaults');
const { recordingsDir } = require('../config/env');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

// Safe path resolver strictly contained within recordingsDir
function safeAudioPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const base = path.basename(filename);
  const resolved = path.join(recordingsDir, base);
  if (!resolved.startsWith(recordingsDir)) return null;
  return resolved;
}

const list = asyncHandler(async (req, res) => {
  const { search, outcome, direction, limit = 50, offset = 0 } = req.query || {};
  const rows = recordingRepo.list({
    search,
    outcome,
    direction,
    limit: Number(limit) || 50,
    offset: Number(offset) || 0,
  });
  const total = recordingRepo.count({ search, outcome, direction });

  const formatted = rows.map((r) => ({
    ...r,
    audio_url: `/api/recordings/${r.call_id}/audio`,
  }));

  res.json({ recordings: formatted, total });
});

const audio = asyncHandler(async (req, res) => {
  const callId = Number(req.params.callId);
  if (!Number.isInteger(callId) || callId <= 0) {
    throw ApiError.badRequest('Invalid call ID');
  }

  const rec = recordingRepo.getByCallId(callId);
  if (!rec) {
    throw ApiError.notFound('Recording not found');
  }

  const filePath = safeAudioPath(rec.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    throw ApiError.notFound('Audio file missing from local storage');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = rec.mime_type || 'audio/webm';
  const range = req.headers.range;

  if (range) {
    // Parse Range: bytes=start-end
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || start >= fileSize || (parts[1] && end >= fileSize) || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const chunksize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

const upload = asyncHandler(async (req, res) => {
  const callId = Number(req.params.callId);
  if (!Number.isInteger(callId) || callId <= 0) {
    throw ApiError.badRequest('Invalid call ID');
  }

  const call = calls.get(callId);
  if (!call) {
    throw ApiError.notFound('Call not found');
  }

  const buffer = req.file?.buffer;
  if (!buffer || buffer.length === 0) {
    throw ApiError.badRequest('No audio data uploaded');
  }

  const ext = req.file.mimetype === 'audio/wav' ? 'wav' : 'webm';
  const filename = `call-${callId}.${ext}`;
  const targetPath = safeAudioPath(filename);
  if (!targetPath) {
    throw ApiError.badRequest('Invalid target audio filename');
  }

  fs.writeFileSync(targetPath, buffer);

  const durationSec = Number(req.body?.duration_sec) || call.duration_sec || 0;
  const sizeBytes = buffer.length;
  const mimeType = req.file.mimetype || 'audio/webm';

  const saved = recordingRepo.insert({
    callId,
    prospectId: call.prospect_id,
    filename,
    durationSec,
    sizeBytes,
    mimeType,
  });

  res.json({
    ok: true,
    recording: {
      ...saved,
      audio_url: `/api/recordings/${callId}/audio`,
    },
  });
});

const remove = asyncHandler(async (req, res) => {
  const callId = Number(req.params.callId);
  if (!Number.isInteger(callId) || callId <= 0) {
    throw ApiError.badRequest('Invalid call ID');
  }

  const rec = recordingRepo.getByCallId(callId);
  if (rec) {
    const filePath = safeAudioPath(rec.filename);
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    recordingRepo.remove(callId);
  }

  res.json({ ok: true, callId });
});

// Creates a synthetic demo tone audio file for testing or initial demo view
function createSyntheticToneWav(durationSeconds = 3, freq = 440) {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const buffer = Buffer.alloc(44 + numSamples);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 1 channel
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34); // 8-bit
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples, 40);

  // Simple sine wave
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(128 + 90 * Math.sin(2 * Math.PI * freq * t));
    buffer.writeUInt8(sample, 44 + i);
  }
  return buffer;
}

const demo = asyncHandler(async (req, res) => {
  // If demo calls exist, attach demo recordings so user can immediately hear playback
  const existingCalls = calls.all().filter((c) => c.status !== 'failed');
  let createdCount = 0;

  for (const c of existingCalls.slice(0, 5)) {
    if (!recordingRepo.getByCallId(c.id)) {
      const filename = `call-${c.id}-demo.wav`;
      const targetPath = safeAudioPath(filename);
      if (targetPath) {
        const audioBuf = createSyntheticToneWav(Math.min(5, Math.max(2, c.duration_sec || 3)), 440 + (c.id * 30));
        fs.writeFileSync(targetPath, audioBuf);
        recordingRepo.insert({
          callId: c.id,
          prospectId: c.prospect_id,
          filename,
          durationSec: c.duration_sec || 5,
          sizeBytes: audioBuf.length,
          mimeType: 'audio/wav',
        });
        createdCount++;
      }
    }
  }

  res.json({ ok: true, created: createdCount });
});

const listChats = asyncHandler(async (req, res) => {
  const callId = Number(req.params.callId);
  if (!Number.isInteger(callId) || callId <= 0) throw ApiError.badRequest('Invalid call ID');
  const chats = chatRepo.listChats(callId);
  res.json({ chats });
});

const createChat = asyncHandler(async (req, res) => {
  const callId = Number(req.params.callId);
  if (!Number.isInteger(callId) || callId <= 0) throw ApiError.badRequest('Invalid call ID');
  const { title } = req.body || {};
  const chat = chatRepo.createChat(callId, title);
  res.status(201).json({ chat });
});

const getChat = asyncHandler(async (req, res) => {
  const chatId = Number(req.params.chatId);
  if (!Number.isInteger(chatId) || chatId <= 0) throw ApiError.badRequest('Invalid chat ID');
  const chat = chatRepo.getChat(chatId);
  if (!chat) throw ApiError.notFound('Chat session not found');
  res.json({ chat });
});

const deleteChat = asyncHandler(async (req, res) => {
  const chatId = Number(req.params.chatId);
  if (!Number.isInteger(chatId) || chatId <= 0) throw ApiError.badRequest('Invalid chat ID');
  const deleted = chatRepo.deleteChat(chatId);
  res.json({ ok: true, deleted });
});

const aiChat = asyncHandler(async (req, res) => {
  const callId = Number(req.params.callId);
  if (!Number.isInteger(callId) || callId <= 0) throw ApiError.badRequest('Invalid call ID');
  const { chatId, message, script, quickAction, apiKey, model } = req.body || {};

  const result = await aiRecordingCoach.processCoachingTurn({
    callId,
    chatId,
    message,
    script,
    quickAction,
    apiKey,
    model,
  });

  res.json(result);
});

const getScript = asyncHandler(async (req, res) => {
  const script = settings.get('sales_script') || DEFAULT_SALES_SCRIPT;
  res.json({ script });
});

const updateScript = asyncHandler(async (req, res) => {
  const { script } = req.body || {};
  if (typeof script !== 'string') throw ApiError.badRequest('Script must be a string');
  settings.set('sales_script', script);
  res.json({ ok: true, script });
});

module.exports = {
  list,
  audio,
  upload,
  remove,
  demo,
  listChats,
  createChat,
  getChat,
  deleteChat,
  aiChat,
  getScript,
  updateScript,
};
