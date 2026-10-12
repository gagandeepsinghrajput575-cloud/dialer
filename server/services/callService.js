// Call lifecycle: direct softphone dialing, outcome classification, voicemail drops,
// discards and the daily-dial safety rails.
const calls = require('../repositories/callRepo');
const prospects = require('../repositories/prospectRepo');
const notes = require('../repositories/noteRepo');
const settings = require('../repositories/settingsRepo');
const telephony = require('./telephonyService');
const prospectService = require('./prospectService');
const { ApiError } = require('../middleware/errorHandler');
const { OUTCOMES } = require('../config/defaults');
const { db } = require('../db');

// While in test mode show test calls; once live, exclude them from analytics.
//
// A call that never left 'ringing' is not a dial: the phone rang and the agent missed it (or
// declined it). Counting those would inflate the dial count every time somebody dials the
// wrong extension, and the funnel is the one number an outbound team trusts.
const statsFilter = (alias = '') => {
  const parts = [];
  if (!settings.getBool('dry_run')) parts.push(`${alias}dry_run = 0`);
  parts.push(`NOT (${alias}direction = 'inbound' AND ${alias}status IN ('ringing', 'missed', 'declined'))`);
  return `AND ${parts.join(' AND ')}`;
};
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const sqlNow = () => sqlTime(new Date());

