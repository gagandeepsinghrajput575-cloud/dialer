// Softphone support endpoints: the Danish calling window, caller-ID pool and the
// voicemail-drop greeting (metadata, upload and playback).
const fs = require('fs');
const path = require('path');
const settings = require('../repositories/settingsRepo');
const telephony = require('../services/telephonyService');
const followUpService = require('../services/followUpService');
const desktopBridge = require('../services/desktopBridgeService');
const { audioDir } = require('../config/env');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const businessHours = asyncHandler(async (req, res) => res.json(telephony.businessHours()));

// GET /api/telephony/webrtc-session
// Everything the in-browser softphone needs to register and dial. Guarded by the origin
// allowlist (middleware/guard) and by an explicit session-token check on the route, because
// this response is the only place a SIP credential can leave the process — and only when the
// agent has turned the handoff on. See telephonyService.webrtcSession for that reasoning.
const webrtcSession = asyncHandler(async (req, res) => res.json(telephony.webrtcSession()));
const desktop = asyncHandler(async (req, res) => res.json(desktopBridge.descriptor()));

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

// GET /api/telephony/flynumber
const flynumber = asyncHandler(async (req, res) => res.json(telephony.flynumberConfig()));

// POST /api/telephony/flynumber
const updateFlynumber = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (body.flynumber_status !== undefined) {
    const s = String(body.flynumber_status).toLowerCase();
    if (!['pending', 'active'].includes(s)) throw ApiError.badRequest('Status must be "pending" or "active"');
    settings.set('flynumber_status', s);
  }
  if (body.flynumber_did !== undefined) {
    const cleanDid = telephony.normalizePhone(body.flynumber_did);
    if (!cleanDid) throw ApiError.badRequest('Invalid Copenhagen DID phone number');
    settings.set('flynumber_did', cleanDid);
  }
  if (body.flynumber_sip_server !== undefined) {
    settings.set('flynumber_sip_server', String(body.flynumber_sip_server).trim());
  }
  if (body.flynumber_sip_user !== undefined) {
    settings.set('flynumber_sip_user', String(body.flynumber_sip_user).trim());
  }
  if (body.flynumber_sip_password) {
    settings.set('flynumber_sip_password', String(body.flynumber_sip_password).trim());
  }
  if (body.flynumber_linphone_configured !== undefined) {
    settings.set('flynumber_linphone_configured', body.flynumber_linphone_configured ? '1' : '0');
  }
  if (body.telnyx_caller_id_verified !== undefined) {
    const verified = body.telnyx_caller_id_verified ? '1' : '0';
    settings.set('telnyx_caller_id_verified', verified);
    if (verified === '1') {
      const did = telephony.normalizePhone(settings.get('flynumber_did') || '+4532331610');
      if (!settings.get('caller_id') || body.set_as_caller_id) {
        settings.set('caller_id', did);
      }
    }
  }
  if (body.inbound_routing_mode !== undefined) {
    settings.set('inbound_routing_mode', String(body.inbound_routing_mode));
  }
  res.json({ ok: true, config: telephony.flynumberConfig() });
});

module.exports = {
  businessHours, webrtcSession, desktop, callerIds, greetingMeta, uploadGreeting,
  greetingFile, followUpEmail, scheduleFollowUp, flynumber, updateFlynumber
};
