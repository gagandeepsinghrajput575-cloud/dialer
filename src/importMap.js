// Header → field matching for imported lead sheets.
//
// Real lead sheets do not use the field names this app uses. A Danish remodeler directory
// arrives with "Owner Name(s)", "Company Name", "Category", "Marketing Notes" and a pile of
// registry columns (CVR, advertising protection, source URLs), and the agent's job is to dial,
// not to answer twelve dropdowns before every import. So the matching lives here, as pure
// functions, where it can be tested against the actual headers that showed up in the wild.
//
// Three rules earn their keep:
//
//   1. **Score, don't grab.** A sheet carries both "Phone" and "Additional Phone(s)"; matching
//      the first header that fits would happily put the secondary number in the primary slot.
//      Candidates are scored (exact known alias beats a loose pattern, secondary markers lose)
//      so "Phone" wins while "Additional Phone(s)" stays available as registry data.
//
//   2. **Registry columns are not contact fields.** CVR numbers, protection flags and *source
//      URLs* must never be mistaken for a website or a phone number — they belong in `extra`,
//      where the cockpit shows them as registry metadata.
//
//   3. **Two passes.** Strict aliases first, then a loose pass for headers that only a human
//      could love ("Tlf. nr", "E-mailadresse"). Whatever survives both lands in `extra`, so a
//      column this file has never heard of is stored rather than silently dropped.

// A header that is registry metadata, never a contact field.
const REGISTRY_ONLY = /(?:^|[^a-z0-9])(?:cvr|advertising[\s_-]*protection|source[\s_-]*(?:url|link)s?)(?:[^a-z0-9]|$)/i;

// "Additional Phone(s)", "Secondary email", "Alt. mobil" — worth having, but never worth
// winning over the primary column when both are present.
const SECONDARY = /(?:^|[^a-z0-9])(?:additional|secondary|alternate|alternative|other|extra|ekstra|sekund(?:ær|aer)|alt)\.?(?:[^a-z0-9]|$)/i;

// Lowercase, punctuation-free, space-free: "Owner Name(s)" and "owner_name" both become
// "ownernames" / "ownername", so an alias list can be written the way a person would say it.
export const normalizeHeader = (h) => String(h ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9æøå]+/g, ' ')
  .trim()
  .replace(/\s+/g, '');

/**
 * Every field the importer can fill.
 *
 * `priority` decides who gets first claim on a header: "Company Name" contains the word "name",
 * so the company target has to look at it before the name target does. `loose` is the second
 * pass, used only when the strict pass left the field empty.
 */
export const IMPORT_TARGETS = [
  {
    id: 'email', label: 'Email', priority: 1,
    aliases: ['email', 'emailaddress', 'emailadresse', 'mail', 'mailadresse', 'epost', 'epostadresse'],
    re: /e-?mail|mailadresse|epost/i,
    loose: /(e-?mail|mail)/i,
  },
  {
    id: 'phone', label: 'Phone number', priority: 2,
    aliases: ['phone', 'phonenumber', 'phonenr', 'primaryphone', 'telefon', 'telefonnr', 'telefonnummer', 'tlf', 'tlfnummer', 'mobil', 'mobilnr', 'mobilnummer', 'hovednummer', 'mobile', 'cell', 'cellphone', 'contactno', 'whatsapp'],
    re: /phone|telefon|tlf|mobil|cell|whatsapp|contact[\s_-]*no/i,
    loose: /(telefon|tlf|mobil|phone|tel)[\s_.-]?(nr|nummer|number|no)?/i,
  },
  {
    id: 'company', label: 'Company', priority: 3,
    aliases: ['company', 'companyname', 'virksomhed', 'virksomhedsnavn', 'selskab', 'selskabsnavn', 'firma', 'firmanavn', 'organisation', 'organization', 'employer', 'business'],
    re: /company|organi[sz]ation|business|employer|firm|virksomhed|selskab|firma/i,
    loose: /(firma|virksomhed|selskab|company|organisation|organization)/i,
  },
  {
    id: 'website', label: 'Website', priority: 4,
    aliases: ['website', 'web', 'webadresse', 'hjemmeside', 'url', 'domain', 'domæne', 'linkedin', 'linkedinurl'],
    re: /website|hjemmeside|webadresse|domain|domæne|linkedin|url/i,
    loose: /(website|hjemmeside|web|url|domain|linkedin)/i,
  },
  {
    id: 'notes', label: 'Notes', priority: 5,
    aliases: ['notes', 'note', 'noter', 'marketingnotes', 'marketingnoter', 'bemærkning', 'bemærkninger', 'kommentar', 'kommentarer', 'comment', 'comments', 'remarks'],
    re: /note|noter|bemærkning|kommentar|comment/i,
    loose: /(noter?|bemærkning|kommentar|notes?|comment|marketing[\s_-]*notes)/i,
  },
  {
    id: 'title', label: 'Job title', priority: 6,
    aliases: ['title', 'jobtitle', 'designation', 'role', 'position', 'stilling', 'titel', 'rolle', 'category', 'kategori', 'trade', 'branche', 'fag', 'erhverv'],
    re: /title|designation|role|position|stilling|titel|rolle|category|kategori|trade|branche|fag/i,
    loose: /(stilling|titel|rolle|title|position|category|trade|branche)/i,
  },
  {
    id: 'location', label: 'Location', priority: 7,
    aliases: ['location', 'city', 'by', 'byen', 'kommune', 'adresse', 'address', 'postnr', 'postnummer', 'zip', 'country', 'land', 'region', 'state'],
    re: /location|city|address|adresse|kommune|postnummer|postnr|country|region|state/i,
    loose: /^(by|city|adresse|address|postnr|postnummer|kommune|location)$/i,
  },
  {
    id: 'first_name', label: 'First name', priority: 8,
    aliases: ['firstname', 'fname', 'givenname', 'given', 'fornavn'],
    re: /first[\s_-]*name|fornavn|fname|given/i,
    loose: /(first[\s_-]*name|fornavn)/i,
  },
  {
    id: 'last_name', label: 'Last name', priority: 9,
    aliases: ['lastname', 'lname', 'surname', 'familyname', 'familienavn', 'efternavn'],
    re: /last[\s_-]*name|efternavn|lname|surname|family/i,
    loose: /(last[\s_-]*name|efternavn|surname)/i,
  },
  {
    id: 'name', label: 'Full name', priority: 10,
    aliases: ['name', 'fullname', 'fuldenavn', 'ownername', 'ownernames', 'owner', 'owners', 'contactname', 'kontaktperson', 'kunde', 'kundenavn', 'navn', 'ejer', 'ejere', 'ejernavn', 'indehaver', 'indehavere', 'beslutningstager', 'decisionmaker'],
    re: /name|navn|owner|ejer|indehaver|kontaktperson|kunde|decision[\s_-]*maker/i,
    loose: /(navn|name|owner|ejer|indehaver)/i,
  },
];

