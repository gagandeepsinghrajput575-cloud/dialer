// Push the current prospect's context to the local StealthPrompter HUD when a call starts.
//
// Deliberately fire-and-forget: never awaited, short timeout, every failure swallowed. If the
// teleprompter is not running, dialing is completely unaffected.
const URL = process.env.TELEPROMPTER_URL || 'http://127.0.0.1:8765/context';
const OFF = process.env.TELEPROMPTER_DISABLED === '1' || process.env.PULSE_TEST === '1';

// The lead list has no dedicated "niche" column; niche/industry/category columns land in `extra`
// (unmapped import columns) or in `title`. Resolve the best available label.
function nicheOf(p = {}) {
  const extra = p.extra || {};
  return (
    p.niche ||
    extra.niche ||
    extra.Niche ||
    extra.industry ||
    extra.Industry ||
    extra.category ||
    extra.Category ||
    extra.categoryDetected ||
    extra['Niche / Industry'] ||
    p.title ||
    ''
  );
}

function notifyCallStarted(prospect) {
  if (OFF || !prospect || typeof fetch !== 'function') return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    const payload = {
      name: String(prospect.name || ''),
      company: String(prospect.company || ''),
      niche: String(nicheOf(prospect) || ''),
    };
    const script = process.env.TELEPROMPTER_SCRIPT;
    if (script === 'call1' || script === 'call2') payload.script = script;
    fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  } catch {
    /* never let the teleprompter break dialing */
  }
}

module.exports = { notifyCallStarted, nicheOf };
