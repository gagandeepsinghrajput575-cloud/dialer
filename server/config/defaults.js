// Settings defaults + the domain constants shared by every layer.
const DEFAULT_FOLLOWUP_EMAIL = [
  'Hej {{name}},',
  '',
  'Tak for snakken tidligere. Som lovet sender jeg lidt mere om, hvordan vi hjælper',
  'virksomheder som {{company}}.',
  '',
  '{{notes}}',
  '',
  'Jeg følger op {{follow_up}} — sig endelig til, hvis et andet tidspunkt passer bedre.',
  '',
  'Mvh',
  '{{agent}}',
].join('\n');

const DEFAULT_SALES_SCRIPT = [
  '# Cold Call Script & Objection Battlecard',
  '',
  '## 1. Opening Hook (0-15s)',
  '- "Hej [Navn], det er [Mit Navn] fra [Firma]. Har du 30 sekunder, eller fanger jeg dig midt i noget?"',
  '- Mål: Respekter deres tid og opnå tilladelse til samtalen.',
  '',
  '## 2. Reason & Value Proposition (15-45s)',
  '- "Grunden til jeg ringer er, at vi hjælper virksomheder som [Firma] med at få kvalificerede opgaver direkte i kalenderen."',
  '- Pain point: Mange spilder tid på henvendelser, der aldrig bliver til reelle aftaler.',
  '',
  '## 3. Qualifying Questions (45-75s)',
  '- "Hvordan ser jeres kapacitet ud for de kommende 2-3 måneder?"',
  '- "Er der specifikke projekter eller kunder, I helst vil have flere af?"',
  '',
  '## 4. Objection Handling',
  '- "Vi har for travlt": "Forståeligt! Netop derfor tager vi kun 10 minutter over Meet, så du ved hvad mulighederne er til når I har luft."',
  '- "Send en mail": "Det gør jeg meget gerne. Hvad er den bedste mailadresse? For at gøre den relevant: hvilke typer opgaver foretrækker I mest?"',
  '- "Vi bruger allerede nogen": "Det er godt at høre. Vi erstatter dem ikke nødvendigvis, men giver jer et benchmark på markedet."',
  '',
  '## 5. Close for Meeting',
  '- "Lad os tage en uforpligtende 10-minutters snak over Google Meet på tirsdag kl. 10 eller torsdag kl. 13 — hvad passer bedst?"',
].join('\n');

const DEFAULTS = {
  // ---- telephony: Telnyx + desktop softphone (Denmark) ----
  telephony_mode: 'softphone', // 'softphone' (Zoiper/Linphone) or 'webrtc'
  softphone_protocol: 'sip', // 'sip' (sip:...) or 'tel' (tel:...)
  telnyx_sip_server: 'sip.telnyx.com', // Telnyx SIP connection domain (FQDN)
  telnyx_sip_user: '', // Telnyx SIP connection username
  telnyx_sip_password: '', // secret — local DB only, never sent to the browser
  telnyx_api_key: '', // secret — Telnyx v2 API key (KEY...) for carrier management
  telnyx_connection_id: '', // optional Telnyx SIP Connection ID
  caller_id: '', // primary Danish (+45) virtual number
  caller_id_pool: '', // comma separated DIDs, rotated round-robin per dial
  caller_id_cursor: '0', // index of the next DID to use (survives restarts)
  default_country_code: '45', // Denmark (+45)
  // ---- safety rails ----
  dry_run: '1', // default safe test mode
  daily_goal: '80',
  daily_cap: '150',
  // ---- Danish calling window ----
  business_tz: 'Europe/Copenhagen',
  business_hours_start: '08:30',
  business_hours_end: '16:30',
  business_days: '1,2,3,4,5', // Mon..Fri (1 = Monday)
  // ---- queue intelligence ----
  queue_smart_sort: '1',
  vm_auto_advance: '1', // V (voicemail drop) advances to the next prospect instantly
  vm_greeting: '', // filename inside data/audio
  // ---- post-call copilot & AI audio coach ----
  ai_provider: 'local', // 'local' | 'openai' | 'gemini' | 'openrouter'
  ai_model: '',
  ai_api_key: '', // secret
  sales_script: DEFAULT_SALES_SCRIPT, // cold calling target script & objection battlecard
  // ---- agent + follow-up email ----
  agent_name: '', // your name, used in the follow-up email template
  followup_email_template: DEFAULT_FOLLOWUP_EMAIL,
  // ---- outbound SMTP (sending real email from the app) ----
  smtp_host: '',
  smtp_port: '587',
  smtp_secure: '0', // 1 = implicit TLS on connect (port 465); 0 = STARTTLS (port 587)
  smtp_user: '',
  smtp_pass: '', // secret — masked like the SIP password
  smtp_from: '', // defaults to smtp_user when empty
  smtp_reply_to: '', // so replies land in your inbox, not the SMTP account
  // ---- Google Meet ----
  meet_link: '', // your standing meeting link; {{meet_link}} inserts it into the template
  email_verify_deep: '0', // SMTP RCPT probing — see emailService.js for why it is off
  // ---- in-browser WebRTC softphone (telephony_mode: 'webrtc') ----
  // The SIP-over-WebSocket gateway the browser registers against. Empty means Telnyx's own
  // gateway (wss://rtc.telnyx.com) — a fixed endpoint, not a port/path derived from the SIP
  // server. Set it explicitly only to point at a different gateway or a proxy.
  webrtc_ws_url: '',
  // The browser cannot register with a SIP server without the SIP password. That is a real
  // tension with the rule that this secret never reaches the browser, so the handoff is an
  // explicit, off-by-default decision rather than something an endpoint does quietly.
  webrtc_credential_handoff: '0',
  webrtc_mic_device: '', // preferred microphone deviceId ('' = browser default)
  webrtc_speaker_device: '', // preferred output deviceId ('' = browser default)
  // ---- FlyNumber Copenhagen Inbound DID (+45 32 33 16 10) ----
  flynumber_did: '+4532331610',
  flynumber_status: 'pending', // 'pending' | 'active'
  flynumber_sip_server: 'sip.flynumber.com',
  flynumber_sip_user: '',
  flynumber_sip_password: '', // secret — local DB only, masked from browser
  flynumber_linphone_configured: '0',
  telnyx_caller_id_verified: '0',
  inbound_routing_mode: 'flynumber_sip', // 'flynumber_sip' | 'linphone' | 'disabled'
  // ---- UI ----
  sound_cues: '0',
};

