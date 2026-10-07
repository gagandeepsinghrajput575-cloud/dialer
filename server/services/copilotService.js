// Post-call copilot. Out of the box this is a zero-dependency extractive summarizer: it reads
// the outcome, talk time and notes and produces a summary, next steps and a suggested callback.
// When a provider + API key are configured it delegates to that model instead, and falls back
// to the local summarizer if the request fails.
const settings = require('../repositories/settingsRepo');
const callService = require('./callService');
const { fmtDuration } = require('./format');

const OUTCOME_TEXT = {
  no_answer: 'nobody picked up',
  voicemail: 'reached voicemail',
  wrong_number: 'the number was wrong',
  gatekeeper: 'a gatekeeper blocked the decision maker',
  hung_up: 'they hung up early',
  conversation: 'had a real conversation',
  meeting_booked: 'booked a meeting',
  dnc: 'asked not to be called again',
};

// Sales signals that make a note worth quoting back.
const SIGNAL_WORDS = ['budget', 'pris', 'price', 'beslut', 'decision', 'møde', 'meeting', 'demo', 'tilbud', 'offer',
  'kontrakt', 'contract', 'competitor', 'konkurrent', 'deadline', 'q1', 'q2', 'q3', 'q4', 'send', 'ring', 'email', 'interesse'];
const ACTION_WORDS = ['send', 'sender', 'ring', 'ringer', 'book', 'booke', 'møde', 'meeting', 'demo', 'tilbud', 'follow', 'følge op', 'email', 'mail', 'prøv', 'trial', 'aftal'];

const sentences = (text) => String(text || '')
  .split(/[\n.;]+/)
  .map((s) => s.trim())
  .filter((s) => s.length > 3);

function keyPhrases(noteText, limit = 3) {
  return sentences(noteText)
    .map((s) => ({ text: s, score: SIGNAL_WORDS.filter((w) => s.toLowerCase().includes(w)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.text);
}

function extractNextSteps(noteText) {
  const steps = sentences(noteText)
    .filter((s) => ACTION_WORDS.some((w) => s.toLowerCase().includes(w)))
    .slice(0, 3);
  return steps.length ? steps : [];
}

function localSummary({ prospect = {}, call = {}, notes = [] } = {}) {
  const p = prospect || {};
  const c = call || {};
  const list = Array.isArray(notes) ? notes : [];
  const noteText = list.map((n) => (n && n.body) || '').join('\n');
  const outcomeText = OUTCOME_TEXT[c.outcome] || (c.vm_dropped ? 'voicemail drop' : 'no outcome logged');
  const who = p.name || p.company || p.phone || 'the prospect';
  const where = p.company ? ` at ${p.company}` : '';
  const duration = fmtDuration(c.duration_sec || 0);
  const phrases = keyPhrases(noteText);
  const steps = extractNextSteps(noteText);

  const parts = [
    `${who}${where}: ${outcomeText} after ${duration} on ${c.dial_uri || 'the softphone'}.`,
    c.vm_dropped ? 'Voicemail drop used — greeting played, callback scheduled.' : '',
    phrases.length ? `Key signals: ${phrases.join(' · ')}.` : '',
    p.follow_up_at ? `Follow-up scheduled for ${p.follow_up_at}.` : '',
  ].filter(Boolean);

  return {
    provider: 'local',
    summary: parts.join(' '),
    nextSteps: steps,
    highlights: phrases,
    talkTimeSec: c.duration_sec || 0,
    outcome: c.outcome || null,
    voicemailDrop: !!c.vm_dropped,
    followUpSuggested: p.follow_up_at || callService.suggestFollowUp(c.outcome || 'no_answer'),
  };
}

const PROVIDERS = {
  openai: (model) => ({
    url: 'https://api.openai.com/v1/chat/completions',
    body: { model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: '' }], temperature: 0.2 },
    parse: (json) => json?.choices?.[0]?.message?.content || '',
  }),
  gemini: (model) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-1.5-flash'}:generateContent`,
    body: { contents: [{ parts: [{ text: '' }] }] },
    parse: (json) => json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '',
  }),
};

async function remoteSummary(prompt) {
  const provider = String(settings.get('ai_provider') || '').toLowerCase();
  const apiKey = settings.get('ai_api_key');
  const spec = PROVIDERS[provider];
  if (!spec || !apiKey) throw new Error(`AI provider "${provider || 'local'}" is not configured`);

  const model = String(settings.get('ai_model') || '').trim();
  const { url, body, parse } = spec(model);
  if (provider === 'openai') body.messages[0].content = prompt;
  else body.contents[0].parts[0].text = prompt;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider === 'openai' ? { Authorization: `Bearer ${apiKey}` } : { 'x-goog-api-key': apiKey }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`AI provider responded ${res.status}`);
  const text = parse(await res.json());
  if (!text) throw new Error('AI provider returned an empty completion');

  const [summary, ...rest] = text.split(/\n\s*next steps?:\s*/i);
  return {
    provider,
    model: model || 'default',
    summary: summary.trim(),
    nextSteps: rest.join('\n').split(/\n+/).map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 5),
    highlights: [],
  };
}

async function summarize({ prospect, call, notes = [] } = {}) {
  const p = prospect || {};
  const c = call || {};
  const list = Array.isArray(notes) ? notes : [];
  const base = localSummary({ prospect: p, call: c, notes: list });
  const provider = String(settings.get('ai_provider') || 'local').toLowerCase();
  if (provider === 'local' || !settings.get('ai_api_key')) return base;

  const prompt = [
    'You are a cold-calling sales copilot for the Danish B2B market.',
    `Prospect: ${p.name || ''} ${p.company || ''} (${p.title || ''}).`,
    `Call outcome: ${c.outcome || 'not logged'}, talk time ${fmtDuration(c.duration_sec || 0)}, voicemail drop: ${c.vm_dropped ? 'yes' : 'no'}.`,
    `Notes: ${(list.map((n) => (n && n.body) || '').join(' | ') || 'none')}`,
    'Write a 2-3 sentence summary, then a line "Next steps:" followed by up to 3 concrete bullets.',
  ].join('\n');

  try {
    const remote = await remoteSummary(prompt);
    return { ...base, ...remote, followUpSuggested: base.followUpSuggested, talkTimeSec: base.talkTimeSec, outcome: base.outcome, voicemailDrop: base.voicemailDrop };
  } catch (e) {
    return { ...base, degraded: true, providerError: e.message };
  }
}

module.exports = { summarize, localSummary, keyPhrases, extractNextSteps, PROVIDERS };
