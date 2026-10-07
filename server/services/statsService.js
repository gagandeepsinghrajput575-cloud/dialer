// Funnel + 7-day analytics. Pure reads over the repositories.
const calls = require('../repositories/callRepo');
const prospects = require('../repositories/prospectRepo');
const settings = require('../repositories/settingsRepo');
const { statsFilter, getStartOfDay, sqlTime } = require('./callService');
const { PICKUP, CONVO, STAGES } = require('../config/defaults');

function summarize(rows) {
  const s = { dials: rows.length, pickups: 0, conversations: 0, meetings: 0, voicemails: 0, vmDrops: 0, talkSec: 0 };
  for (const r of rows) {
    if (PICKUP.includes(r.outcome)) s.pickups++;
    if (CONVO.includes(r.outcome)) s.conversations++;
    if (r.outcome === 'meeting_booked') s.meetings++;
    if (r.outcome === 'voicemail') s.voicemails++;
    if (r.vm_dropped) s.vmDrops++;
    if (CONVO.includes(r.outcome)) s.talkSec += r.duration_sec || 0;
  }
  s.pickupRate = s.dials ? s.pickups / s.dials : 0;
  s.conversationRate = s.pickups ? s.conversations / s.pickups : 0;
  s.meetingRate = s.conversations ? s.meetings / s.conversations : 0;
  s.avgTalkSec = s.conversations ? Math.round(s.talkSec / s.conversations) : 0;
  return s;
}

function stats({ tzOffset = null } = {}) {
  const filter = statsFilter();
  const since7 = sqlTime(getStartOfDay(-6, tzOffset));
  const rows = calls.since(since7, filter);

  const byDay = {};
  for (let i = 6; i >= 0; i--) byDay[getStartOfDay(-i, tzOffset).toISOString().slice(0, 10)] = [];
  const todayStart = getStartOfDay(0, tzOffset).getTime();
  const todayRows = [];

  for (const r of rows) {
    const t = new Date(String(r.started_at).replace(' ', 'T') + 'Z').getTime();
    for (let i = 6; i >= 0; i--) {
      const start = getStartOfDay(-i, tzOffset).getTime();
      if (t >= start && t < start + 86400000) { byDay[getStartOfDay(-i, tzOffset).toISOString().slice(0, 10)].push(r); break; }
    }
    if (t >= todayStart) todayRows.push(r);
  }

  const week = Object.entries(byDay).map(([date, dayRows]) => ({ date: `${date}T00:00:00.000Z`, ...summarize(dayRows) }));

  return {
    today: summarize(todayRows),
    week,
    goal: settings.getInt('daily_goal'),
    cap: settings.getInt('daily_cap'),
    stageCounts: prospects.stageCounts(),
    total: prospects.count(),
    dncCount: prospects.dncCount(),
    recent: calls.recent(8, filter.replace('dry_run', 'c.dry_run')),
    stages: STAGES,
  };
}

module.exports = { stats, summarize };
