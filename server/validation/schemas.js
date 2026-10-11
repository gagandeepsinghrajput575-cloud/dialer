// Zod schemas for every write endpoint. Controllers validate with `validate()` from the
// middleware, so bad payloads get a 400 with per-field details instead of a crash.
const { z } = require('zod');
const { STAGES, OUTCOMES, SOFTPHONE_PROTOCOLS, TELEPHONY_MODES } = require('../config/defaults');

const AI_PROVIDERS = ['local', 'openai', 'gemini'];
// A null from a CSV cell or a JSON client means "empty", not "invalid" — accept it and
// normalize to '' so the services never have to special-case it. The `.optional()` has to be
// the OUTERMOST wrapper: an absent key must stay absent, otherwise every settings save would
// materialize '' for keys the client never sent and wipe the stored values.
const nullable = (schema) => z.union([schema, z.null()]).transform((v) => (v === null ? '' : v)).optional();
const str = (max = 500) => nullable(z.string().max(max));
const maybeStr = (max = 500) => nullable(z.union([z.string().max(max), z.number(), z.boolean()]));
// Accepts true/false and '1'/'0' from HTML forms, stores the canonical '1'/'0'.
const boolish = z.union([z.boolean(), z.string(), z.number()])
  .transform((v) => (v === true || v === 1 || v === '1' || v === 'true' ? '1' : '0'));
const count = z.coerce.number().int().min(0).max(1000000).transform(String);
// The dialer's timer reports fractional seconds — accept them and round, as the old API did.
const seconds = z.coerce.number().min(0).max(86400).transform((v) => Math.round(v));
const phoneish = nullable(z.union([z.string().max(64), z.number()]));

// 'YYYY-MM-DD' (what <input type="date"> posts) or a full local/UTC timestamp. Anything
// else used to be stored verbatim and then quietly turned into Invalid Date downstream.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const datetime = (max = 40) => z.string().max(max).regex(DATETIME_RE, 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM');
// Clearing a date is a real action: the follow-up field posts '' when the agent empties it, and
// before this the API answered 400, so a scheduled follow-up could never be un-scheduled from
// the UI — it just kept re-ranking to the top of the queue at score 95. An empty string now
// means the same thing as null: no follow-up.
const nullableDatetime = (max = 40) => z.union([datetime(max), z.literal(''), z.null()])
  .transform((v) => (v === '' ? null : v));

const prospectCreate = z.object({
  name: maybeStr(200),
  phone: phoneish,
  email: maybeStr(320),
  company: maybeStr(200),
  title: maybeStr(200),
  location: maybeStr(200),
  website: maybeStr(320),
  extra: z.record(z.string(), z.any()).optional(),
  stage: z.enum(STAGES).optional(),
});

const prospectPatch = prospectCreate.partial().extend({
  dnc: boolish.optional(),
  follow_up_at: nullableDatetime().optional(),
});

// At least one identifying field, otherwise an empty POST silently creates a blank row.
const prospectCreateStrict = prospectCreate.refine(
  (v) => ['name', 'phone', 'email', 'company'].some((k) => String(v[k] ?? '').trim().length > 0),
  { message: 'Give the prospect a name, phone, email or company', path: ['name'] }
);

// A real 50k-row export must import in one go; the cap exists to keep the request sane.
const bulkImport = z.object({
  rows: z.array(z.record(z.string(), z.any())).max(50000),
  // `notes` is a first-class target alongside the prospect fields, so the mapping is a free
  // record rather than an enum — the import screen decides what it can map to.
  mapping: z.record(z.string(), z.string()).optional().default({}),
  skipDuplicates: z.boolean().optional().default(true),
});

// Bulk management. The id list is bounded (a select-all on a huge list pages through the table
// 400 rows at a time) but deduplication happens in the service, not here, so a caller that
// repeats an id still gets the honest count back.
const bulkIds = z.array(z.union([z.number().int().positive(), z.string().trim().min(1).max(20)]))
  .min(1, 'Select at least one prospect')
  .max(1000, 'Too many prospects in one action — narrow the selection');
const bulkStage = z.object({ ids: bulkIds, stage: z.enum(STAGES, { message: 'Unknown stage' }) });
const bulkDelete = z.object({ ids: bulkIds });

const callStart = z.object({ tzOffset: z.coerce.number().optional() });

const callPatch = z.object({
  outcome: z.enum(OUTCOMES).optional(),
  duration_sec: seconds.optional(),
  vm_dropped: boolish.optional(),
  follow_up_at: nullableDatetime().optional(),
  summary: z.string().max(4000).optional(),
  next_step: z.string().max(1000).optional(),
});

const voicemailDrop = z.object({
  duration_sec: seconds.optional(),
  follow_up_at: datetime().optional(),
});

const noteCreate = z.object({ body: z.string().trim().min(1, 'Write something first').max(20000) });
const notePatch = z.object({ body: z.string().max(20000) });

