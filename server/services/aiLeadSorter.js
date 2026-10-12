const settings = require('../repositories/settingsRepo');

const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash';

/**
 * Intelligent AI Lead Sorter powered by Google Gemini.
 * Analyzes raw lead sheets, forms and CSVs to classify primary calling fields
 * (name, company, phone, email, title, location, website, notes) and routes
 * secondary/registry/metadata columns into the collapsible drop-down section.
 */
async function analyzeLeadStructure({ headers = [], sampleRows = [], apiKey = null, model = null } = {}) {
  const activeKey = apiKey || settings.get('ai_api_key') || process.env.GEMINI_API_KEY || '';
  if (!activeKey) {
    return {
      configured: false,
      needsKey: true,
      message: 'Google Gemini API key is required to analyze lead forms with AI.',
    };
  }

  const activeModel = model || settings.get('ai_model') || GEMINI_DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`;

  const prompt = `You are an expert CRM data architect. A user has uploaded a raw lead sheet with the following column headers and sample data rows.

COLUMN HEADERS:
${JSON.stringify(headers, null, 2)}

SAMPLE DATA (first ${Math.min(sampleRows.length, 3)} rows):
${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

TASK:
1. Map the columns to our core contact fields for cold calling:
   - "name": The individual contact person / owner / director / decision-maker name (e.g. "Best Public Decision-Maker", "Owner Name(s)", "Full name", "Navn")
   - "company": The legal company or business name (e.g. "Company / Legal Name", "Website Name", "Virksomhedsnavn", "Firma")
   - "phone": The primary phone number to call
   - "email": The primary email address
   - "title": Job title, designation or specific role (e.g. "Decision-Maker Role", "Direktør", "Stilling", or category if no role exists)
   - "location": Physical address, municipality, postal code or city
   - "website": Main website URL
   - "notes": Marketing notes, qualification notes or general remarks

2. Identify "secondaryColumns":
   All columns that represent registry data, CVR numbers, advertising protection flags, social profile URLs (Facebook, Instagram, LinkedIn), Meta Ads/pixel data, Google Maps URLs, qualification URLs, or evidence snippets.
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

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': activeKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Google Gemini returned status ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('Empty response from Google Gemini');

    const parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());

    // Clean up mapping to only include keys that actually match one of the headers
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
      provider: 'gemini',
      model: activeModel,
      mapping: cleanMapping,
      secondaryColumns: secondary,
      summary: parsed.summary || 'Lead columns analyzed and classified with Gemini.',
      categoryDetected: parsed.categoryDetected || 'General Leads',
    };
  } catch (err) {
    return {
      success: false,
      configured: true,
      error: err.message,
    };
  }
}

module.exports = {
  analyzeLeadStructure,
};
