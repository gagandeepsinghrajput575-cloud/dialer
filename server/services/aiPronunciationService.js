const settings = require('../repositories/settingsRepo');
const danishPhonetics = require('./danishPhonetics');

const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash';

/**
 * Generates English phonetic pronunciations for a list of Danish names.
 * Uses Google Gemini if configured, with instantaneous deterministic phonetic fallback.
 *
 * @param {string[]} names - Array of full prospect names
 * @param {object} options
 * @returns {Promise<Record<string, string>>} name -> pronunciation (e.g. "[MEE-kel YORT SHEH-lahk]")
 */
async function generatePronunciations(rawNames = [], options = {}) {
  const names = Array.isArray(rawNames) ? rawNames : (Array.isArray(rawNames?.names) ? rawNames.names : []);
  const opts = Array.isArray(rawNames) ? (options || {}) : (rawNames || {});
  const { apiKey = null, model = null } = opts;

  const list = [...new Set(names.filter((n) => typeof n === 'string' && n.trim()))];
  if (!list.length) return {};

  const activeKey = apiKey || settings.get('ai_api_key') || settings.get('gemini_api_key') || process.env.GEMINI_API_KEY || '';
  const result = {};

  // Default baseline using deterministic phonetics engine
  for (const name of list) {
    result[name] = danishPhonetics.getPronunciation(name);
  }

  // If no Gemini key, return deterministic pronunciations instantly
  if (!activeKey) {
    return result;
  }

  // Use AI (OpenRouter or Gemini) to enhance/refine pronunciations
  try {
    const isOr = activeKey.startsWith('sk-or-') || settings.get('ai_provider') === 'openrouter';
    const activeModel = model || settings.get('ai_model') || (isOr ? 'openrouter/free' : GEMINI_DEFAULT_MODEL);

    // Process in batches of 40 to stay well within token limits and latency budgets
    const BATCH_SIZE = 40;
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const chunk = list.slice(i, i + BATCH_SIZE);
      const prompt = `You are an expert pronunciation coach for English-speaking cold callers reaching out to Danish business executives.
For each Danish name below, provide an intuitive English phonetic pronunciation respelling that an English speaker can read naturally on first sight.
RULES:
1. Capitalize stressed syllables (e.g. MEE-kel, YORT, SHEH-lahk, BOH, NUR-eeng, NEEL-sen).
2. Separate syllables with hyphens within a word.
3. Wrap the final full name pronunciation in square brackets: e.g. "[MEE-kel YORT SHEH-lahk]".
4. Return STRICT JSON array of objects: [{"name": "...", "pronunciation": "[...]"}]

NAMES TO PRONOUNCE:
${JSON.stringify(chunk, null, 2)}`;

      let rawText = '';
      if (isOr) {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeKey}`,
            'HTTP-Referer': 'https://pulsegrowth.dk',
            'X-Title': 'Pulse Dialer',
          },
          body: JSON.stringify({
            model: activeModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          rawText = data?.choices?.[0]?.message?.content || '';
        }
      } else {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;
        const body = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        };
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': activeKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) {
          const data = await res.json();
          rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
      }
      if (rawText) {
        try {
          const parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item?.name && item?.pronunciation) {
                let p = String(item.pronunciation).trim();
                if (!p.startsWith('[')) p = `[${p}`;
                if (!p.endsWith(']')) p = `${p}]`;
                result[item.name] = p;
              }
            }
          }
        } catch {
          // Keep deterministic fallback on JSON parse failure
        }
      }
    }
  } catch {
    // If Gemini fails or times out, fallback seamlessly to deterministic dictionary
  }

  return result;
}

module.exports = {
  generatePronunciations,
  generateBatch: generatePronunciations,
};