const settingsUpdate = z.object({
  telephony_mode: z.enum(TELEPHONY_MODES).optional(),
  softphone_protocol: z.enum(SOFTPHONE_PROTOCOLS).optional(),
  // ---- Telnyx SIP connection ----
  // The FQDN is validated as a hostname rather than free text: a stray scheme or a trailing
  // slash here produces a dial URI no softphone can parse, and it would fail silently.
  telnyx_sip_server: str(200).refine((v) => {
    const t = String(v || '').trim();
    if (!t) return true;                      // empty falls back to sip.telnyx.com
    if (!/^[a-z0-9.-]+(:\d{2,5})?$/i.test(t)) return false;
    return t.includes('.');
  }, 'Use a SIP domain like sip.telnyx.com (no scheme, no path)').optional(),
  telnyx_sip_user: str(200).optional(),
  telnyx_sip_password: str(500).optional(),
  telnyx_api_key: str(500).optional(),
  telnyx_connection_id: str(200).optional(),
  caller_id: str(64).optional(),
  caller_id_pool: str(1000).optional(),
  caller_id_cursor: count.optional(),
  default_country_code: z.string().regex(/^\+?\d{1,4}$/, 'Country code must be 1-4 digits').optional(),
  dry_run: boolish.optional(),
  daily_goal: count.optional(),
  daily_cap: count.optional(),
  business_tz: str(64).optional(),
  business_hours_start: z.string().regex(/^\d{1,2}:\d{2}$/, 'Use HH:MM').optional(),
  business_hours_end: z.string().regex(/^\d{1,2}:\d{2}$/, 'Use HH:MM').optional(),
  business_days: z.string().regex(/^[1-7](,[1-7])*$/, 'Use 1-7 (Monday = 1)').optional(),
  queue_smart_sort: boolish.optional(),
  vm_auto_advance: boolish.optional(),
  vm_greeting: str(200).optional(),
  ai_provider: z.enum(AI_PROVIDERS).optional(),
  ai_model: str(120).optional(),
  ai_api_key: str(500).optional(),
  agent_name: str(200).optional(),
  followup_email_template: nullable(z.string().max(8000)).optional(),
  sound_cues: boolish.optional(),
  // ---- outbound SMTP ----
  // Deliberately *not* hostname-validated: 'local' is a meaningful value here, not a typo. It
  // selects the catch-all sink that captures mail into the outbox instead of transmitting it.
  smtp_host: str(253).optional(),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  smtp_secure: boolish.optional(),
  smtp_user: str(320).optional(),
  smtp_pass: str(500).optional(),
  smtp_from: str(320).optional(),
  smtp_reply_to: str(320).optional(),
  meet_link: nullable(z.string().max(500)).optional(),
  email_verify_deep: boolish.optional(),
  // ---- in-browser WebRTC softphone ----
  // Every one of these must also exist in config/defaults DEFAULTS — this schema strips
  // unknown keys, so a setting missing here is silently un-settable. Group 2 of the test
  // suite asserts the two lists stay in step.
  webrtc_ws_url: str(300).optional(),
  webrtc_credential_handoff: boolish.optional(),
  webrtc_mic_device: str(200).optional(),
  webrtc_speaker_device: str(200).optional(),
});

const followUpSchedule = z.object({ at: datetime() });
const emailRender = z.object({ noteText: z.string().max(8000).optional(), at: z.string().max(40).optional() });
const softphoneTest = z.object({ number: z.union([z.string().max(64), z.number()]).optional() });
const searchQuery = z.object({ q: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
// Becomes part of a file name, so it is reduced to a safe slug before it reaches the disk.
const backupCreate = z.object({ reason: z.string().max(60).optional() });

// ---- email ----
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const emailAddress = z.string().trim().min(3).max(254).regex(EMAIL_RE, 'Not a validly shaped email address');
const emailVerify = z.object({ email: emailAddress, deep: z.boolean().optional() });
const emailVerifyBatch = z.object({ emails: z.array(z.string().trim().max(320)).min(1).max(500) });
const emailSend = z.object({
  // A comma-separated string is accepted too, since that is how people paste recipients —
  // but every part still has to be a real address, or "nope" would sail through the union.
  to: z.union([
    emailAddress,
    z.array(emailAddress).min(1).max(20),
    z.string().trim().min(3).max(2000).refine(
      (v) => v.split(',').map((x) => x.trim()).filter(Boolean).every((x) => EMAIL_RE.test(x)),
      'Every address in that list must be a validly shaped email',
    ),
  ]),
  subject: z.string().trim().min(1, 'The email needs a subject').max(300),
  body: z.string().max(200000),
  html: z.string().max(400000).optional(),
  attachments: z.array(z.string().max(64)).max(5).optional(),
  replyTo: z.string().max(320).optional(),
  prospectId: z.coerce.number().int().positive().optional(),
  // Sending past a failed verification requires an explicit override, not just a click.
  force: z.boolean().optional(),
});
const emailDraft = z.object({ noteText: z.string().max(8000).optional(), at: z.string().max(40).optional() });
// Pagination + search for the local outbox. Coerced, because query strings are always text.
const outboxQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
  q: z.string().trim().max(120).optional(),
});
const queueQuery = z.object({
  tab: z.enum(['new', 'follow', 'all']).optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().max(256).optional(),
});

module.exports = {
  AI_PROVIDERS, DATETIME_RE, prospectCreate, prospectCreateStrict, prospectPatch, bulkImport, callStart,
  callPatch, voicemailDrop, noteCreate, notePatch, settingsUpdate, followUpSchedule, emailRender,
  softphoneTest, searchQuery, queueQuery, backupCreate,
  emailVerify, emailVerifyBatch, emailSend, emailDraft, outboxQuery,
  bulkStage, bulkDelete,
};
