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

const pad2 = (n) => String(n).padStart(2, '0');

// The label on a day bucket has to be the *client's* calendar date. Deriving it from the UTC
// instant of local midnight captioned every bar one day early for anyone east of Greenwich —
// a Danish agent (UTC+1/+2) saw today's bar labelled with yesterday's date. The bucket
// boundaries were always right; only the label lied.
function dayLabel(offsetDays, tzOffsetMin) {
  const start = getStartOfDay(offsetDays, tzOffsetMin);
  if (tzOffsetMin !== null && Number.isFinite(tzOffsetMin)) {
    // Shift the instant onto the client's wall clock and read the date off in UTC.
    const wall = new Date(start.getTime() - tzOffsetMin * 60000);
    return `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
  }
  return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
}

function stats({ tzOffset = null } = {}) {
  const filter = statsFilter();
  const since7 = sqlTime(getStartOfDay(-6, tzOffset));
  const rows = calls.since(since7, filter);
  // The recent list joins `calls c`, so it needs the same filter spelled with that alias
  // rather than a string substitution on the unaliased fragment.
  const recentFilter = statsFilter('c.');

  const byDay = {};
  for (let i = 6; i >= 0; i--) byDay[dayLabel(-i, tzOffset)] = [];
  const todayStart = getStartOfDay(0, tzOffset).getTime();
  const todayRows = [];

  for (const r of rows) {
    const t = new Date(String(r.started_at).replace(' ', 'T') + 'Z').getTime();
    for (let i = 6; i >= 0; i--) {
      const start = getStartOfDay(-i, tzOffset).getTime();
      if (t >= start && t < start + 86400000) { byDay[dayLabel(-i, tzOffset)].push(r); break; }
    }
    if (t >= todayStart) todayRows.push(r);
  }

  // A plain calendar date, not a fabricated UTC midnight: the client renders it as a weekday
  // and re-parsing it into an instant is what would shift the caption again in the browser.
  const week = Object.entries(byDay).map(([date, dayRows]) => ({ date, ...summarize(dayRows) }));

  return {
    today: summarize(todayRows),
    week,
    goal: settings.getInt('daily_goal'),
    cap: settings.getInt('daily_cap'),
    stageCounts: prospects.stageCounts(),
    total: prospects.count(),
    dncCount: prospects.dncCount(),
    recent: calls.recent(8, recentFilter),
    stages: STAGES,
  };
}

module.exports = { stats, summarize };
