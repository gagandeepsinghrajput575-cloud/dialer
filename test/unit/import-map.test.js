// Unit layer for the import matcher and the registry-metadata reader.
//
// Both are pure functions, and both fail silently when they are wrong: a mis-mapped phone
// column means 500 calls to the wrong number, and a missed advertising-protection flag means
// marketing material sent to a company that has legally opted out. Neither shows up as an
// error anywhere — only as a bad column or a wrong pill — so the contracts are pinned here.
//
// The headers below are the ones a real enriched Danish lead sheet arrives with, verbatim.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let passed = 0;
const ok = (msg) => { passed++; console.log(`    \u2713 ${msg}`); };

// The sheet this feature exists for.
const ENRICHED = [
  'Owner Name(s)', 'Company Name', 'Category', 'Phone', 'Primary Phone', 'Additional Phone(s)',
  'E-mail', 'Marketing Notes', 'Website', 'Location', 'CVR', 'CVR Advertising Protection',
  'Current CVR Status', 'Owner Source URL(s)', 'Phone Source URL(s)', 'Marketing Outreach Flag',
];

async function run() {
  const { IMPORT_TARGETS, guessMapping, extrasOf, canImport, isRegistryHeader, normalizeHeader } =
    await import(path.join(ROOT, 'src', 'importMap.js'));
  const { extraInsights, isUrlValue, clip } = await import(path.join(ROOT, 'src', 'registry.js'));

  // ---- the enriched sheet ---------------------------------------------------------------
  const map = guessMapping(ENRICHED);
  assert.strictEqual(map.name, 'Owner Name(s)', 'the owner column becomes the name');
  assert.strictEqual(map.company, 'Company Name');
  assert.strictEqual(map.phone, 'Phone', 'the primary number wins over "Additional Phone(s)"');
  assert.strictEqual(map.title, 'Category', 'a trade/category column is the job title');
  assert.strictEqual(map.email, 'E-mail', 'the Danish spelling of email still lands');
  assert.strictEqual(map.notes, 'Marketing Notes', 'notes are notes, not a registry field');
  assert.strictEqual(map.website, 'Website');
  assert.strictEqual(map.location, 'Location');
  ok('the enriched Danish sheet maps with zero manual clicks (8 fields, including notes)');

  // The columns nobody should guess at: registry metadata stays in `extra`.
  const extras = extrasOf(ENRICHED, map);
  for (const col of ['CVR', 'CVR Advertising Protection', 'Current CVR Status', 'Owner Source URL(s)', 'Phone Source URL(s)', 'Marketing Outreach Flag', 'Additional Phone(s)']) {
    assert.ok(extras.includes(col), `${col} stays registry metadata`);
    assert.ok(!Object.values(map).includes(col), `${col} is never used as a contact field`);
  }
  ok('registry columns (CVR, protection, source URLs, secondary phone) are never claimed as contact fields');

  // A source URL must not be mistaken for a website: the sheet's real Website column is one
  // link, the two "Source URL(s)" columns are provenance for individual fields.
  assert.ok(isRegistryHeader('Owner Source URL(s)') && isRegistryHeader('CVR'), 'registry detection is exposed');
  assert.ok(!isRegistryHeader('Website') && !isRegistryHeader('Marketing Notes'), 'and does not swallow real fields');
  const urlOnly = guessMapping(['Phone Source URL(s)', 'Owner Source URL(s)']);
  assert.strictEqual(urlOnly.website, undefined, 'a provenance link is not the company website');
  const realSite = guessMapping(['Phone', 'Hjemmeside', 'Phone Source URL(s)']);
  assert.strictEqual(realSite.website, 'Hjemmeside', 'the real website column still maps when one exists');
  ok('source/provenance links never masquerade as the company website');

  // ---- secondary columns -----------------------------------------------------------------
  const onlySecondary = guessMapping(['Company', 'Additional Phone(s)']);
  assert.strictEqual(onlySecondary.phone, 'Additional Phone(s)', 'with no primary number, a secondary one is still worth having');
  const bothPhones = guessMapping(['Additional Phone(s)', 'Telefon']);
  assert.strictEqual(bothPhones.phone, 'Telefon', 'but it never outranks the primary column, whichever order the sheet uses');
  ok('secondary columns are a fallback, not a preference (both header orders covered)');

  // ---- plain sheets must keep working exactly as before -----------------------------------
  const plain = guessMapping(['Name', 'Phone', 'Email', 'Company', 'Title', 'City', 'Notes from list']);
  assert.strictEqual(plain.name, 'Name');
  assert.strictEqual(plain.phone, 'Phone');
  assert.strictEqual(plain.notes, 'Notes from list', 'the sample sheet\'s notes column maps too');
  assert.strictEqual(plain.location, 'City');
  assert.ok(!extrasOf(['Name', 'Phone', 'Email', 'Company', 'Title', 'City', 'Notes from list'], plain).length,
    'nothing is left over on a clean sheet');
  ok('an ordinary English sheet maps with nothing left in "more details"');

  // ---- split names, loose headers, junk ---------------------------------------------------
  const split = guessMapping(['First name', 'Last name', 'Tlf. nr.', 'E-mailadresse']);
  assert.strictEqual(split.first_name, 'First name');
  assert.strictEqual(split.last_name, 'Last name');
  assert.strictEqual(split.phone, 'Tlf. nr.', 'a period-heavy Danish header matches on the loose pass');
  assert.strictEqual(split.email, 'E-mailadresse');
  assert.strictEqual(canImport(split), true);
  ok('split names and punctuation-heavy headers ("Tlf. nr.") still resolve');

  const noPhone = guessMapping(['Ejer', 'Virksomhed']);
  assert.strictEqual(noPhone.name, 'Ejer');
  assert.strictEqual(noPhone.company, 'Virksomhed');
  assert.strictEqual(noPhone.phone, undefined, 'nothing is invented for a field the sheet lacks');
  assert.strictEqual(canImport(noPhone), true, 'a name or company is enough to import');
  assert.strictEqual(canImport({}), false, 'an empty mapping is not importable');
  ok('missing fields stay empty instead of being filled with a neighbouring column');

  // No column may be claimed by two fields: that is how a phone number ends up as an email.
  const headers = ['Navn', 'Navn (kort)', 'Telefon', 'Telefon 2', 'Firma', 'Firma Navn'];
  const dup = guessMapping(headers);
  const claimed = Object.values(dup);
  assert.strictEqual(new Set(claimed).size, claimed.length, `each column is used once (${claimed.join(', ')})`);
  ok('a column can never be assigned to two fields at once');

  // Every target declares the shape the UI depends on.
  for (const t of IMPORT_TARGETS) {
    assert.ok(t.id && t.label && t.priority, `${t.id} is a complete target`);
    assert.ok(t.re instanceof RegExp, `${t.id} has a strict pattern`);
  }
  assert.strictEqual(new Set(IMPORT_TARGETS.map((t) => t.id)).size, IMPORT_TARGETS.length, 'target ids are unique');
  assert.strictEqual(new Set(IMPORT_TARGETS.map((t) => t.priority)).size, IMPORT_TARGETS.length, 'match priorities are unique, so the order is deterministic');
  assert.strictEqual(normalizeHeader('Owner Name(s)'), 'ownernames', 'header normalisation is stable');
  ok('every target is well-formed and match priority is deterministic');

  // ---- registry insights (the pills) ------------------------------------------------------
  const rich = {
    'CVR': '41234567',
    'CVR Advertising Protection': 'Ja',
    'Current CVR Status': 'Aktiv',
    'Owner Source URL(s)': 'https://www.proff.dk/firma/nordic-logistik/41234567',
    'Marketing Outreach Flag': '',
  };
  const ins = extraInsights(rich);
  assert.strictEqual(ins.count, 4, 'blank metadata is not counted');
  assert.strictEqual(ins.cvr, '41234567', 'the CVR pill reads the registration number');
  assert.strictEqual(ins.adProtected, true, 'Ja means protected');
  assert.strictEqual(ins.urlCount, 1, 'the source URL is recognised as a link');
  assert.strictEqual(ins.entries.find((e) => e.key === 'Owner Source URL(s)').isUrl, true);
  assert.match(ins.protectionNote, /do not send marketing/i, 'the tooltip says what protection means');
  ok('CVR number, ad-protection flag and source links are read off the extra columns');

  // The flag must not fire on a "no", an empty cell, or an unrelated column.
  const clean = extraInsights({ CVR: '41234567', 'CVR Advertising Protection': 'Nej', 'Current CVR Status': 'Aktiv' });
  assert.strictEqual(clean.adProtected, false, 'Nej is not a warning');
  assert.strictEqual(clean.cvr, '41234567', 'and the CVR is still shown');
  assert.strictEqual(extraInsights({ 'CVR Advertising Protection': '' }).adProtected, false, 'a blank flag is not protected');
  assert.strictEqual(extraInsights({ 'Marketing Outreach Flag': 'Ja' }).adProtected, false, 'an unrelated flag with a Ja is not protection');
  assert.strictEqual(extraInsights({ 'CVR Advertising Protection': 'Ja' }).adProtected, true, 'protection alone is enough to warn');
  ok('the ad-protection pill fires on affirmative values only, never on "Nej" or an unrelated flag');

  // Danish spellings and odd values.
  assert.strictEqual(extraInsights({ 'Reklamebeskyttelse': 'Ja' }).adProtected, true, 'the Danish column name works');
  assert.strictEqual(extraInsights({ 'Reklamebeskyttelse': 'true' }).adProtected, true);
  assert.strictEqual(extraInsights({ 'CVR': 'DK 41234567' }).cvr, 'DK 41234567', 'an odd CVR value is still shown verbatim');
  assert.strictEqual(extraInsights({}).count, 0, 'a prospect with no extra columns has no accordion');
  assert.strictEqual(extraInsights(undefined).count, 0, 'and a missing extra blob does not throw');
  assert.strictEqual(extraInsights({ A: null, B: '   ' }).count, 0, 'null and whitespace values are dropped');
  ok('Danish protection column, odd CVR values and empty inputs all behave');

  // Link handling.
  assert.strictEqual(isUrlValue('https://a.dk/x'), true);
  assert.strictEqual(isUrlValue('www.a.dk'), false, 'a bare domain is text, not a guaranteed-safe link');
  assert.strictEqual(isUrlValue('javascript:alert(1)'), false, 'a javascript: value is never rendered as a link');
  assert.strictEqual(isUrlValue('Ja'), false);
  assert.strictEqual(clip('x'.repeat(80)).length, 44, 'long values are clipped for display');
  assert.strictEqual(clip('short'), 'short');
  ok('only http(s) values become links — a javascript: payload stays inert text');

  // ---- the sheet's own notes column must survive the trip ---------------------------------
  // The mapper decides where notes go; the server half of that contract is exercised in the
  // HTTP suite (group 38), because it needs a real import.
  assert.strictEqual(map.notes, 'Marketing Notes');
  assert.ok(extras.includes('Additional Phone(s)') && !extras.includes('Marketing Notes'),
    'a mapped notes column is not duplicated into the metadata blob');
  ok('notes are routed to the activity feed and not duplicated into metadata');

  // ---- layout audit: the accordion must not become the overflow bug -----------------------
  // Long Danish headers ("CVR Advertising Protection") and long URLs are the norm in these
  // sheets, and a two-column grid is exactly the shape that pushes a card sideways at 390px.
  // jsdom has no layout engine, so the stylesheet is checked the way a browser would resolve it.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const rule = (selector) => {
    const m = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel]) => sel.split(',').some((one) => one.trim() === selector));
    return m.map(([, , body]) => body).join(';');
  };
  const mediaBodies = (query) => [...css.matchAll(new RegExp(`@media\\s*\\(${query}\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))].map((m) => m[1]).join('\n');

  assert.match(rule('.registry-grid'), /repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    'the registry grid uses minmax(0, 1fr): a long CVR line cannot widen the card');
  assert.match(rule('.registry-item'), /min-width:\s*0/, 'each registry cell can shrink below its content width');
  assert.match(rule('.registry-item span'), /word-break:\s*break-word/, 'and long values wrap instead of overflowing');
  assert.match(rule('.registry-pills'), /flex-wrap:\s*wrap/, 'the pills wrap rather than pushing the toggle wider');
  assert.match(rule('.registry-toggle'), /width:\s*100%/, 'the toggle spans the card and stays reachable');
  assert.match(rule('.registry-toggle:focus-visible'), /outline:/, 'the accordion trigger shows focus (WCAG 2.4.7)');
  assert.match(rule('.registry-link'), /word-break:\s*break-all/, 'a long source URL wraps inside its cell');
  // The narrow-width collapse already lives in the <=900px block, which a 390px phone also
  // matches; assert there rather than demanding a second, redundant rule.
  assert.match(mediaBodies('max-width:\\s*900px'), /\.registry-grid[^{]*\{[^}]*grid-template-columns:\s*1fr/,
    'at mobile width the registry grid collapses to one column');
  assert.match(mediaBodies('max-width:\\s*720px'), /\.map-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/,
    'on a phone the mapping row stacks its label above the field');
  assert.match(mediaBodies('max-width:\\s*720px'), /\.registry-pills[^{]*\{[^}]*justify-content:\s*flex-start/,
    'and the pills wrap under the label instead of squeezing it');
  assert.match(mediaBodies('max-width:\\s*900px'), /\.registry-grid[^{]*\{[^}]*grid-template-columns:\s*1fr/,
    'the drawer keeps its catalogue readable in the narrower column');
  assert.match(rule('.registry-body'), /overflow:\s*hidden/, 'the collapsing panel clips its content rather than spilling');

  // A long header in the mapping select must not stretch its row: the select shares the track.
  assert.match(rule('.map-row'), /minmax\(0,\s*1fr\)/, 'the mapping row gives the select a shrinkable track');
  ok('registry accordion and mapping rows stay inside their container at every breakpoint');

  console.log(`  [import-map] ${passed} mapping checks passed`);
}

run().catch((e) => {
  console.error(`  \u274C import-map unit failure: ${e.message}`);
  process.exitCode = 1;
});