function getStartOfDay(offsetDays = 0, tzOffsetMin = null) {
  if (tzOffsetMin !== null && Number.isFinite(tzOffsetMin)) {
    const clientLocal = new Date(Date.now() - tzOffsetMin * 60000);
    clientLocal.setUTCDate(clientLocal.getUTCDate() + offsetDays);
    clientLocal.setUTCHours(0, 0, 0, 0);
    return new Date(clientLocal.getTime() + tzOffsetMin * 60000);
  }
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

const todaysDials = (tzOffset = null) => calls.countSince(sqlTime(getStartOfDay(0, tzOffset)), statsFilter());

// Direct outbound dialing: log the call, rotate the caller ID, and hand back the dial URI the
// browser dispatches to the desktop softphone. No callback bridge, no second leg to wait for.
function start(prospectId, { tzOffset = null } = {}) {
  const p = prospects.get(prospectId);
  if (!p) throw ApiError.notFound('Prospect not found');
  if (p.dnc) throw ApiError.forbidden('This prospect is marked Do Not Call.');
  if (!p.phone) throw ApiError.badRequest('This prospect has no phone number.');

  const cap = settings.getInt('daily_cap');
  if (cap && todaysDials(tzOffset) >= cap) {
    throw ApiError.tooMany(`Daily dial cap reached (${cap}). Raise it in Settings if you want to continue.`);
  }

  const dry = settings.getBool('dry_run');
  const proto = telephony.protocol();
  const callMode = telephony.mode();
  const webrtc = callMode === 'webrtc';
  // A browser call is addressed to the SIP server over the WebSocket gateway; a softphone
  // call is an OS protocol URI. Keeping them distinct means the client can tell, from the
  // response alone, that it must open an in-browser session instead of handing the URI to
  // the operating system.
  const dialUri = webrtc ? telephony.buildWebRtcUri(p.phone) : telephony.buildDialUri(p.phone, proto);
  const { callerId, poolSize, index } = telephony.nextCallerId();

  // One atomic unit: either the call row and the prospect's dial counter both land, or
  // neither does. Previously a failure in markCalled left an orphan call row behind and
  // then inserted a second "failed" row for the same dial.
  let call;
  try {
    call = db.transaction(() => {
      const row = calls.insert({
        prospect_id: p.id,
        status: dry ? 'dry_run' : 'placed',
        dry_run: dry,
        dial_uri: dialUri,
        caller_id: callerId || null,
      });
      prospects.markCalled(p.id);
      return row;
    })();
  } catch (e) {
    let failed = null;
    try {
      failed = calls.insert({ prospect_id: p.id, status: 'failed', dry_run: dry, dial_uri: dialUri, caller_id: callerId || null });
      calls.patch(failed.id, { error: String(e.message || e) });
    } catch { /* the failure record is best-effort; the real error still surfaces below */ }
    throw new ApiError(500, String(e.message || e), failed ? { callId: failed.id } : undefined);
  }

  const readiness = webrtc ? telephony.webrtcReadiness() : null;

  return {
    callId: call.id,
    dryRun: dry,
    dialUri,
    dialUriFull: webrtc ? dialUri : telephony.buildDialUriFull(p.phone),
    protocol: webrtc ? 'webrtc' : proto,
    telephonyMode: callMode,
    // The client branches on this: true means "open an in-browser session", false means
    // "hand the URI to the OS softphone".
    inBrowser: webrtc,
    webrtc: webrtc ? { wsUrl: readiness.wsUrl, server: readiness.server, configured: readiness.configured } : null,
    phone: p.phone,
    callerId,
    callerIdPoolSize: poolSize,
    callerIdIndex: index,
    businessHours: telephony.businessHours(),
    // Danish 70/90 ranges cost real money and 80 is a service line — the dialer shows this
    // before the softphone is handed the number, not after the bill arrives.
    numberKind: telephony.numberKind(p.phone),
    voicemail: telephony.voicemailGreeting(),
    warning: webrtc
      ? (readiness.configured ? null
        : `The in-browser softphone is missing: ${readiness.missing.join(', ')}. Add it in Settings → Telephony.`)
      : (!dry && !telephony.sipConfigured()
        ? 'The Telnyx SIP account is not saved in Settings yet. Make sure Zoiper is registered before dialing.'
        : null),
  };
}

// ---- inbound calls -------------------------------------------------------------------------
// The browser softphone is registered and listening; the provider delivers an INVITE and the
// client tells us who is calling. Two things have to happen, atomically: resolve the person,
// and put a row in the ledger that still makes sense if the tab dies mid-ring.
//
// A withheld or unparseable caller ID is refused rather than stored as junk — an inbound log
// full of "Unknown" rows is worse than an honest gap, and the UI keeps ringing either way.
function inboundCallerId(raw) {
  const s = telephony.cleanStr(raw);
  if (!s) return '';
  const normalized = telephony.normalizePhone(s);
  if (normalized) return normalized;
  // A SIP address is a legitimate caller identity even though it has no digits.
  return /^(sip|tel):/i.test(s) || s.includes('@') ? s : '';
}

// Only ever true for a placeholder row this app created when a stranger rang. It is not a
// real lead: it exists so the agent can see who is calling, and may be deleted again.
const isProvisionalLead = (p) => !!(p && p.extra && p.extra.provisional);

function startInbound({ callerPhone = '', prospectId = null } = {}) {
  const callerId = inboundCallerId(callerPhone);
  if (!callerId) throw ApiError.badRequest('A caller number is required to log an inbound call.');

  // The same ring can be delivered twice (a forked INVITE, a retry after a dropped socket).
  // An unanswered inbound row for this caller inside the window *is* that ring.
  const open = calls.findOpenInbound(callerId);
  if (open) {
    const existing = prospects.get(open.prospect_id);
    return {
      ok: true, reused: true, callId: open.id, call: open, direction: 'inbound', callerId,
      matched: !!existing && !isProvisionalLead(existing),
      provisional: isProvisionalLead(existing),
      prospect: existing ? prospectService.detail(existing.id) : null,
    };
  }

  const dry = settings.getBool('dry_run');
  const resolved = db.transaction(() => {
    let p = null;
    let matched = false;
    let provisional = false;
    if (prospectId) {
      p = prospects.get(prospectId);
      if (!p) throw ApiError.notFound('Prospect not found');
      matched = true;
    } else {
      p = prospects.findByPhone(callerId);
      matched = !!p;
    }
    // Nobody on file: a placeholder lead, so the modal can show a real number and answering
    // can become a real prospect in one click instead of the agent retyping the number.
    if (!p) {
      p = prospects.insert({ name: callerId, phone: callerId, stage: 'new', extra: { inbound: true, provisional: true } });
      provisional = true;
    }
    return { call: calls.createInbound({ prospectId: p.id, callerId, status: 'ringing', dryRun: dry }), prospectId: p.id, matched, provisional };
  })();

  return {
    ok: true, reused: false,
    callId: resolved.call.id, call: resolved.call, direction: 'inbound', callerId,
    matched: resolved.matched, provisional: resolved.provisional,
    prospect: prospectService.detail(resolved.prospectId),
  };
}

// Terminal state for a ring that was never picked up: the prospect hung up (CANCEL), or the
// agent pressed Decline. Idempotent, because a CANCEL and a declined button can race.
function markInboundMissed(callId, { reason = 'missed', duration_sec = 0 } = {}) {
  const id = Number(callId);
  const call = Number.isInteger(id) && id > 0 ? calls.get(id) : null;
  if (!call) {
    // A ring that was already swept has no row left to close — its placeholder lead and this
    // ledger row went together. A far-end CANCEL and a Decline click can both land, so the
    // replay has to read as "nothing left to do" instead of erroring a UI that is already
    // tearing the call down. A bad id is still a 404.
    if (Number.isInteger(id) && id > 0) return { ok: true, alreadyResolved: true, cleanedUp: true, call: null, missing: true };
    throw ApiError.notFound('Call not found');
  }
  if (call.direction !== 'inbound') throw ApiError.badRequest('Only an inbound call can be missed.');
  if (call.status !== 'ringing') return { ok: true, alreadyResolved: true, cleanedUp: false, call };

  const lead = prospects.get(call.prospect_id);
  // Sweeping a placeholder lead is only safe while it is still *only* a placeholder: this
  // ring, and nothing else. One note or one earlier call and it is somebody's real record,
  // which must survive a missed call years later.
  const history = calls.listByProspect(call.prospect_id, 5);
  const hasNotes = lead ? notes.listByProspect(call.prospect_id).length > 0 : false;
  const cleanedUp = isProvisionalLead(lead) && history.length === 1 && !hasNotes;

  const status = reason === 'declined' ? 'declined' : 'missed';
  const updated = db.transaction(() => {
    const row = calls.patch(call.id, { status, ended_at: sqlNow(), duration_sec: Math.max(0, Math.round(duration_sec || 0)) });
    if (cleanedUp) prospects.remove(call.prospect_id);
    return row;
  })();

  return { ok: true, alreadyResolved: false, cleanedUp, status, call: updated };
}

const OUTCOME_LABEL = {
  no_answer: 'no answer', voicemail: 'voicemail', wrong_number: 'wrong number', gatekeeper: 'gatekeeper',
  hung_up: 'hung up', conversation: 'conversation', meeting_booked: 'meeting booked', dnc: 'do not call',
};

// Stage machine + follow-up scheduling.
function applyOutcomeStage(p, outcome, followUpAt) {
  let stage = p.stage;
  let dnc = p.dnc;
  const PICKUP = ['gatekeeper', 'hung_up', 'conversation', 'meeting_booked'];
  if (PICKUP.includes(outcome) && stage === 'new') stage = 'contacted';
  if (outcome === 'meeting_booked') stage = 'meeting';
  if (outcome === 'wrong_number') stage = 'lost';
  if (outcome === 'dnc') { dnc = 1; stage = 'lost'; }
  if (followUpAt && !['meeting', 'won', 'lost'].includes(stage)) stage = 'followup';
  return { stage, dnc: dnc ? 1 : 0 };
}

function classify(callId, input = {}) {
  const call = calls.get(callId);
  if (!call) throw ApiError.notFound('Call not found');

  const outcome = input.outcome || null;
  if (outcome && !OUTCOMES.includes(outcome)) throw ApiError.badRequest('Bad outcome');

  const fields = { ended_at: sqlNow() };
  if (outcome) fields.outcome = outcome;
  if (Number.isFinite(input.duration_sec)) fields.duration_sec = Math.round(input.duration_sec);
  if (input.vm_dropped !== undefined) fields.vm_dropped = input.vm_dropped ? 1 : 0;
  if (input.summary !== undefined) fields.summary = String(input.summary || '').slice(0, 4000);
  if (input.next_step !== undefined) fields.next_step = String(input.next_step || '').slice(0, 1000);
  if (input.follow_up_at !== undefined) fields.follow_up_at = input.follow_up_at || null;
  const updated = calls.patch(callId, fields);

  let prospect = prospects.get(call.prospect_id);
  if (outcome && prospect) {
    const { stage, dnc } = applyOutcomeStage(prospect, outcome, input.follow_up_at || null);
    const patch = { last_outcome: outcome, stage, dnc };
    if (input.follow_up_at !== undefined) patch.follow_up_at = input.follow_up_at || null;
    prospect = prospects.update(call.prospect_id, patch);
  }
  return { ok: true, prospect, call: updated };
}

// V — voicemail drop: log it, flag the drop, schedule the callback and let the UI advance.
function voicemailDrop(callId, input = {}) {
  const call = calls.get(callId);
  if (!call) throw ApiError.notFound('Call not found');

  const followUpAt = input.follow_up_at || suggestFollowUp('voicemail');
  const fields = { outcome: 'voicemail', vm_dropped: 1, ended_at: sqlNow(), follow_up_at: followUpAt };
  if (Number.isFinite(input.duration_sec)) fields.duration_sec = Math.round(input.duration_sec);
  if (input.summary) fields.summary = String(input.summary).slice(0, 4000);
  const updated = calls.patch(callId, fields);

  let prospect = prospects.get(call.prospect_id);
  if (prospect) {
    const { stage, dnc } = applyOutcomeStage(prospect, 'voicemail', followUpAt);
    prospect = prospects.update(call.prospect_id, { last_outcome: 'voicemail', stage, dnc, follow_up_at: followUpAt });
  }

  return {
    ok: true,
    call: updated,
    prospect,
    followUpAt,
    autoAdvance: settings.getBool('vm_auto_advance'),
    voicemail: telephony.voicemailGreeting(),
    message: `Voicemail drop logged for ${prospect ? prospect.name || prospect.phone : 'prospect'} — callback scheduled ${followUpAt}.`,
  };
}

function discard(callId) {
  const call = calls.get(callId);
  if (call) {
    calls.remove(call.id);
    prospects.unmarkCalled(call.prospect_id);
  }
  return { ok: true };
}

const remove = discard; // DELETE /api/calls/:id keeps the same behaviour

// Sensible callback windows per outcome (days out), used by the scheduler and the copilot.
const FOLLOW_UP_TIME = '09:30'; // booked in the business timezone
const FOLLOW_UP_DAYS = { no_answer: 1, voicemail: 3, gatekeeper: 2, hung_up: 4, conversation: 7, interested: 5 };
// Callbacks are booked for 09:30 in the *business* timezone (Denmark by default), not in
// whatever timezone the server happens to run in.
function suggestFollowUp(outcome, from = new Date()) {
  const days = FOLLOW_UP_DAYS[outcome] || 3;
  const tz = String(settings.get('business_tz') || 'Europe/Copenhagen');
  const date = telephony.zonedDate(days, tz, from);
  return sqlTime(telephony.zonedTimeToUtc(date, FOLLOW_UP_TIME, tz));
}

module.exports = {
  statsFilter, sqlTime, sqlNow, getStartOfDay, todaysDials,
  start, startInbound, markInboundMissed, inboundCallerId, isProvisionalLead,
  classify, voicemailDrop, discard, remove, suggestFollowUp, applyOutcomeStage,
  OUTCOME_LABEL, FOLLOW_UP_DAYS, FOLLOW_UP_TIME,
};
