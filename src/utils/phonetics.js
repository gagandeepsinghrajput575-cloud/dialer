// Client-side Danish phonetic pronunciation helpers and Web Speech audio playback

export const DANISH_DICTIONARY = {
  'aage': 'AW-geh',
  'aase': 'AW-seh',
  'aksel': 'AHK-sel',
  'alf': 'AHLF',
  'allan': 'AH-lahn',
  'anders': 'AHN-ders',
  'anette': 'ah-NET-teh',
  'annette': 'ah-NET-teh',
  'arne': 'AHR-neh',
  'asger': 'AHS-ger',
  'bent': 'BENT',
  'bente': 'BEN-teh',
  'birgit': 'BEER-git',
  'birgitte': 'beer-GEET-teh',
  'bjarne': 'BYAR-neh',
  'bjarke': 'BYAR-keh',
  'bjørn': 'BYURN',
  'bo': 'BOH',
  'børge': 'BUR-geh',
  'carl': 'KAHRL',
  'carsten': 'KAHR-sten',
  'christian': 'KRIS-chan',
  'claus': 'KLOWS',
  'dorte': 'DOR-teh',
  'dorthe': 'DOR-teh',
  'ejner': 'EYE-ner',
  'erik': 'EH-rik',
  'esben': 'ES-ben',
  'fayik': 'FAH-yeek',
  'flemming': 'FLEM-eeng',
  'frederik': 'FRED-er-ik',
  'gitte': 'GEET-teh',
  'gunnar': 'GOON-nahr',
  'hanne': 'HAHN-neh',
  'hans': 'HAHNS',
  'helge': 'HEL-geh',
  'henning': 'HEN-eeng',
  'henrik': 'HEN-rik',
  'ib': 'EEB',
  'inge': 'EENG-eh',
  'inger': 'EENG-er',
  'ingrid': 'EENG-reed',
  'jakob': 'YAH-kohb',
  'jacob': 'YAH-kohb',
  'jan': 'YAHN',
  'jannik': 'YAHN-neek',
  'jens': 'YENS',
  'jeppe': 'YEP-peh',
  'jesper': 'YES-per',
  'jim': 'JEEM',
  'johan': 'yo-HAHN',
  'johannes': 'yo-HAHN-nes',
  'john': 'YON',
  'jonas': 'YO-nahs',
  'jørgen': 'YUR-gen',
  'jørn': 'YURN',
  'karl': 'KAHRL',
  'karsten': 'KAHR-sten',
  'kasper': 'KAHS-per',
  'kenn': 'KEN',
  'keld': 'KELL',
  'kjeld': 'KYELL',
  'klaus': 'KLOWS',
  'knud': 'KNOOD',
  'kristian': 'KRIS-chan',
  'lars': 'LAHRS',
  'lasse': 'LAHS-seh',
  'leif': 'LAYF',
  'line': 'LEE-neh',
  'lis': 'LEES',
  'lisbeth': 'LEES-bet',
  'lotte': 'LOT-teh',
  'mads': 'MAHDS',
  'magnus': 'MAHG-noos',
  'malene': 'mah-LEH-neh',
  'martin': 'MAHR-teen',
  'mathias': 'mah-TEE-ahs',
  'mette': 'MET-teh',
  'michael': 'MEE-kel',
  'mikael': 'MEE-kel',
  'mikkel': 'MEEK-kel',
  'mogens': 'MOW-ens',
  'morten': 'MOR-ten',
  'nanna': 'NAHN-nah',
  'niels': 'NEELS',
  'ole': 'OH-leh',
  'oluf': 'OH-loof',
  'palle': 'PAHL-leh',
  'per': 'PEHR',
  'pernille': 'per-NEEL-leh',
  'peter': 'PEH-ter',
  'piet': 'PEET',
  'poul': 'POWL',
  'preben': 'PREH-ben',
  'rasmus': 'RAHS-moos',
  'rene': 'reh-NEH',
  'sanne': 'SAHN-neh',
  'simon': 'SEE-mohn',
  'steen': 'STEEN',
  'stefan': 'STEF-ahn',
  'stig': 'STEEG',
  'svend': 'SVEN',
  'søren': 'SUR-en',
  'tage': 'TAH-geh',
  'thomas': 'TOM-ahs',
  'thorbjørn': 'TOR-byurn',
  'torkil': 'TOR-keel',
  'torben': 'TOR-ben',
  'troels': 'TROHLS',
  'ulla': 'OOL-lah',
  'vagn': 'VAHWN',
  'viggo': 'VEEG-goh',
  'andersen': 'AHN-der-sen',
  'akkas': 'AHK-kahs',
  'bak': 'BAHK',
  'bang': 'BAHNG',
  'bech': 'BEK',
  'beck': 'BEK',
  'berg': 'BEHR',
  'berthelsen': 'BEHR-tel-sen',
  'birkemose': 'BEER-keh-moh-seh',
  'bruun': 'BROON',
  'bundgaard': 'BOON-gor',
  'carlsen': 'KAHRL-sen',
  'christensen': 'KRIS-ten-sen',
  'christiansen': 'kris-CHAN-sen',
  'clausen': 'KLOW-sen',
  'dam': 'DAHM',
  'damgaard': 'DAHM-gor',
  'denhardt': 'DEN-hart',
  'dahl': 'DAHL',
  'eriksen': 'EH-rik-sen',
  'friis': 'FREES',
  'frost': 'FROST',
  'graversen': 'GRAH-ver-sen',
  'hansen': 'HAHN-sen',
  'haugaard': 'HOW-gor',
  'hedegaard': 'HEH-deh-gor',
  'hjorth': 'YORT',
  'holm': 'HOHLM',
  'høj': 'HOY',
  'højbjerg': 'HOY-byer',
  'ingels': 'EENG-els',
  'iversen': 'EE-ver-sen',
  'jakobsen': 'YAH-kohb-sen',
  'jensen': 'YEN-sen',
  'jeppesen': 'YEP-peh-sen',
  'jespersen': 'YES-per-sen',
  'jessen': 'YES-sen',
  'johansen': 'yo-HAHN-sen',
  'jørgensen': 'YUR-gen-sen',
  'juul': 'YOOL',
  'kirkegaard': 'KEER-keh-gor',
  'kjeldsen': 'KYELL-sen',
  'kjær': 'KYAIR',
  'klausen': 'KLOW-sen',
  'knudsen': 'KNOOD-sen',
  'kofoed': 'KOH-fod',
  'koldsgaard': 'KOHLS-gor',
  'kristensen': 'KRIS-ten-sen',
  'krogh': 'KROH',
  'larsen': 'LAHR-sen',
  'lassen': 'LAHS-sen',
  'laursen': 'LOWR-sen',
  'lind': 'LEEND',
  'lindegaard': 'LEEN-deh-gor',
  'lund': 'LOOND',
  'madsen': 'MAHD-sen',
  'mathiesen': 'mah-TEE-sen',
  'meisner': 'MYS-ner',
  'mikkelsen': 'MEEK-kel-sen',
  'mogensen': 'MOW-en-sen',
  'mortensen': 'MOR-ten-sen',
  'møller': 'MUR-ler',
  'munch': 'MOONK',
  'nielsen': 'NEEL-sen',
  'nørgaard': 'NUR-gor',
  'nørring': 'NUR-eeng',
  'nørvig': 'NUR-veeg',
  'nygaard': 'NEE-gor',
  'olsen': 'OHL-sen',
  'overgaard': 'OH-ver-gor',
  'pedersen': 'PEH-der-sen',
  'petersen': 'PEH-ter-sen',
  'poulsen': 'POWL-sen',
  'rasmussen': 'RAHS-moos-sen',
  'ravn': 'RAHWN',
  'riis': 'REES',
  'schmidt': 'SHMEET',
  'schou': 'SKOW',
  'simonsen': 'SEE-mon-sen',
  'skarby': 'SKAHR-bee',
  'steffensen': 'STEF-en-sen',
  'svendsen': 'SVEN-sen',
  'szelak': 'SHEH-lahk',
  'sørensen': 'SUR-en-sen',
  'thomsen': 'TOM-sen',
  'toft': 'TOHFT',
  'vestergaard': 'VES-ter-gor',
  'villadsen': 'VEEL-lahd-sen',
  'winther': 'VEEN-ter',
  'westergaard': 'VES-ter-gor',
  'østergaard': 'UR-ster-gor'
};

