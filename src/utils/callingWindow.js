// Danish B2B Calling Window Evaluator & Mid-Call Transition Guard (Challenge 6).
//
// Evaluates the Copenhagen business calling window (default 08:30–16:30 Europe/Copenhagen,
// Mon–Fri) down to exact second boundaries:
//   - Never terminates or interrupts an active conversation when the clock crosses 16:30:00.
//   - Emits a single non-intrusive wrap-up notice on the open -> closed boundary:
//       "Calling window closed for today (16:30). Wrap up active conversation."
//   - Disables automatic next-lead queuing (`allowAutoNext = false`) once closed.
//   - Inhibits new outbound calls (`allowOutboundDial = false`) after wrap-up until the window
//     re-opens at 08:30 on the next business day.

const fmtCache = new Map();

function getFormatter(tz) {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
}

export function evaluateCallingWindow(settings = {}, now = new Date()) {
  const tz = String(settings?.business_tz || 'Europe/Copenhagen');
  const start = String(settings?.business_hours_start || '08:30');
  const end = String(settings?.business_hours_end || '16:30');
  const parsedDays = String(settings?.business_days || '')
    .split(',')
    .map((d) => parseInt(d, 10))
    .filter((d) => d >= 1 && d <= 7);
  const days = parsedDays.length ? [...new Set(parsedDays)].sort((a, b) => a - b) : [1, 2, 3, 4, 5];

  const dateObj = now instanceof Date ? now : new Date(now);
  const parts = {};
  for (const p of getFormatter(tz).formatToParts(dateObj)) parts[p.type] = p.value;

  const hour = parseInt(parts.hour === '24' ? '0' : parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const second = parseInt(parts.second || '0', 10);
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const isoDay = dayIdx === 0 ? 7 : dayIdx;
  const mins = hour * 60 + minute + second / 60;
  const isBusinessDay = days.includes(isoDay);
  const open = isBusinessDay && mins >= toMinutes(start) && mins < toMinutes(end);

  return {
    open,
    tz,
    startsAt: start,
    endsAt: end,
    businessDays: days,
    isBusinessDay,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    notice: `Calling window closed for today (${end}). Wrap up active conversation.`,
  };
}

export function createCallingWindowMonitor({
  getSettings = () => ({}),
  isCallActive = () => false,
  onWindowClosed,
} = {}) {
  let prevOpen = null;
  let closedTransitionLatched = false;

  const tick = (now = new Date()) => {
    const settings = getSettings() || {};
    const dryRun = String(settings.dry_run ?? '') === '1';
    const status = evaluateCallingWindow(settings, now);

    if (status.open) {
      closedTransitionLatched = false;
    } else if (prevOpen === true && !status.open) {
      closedTransitionLatched = true;
      try {
        onWindowClosed?.(status.notice, { ...status, callActive: !!isCallActive() });
      } catch { /* UI notification must never break dialer loop */ }
    }

    prevOpen = status.open;

    // Enforce window lock in live calling mode (`!dryRun`) and whenever a live clock transition
    // crosses the closing boundary (`closedTransitionLatched`), while keeping dry-run test
    // harnesses operable when launched directly outside Danish office hours.
    const locked = !status.open && (!dryRun || closedTransitionLatched);

    return {
      ...status,
      locked,
      transitionedClosed: closedTransitionLatched,
      allowAutoNext: !locked,
      allowOutboundDial: !locked,
    };
  };

  return { tick };
}
