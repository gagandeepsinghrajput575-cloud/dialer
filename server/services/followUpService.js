// Follow-up scheduling + the 1-click email the agent pastes into Gmail/Outlook.
const prospects = require('../repositories/prospectRepo');
const calls = require('../repositories/callRepo');
const notes = require('../repositories/noteRepo');
const settings = require('../repositories/settingsRepo');
const callService = require('./callService');
const telephony = require('./telephonyService');
const { ApiError } = require('../middleware/errorHandler');
const { parseSqlTime } = require('./format');

function renderEmail(prospectId, { noteText = '', at = null } = {}) {
  const prospect = prospects.get(prospectId);
  if (!prospect) throw ApiError.notFound('Prospect not found');
  const call = calls.lastByProspect(prospectId) || {};
  const template = settings.get('followup_email_template') || '';
  const note = String(noteText || '').trim() || notes.listByProspect(prospectId).slice(0, 1).map((n) => n.body).join('\n');

  const when = at || prospect.follow_up_at || callService.suggestFollowUp(call.outcome || 'conversation');
  const values = {
    name: (prospect.name || '').split(' ')[0] || 'der',
    full_name: prospect.name || '',
    company: prospect.company || '',
    title: prospect.title || '',
    email: prospect.email || '',
    phone: prospect.phone || '',
    notes: note || 'Som aftalt finder du det korte oplæg vedhæftet.',
    outcome: callService.OUTCOME_LABEL[call.outcome] || 'snakken',
    follow_up: String(when).slice(0, 16),
    agent: settings.get('agent_name') || '[dit navn]',
  };

  // Only real own properties are substituted — `{{constructor}}`/`{{toString}}` are left
  // alone instead of serializing a function into the email body.
  const body = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : m
  ));
  const subject = prospect.company
    ? `Opfølgning — ${prospect.company}`
    : `Opfølgning til ${values.name}`;
  return { to: prospect.email || '', subject, body, placeholders: Object.keys(values), followUpAt: when };
}

// Prospects whose follow-up is due now (or overdue), newest first.
function due({ tzOffset = null } = {}) {
  const nowIso = callService.sqlTime(new Date());
  return prospects.followUpsDue(nowIso).map((p) => {
    const at = parseSqlTime(p.follow_up_at);
    return {
      ...p,
      // Unparseable rows still come back (they are due by definition of the query),
      // but they report 0 instead of NaN, which would serialize as null.
      overdueHours: at ? Math.round((Date.now() - at.getTime()) / 3600000) : 0,
    };
  });
}

function schedule(prospectId, at) {
  const prospect = prospects.get(prospectId);
  if (!prospect) throw ApiError.notFound('Prospect not found');
  const iso = String(at || '').trim();
  if (!iso) throw ApiError.badRequest('follow_up_at is required');
  if (!parseSqlTime(iso)) throw ApiError.badRequest('follow_up_at must be a real date (YYYY-MM-DD HH:MM)');
  let stage = prospect.stage;
  if (!['meeting', 'won', 'lost'].includes(stage)) stage = 'followup';
  return prospects.update(prospectId, { follow_up_at: iso, stage });
}

module.exports = { renderEmail, due, schedule, suggest: callService.suggestFollowUp, businessHours: telephony.businessHours };
