const settings = require('../repositories/settingsRepo');

const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/free';

/**
 * Robust JSON extractor from LLM text responses (handles markdown code fences or conversational text)
 */
function extractJson(rawText) {
  let cleaned = String(rawText || '').trim();
  const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    cleaned = match[1].trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }
  return JSON.parse(cleaned);
}

/**
 * Call OpenRouter API (supports free meta-router openrouter/free, minimax/minimax-m3.1-flash:free, etc.)
 */
async function callOpenRouter({ apiKey, model, prompt, signal }) {
  const activeModel = model || OPENROUTER_DEFAULT_MODEL;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://pulsegrowth.dk',
      'X-Title': 'Pulse Dialer',
    },
    body: JSON.stringify({
      model: activeModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
    signal: signal || AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`OpenRouter returned status ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    err.body = errText;
    throw err;
  }

  const data = await res.json();
  const rawText = data?.choices?.[0]?.message?.content || '';
  if (!rawText) throw new Error('Empty response from OpenRouter');
  return { rawText, model: activeModel, provider: 'openrouter' };
}

/**
 * Call Google Gemini API
 */
async function callGemini({ apiKey, model, prompt, signal }) {
  const activeModel = model || GEMINI_DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    }),
    signal: signal || AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Google Gemini returned status ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    err.body = errText;
    throw err;
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!rawText) throw new Error('Empty response from Google Gemini');
  return { rawText, model: activeModel, provider: 'gemini' };
}

/**
 * Intelligent AI Lead Sorter supporting OpenRouter & Google Gemini with automatic failover.
 * Analyzes raw lead sheets, forms and CSVs to classify primary calling fields
 * (name, company, phone, email, title, location, website, notes) and routes
 * secondary/registry/metadata columns into the collapsible drop-down section.
 */
async function analyzeLeadStructure({ headers = [], sampleRows = [], apiKey = null, model = null, provider = null } = {}) {
  // 1. Gather all potential keys across explicit args, settings, and environment variables
  const configuredKey = settings.get('ai_api_key') || process.env.PULSE_AI_API_KEY || '';
  const openrouterKey = (apiKey && apiKey.startsWith('sk-or-'))
    ? apiKey
    : (configuredKey.startsWith('sk-or-') ? configuredKey : (process.env.OPENROUTER_API_KEY || ''));
  const geminiKey = (apiKey && !apiKey.startsWith('sk-or-'))
    ? apiKey
    : (configuredKey.startsWith('AIza') ? configuredKey : (process.env.GEMINI_API_KEY || ''));

  // 2. Resolve target provider
  let activeProvider = provider || settings.get('ai_provider') || process.env.PULSE_AI_PROVIDER || '';
  if (apiKey) {
    if (apiKey.startsWith('sk-or-')) activeProvider = 'openrouter';
    else if (!provider) activeProvider = 'gemini';
  } else if (!activeProvider || activeProvider === 'local') {
    if (openrouterKey) activeProvider = 'openrouter';
    else if (geminiKey) activeProvider = 'gemini';
  }

  // 3. Check if at least one AI key is present
  const primaryKey = activeProvider === 'openrouter' ? (openrouterKey || apiKey) : (geminiKey || apiKey || configuredKey);
  if (!primaryKey && !openrouterKey && !geminiKey) {
    return {
      configured: false,
      needsKey: true,
      message: 'An OpenRouter or Google Gemini API key is required to analyze lead forms with AI.',
    };
  }

  const prompt = `You are an expert CRM data architect. A user has uploaded a raw lead sheet with the following column headers and sample data rows.

COLUMN HEADERS:
${JSON.stringify(headers, null, 2)}

SAMPLE DATA (first ${Math.min(sampleRows.length, 3)} rows):
${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

TASK:
1. Map the columns to our core contact fields for cold calling:
   - "name": The individual contact person / owner / director / decision-maker name (e.g. "Best Public Decision-Maker", "Owner Name(s)", "Full name", "Navn", "Indehaver")
   - "company": The legal company or business name (e.g. "Company / Legal Name", "Website Name", "Virksomhedsnavn", "Firma")
   - "phone": The primary phone number to call (e.g. "Telefon", "Phone", "Mobil")
   - "email": The primary email address (e.g. "E-mail", "Email")
   - "title": Job title, designation or specific role (e.g. "Decision-Maker Role", "Direktør", "Stilling", or category/niche if no role exists)
   - "location": Physical address, municipality, postal code or city (e.g. "Base Location", "Postnr og By", "Adresse")
   - "website": Main website URL (e.g. "Website", "Hjemmeside")
   - "notes": Marketing notes, qualification notes or general remarks

2. Identify "secondaryColumns":
   All columns that represent registry data, CVR numbers, advertising protection flags ("Reklamebeskyttelse"), social profile URLs (Facebook, Instagram, LinkedIn), Meta Ads/pixel data, Google Maps URLs, employee counts, or qualification evidence snippets.
   These will NOT clutter the primary cockpit and will be placed in a clean, collapsible "Extra Details & Registry Info" dropdown menu.

3. Provide a concise 1-2 sentence human explanation in "summary".

Respond with STRICT JSON ONLY matching this exact structure:
{
  "mapping": {
    "name": "exact_header_name_or_empty",
    "company": "exact_header_name_or_empty",
    "phone": "exact_header_name_or_empty",
    "email": "exact_header_name_or_empty",
    "title": "exact_header_name_or_empty",
    "location": "exact_header_name_or_empty",
    "website": "exact_header_name_or_empty",
    "notes": "exact_header_name_or_empty"
  },
  "secondaryColumns": ["column1", "column2"],
  "summary": "Short explanation",
  "categoryDetected": "Detected lead niche/industry"
}`;

  let callResult = null;
  let fallbackUsed = false;
  let activeModel = model || settings.get('ai_model') || (activeProvider === 'openrouter' ? OPENROUTER_DEFAULT_MODEL : GEMINI_DEFAULT_MODEL);

  // Normalize model default if mismatched with provider
  if (activeProvider === 'openrouter' && (!activeModel || activeModel.startsWith('gemini-'))) {
    activeModel = OPENROUTER_DEFAULT_MODEL;
  } else if (activeProvider === 'gemini' && (!activeModel || activeModel.includes('/'))) {
    activeModel = GEMINI_DEFAULT_MODEL;
  }

  // 4. Execute primary call with automatic resilient fallback
  try {
    if (activeProvider === 'openrouter') {
      const key = openrouterKey || primaryKey;
      callResult = await callOpenRouter({ apiKey: key, model: activeModel, prompt });
    } else {
      const key = geminiKey || primaryKey;
      callResult = await callGemini({ apiKey: key, model: activeModel, prompt });
    }
  } catch (err) {
    // Case A: Gemini failed (503 high demand, 429 rate limit, 500, or timeout) -> Fallback to OpenRouter
    if (activeProvider === 'gemini' && openrouterKey) {
      try {
        callResult = await callOpenRouter({ apiKey: openrouterKey, model: OPENROUTER_DEFAULT_MODEL, prompt });
        fallbackUsed = true;
      } catch (fallbackErr) {
        // Fallback to OpenRouter failed, check Gemini retry
      }
    }

    // Case B: If OpenRouter was not available or failed, and it was a preview model -> Retry with stable GA Gemini 2.5 Flash
    if (!callResult && activeProvider === 'gemini' && activeModel !== 'gemini-2.5-flash') {
      try {
        const key = geminiKey || primaryKey;
        callResult = await callGemini({ apiKey: key, model: 'gemini-2.5-flash', prompt });
        fallbackUsed = true;
      } catch (geminiRetryErr) {
        // Fall through
      }
    }

    // Case C: OpenRouter failed -> Fallback to Gemini if key is available
    if (!callResult && activeProvider === 'openrouter' && geminiKey) {
      try {
        callResult = await callGemini({ apiKey: geminiKey, model: GEMINI_DEFAULT_MODEL, prompt });
        fallbackUsed = true;
      } catch (geminiFallbackErr) {
        // Fall through to error return
      }
    }

    if (!callResult) {
      return {
        success: false,
        configured: true,
        error: err.message,
      };
    }
  }

  // 5. Parse and clean structure
  try {
    const parsed = extractJson(callResult.rawText);

    // Clean up mapping to only include keys that actually match one of the uploaded headers
    const validHeaders = new Set(headers);
    const cleanMapping = {};
    for (const [k, v] of Object.entries(parsed.mapping || {})) {
      if (v && validHeaders.has(v)) {
        cleanMapping[k] = v;
      }
    }

    const secondary = (parsed.secondaryColumns || []).filter((h) => validHeaders.has(h));

    return {
      success: true,
      configured: true,
      provider: callResult.provider,
      model: callResult.model,
      fallbackUsed,
      mapping: cleanMapping,
      secondaryColumns: secondary,
      summary: parsed.summary || 'Lead columns analyzed and classified with AI.',
      categoryDetected: parsed.categoryDetected || 'General Leads',
    };
  } catch (parseErr) {
    return {
      success: false,
      configured: true,
      error: `Failed to parse AI structure response: ${parseErr.message}`,
    };
  }
}

module.exports = {
  analyzeLeadStructure,
  callOpenRouter,
  callGemini,
  extractJson,
};
