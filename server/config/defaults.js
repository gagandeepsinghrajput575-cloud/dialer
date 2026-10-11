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

const DEFAULTS = {
  // ---- telephony: VOIP.SO + desktop softphone (Denmark) ----
  telephony_mode: 'softphone', // 'softphone' (Zoiper/Linphone) or 'webrtc'
  softphone_protocol: 'sip', // 'sip' (sip:...) or 'tel' (tel:...)
  voipso_sip_server: 'sip.voip.so', // VOIP.SO SIP server domain
  voipso_sip_user: '', // VOIP.SO SIP account / extension
  voipso_sip_password: '', // secret — local DB only, never sent to the browser
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
  // ---- post-call copilot ----
  ai_provider: 'local', // 'local' | 'openai' | 'gemini'
  ai_model: '',
  ai_api_key: '', // secret
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
  // The SIP-over-WebSocket gateway the browser registers against. Empty derives a default
  // from the SIP server below; set it explicitly when your provider uses another port/path.
  webrtc_ws_url: '',
  // The browser cannot register with a SIP server without the SIP password. That is a real
  // tension with the rule that this secret never reaches the browser, so the handoff is an
  // explicit, off-by-default decision rather than something an endpoint does quietly.
  webrtc_credential_handoff: '0',
  webrtc_mic_device: '', // preferred microphone deviceId ('' = browser default)
  webrtc_speaker_device: '', // preferred output deviceId ('' = browser default)
  // ---- UI ----
  sound_cues: '0',
};

const SETTING_KEYS = Object.keys(DEFAULTS);
// Setting key -> the boolean the API exposes instead of the value.
const SECRET_KEYS = { voipso_sip_password: 'has_password', ai_api_key: 'has_api_key', smtp_pass: 'has_smtp_pass' };

const STAGES = ['new', 'contacted', 'interested', 'followup', 'meeting', 'won', 'lost'];
const OUTCOMES = ['no_answer', 'voicemail', 'wrong_number', 'gatekeeper', 'hung_up', 'conversation', 'meeting_booked', 'dnc'];
const PICKUP = ['gatekeeper', 'hung_up', 'conversation', 'meeting_booked'];
const CONVO = ['conversation', 'meeting_booked'];
const FIELDS = ['name', 'phone', 'email', 'company', 'title', 'location', 'website'];

const SOFTPHONE_PROTOCOLS = ['sip', 'tel'];
const TELEPHONY_MODES = ['softphone', 'webrtc'];
// National subscriber length (digits after the country code, no trunk prefix).
const NATIONAL_LENGTH = { 45: 8 };

// Env vars that seed an empty setting on first boot (.env.example documents them).
const ENV_SEEDS = {
  voipso_sip_server: 'VOIPSO_SIP_SERVER',
  voipso_sip_user: 'VOIPSO_SIP_USER',
  voipso_sip_password: 'VOIPSO_SIP_PASSWORD',
  caller_id: 'VOIPSO_CALLER_ID',
  caller_id_pool: 'VOIPSO_CALLER_ID_POOL',
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
