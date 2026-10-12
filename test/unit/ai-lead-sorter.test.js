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
  const noKey = await aiLeadSorter.analyzeLeadStructure({
    headers: ['Category', 'Phone', 'Google Maps URL'],
    sampleRows: [],
    apiKey: '',
  });
  assert.strictEqual(noKey.needsKey, true, 'prompts user for key if not configured');
  assert.strictEqual(noKey.configured, false);
  ok('requires key when unconfigured');

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