export function phoneticWord(word) {
  if (!word) return '';
  const clean = String(word).trim();
  const lower = clean.toLowerCase();
  
  if (DANISH_DICTIONARY[lower]) {
    return DANISH_DICTIONARY[lower];
  }

  if (lower.endsWith('sen') && lower.length > 5) {
    const root = lower.slice(0, -3);
    const rootPhon = DANISH_DICTIONARY[root] || phoneticWord(root);
    return `${rootPhon}-sen`.replace(/-+/g, '-');
  }

  if (lower.endsWith('gaard') || lower.endsWith('gård')) {
    const stem = lower.replace(/g[aå]{1,2}rd$/, '');
    const stemPhon = DANISH_DICTIONARY[stem] || phoneticWord(stem);
    return `${stemPhon}-gor`.replace(/-+/g, '-');
  }

  if (lower.endsWith('bjerg')) {
    const stem = lower.slice(0, -5);
    const stemPhon = DANISH_DICTIONARY[stem] || phoneticWord(stem);
    return `${stemPhon}-byer`.replace(/-+/g, '-');
  }

  let p = lower;
  p = p.replace(/^hj/i, 'Y');
  p = p.replace(/^hv/i, 'V');
  p = p.replace(/^kj/i, 'KY');
  p = p.replace(/^gj/i, 'GY');
  p = p.replace(/^j([aeiouæøå])/i, 'Y$1');
  p = p.replace(/aa|å/g, 'or');
  p = p.replace(/ø/g, 'ur');
  p = p.replace(/æ/g, 'eh');
  p = p.replace(/ch/g, 'k');
  p = p.replace(/ng/g, 'eeng');
  p = p.replace(/qu/g, 'kw');

  if (p.length <= 4) return p.toUpperCase();
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function getDanishPronunciation(fullName) {
  if (!fullName || typeof fullName !== 'string') return '';
  const tokens = fullName
    .replace(/[^\w\sæøåÆØÅ-]/g, '')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);

  if (!tokens.length) return '';
  const respelled = tokens.map((t) => phoneticWord(t));
  return `[${respelled.join(' ')}]`;
}

/**
 * Triggers audio pronunciation using native Web Speech Synthesis.
 */
export function speakPronunciation(name, pronunciation) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const cleanPhonetic = (pronunciation || '').replace(/[\[\]]/g, '').trim();
    const cleanName = (name || '').trim();
    
    // Choose speech text
    const textToSpeak = cleanName || cleanPhonetic;
    if (!textToSpeak) return;

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    const voices = window.speechSynthesis.getVoices() || [];
    const daVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('da'));
    const enVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('en'));

    if (daVoice) {
      utterance.voice = daVoice;
      utterance.lang = 'da-DK';
    } else if (enVoice) {
      utterance.voice = enVoice;
      utterance.text = cleanPhonetic || cleanName;
      utterance.lang = 'en-US';
    }
    utterance.rate = 0.88;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Graceful silence if audio permissions or speech synthesis unsupported
  }
}
