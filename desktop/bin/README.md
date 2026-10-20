# In-app telephony engine (optional binary)

Drop a headless Linphone build here and the desktop shell runs **all of its audio inside the
app**: `linphone-daemon` (preferred) or `linphonec`. Both speak the same command dialect and
both capture/play through CoreAudio with Opus/G.711, a jitter buffer and echo cancellation.

```
desktop/bin/linphone-daemon      # preferred
desktop/bin/linphonec            # fallback
```

`desktop/telephony/linphoneDaemon.js` also looks in `Pulse Dialer.app/Contents/Resources/linphone/bin`,
`/opt/homebrew/bin`, `/usr/local/bin` and `$PATH`, so a Homebrew install works without copying
anything. Check what this machine resolves with:

```bash
npm run desktop:check
```

Binaries are **not** committed (see `.gitignore`); `npm run desktop:dist` bundles whatever is in
this folder as `Contents/Resources/linphone/bin`.

No binary? Nothing breaks. `PULSE_DESKTOP_ENGINE=auto` falls back to the in-window WebRTC engine,
which also carries audio through CoreAudio — it just cannot survive the window being closed.