const byPriority = [...IMPORT_TARGETS].sort((a, b) => a.priority - b.priority);

/** 100 for a known alias, 60 for a pattern match, and a haircut for secondary columns. */
function scoreHeader(header, target, strict) {
  const penalty = SECONDARY.test(header) ? -45 : 0;
  if (strict) {
    if (target.aliases.includes(normalizeHeader(header))) return 100 + penalty;
    if (target.re.test(header)) return 60 + penalty;
    return null;
  }
  if (target.loose && target.loose.test(header)) return 40 + penalty;
  return null;
}

function bestHeader(headers, used, target, strict) {
  let best = null;
  for (const h of headers) {
    if (used.has(h) || REGISTRY_ONLY.test(h)) continue;
    const score = scoreHeader(h, target, strict);
    if (score === null) continue;
    // Strictly greater: on a tie the earlier column in the sheet wins, which is the one the
    // person who built the spreadsheet put first.
    if (!best || score > best.score) best = { header: h, score };
  }
  return best ? best.header : null;
}

/**
 * Guess a column mapping for a sheet's headers.
 * @returns {Record<string, string>} target id → header (absent when nothing matched)
 */
export function guessMapping(headers = []) {
  const list = (Array.isArray(headers) ? headers : []).map((h) => String(h ?? ''));
  const mapping = {};
  const used = new Set();

  for (const target of byPriority) {
    const header = bestHeader(list, used, target, true);
    if (header) { mapping[target.id] = header; used.add(header); }
  }
  // Second pass: only the fields still empty, and only with the forgiving patterns. A sheet
  // whose phone column is called "Tlf. nr." is not a sheet worth making somebody map by hand.
  for (const target of byPriority) {
    if (mapping[target.id]) continue;
    const header = bestHeader(list, used, target, false);
    if (header) { mapping[target.id] = header; used.add(header); }
  }
  return mapping;
}

/** Columns that no target claimed: these are stored under the prospect's "More details". */
export function extrasOf(headers = [], mapping = {}) {
  const claimed = new Set(Object.values(mapping).filter(Boolean));
  return (Array.isArray(headers) ? headers : [])
    .map((h) => String(h ?? ''))
    .filter((h) => !claimed.has(h));
}

/** Is there enough mapped to be worth importing? */
export const canImport = (mapping = {}) => !!(
  mapping.phone || mapping.name || mapping.first_name || mapping.email || mapping.company
);

/** Which of these columns will be filed as registry metadata rather than contact fields. */
export const isRegistryHeader = (header) => REGISTRY_ONLY.test(String(header ?? ''));
