const assert = require('assert');
const danishPhonetics = require('../../server/services/danishPhonetics');
const aiPronunciationService = require('../../server/services/aiPronunciationService');
const prospectService = require('../../server/services/prospectService');
const prospectsRepo = require('../../server/repositories/prospectRepo');
const { db } = require('../../server/db');
// These suites read real tables. Every other DB suite calls migrate.run() itself; these three
// never did, so they have failed with `no such table` since they were written and the behaviour
// they cover has been unverified the whole time.
const migrate = require('../../server/db/migrate');
migrate.run();

console.log('--- Unit: Danish Pronunciation Engine & AI Batch Service ---');

// 1. danishPhonetics unit tests
{
  const p1 = danishPhonetics.getPronunciation('Michael Hjorth Szelak');
  assert.strictEqual(p1, '[MEE-kel YORT SHEH-lahk]', 'Michael Hjorth Szelak phonetics should match expected');
  console.log('  ✓ Michael Hjorth Szelak ->', p1);

  const p2 = danishPhonetics.getPronunciation('Bo Nørring Nielsen');
  assert.strictEqual(p2, '[BOH NUR-eeng NEEL-sen]', 'Bo Nørring Nielsen phonetics should match expected');
  console.log('  ✓ Bo Nørring Nielsen ->', p2);

  const p3 = danishPhonetics.getPronunciation('Jørgen Møller');
  assert.ok(p3.includes('YUR-gen') || p3.includes('MUR-ler'), 'Jørgen Møller correctly renders ø phonemes');
  console.log('  ✓ Jørgen Møller ->', p3);

  const p4 = danishPhonetics.getPronunciation('Claus Bjerregaard Larsen');
  assert.ok(p4.includes('KLOWS') && p4.includes('LAHR-sen'), 'Patronymics and compound names parsed correctly');
  console.log('  ✓ Claus Bjerregaard Larsen ->', p4);
}

// 2. Batch pronunciation service test
(async () => {
  const names = ['Mette Jensen', 'Anders Nielsen', 'Søren Kierkegaard'];
  const res = await aiPronunciationService.generatePronunciations({ names });
  assert.strictEqual(Object.keys(res).length, 3);
  assert.ok(res['Mette Jensen'].length > 0);
  assert.ok(res['Anders Nielsen'].length > 0);
  console.log('  ✓ aiPronunciationService fallback generates batch pronunciations for entire lists');

  // 3. Prospect creation and bulk import auto-pronunciation
  const newProspect = prospectService.create({
    name: 'Henrik Vestergaard',
    phone: '+4599887766',
    company: 'Vestergaard Byg ApS',
  });
  assert.ok(newProspect.pronunciation, 'New prospect must have pronunciation automatically populated');
  assert.ok(newProspect.pronunciation.includes('HEN-rik'), 'Henrik correctly rendered');
  console.log('  ✓ prospectService.create automatically attaches pronunciation:', newProspect.pronunciation);

  // Clean up test prospect
  db.prepare('DELETE FROM prospects WHERE id = ?').run(newProspect.id);

  console.log('\nAll Danish Pronunciation & AI Batch checks passed!\n');
})();
