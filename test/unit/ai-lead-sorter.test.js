process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/pulse-ai-sorter-');
process.env.PULSE_TEST = '1';

const assert = require('assert');
const migrate = require('../../server/db/migrate');
migrate.run();

const aiLeadSorter = require('../../server/services/aiLeadSorter');
const prospectService = require('../../server/services/prospectService');

let passed = 0;
const ok = (msg) => { passed++; console.log(`    ✓ ${msg}`); };

async function run() {
  console.log('--- Unit: AI Lead Sorter & Auto-Extraction ---');

  // 1. Without key, returns needsKey gracefully
  const savedKey = process.env.PULSE_AI_API_KEY;
  const savedOrKey = process.env.OPENROUTER_API_KEY;
  const savedGemKey = process.env.GEMINI_API_KEY;
  delete process.env.PULSE_AI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const settings = require('../../server/repositories/settingsRepo');
  const savedDbKey = settings.get('ai_api_key');
  settings.set('ai_api_key', '');

  const noKey = await aiLeadSorter.analyzeLeadStructure({
    headers: ['Category', 'Phone', 'Google Maps URL'],
    sampleRows: [],
    apiKey: '',
  });
  assert.strictEqual(noKey.needsKey, true, 'prompts user for key if not configured');
  assert.strictEqual(noKey.configured, false);
  ok('requires key when unconfigured');

  // Restore keys for subsequent tests
  if (savedKey) process.env.PULSE_AI_API_KEY = savedKey;
  if (savedOrKey) process.env.OPENROUTER_API_KEY = savedOrKey;
  if (savedGemKey) process.env.GEMINI_API_KEY = savedGemKey;
  settings.set('ai_api_key', savedDbKey);

  // 2. With key and mocked Gemini response, parses mapping and secondary columns
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      assert.ok(url.includes('generateContent'));
      assert.strictEqual(opts.headers['x-goog-api-key'], 'test-fake-key');
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      mapping: {
                        name: 'Best Public Decision-Maker',
                        company: 'Company / Legal Name',
                        phone: 'Phone',
                        email: 'Email',
                        title: 'Decision-Maker Role',
                        location: 'Base Location',
                        website: 'Website',
                        notes: '',
                      },
                      secondaryColumns: ['CVR', 'Ad-Protected', 'Google Maps URL'],
                      summary: 'Mapped Danish enriched remodelers sheet with executive contact and company columns.',
                      categoryDetected: 'Bathroom Remodelers',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      };
    };

    const aiRes = await aiLeadSorter.analyzeLeadStructure({
      headers: ['Best Public Decision-Maker', 'Company / Legal Name', 'Phone', 'Email', 'Decision-Maker Role', 'Base Location', 'Website', 'CVR', 'Ad-Protected', 'Google Maps URL'],
      sampleRows: [{ 'Company / Legal Name': 'A/S BRDR. JENSEN VVS', 'Phone': '45878088' }],
      apiKey: 'test-fake-key',
    });

    assert.strictEqual(aiRes.success, true);
    assert.strictEqual(aiRes.mapping.name, 'Best Public Decision-Maker');
    assert.strictEqual(aiRes.mapping.company, 'Company / Legal Name');
    assert.strictEqual(aiRes.mapping.phone, 'Phone');
    assert.deepStrictEqual(aiRes.secondaryColumns, ['CVR', 'Ad-Protected', 'Google Maps URL']);
    assert.strictEqual(aiRes.categoryDetected, 'Bathroom Remodelers');
    ok('successfully parses Gemini AI response into clean mapping and secondary columns');
  } finally {
    global.fetch = originalFetch;
  }

  // 2b. OpenRouter support (when key starts with sk-or-)
  try {
    global.fetch = async (url, opts) => {
      assert.ok(url.includes('openrouter.ai'));
      assert.strictEqual(opts.headers.Authorization, 'Bearer sk-or-v1-testkey');
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.model, 'openrouter/free');
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mapping: {
                    name: 'Navn på Indehaver',
                    company: 'Virksomhedsnavn',
                    phone: 'Telefonnummer',
                    email: 'E-mail',
                    title: 'Direktør Stilling',
                    location: 'Postnr og By',
                    website: 'Hjemmeside',
                  },
                  secondaryColumns: ['CVR-nummer', 'Google Maps Link', 'Reklamebeskyttelse'],
                  summary: 'OpenRouter analyzed Danish B2B lead list.',
                  categoryDetected: 'Danish Construction & Trades',
                }),
              },
            },
          ],
        }),
      };
    };

    const orRes = await aiLeadSorter.analyzeLeadStructure({
      headers: ['Navn på Indehaver', 'Virksomhedsnavn', 'Telefonnummer', 'E-mail', 'Direktør Stilling', 'Postnr og By', 'Hjemmeside', 'CVR-nummer', 'Google Maps Link', 'Reklamebeskyttelse'],
      sampleRows: [{ 'Virksomhedsnavn': 'Nordic Solutions ApS', 'Telefonnummer': '4532331610' }],
      apiKey: 'sk-or-v1-testkey',
    });

    assert.strictEqual(orRes.success, true);
    assert.strictEqual(orRes.provider, 'openrouter');
    assert.strictEqual(orRes.mapping.name, 'Navn på Indehaver');
    assert.strictEqual(orRes.mapping.company, 'Virksomhedsnavn');
    assert.strictEqual(orRes.mapping.phone, 'Telefonnummer');
    assert.deepStrictEqual(orRes.secondaryColumns, ['CVR-nummer', 'Google Maps Link', 'Reklamebeskyttelse']);
    ok('successfully identifies sk-or- key, queries OpenRouter, and parses Danish mapping');
  } finally {
    global.fetch = originalFetch;
  }

  // 2c. Resilient 503 fallback from Gemini to OpenRouter
  try {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-fallback-key';
    let geminiCalls = 0;
    let openrouterCalls = 0;

    global.fetch = async (url, opts) => {
      if (url.includes('googleapis.com')) {
        geminiCalls++;
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand. Please try again later.' } }),
        };
      }
      if (url.includes('openrouter.ai')) {
        openrouterCalls++;
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  mapping: { name: 'Owner', company: 'Firm', phone: 'Tel' },
                  secondaryColumns: ['CVR'],
                  summary: 'Sorted via OpenRouter fallback after Gemini 503.',
                  categoryDetected: 'General Leads',
                }),
              },
            }],
          }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const fallbackRes = await aiLeadSorter.analyzeLeadStructure({
      headers: ['Owner', 'Firm', 'Tel', 'CVR'],
      sampleRows: [{ Firm: 'Test ApS', Tel: '12345678' }],
      apiKey: 'AIzaSyFakeGeminiKey',
    });

    assert.strictEqual(geminiCalls, 1, 'called gemini first');
    assert.strictEqual(openrouterCalls, 1, 'fell back to openrouter after gemini 503');
    assert.strictEqual(fallbackRes.success, true);
    assert.strictEqual(fallbackRes.provider, 'openrouter');
    assert.strictEqual(fallbackRes.fallbackUsed, true);
    assert.strictEqual(fallbackRes.mapping.name, 'Owner');
    ok('automatically catches Gemini 503 high demand spikes and falls back seamlessly to OpenRouter');
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    global.fetch = originalFetch;
  }

  // 3. prospectService auto-extraction from Google Maps URL when company is blank
  const rawRows = [
    {
      'Phone': '46 75 70 26',
      'Google Maps URL': 'https://www.google.com/maps/search/?api=1&query=A.+VILLADSEN+A%2FS%2C+Vestre+Hedevej+28B+4000+Roskilde%2C+Denmark',
      'Category': 'Bathroom Remodeler',
    },
    {
      'Phone': '45 87 80 88',
      'Company / Legal Name': 'A/S BRDR. JENSEN VVS',
      'Best Public Decision-Maker': 'Henrik Jensen',
      'Decision-Maker Role': 'Direktør',
      'Base Location': 'Hjortekærsvej 180 2800 Kgs. Lyngby',
    },
  ];

  const res = await prospectService.bulkImport({
    rows: rawRows,
    mapping: {
      phone: 'Phone',
      // note: name and company intentionally not mapped for row 1
    },
    skipDuplicates: false,
  });

  assert.strictEqual(res.added, 2, 'both rows imported');
  ok('prospectService automatically extracts company and location from Google Maps URL when unmapped');

  // Verify the prospects in DB
  const p1 = prospectService.search('VILLADSEN');
  assert.ok(p1.length >= 1, 'found extracted company name');
  assert.strictEqual(p1[0].company, 'A. VILLADSEN A/S');
  assert.ok(p1[0].location.includes('Roskilde'));
  assert.strictEqual(p1[0].title, 'Bathroom Remodeler');
  ok('prospect record in database has company and location populated from maps query');

  const p2 = prospectService.search('Henrik Jensen');
  assert.ok(p2.length >= 1, 'found extracted decision-maker name');
  assert.strictEqual(p2[0].name, 'Henrik Jensen');
  assert.strictEqual(p2[0].company, 'A/S BRDR. JENSEN VVS');
  ok('prospect record has Best Public Decision-Maker extracted into name');

  console.log(`\nAll ${passed} AI Lead Sorter & auto-extraction checks passed!\n`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
