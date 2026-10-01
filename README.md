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

## Data
Everything is stored locally in `data/dialer.db` (SQLite). Back it up by copying that file.
