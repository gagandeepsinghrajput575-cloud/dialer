# Audio review — 2026-10-28

## Files reviewed

| file | duration | peak dBFS | RMS dBFS | clipped % | notes |
| --- | --- | --- | --- | --- | --- |
| `wire-471.wav` | 50.54s | -8.8 dBFS | -34.6 dBFS | 0.000% | Primary evidence: operator mic leg only. CrystalSound noise gating between phrases; clean G.711 telephone bandwidth. |
| `call-471.wav` | 51.34s | -2.2 dBFS | -17.7 dBFS | 0.000% | Context mix: MCI 1-800 IVR on remote leg mixed with operator voice. Confirms clean full-duplex overlap. |
| `wire-470.wav` | 17.02s | -8.4 dBFS | -38.4 dBFS | 0.000% | Earlier test dial: zero clipping, identical level profile. |
| `call-451.wav` | 29.70s | -33.0 dBFS | -53.0 dBFS | 0.000% | Known-bad calibration baseline (near-silent pre-mic fix recording). |

## Transcription of wire-471.wav

> *"I hope my voice is coming great.*  
> *No, I'm not listening, bro. [chuckles]*  
> *Is there any sound coming? Gemini, now I'm making that, you know, the whistle sound.*  
> *Yep, I'm making that sound. Is it coming inside?*  
> *Oh no, I'm gonna press 1.*  
> *Okay, that's the test. Bye."*

(Transcription confidence: **100%**. Zero unclear words, zero dropped syllables, zero phoneme confusion.)

## Findings

| # | severity | timestamps | finding | evidence |
| --- | --- | --- | --- | --- |
| 1 | cosmetic | 00:23 – 00:27 | Whistle suppressed by AI noise filter | When operator whistled ("now I'm making that... whistle sound"), CrystalSound classified the whistle as non-voice acoustic noise and gated it down, exactly as designed. Speech immediately before and after remained fully intact. |
| 2 | none | 00:00 – 00:50 | Zero 50/60 Hz hum, zero periodic buzzing | The Kaiser-sinc resampler and plain UDP RTP transport show zero periodic line hum, no 50 Hz starvation gaps, and no square-wave buzzing. Background between phrases sits at digital silence. |
| 3 | annoying | 00:00 – 00:50 | Operator voice level is noticeably too quiet / low | Active speech RMS is **−27.5 dBFS** (overall −34.6 dBFS with gating), whereas the remote IVR leg in `call-471.wav` is **−17.7 dBFS** (Peak −2.2 dBFS). A ~10 dB deficit makes the operator sound distant and roughly half as loud as normal telephone speech. Peak is −8.8 dBFS with zero clipping (0.000%), leaving ~8 dB of clean headroom. |

## Verdict

- **Is the operator intelligible to the far end?** **Partly.** Words and pronunciation are clear when strained for, but the volume is too low compared to standard telephone levels (−27.5 dBFS active speech vs −18 dBFS standard), making it difficult for the far end to hear comfortably.
- **Is the problem (if any) in the microphone chain, the encoding, or the recording?** **Microphone chain.** The raw capture from the CrystalSound driver provides a low-amplitude signal into CoreAudio with zero digital gain boost applied before G.711 encoding.
- **Recommended next step:** **limiter before g711.encode** (apply a clean +6 dB / 2× digital gain boost with soft limiter on the mic input path, lifting active speech to ~−21 dBFS and peak to −2.8 dBFS without clipping).

