const settings = require('../repositories/settingsRepo');
const telephony = require('../services/telephonyService');
const emailService = require('../services/emailService');
const backup = require('../db/backup');
const path = require('path');
const { backupDir } = require('../config/env');
const { ApiError } = require('../middleware/errorHandler');
const { SETTING_KEYS, SECRET_KEYS } = require('../config/defaults');
const { asyncHandler } = require('../middleware/errorHandler');

const get = asyncHandler(async (req, res) => res.json(settings.publicView()));

const put = asyncHandler(async (req, res) => {
  // The SMTP transport is pooled and cached, so editing the credentials has to tear it down
  // or a corrected password would never be tried until the next restart.
  let smtpTouched = false;
  for (const key of SETTING_KEYS) {
    if (!(key in req.body)) continue;
    // A blank secret means "keep what is already stored".
    if (SECRET_KEYS[key] && !String(req.body[key] ?? '').trim()) continue;
    if (key.startsWith('smtp_')) smtpTouched = true;
    settings.set(key, typeof req.body[key] === 'boolean' ? (req.body[key] ? '1' : '0') : req.body[key]);
  }
  if (smtpTouched) emailService.invalidateTransport();
  res.json({ ok: true, settings: settings.publicView(), sampleDialUri: telephony.sampleDialUri() });
});

// Protocol verification: nothing leaves the machine, the browser dispatches the returned URI.
// In webrtc mode there is no OS dispatch at all — the browser opens the session itself — so
// the response describes a WebRTC session instead of claiming a softphone will launch. It used
// to answer `configured: true` unconditionally for webrtc, which told the agent everything was
// ready when nothing had been set up.
const testSoftphone = asyncHandler(async (req, res) => {
  const proto = telephony.protocol();
  const mode = telephony.mode();
  const sample = telephony.normalizePhone(req.body?.number || '20123456');

  if (mode === 'webrtc') {
    const session = telephony.webrtcSession();
    return res.json({
      ok: true,
      configured: session.canRegister,
      protocol: 'webrtc',
      telephonyMode: mode,
      sampleNumber: sample,
      dialUri: telephony.buildWebRtcUri(sample),
      dialUriFull: telephony.buildWebRtcUri(sample),
      inBrowser: true,
      callerId: session.callerId,
      callerIdPool: telephony.callerIdPool(),
      sipServer: session.server,
      wsUrl: session.wsUrl,
      needsCredentialHandoff: session.configured && !session.credentialHandoff,
      webrtc: session,
      message: session.canRegister
        ? `Ready — the browser will dial ${sample} over ${session.wsUrl}.`
        : session.configured
          ? 'The SIP account is saved, but credential handoff is off, so the browser cannot register. Turn it on in Settings → Telephony.'
          : `The in-browser softphone is missing: ${session.missing.join(', ')}. Add it in Settings → Telephony.`,
    });
  }

  const dialUri = telephony.buildDialUri(sample, proto);
  const configured = telephony.sipConfigured();
  return res.json({
    ok: true,
    configured,
    protocol: proto,
    telephonyMode: mode,
    sampleNumber: sample,
    dialUri,
    dialUriFull: telephony.buildDialUriFull(sample),
    inBrowser: false,
    callerId: settings.get('caller_id') || '',
    callerIdPool: telephony.callerIdPool(),
    sipServer: settings.get('voipso_sip_server') || '',
    message: configured
      ? `Launching ${dialUri} — your softphone should place this test call now.`
      : `${dialUri} is ready to launch, but no VOIP.SO SIP account is saved yet. Register it in Zoiper (and here) first.`,
  });
});

const listBackups = asyncHandler(async (req, res) => res.json({ backups: backup.list() }));
const createBackup = asyncHandler(async (req, res) => res.json(await backup.create(String(req.body?.reason || 'manual'))));

// Download a snapshot so the whole database can live somewhere other than this machine.
// The name is matched against the directory listing instead of being trusted, so a crafted
// path can never escape data/backups.
const downloadBackup = asyncHandler(async (req, res) => {
  const wanted = String(req.params.file || '');
  const match = backup.list().find((b) => b.file === wanted);
  if (!match) throw ApiError.notFound('No snapshot with that name');
  const full = path.join(backupDir, match.file);
  if (!full.startsWith(path.resolve(backupDir) + path.sep)) throw ApiError.badRequest('Bad snapshot name');
  res.setHeader('Content-Type', 'application/x-sqlite3');
  res.setHeader('Content-Disposition', `attachment; filename="${match.file}"`);
  res.setHeader('Content-Length', String(match.bytes));
  res.sendFile(full);
});

module.exports = { get, put, testSoftphone, listBackups, createBackup, downloadBackup };
