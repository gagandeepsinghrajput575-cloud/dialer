// Softphone support endpoints: the Danish calling window, caller-ID pool and the
// voicemail-drop greeting (metadata, upload and playback).
const fs = require('fs');
const path = require('path');
const settings = require('../repositories/settingsRepo');
const telephony = require('../services/telephonyService');
const followUpService = require('../services/followUpService');
const { audioDir } = require('../config/env');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const businessHours = asyncHandler(async (req, res) => res.json(telephony.businessHours()));

const callerIds = asyncHandler(async (req, res) => res.json({
  pool: telephony.callerIdPool(),
  primary: settings.get('caller_id') || '',
  nextIndex: (() => { const pool = telephony.callerIdPool(); const c = parseInt(settings.get('caller_id_cursor'), 10) || 0; return pool.length ? c % pool.length : 0; })(),
}));

const greetingMeta = asyncHandler(async (req, res) => res.json(telephony.voicemailGreeting()));

// POST /api/telephony/voicemail-greeting  (multipart field: file)
const uploadGreeting = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach an audio file (field name: file)');
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (!['.mp3', '.wav', '.m4a', '.ogg'].includes(ext)) {
    throw ApiError.badRequest('Use an .mp3, .wav, .m4a or .ogg recording');
  }
  const file = `vm_danish${ext}`;
  fs.writeFileSync(path.join(audioDir, file), req.file.buffer);
  settings.set('vm_greeting', file);
  res.json({ ok: true, ...telephony.voicemailGreeting() });
});

const greetingFile = asyncHandler(async (req, res) => {
  const info = telephony.voicemailGreeting();
  const file = path.join(audioDir, info.file);
  if (!info.exists) throw ApiError.notFound(`No greeting recorded yet — save one as ${info.expectedPath}`);
  res.setHeader('Content-Type', info.file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
  res.sendFile(file);
});

const followUpEmail = asyncHandler(async (req, res) => {
  res.json(followUpService.renderEmail(req.params.id, { noteText: req.body?.noteText, at: req.body?.at }));
});

const scheduleFollowUp = asyncHandler(async (req, res) => {
  res.json({ ok: true, prospect: followUpService.schedule(req.params.id, req.body.at) });
});

module.exports = { businessHours, callerIds, greetingMeta, uploadGreeting, greetingFile, followUpEmail, scheduleFollowUp };
