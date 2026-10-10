# Pulse Dialer: Sonetel dialer + mini CRM

Upload a prospect list, click **Call**, and Sonetel rings your softphone/phone first, then dials the prospect.
The prospect's full details, notes and pipeline stage stay on screen the whole time.

## Run it
```bash
npm install
npm run app        # builds the UI and starts everything on http://localhost:3001
```
For UI development use `npm run dev` (Vite on :5173 + API on :3001).

## First-time setup (in the app → Settings)
1. Enter your Sonetel login email + password, then press **Test connection**.
2. Set **Your phone / SIP address**: where Sonetel should ring you first (your Sonetel SIP address like `you@yourdomain.com`
   registered in Zoiper/Linphone, or your mobile in +country format).
3. Turn **Test mode OFF** when you're ready for real calls. Test mode simulates calls and never dials.

You can also put credentials in a `.env` file (see `.env.example`) instead of the Settings page.

## Keyboard shortcuts (Dialer)
`C` call · `1–8` log result · `←/→` previous/next · `N` focus notes

## Metrics
Pickup = a live person answered (gatekeeper, hung up, conversation, meeting). Voicemail / no answer / wrong number don't count.

## Tests
```bash
npm test          # API integration: boots the server three times on throwaway SQLite files
                  # (core flows, hardening, then the 2000-row queue scale suite)
npm run test:ui   # UI: rendered components, the CSS touch-target contract, the real Dialer
                  # mounted in jsdom against a fake backend, then useServerQueue on its own
npm run test:all  # everything
```
`npm test` never reads or writes your real `data/dialer.db` — it points the server at a
temp database via `DB_PATH` and deletes it afterwards. (`node test/all-tests.js` still
works against an already-running server if you want that instead.)

`test/hardening.test.js` and `test/queue.hook.mjs` are regression tests for defects that
were reproduced, minimised and fixed; every one of them was mutation-tested, meaning
reverting its fix turns it red.

## Security
This is a single-operator tool with no login, so the API is protected at the edges rather
than by accounts.

**Any script or integration that writes to the API must send `X-Requested-With: pulse-dialer`.**
Mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`) without it are refused with `403`. Reads
are unaffected. This is the defence that actually matters: tightening CORS only hides a
response, it does not stop the request, and a cross-origin `fetch` with a `text/plain` body
is a "simple request" that the browser sends with no preflight at all — which is enough to
hit `POST /api/prospects/clear` and empty the database. A custom header cannot be set
without a preflight, and the preflight is refused. `src/api.js` sends it automatically.

Also in place:

- **CORS is closed by default.** The client is always same-origin (vite proxies `/api` in
  dev; production serves `dist/` from this same process). To allow another origin, start
  the server with `CORS_ORIGIN=https://portal.example.com` (comma-separated list).
- **CSV export neutralises formula injection.** A cell starting with `=`, `+`, `-`, `@`, a
  tab or a CR is evaluated by Excel/Sheets on open, so an imported lead name could run as a
  formula on your machine. Those cells are exported prefixed with `'`. A leading `+`/`-`
  followed by only digits is left alone, so international phone numbers survive intact.
- **Errors answer as JSON and never leak internals.** The default Express handler was
  returning HTML 500s containing `SqliteError` text and absolute paths from the host.
- **Bounded growth.** `POST /api/demo` stops at 500 prospects (`409` after that) and
  `POST /api/prospects/bulk` rejects more than 100,000 rows per import.
- **Headers:** `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, and `X-Frame-Options: DENY`.
- **Embedding.** `frame-ancestors` defaults to `'none'`. To serve the app inside an iframe
  (a preview proxy or an internal portal), start it with
  `FRAME_ANCESTORS="https://*.example.com"`. `X-Frame-Options` is then omitted, because it
  cannot express an allowlist and would otherwise override the CSP and block the frame.

**Known residual risk:** the `xlsx` package is pinned at `0.18.5`, the last version
published to npm, which carries known prototype-pollution and ReDoS advisories. The fixed
releases are only distributed from `cdn.sheetjs.com`. It is used on one endpoint,
`POST /api/import/parse`, behind a 30MB upload cap — so treat spreadsheet upload as a
trusted-operator action until that dependency can be moved to the upstream registry.

## How the dialer queue works
The queue is paginated on the server, so a 50,000-row list costs the same as a 50-row one:
the browser only ever holds the pages you have scrolled through.

`GET /api/queue?tab=new|follow|all&q=search&limit=50&cursor=<opaque>` returns

```json
{ "items": [...], "total": 64, "counts": { "new": 64, "follow": 48, "all": 128 },
  "hasMore": true, "limit": 50, "tab": "new", "q": "", "nextCursor": "eyJwIjox..." }
```

Filtering (tab, search, Do-Not-Call) and ordering (dialable numbers first, then id) happen
in SQL. Paging is **keyset**, not `OFFSET`: the cursor encodes the last row's sort key, so
inserting or deleting rows while you page can't duplicate or skip anybody. `items` are
byte-identical to `/api/prospects` rows, and that endpoint is unchanged — the Prospects
table, Pipeline and CSV export still see the whole list.

On touch screens every control is at least 44×44px (`@media (pointer: coarse)`); the dense
desktop layout is untouched.

## Data
Everything is stored locally in `data/dialer.db` (SQLite). Back it up by copying that file.
