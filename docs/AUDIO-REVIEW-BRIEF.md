# Audio review brief — Pulse Dialer outbound voice

**For:** a multimodal agent that can listen to audio (e.g. Gemini in Antigravity), working in this
same workspace.
**Goal:** judge how the operator's voice sounds **to the person they called**, from recordings the
daemon produced, and say whether anything needs fixing.
**Write-only deliverable:** `dialer/docs/AUDIO-REVIEW-<YYYY-MM-DD>.md`. Do **not** modify code,
tests, settings, `.env` or `data/dialer.db`. Do not delete recordings. Do not commit.

---

## 1. What to listen to

Recordings live in `dialer/data/recordings/`. Two different artefacts — do not confuse them:

| File | What it is | How to treat it |
| --- | --- | --- |
| `wire-<callId>.wav` | **Only the audio we transmitted** (mic → G.711 → decoded back). This is what the carrier received. | **Primary evidence.** Judge the operator's voice from this. |
| `call-<id>.wav` | Mic **mixed with the far end** (`recorder.js` mixes both legs). | Secondary. If the other party speaks in it, do not attribute their audio to the operator. |

Attach the `.wav` files to yourself with your audio input and actually listen. Reading header bytes
is not a review.

Preferred order:
1. newest `wire-*.wav` (the operator's own voice, uncontaminated);
2. the matching `call-<id>.wav` for context (what the call sounded like overall);
3. `call-451.wav` as a known-bad reference (RMS −53 dBFS, 86% of energy below 200 Hz — effectively no
   voice, recorded before the microphone was switched). Use it to calibrate "unusable".

---

## 2. Context you must hold

- Path under test: **UDP SIP 5060**, plain RTP, G.711 (PCMU or PCMA depending on the carrier's
  answer). TLS/SRTP/STUN was attempted and **reverted** — ignore mentions of it in the docs.
- Outbound payload type now follows the carrier's answer (`rtp.js` session payload type is live).
- Microphone: **CrystalSound Microphone**, an AI noise-suppression virtual device. Two signatures that
  are *not* bugs: (a) exact digital silence between phrases (it gates), and (b) processing artefacts
  (chopped onsets, "swishing", thin sibilance).
- 8 kHz with roughly 3.4 kHz of bandwidth. It should sound like a telephone; "hi-fi" is the wrong
  expectation.
- Open question: there is **no limiter** before encoding, and the mic meter has been seen at full
  scale. Clipping is a live hypothesis, not a certainty.

---

## 3. Questions to answer, in this order

1. **Intelligibility.** Transcribe the `wire-*.wav` as literally as you can. Report what you heard,
   where you were unsure, and any words you could not resolve. Low-confidence transcription is the
   strongest objective signal that the far end is struggling.
2. **Level.** Too quiet, about right, or too hot? Give numbers (§4).
3. **Clipping / harshness.** On loud syllables, does it crackle, splatter, or sound like it hits a
   ceiling? Name the worst timestamp range.
4. **Buzz, hum or periodic artefacts.** Listen specifically for 50/60 Hz hum or a steady buzz that
   repeats faster than speech. This project has a history of exactly that class of bug — name it if
   you hear even a trace, with timestamps.
5. **Microphone processing.** Do word onsets get swallowed? Does the noise floor pump between
   phrases? Is sibilance unnaturally thin or lisping?
6. **Anything that looks like a codec or packet problem** rather than a microphone problem: clicks,
   dropouts, half-duplex gaps, robotic warble.

For each finding: severity (`blocker` · `annoying` · `cosmetic`), timestamp range, and the evidence.

---

## 4. Numbers to include (cheap — do not skip them)

Node 24 is installed. Substitute the real file name:

```bash
node -e '
const fs=require("fs");
const p=process.argv[1];const b=fs.readFileSync(p);
let o=12,fmt,data;
while(o+8<=b.length){const id=b.toString("ascii",o,o+4),sz=b.readUInt32LE(o+4),bo=o+8;
 if(id==="fmt ")fmt={ch:b.readUInt16LE(bo+2),rate:b.readUInt32LE(bo+4),bits:b.readUInt16LE(bo+14)};
 else if(id==="data")data=b.subarray(bo,Math.min(bo+sz,b.length));
 o=bo+sz+(sz%2);}
const x=new Int16Array(data.buffer,data.byteOffset,Math.floor(data.byteLength/2));
let peak=0,sq=0,clip=0,zc=0,prev=0,run=0,maxrun=0;
for(const v of x){const a=Math.abs(v);if(a>peak)peak=a;sq+=v*v;if(a>=32700)clip++;
 if((v>=0)!==(prev>=0))zc++;prev=v;if(a<8){run++;if(run>maxrun)maxrun=run;}else run=0;}
const db=v=>v<=0?"-inf":(20*Math.log10(v/32768)).toFixed(1);
console.log(p.split("/").pop(),(x.length/fmt.rate).toFixed(2)+"s",fmt.rate+"Hz",fmt.ch+"ch");
console.log("peak",peak+" ("+db(peak)+" dBFS)","rms",Math.sqrt(sq/x.length).toFixed(0)+" ("+db(Math.sqrt(sq/x.length))+" dBFS)");
console.log("clipped",clip,"("+(100*clip/x.length).toFixed(3)+"%)","zcr",(zc/(x.length/fmt.rate)).toFixed(0)+"/s","longest near-silence",(maxrun/fmt.rate*1000).toFixed(0)+"ms");
' dialer/data/recordings/wire-<callId>.wav
```

Baselines measured earlier on healthy (mixed) recordings: peak ≈ −2.4 dBFS, RMS ≈ −17 dBFS, clipping
0.000%, dominant energy 227–234 Hz, >87% of energy in 200–3400 Hz and <0.3% above 3.4 kHz. Treat those
as the shape of "fine", not as targets.

---

## 5. Report format

```markdown
# Audio review — <date>

## Files reviewed
| file | duration | peak dBFS | RMS dBFS | clipped % | notes |

## Transcription of wire-<id>.wav
<literal transcript, with [unclear] markers>

## Findings
| # | severity | timestamps | finding | evidence |

## Verdict
- Is the operator intelligible to the far end? yes / partly / no — with the reason.
- Is the problem (if any) in the microphone chain, the encoding, or the recording? Name one.
- Recommended next step: none · limiter before g711.encode · adjust CrystalSound · investigate
  (say exactly what to measure next).
```

---

## 6. Rules

- Judge only what is in the file. Do not infer the far end's opinion from a `call-*.wav` mix.
- If a file is mostly the other party speaking, say so and skip it rather than blaming the operator.
- If you cannot actually listen to an attachment, say so plainly instead of describing what such a
  file usually sounds like. An honest "I could not hear it" beats a plausible guess.
- Cite numbers and timestamps for every claim. "Sounds fine" without evidence is not a review.