const SETTING_KEYS = Object.keys(DEFAULTS);
// Setting key -> the boolean the API exposes instead of the value.
// Setting key -> the boolean the API exposes instead of the value. One flag per secret: two
// secrets sharing a flag would make "do you have one?" answer for the wrong one.
const SECRET_KEYS = {
  telnyx_sip_password: 'has_password',
  telnyx_api_key: 'has_api_key',
  flynumber_sip_password: 'has_flynumber_password',
  ai_api_key: 'has_ai_key',
  smtp_pass: 'has_smtp_pass',
};

const STAGES = ['new', 'contacted', 'interested', 'followup', 'meeting', 'won', 'lost'];
const OUTCOMES = ['no_answer', 'voicemail', 'wrong_number', 'gatekeeper', 'hung_up', 'conversation', 'meeting_booked', 'dnc'];
const PICKUP = ['gatekeeper', 'hung_up', 'conversation', 'meeting_booked'];
const CONVO = ['conversation', 'meeting_booked'];
const FIELDS = ['name', 'phone', 'email', 'company', 'title', 'location', 'website', 'pronunciation'];

const SOFTPHONE_PROTOCOLS = ['sip', 'tel'];
const TELEPHONY_MODES = ['softphone', 'webrtc'];
// National subscriber length (digits after the country code, no trunk prefix).
const NATIONAL_LENGTH = { 45: 8 };

// Env vars that seed an empty setting on first boot (.env.example documents them).
const ENV_SEEDS = {
  telnyx_sip_server: 'TELNYX_SIP_SERVER',
  telnyx_sip_user: 'TELNYX_SIP_USER',
  telnyx_sip_password: 'TELNYX_SIP_PASSWORD',
  telnyx_api_key: 'TELNYX_API_KEY',
  telnyx_connection_id: 'TELNYX_CONNECTION_ID',
  caller_id: 'TELNYX_CALLER_ID',
  caller_id_pool: 'TELNYX_CALLER_ID_POOL',
  flynumber_did: 'FLYNUMBER_DID',
  flynumber_status: 'FLYNUMBER_STATUS',
  flynumber_sip_server: 'FLYNUMBER_SIP_SERVER',
  flynumber_sip_user: 'FLYNUMBER_SIP_USER',
  flynumber_sip_password: 'FLYNUMBER_SIP_PASSWORD',
  ai_api_key: 'PULSE_AI_API_KEY',
  ai_provider: 'PULSE_AI_PROVIDER',
  ai_model: 'PULSE_AI_MODEL',
  // Outbound email — seeds settings on first boot only, so the UI stays the source of truth
  // afterwards and a later .env edit cannot silently override what you typed.
  smtp_host: 'SMTP_HOST',
  smtp_port: 'SMTP_PORT',
  smtp_secure: 'SMTP_SECURE',
  smtp_user: 'SMTP_USER',
  smtp_pass: 'SMTP_PASS',
  smtp_from: 'SMTP_FROM',
  smtp_reply_to: 'SMTP_REPLY_TO',
  meet_link: 'PULSE_MEET_LINK',
  webrtc_ws_url: 'PULSE_WEBRTC_WS_URL',
};

module.exports = {
  DEFAULTS, SETTING_KEYS, SECRET_KEYS, ENV_SEEDS,
  STAGES, OUTCOMES, PICKUP, CONVO, FIELDS,
  SOFTPHONE_PROTOCOLS, TELEPHONY_MODES, NATIONAL_LENGTH,
  DEFAULT_FOLLOWUP_EMAIL,
};
