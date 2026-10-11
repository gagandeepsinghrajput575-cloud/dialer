import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Save, Loader2, Trash2, ShieldCheck, FlaskConical, PhoneCall, Target,
  Headphones, KeyRound, Radio, Globe, PlayCircle, DatabaseBackup, Download, FileJson, FileSpreadsheet,
  Mail, Plug, Video, Mic, MicOff, Volume2, AlertTriangle
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Switch } from '../components/ui.jsx';
import { dispatchDialUri, softphoneLabel } from '../utils.js';
import { listAudioDevices } from '../useWebRtc.js';

const MODES = [
  { id: 'softphone', label: 'Desktop softphone', hint: 'Zoiper · Linphone · Telephone — Pulse hands the number to your OS softphone.' },
  { id: 'webrtc', label: 'In-browser WebRTC softphone', hint: 'The call stays inside Pulse — no Zoiper, no OS app, nothing to install.' },
];
const PROTOCOLS = [
  { id: 'sip', label: 'sip:', hint: 'sip:+4520123456 — Zoiper registers the sip: scheme when you install it.' },
  { id: 'tel', label: 'tel:', hint: 'tel:+4520123456 — macOS Telephone, mobile diallers, some desk-phone apps.' },
];

// Live microphone meter. Talks to the browser directly — no server round-trip, no audio
// uploaded anywhere — and always releases the device when you stop or navigate away.
function MicTester({ deviceId, onGranted }) {
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState('');
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const ctxRef = useRef(null);

  const stop = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    try { for (const t of streamRef.current?.getTracks() || []) t.stop(); } catch { /* ignore */ }
    streamRef.current = null;
    try { if (ctxRef.current && ctxRef.current.state !== 'closed') ctxRef.current.close(); } catch { /* ignore */ }
    ctxRef.current = null;
    setLevel(0);
    setOn(false);
  }, []);

  // Releasing the mic on unmount matters: an open device keeps the browser's recording
  // indicator on and is impossible to explain away.
  useEffect(() => () => stop(), [stop]);

  const start = useCallback(async () => {
    setErr('');
    const md = navigator?.mediaDevices;
    if (!md?.getUserMedia) { setErr('This browser has no microphone API (navigator.mediaDevices is missing).'); return; }
    try {
      const stream = await md.getUserMedia({ audio: deviceId ? { deviceId: { ideal: deviceId } } : true });
      streamRef.current = stream;
      setOn(true);
      onGranted?.();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return; // device is open; we just cannot draw a level for it
      const ctx = new Ctx();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        setLevel((l) => Math.max(peak, l * 0.72)); // fast attack, slow decay — reads like a VU meter
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setErr(denied ? 'Microphone permission was refused. Allow it for this site and try again.' : `Could not open the microphone: ${e?.message || e}`);
      setLevel(0);
      setOn(false);
    }
  }, [deviceId, onGranted]);

  return (
    <div className="mic-test">
      <div className="mic-test-head">
        <b><Mic size={15} /> Test microphone</b>
        {on
          ? <button className="btn sm danger" onClick={stop}><MicOff size={14} /> Stop test</button>
          : <button className="btn sm" onClick={start}><PlayCircle size={14} /> Start test</button>}
      </div>
      <div className={`mic-meter ${on ? 'on' : ''}`} aria-hidden="true">
        <span style={{ width: `${Math.round(Math.min(1, level * 2.4) * 100)}%` }} />
      </div>
      <p className="muted small">
        {err
          ? <><AlertTriangle size={12} /> {err}</>
          : on
            ? 'Speak — the bar should move. This is the same microphone the in-browser call will use.'
            : 'Checks the browser can reach your microphone before a real call does.'}
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, refreshSettings, toast, refreshProspects, refreshStats } = useStore();
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [backups, setBackups] = useState([]);
  const [snapshotting, setSnapshotting] = useState(false);
  const [smtpTest, setSmtpTest] = useState(null);
  const [devices, setDevices] = useState({ supported: false, inputs: [], outputs: [] });
  const [testingSmtp, setTestingSmtp] = useState(false);

  useEffect(() => {
    if (settings && !f) setF({ ...settings, voipso_sip_password: '', dry_run: settings.dry_run === '1' });
  }, [settings, f]);

  const loadBackups = useCallback(async () => {
    try { setBackups((await api.backups()).backups || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadBackups(); }, [loadBackups]);

  const testSmtp = async () => {
    setTestingSmtp(true); setSmtpTest(null);
    try {
      await api.saveSettings(f);            // save first so we test what is on screen
      const r = await api.testSmtp();
      setSmtpTest({ ok: true, msg: `Connected to ${r.host}:${r.port} as ${r.from}` });
      await refreshSettings();
    } catch (e) { setSmtpTest({ ok: false, msg: e.message }); }
    setTestingSmtp(false);
  };

  // Ask the browser what audio hardware it admits to. Labels stay blank until the agent has
  // granted microphone access at least once — a browser rule, so we re-ask after the test.
  const loadDevices = useCallback(async () => {
    const d = await listAudioDevices();
    setDevices(d);
    return d;
  }, []);
  useEffect(() => { loadDevices(); }, [loadDevices]);

  const takeSnapshot = async () => {
    setSnapshotting(true);
    try {
      const b = await api.createBackup('manual');
      toast(`Snapshot saved: ${b.file}`);
      await loadBackups();
    } catch (e) { toast(e.message, 'error'); }
    setSnapshotting(false);
  };
  if (!f) return <div className="muted pad">Loading…</div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const cc = String(f.default_country_code || '45').replace(/\D/g, '');
  const proto = f.softphone_protocol === 'tel' ? 'tel' : 'sip';
  const inBrowser = f.telephony_mode === 'webrtc';
  const sipServer = f.voipso_sip_server || 'sip.voip.so';
  // The two modes hand out completely different URIs, so the sample must not lie about which
  // one Pulse will actually dial.
  const sampleUri = inBrowser ? `sip:+${cc}20123456@${sipServer};transport=ws` : `${proto}:+${cc}20123456`;
  const softphone = softphoneLabel(f.telephony_mode);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(f);
      await refreshSettings();
      setF((x) => ({ ...x, voipso_sip_password: '' }));
      toast('Settings saved');
      refreshStats();
    } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };

  // Save first so the launch uses the config you just typed, then hand the OS a sample URI.
  const testSoftphone = async () => {
    setTesting(true); setResult(null);
    try {
      await api.saveSettings(f);
      const r = await api.testSoftphone({ number: '20123456' });
      await refreshSettings();
      // In-browser mode has nothing to hand to the OS — the sample stays inside Pulse, so a
      // "check" here means checking the server-side session, not launching an app.
      if (r.inBrowser) {
        setResult({
          ok: !!r.configured,
          msg: `${r.configured ? 'In-browser softphone is ready' : 'The in-browser softphone still needs attention'} — sample dial URI ${r.dialUri}. ${r.message || ''}`.trim(),
        });
        setTesting(false);
        return;
      }
      const launched = dispatchDialUri(r.dialUri);
      setResult({
        ok: true,
        msg: launched
          ? `Launched ${r.dialUri} — ${softphoneLabel(r.telephonyMode)} should be dialing it now.${r.configured ? '' : ' (No VOIP.SO SIP account saved yet — register it in your softphone first.)'}`
          : r.message,
      });
    } catch (e) { setResult({ ok: false, msg: e.message }); }
    setTesting(false);
  };

  const clearAll = async () => {
    if (!confirm('Delete ALL prospects, notes and call history? This cannot be undone.')) return;
    await api.clearProspects(); await refreshProspects(); await refreshStats(); toast('All prospects deleted');
  };

  return (
    <div className="settings">
      <header className="page-head">
        <div><h1>Settings</h1><p>Point Pulse at VOIP.SO, pick your softphone, and set your daily targets.</p></div>
        <button className="btn primary glow" onClick={save} disabled={saving}>{saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save changes</button>
      </header>

      <motion.section className={`glass pad-lg mode-card ${f.dry_run ? 'dry' : 'live'}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
        <div className="mode-row">
          <div className="mode-ico"><FlaskConical size={22} /></div>
          <div>
            <h3>Test mode {f.dry_run ? 'is ON' : 'is OFF'}</h3>
            <p>{f.dry_run
              ? 'Nothing is dialed. Pulse simulates the call in the browser so you can try the flow safely.'
              : `Calls are REAL: ${softphone} dials straight out over VOIP.SO and every second is billed.`}</p>
          </div>
          <Switch checked={f.dry_run} onChange={(v) => setF({ ...f, dry_run: v })} />
        </div>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <div className="panel-title"><PhoneCall size={16} /> Telephony &amp; VOIP.SO (Denmark +45) <em>direct dialing</em></div>

        <div className="picker-grid">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`pick-card ${f.telephony_mode === m.id ? 'on' : ''}`}
              onClick={() => setF({ ...f, telephony_mode: m.id })}
            >
              <span className="pick-ico">{m.id === 'softphone' ? <Headphones size={16} /> : <Globe size={16} />}</span>
              <b>{m.label}</b>
              <small>{m.hint}</small>
            </button>
          ))}
        </div>

        <div className="picker-grid">
          {PROTOCOLS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`pick-card ${proto === p.id ? 'on' : ''}`}
              onClick={() => setF({ ...f, softphone_protocol: p.id })}
            >
              <span className="pick-ico"><Radio size={16} /></span>
              <b>{p.label} URI scheme</b>
              <small>{p.hint}</small>
            </button>
          ))}
        </div>

        <div className="form two">
          <label>Outbound caller ID (Danish number)<input value={f.caller_id} onChange={set('caller_id')} placeholder="+45 20 12 34 56" /></label>
          <label>Default country code (numbers without +)<input value={f.default_country_code} onChange={set('default_country_code')} placeholder="45" /></label>
        </div>

        <div className="panel-title sub"><KeyRound size={15} /> VOIP.SO SIP account</div>
        {settings.has_password && <div className="banner ok"><ShieldCheck size={15} /> A SIP password is stored locally. Leave the field blank to keep it.</div>}
        <div className="form two">
          <label>SIP server / domain<input value={f.voipso_sip_server} onChange={set('voipso_sip_server')} placeholder="sip.voip.so" autoComplete="off" /></label>
          <label>SIP username / extension<input value={f.voipso_sip_user} onChange={set('voipso_sip_user')} placeholder="1001" autoComplete="off" /></label>
          <label>SIP password<input type="password" value={f.voipso_sip_password} onChange={set('voipso_sip_password')} placeholder={settings.has_password ? '•••••••• (saved, leave blank to keep)' : 'Your SIP secret'} autoComplete="new-password" /></label>
          <label>Sample dial URI Pulse will dispatch<input readOnly value={sampleUri} className="mono" /></label>
        </div>
        <p className="muted small">
          {inBrowser
            ? 'Your credential stays in this computer’s local database. Pulse only releases it to the in-browser softphone when you switch the handoff on below, and never to any other site.'
            : 'Register your VOIP.SO credentials and Danish number in Zoiper. When you hit Call in Pulse Dialer, Zoiper will instantly place the call with zero callback lag. The SIP secret stays in this computer’s local database and is never sent to the browser.'}
        </p>
        <div className="row gap">
          <button className="btn" onClick={testSoftphone} disabled={testing}>
            {testing ? <Loader2 size={15} className="spin" /> : <PlayCircle size={15} />} {inBrowser ? 'Check in-browser softphone' : 'Test softphone launch'}
          </button>
          {result && <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className={`test-result ${result.ok ? 'ok' : 'bad'}`}>{result.msg}</motion.span>}
        </div>
      </motion.section>

      {inBrowser && (
        <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.09 }}>
          <div className="panel-title"><Globe size={16} /> In-browser softphone <em>no app required</em></div>
          <p className="muted small">
            The call runs inside Pulse: the microphone, the audio and the hang-up all live in this tab.
            Nothing is handed to the operating system, so there is no Zoiper to install and no callback lag.
          </p>

          <div className="form two">
            <label>
              WebSocket signalling URL
              <input value={f.webrtc_ws_url} onChange={set('webrtc_ws_url')} placeholder={`wss://${sipServer}:8089/ws`} className="mono" />
            </label>
            <label>
              Microphone
              <select value={f.webrtc_mic_device || ''} onChange={(e) => setF({ ...f, webrtc_mic_device: e.target.value })} disabled={!devices.inputs.length}>
                <option value="">System default</option>
                {devices.inputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
            <label>
              Speaker
              <select value={f.webrtc_speaker_device || ''} onChange={(e) => setF({ ...f, webrtc_speaker_device: e.target.value })} disabled={!devices.outputs.length}>
                <option value="">System default</option>
                {devices.outputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
          </div>
          {!devices.supported && (
            <p className="muted small"><AlertTriangle size={12} /> This browser does not expose audio devices, so the in-browser softphone falls back to the system defaults — or cannot place calls at all.</p>
          )}
          {devices.supported && devices.needsPermission && (
            <p className="muted small"><AlertTriangle size={12} /> Device names stay hidden until you allow microphone access once — run the test below.</p>
          )}

          <div className="handoff-row">
            <div>
              <b>SIP credential handoff</b>
              <small>
                Required for in-browser calls. Pulse passes the stored VOIP.SO password to this page only —
                every other origin and any request without the page token is refused, and Settings never echoes it back.
              </small>
            </div>
            <Switch checked={f.webrtc_credential_handoff === '1'} onChange={(v) => setF({ ...f, webrtc_credential_handoff: v ? '1' : '0' })} />
          </div>

          <MicTester deviceId={f.webrtc_mic_device} onGranted={loadDevices} />
        </motion.section>
      )}

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <div className="panel-title"><Headphones size={16} /> {inBrowser ? 'In-browser call flow' : 'Zoiper quick setup'}</div>
        <ol className="setup-steps">
          {inBrowser ? (
            <>
              <li>Save <b>SIP server</b>, <b>username</b> and <b>password</b> above — the same VOIP.SO account you would put in Zoiper.</li>
              <li>Leave the WebSocket URL blank to use Pulse's derived gateway (<b>wss://{sipServer}:8089/ws</b>), or paste the one your provider documents.</li>
              <li>Turn <b>SIP credential handoff</b> on, then press <b>Test microphone</b> and allow the browser access.</li>
              <li>In the Dialer, press <b>C</b>: the call connects in this tab. <kbd>M</kbd> mutes, <kbd>D</kbd> opens the touch-tone pad, <kbd>H</kbd> hangs up and drops you straight into classification — and the microphone is released the moment you do.</li>
            </>
          ) : (
            <>
              <li>Install <b>Zoiper 5</b> (or Linphone) and add a SIP account: domain <b>{sipServer}</b>, username and password from your VOIP.SO portal.</li>
              <li>Wait for the green <b>Registered</b> badge, then set your outbound caller ID to your Danish <b>+45</b> number.</li>
              <li>Make Zoiper the default app for <b>{proto}:</b> links (Zoiper does this on install).</li>
              <li>Back here: turn <b>Test mode OFF</b> and press <b>C</b> in the Dialer — Zoiper dials the prospect instantly while your notes, timer and 1–8 shortcuts stay live.</li>
            </>
          )}
        </ol>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
        <div className="panel-title"><Target size={16} /> Daily targets</div>
        <div className="form two">
          <label>Daily dial goal<input type="number" min="0" value={f.daily_goal} onChange={set('daily_goal')} /></label>
          <label>Daily dial cap (safety limit)<input type="number" min="0" value={f.daily_cap} onChange={set('daily_cap')} /></label>
        </div>
        <p className="muted small">The cap stops the Call button once you hit it, which helps you stay at a human pace and avoid spam flags.</p>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
        <div className="panel-title"><Mail size={16} /> Email sending &amp; verification</div>
        <p className="muted small">
          Pulse verifies addresses itself — syntax, throwaway inboxes, common typos and a live MX lookup —
          so you find out a lead gave you a dead address before you write to them. To actually
          <b> send</b>, connect any SMTP account below.
        </p>
        <div className="form two">
          <label>SMTP host<input value={f.smtp_host || ''} onChange={set('smtp_host')} placeholder="smtp.gmail.com" /></label>
          <label>Port<input type="number" value={f.smtp_port || ''} onChange={set('smtp_port')} placeholder="587" /></label>
          <label>Username<input value={f.smtp_user || ''} onChange={set('smtp_user')} placeholder="you@gmail.com" autoComplete="off" /></label>
          <label>
            Password / app password
            <input type="password" value={f.smtp_pass || ''} onChange={set('smtp_pass')} placeholder={settings?.has_smtp_pass ? '•••••••• (saved — type to replace)' : 'app password'} autoComplete="new-password" />
          </label>
          <label>From address<input value={f.smtp_from || ''} onChange={set('smtp_from')} placeholder="Mette &lt;you@gmail.com&gt;" /></label>
          <label>Reply-to<input value={f.smtp_reply_to || ''} onChange={set('smtp_reply_to')} placeholder="your real inbox" /></label>
        </div>
        <label className="switch-row">
          <Switch checked={f.smtp_secure === '1'} onChange={(v) => setF({ ...f, smtp_secure: v ? '1' : '0' })} />
          <span>Implicit TLS (port 465). Leave off for STARTTLS on 587.</span>
        </label>
        <div className="row gap wrap" style={{ marginTop: 10 }}>
          <button className="btn" onClick={testSmtp} disabled={testingSmtp}>
            {testingSmtp ? <Loader2 size={15} className="spin" /> : <Plug size={15} />} Test connection
          </button>
          <span className="btn primary" onClick={save} style={{ cursor: 'pointer' }}><Save size={15} /> Save settings</span>
        </div>
        {smtpTest && (
          <p className={`small ${smtpTest.ok ? 'ok-text' : 'err-text'}`}>{smtpTest.msg}</p>
        )}
        <div className="panel-title" style={{ marginTop: 16 }}><Video size={15} /> Google Meet</div>
        <div className="form">
          <label>
            Standing meeting link
            <input value={f.meet_link || ''} onChange={set('meet_link')} placeholder="https://meet.google.com/abc-defg-hij" />
          </label>
        </div>
        <p className="muted small">
          This link is appended to every follow-up draft. In the composer, <b>New Google Meet room</b> opens
          meet.google.com/new, which mints a fresh room in your own logged-in browser — a link cannot be
          generated server-side without Google OAuth, so you paste it back.
        </p>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.24 }}>
        <div className="panel-title"><DatabaseBackup size={16} /> Your data &amp; snapshots</div>
        <p className="muted small">
          Everything — leads, notes, call history — lives in one local SQLite file (<code>data/dialer.db</code>).
          It is <b>not</b> sent anywhere and <b>not</b> committed to git, so keep a copy off this machine.
          A snapshot is taken automatically every day and before every import.
        </p>
        <div className="row gap wrap" style={{ marginTop: 10 }}>
          <button className="btn" onClick={takeSnapshot} disabled={snapshotting}>
            {snapshotting ? <Loader2 size={15} className="spin" /> : <DatabaseBackup size={15} />} Take a snapshot now
          </button>
          <a className="btn" href={api.exportProspectsUrl()}><FileSpreadsheet size={15} /> Export CSV (Excel)</a>
          <a className="btn" href={api.exportJsonUrl()}><FileJson size={15} /> Export JSON (leads + notes + calls)</a>
        </div>
        <div className="muted small" style={{ marginTop: 10 }}>
          {backups.length ? `${backups.length} snapshot(s) in data/backups — newest first:` : 'No snapshots yet.'}
        </div>
        <div className="hist-list" style={{ marginTop: 6 }}>
          {backups.slice(0, 8).map((b) => (
            <div className="hist-item" key={b.file}>
              <i className="dot" style={{ background: '#34d399' }} />
              <div>
                <b>{b.file}</b>
                <span>{new Date(b.created_at).toLocaleString()} · {Math.round(b.bytes / 1024)} KB</span>
              </div>
              <a className="link-btn" href={api.backupDownloadUrl(b.file)}><Download size={13} /> Download</a>
            </div>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          To restore one later: stop Pulse Dialer, copy the file over <code>data/dialer.db</code> and start it again.
        </p>
      </motion.section>

      <section className="glass pad-lg danger-zone">
        <div className="panel-title">Danger zone</div>
        <button className="btn danger" onClick={clearAll}><Trash2 size={15} /> Delete all prospects &amp; history</button>
      </section>
    </div>
  );
}
