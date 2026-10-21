import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Save, Loader2, Trash2, ShieldCheck, FlaskConical, PhoneCall, Target,
  Headphones, KeyRound, Radio, Globe, PlayCircle, DatabaseBackup, Download, FileJson, FileSpreadsheet,
  Mail, Plug, Video, Mic, MicOff, Volume2, AlertTriangle, Inbox, ServerOff, Sparkles,
  PhoneIncoming, Building2, Copy, Bell
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { useSoftphone } from '../softphone.jsx';
import { Switch } from '../components/ui.jsx';
import { dispatchDialUri, softphoneLabel } from '../utils.js';
import DesktopBridgeCard from '../components/DesktopBridgeCard.jsx';
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
  const { settings, refreshSettings, toast, refreshProspects, refreshStats, openOutbox } = useStore();
  const softphoneEngine = useSoftphone();
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [backups, setBackups] = useState([]);
  const [snapshotting, setSnapshotting] = useState(false);
  const [smtpTest, setSmtpTest] = useState(null);
  const [devices, setDevices] = useState({ supported: false, inputs: [], outputs: [] });
  const [outboxCount, setOutboxCount] = useState(null);
  const [testingSmtp, setTestingSmtp] = useState(false);

  useEffect(() => {
    if (settings && !f) setF({ ...settings, telnyx_sip_password: '', telnyx_api_key: '', flynumber_sip_password: '', dry_run: settings.dry_run === '1' });
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
      setSmtpTest({
        ok: true,
        msg: r.local
          ? `Local Outbox Sink ready — mail is captured to this machine (${r.outboxCount ?? 0} stored). Nothing is transmitted.`
          : `Connected to ${r.host}:${r.port} as ${r.from}`,
      });
      await loadOutboxCount();
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

  // How much captured mail the sink is holding. Cheap (one COUNT) and it is what the
  // "View Outbox (N)" button advertises.
  const loadOutboxCount = useCallback(async () => {
    try {
      const r = await api.getOutbox({ limit: 1 });
      setOutboxCount(r.total || 0);
      return r.total || 0;
    } catch { return null; }
  }, []);
  useEffect(() => { loadOutboxCount(); }, [loadOutboxCount]);

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
  const sipServer = f.telnyx_sip_server || 'sip.telnyx.com';
  // Telnyx's WebRTC gateway is a single fixed endpoint, not a port/path derived from the SIP
  // domain, so the placeholder states it outright instead of synthesising a URL.
  const wsGateway = f.webrtc_ws_url || 'wss://rtc.telnyx.com';
  // The two modes hand out completely different URIs, so the sample must not lie about which
  // one Pulse will actually dial.
  const sampleUri = inBrowser ? `sip:+${cc}20123456@${sipServer}` : `${proto}:+${cc}20123456`;
  const softphone = softphoneLabel(f.telephony_mode);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(f);
      await refreshSettings();
      setF((x) => ({ ...x, telnyx_sip_password: '', telnyx_api_key: '', flynumber_sip_password: '' }));
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
          ? `Launched ${r.dialUri} — ${softphoneLabel(r.telephonyMode)} should be dialing it now.${r.configured ? '' : ' (No Telnyx SIP connection saved yet — register it in your softphone first.)'}`
          : r.message,
      });
    } catch (e) { setResult({ ok: false, msg: e.message }); }
    setTesting(false);
  };

  // One click, and email works: the sink needs no account, no password and no network. The
  // values are chosen to look like a real relay's (a port, a username) so nothing downstream
  // has to special-case "half configured", while `local` is what actually selects the sink.
  const useLocalSink = async () => {
    const next = {
      ...f,
      smtp_host: 'local',
      smtp_port: '1025',
      smtp_user: 'agent@firma.dk',
      smtp_secure: '0',
    };
    setF(next);
    setSaving(true);
    try {
      await api.saveSettings(next);
      await refreshSettings();
      setF((x) => ({ ...x, smtp_pass: '' }));
      await loadOutboxCount();
      toast('Local Mail Sink is on — mail is captured, not sent');
    } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };

  const clearAll = async () => {
    if (!confirm('Delete ALL prospects, notes and call history? This cannot be undone.')) return;
    await api.clearProspects(); await refreshProspects(); await refreshStats(); toast('All prospects deleted');
  };

  return (
    <div className="settings">
      <header className="page-head">
        <div><h1>Settings</h1><p>Point Pulse at your Telnyx SIP connection, pick your softphone, and set your daily targets.</p></div>
        <button className="btn primary glow" onClick={save} disabled={saving}>{saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save changes</button>
      </header>

      <motion.section className={`glass pad-lg mode-card ${f.dry_run ? 'dry' : 'live'}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
        <div className="mode-row">
          <div className="mode-ico"><FlaskConical size={22} /></div>
          <div>
            <h3>Test mode {f.dry_run ? 'is ON' : 'is OFF'}</h3>
            <p>{f.dry_run
              ? 'Nothing is dialed. Pulse simulates the call in the browser so you can try the flow safely.'
              : `Calls are REAL: ${softphone} dials straight out over Telnyx and every second is billed.`}</p>
          </div>
          <Switch checked={f.dry_run} onChange={(v) => setF({ ...f, dry_run: v })} />
        </div>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <div className="panel-title"><PhoneCall size={16} /> Telephony &amp; Telnyx (Denmark +45) <em>direct dialing</em></div>

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

        <div className="panel-title sub"><KeyRound size={15} /> Telnyx SIP connection <em>Credential Auth</em></div>
        {settings.has_password && <div className="banner ok"><ShieldCheck size={15} /> A SIP password is stored locally. Leave the field blank to keep it.</div>}
        <div className="form two">
          <label>SIP domain (FQDN)<input value={f.telnyx_sip_server} onChange={set('telnyx_sip_server')} placeholder="sip.telnyx.com" autoComplete="off" /></label>
          <label>SIP username<input value={f.telnyx_sip_user} onChange={set('telnyx_sip_user')} placeholder="From the SIP Connection" autoComplete="off" /></label>
          <label>SIP password<input type="password" value={f.telnyx_sip_password} onChange={set('telnyx_sip_password')} placeholder={settings.has_password ? '•••••••• (saved, leave blank to keep)' : 'Your SIP connection secret'} autoComplete="new-password" /></label>
          <label>Sample dial URI Pulse will dispatch<input readOnly value={sampleUri} className="mono" /></label>
        </div>
        <div className="panel-title sub"><KeyRound size={15} /> Telnyx API access <em>optional</em></div>
        <div className="form two">
          <label>API key<input type="password" value={f.telnyx_api_key} onChange={set('telnyx_api_key')} placeholder={settings.has_api_key ? '•••••••• (saved, leave blank to keep)' : 'KEY… (Mission Control → API Keys)'} autoComplete="new-password" /></label>
          <label>SIP Connection ID<input value={f.telnyx_connection_id} onChange={set('telnyx_connection_id')} placeholder="Optional — for carrier automation" autoComplete="off" /></label>
        </div>
        <p className="muted small">
          {inBrowser
            ? 'Your credential stays in this computer’s local database. Pulse releases it to the in-browser softphone only when you switch the handoff on below, and never to any other site.'
            : 'Register the same Telnyx SIP connection in Zoiper. When you hit Call in Pulse Dialer, Zoiper places the call instantly with zero callback lag. The SIP secret stays in this computer’s local database and is never sent to the browser.'}
        </p>
        <div className="row gap">
          <button className="btn" onClick={testSoftphone} disabled={testing}>
            {testing ? <Loader2 size={15} className="spin" /> : <PlayCircle size={15} />} {inBrowser ? 'Check in-browser softphone' : 'Test softphone launch'}
          </button>
          {result && <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className={`test-result ${result.ok ? 'ok' : 'bad'}`}>{result.msg}</motion.span>}
        </div>
      </motion.section>

      <DesktopBridgeCard />

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
              <input value={f.webrtc_ws_url} onChange={set('webrtc_ws_url')} placeholder="wss://sip.telnyx.com:7443" className="mono" />
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
                Required for in-browser calls. Pulse passes the stored Telnyx SIP password to this page only —
                every other origin and any request without the page token is refused, and Settings never echoes it back.
              </small>
            </div>
            <Switch checked={f.webrtc_credential_handoff === '1'} onChange={(v) => setF({ ...f, webrtc_credential_handoff: v ? '1' : '0' })} />
          </div>

          <MicTester deviceId={f.webrtc_mic_device} onGranted={loadDevices} />
        </motion.section>
      )}

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <div className="panel-title"><Headphones size={16} /> Telnyx setup <em>once, then it just dials</em></div>
        <ol className="setup-steps">
          <li>
            In <b>Telnyx Mission Control</b>, create a <b>SIP Connection</b> with
            <b> Credential Auth</b> (Connections → SIP). Copy its <b>username</b> and <b>secret</b>
            into the fields above — the domain stays <b>sip.telnyx.com</b>.
          </li>
          <li>
            Buy or port your Danish <b>+45</b> numbers, then assign them to that SIP Connection
            (Numbers → your number → Connection).
          </li>
          <li>
            Set the connection's <b>outbound caller ID</b> to the Danish DID you want to present,
            and paste the same number(s) into <b>Outbound caller ID</b> / the DID pool below so
            Pulse rotates them.
          </li>
          {inBrowser ? (
            <>
              <li>
                In-browser mode needs no softphone: leave the gateway blank to use Telnyx's
                <b> wss://sip.telnyx.com:7443</b>, then switch <b>SIP credential handoff</b> on and
                press <b>Test microphone</b>.
              </li>
              <li>
                Press <kbd>C</kbd> in the Dialer: the call connects in this tab. <kbd>M</kbd> mutes,
                <kbd>D</kbd> opens the touch-tone pad, <kbd>H</kbd> hangs up into classification —
                and the microphone is released the moment you do.
              </li>
            </>
          ) : (
            <>
              <li>
                Install <b>Zoiper 5</b> (or Linphone) and add a SIP account: domain{' '}
                <b>{sipServer}</b>, plus the username and secret from your Telnyx SIP Connection.
                Wait for the green <b>Registered</b> badge.
              </li>
              <li>
                Make Zoiper the default app for <b>{proto}:</b> links (Zoiper does this on install),
                then turn <b>Test mode OFF</b> and press <kbd>C</kbd> in the Dialer — Zoiper dials
                the prospect instantly while your notes, timer and 1–8 shortcuts stay live.
              </li>
            </>
          )}
        </ol>
      </motion.section>

      {/* FLYNUMBER COPENHAGEN INBOUND DID & HYBRID ARCHITECTURE HUB */}
      {(() => {
        const isWebRtcInbound = (f.inbound_routing_mode || 'webrtc') === 'webrtc' || f.telephony_mode === 'webrtc';
        const telnyxForwardingUri = f.telnyx_sip_user ? `sip:${f.telnyx_sip_user}@${f.telnyx_sip_server || 'sip.telnyx.com'}` : '';

        return (
          <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
            <div className="panel-title">
              <PhoneIncoming size={16} /> FlyNumber Inbound &amp; Copenhagen Line (+45 32 33 16 10)
              <em>$0/min inbound via FlyNumber SIP</em>
            </div>

            <div className="flynumber-banner">
              <div>
                <div className="flynumber-badges">
                  <span className="cph-pill"><Building2 size={13} /> +45 32 33 16 10</span>
                  <span className={`cph-pill ${f.flynumber_status === 'active' ? 'clean' : 'pending'}`}>
                    {f.flynumber_status === 'active' ? '✓ Line ACTIVE' : '⏳ Pending Carrier Review'}
                  </span>
                  <span className="cph-pill clean">180.dk Clean</span>
                  <span className="cph-pill" style={{ background: 'rgba(99, 102, 241, 0.12)', borderColor: 'rgba(99, 102, 241, 0.3)', color: '#818cf8' }}>
                    {isWebRtcInbound ? '🎧 In-Browser Ringing' : '🖥️ Linphone Desktop'}
                  </span>
                </div>
                <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                  Copenhagen business landline DID ($2.95/mo). Outbound dials via Telnyx wholesale; all prospect return calls route for free ($0.00/min) directly into {isWebRtcInbound ? 'this browser tab' : 'Linphone'}.
                </p>
              </div>
              <div className="flynumber-badges">
                <span className="rate-badge">Monthly: $2.95</span>
                <span className="rate-badge" style={{ color: '#4ade80' }}>Inbound: $0.00/min</span>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => {
                    setF({ ...f, caller_id: '+45 32 33 16 10' });
                    toast('Outbound caller ID set to Copenhagen line (+45 32 33 16 10)');
                  }}
                  title="Stamp this Copenhagen DID on all outbound calls"
                >
                  Use as Outbound CLI
                </button>
              </div>
            </div>

            <div className="panel-title sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <span><Globe size={15} /> Inbound Destination &amp; Call Routing</span>
              <div className="tab-pills" style={{ display: 'inline-flex', gap: 6 }}>
                <button
                  type="button"
                  className={`btn sm ${isWebRtcInbound ? 'primary' : ''}`}
                  onClick={() => setF({ ...f, inbound_routing_mode: 'webrtc', telephony_mode: 'webrtc' })}
                >
                  <Globe size={13} /> Built-in Browser App (WebRTC)
                </button>
                <button
                  type="button"
                  className={`btn sm ${!isWebRtcInbound ? 'primary' : ''}`}
                  onClick={() => setF({ ...f, inbound_routing_mode: 'flynumber_sip' })}
                >
                  <Headphones size={13} /> External Softphone (Linphone)
                </button>
              </div>
            </div>

            {isWebRtcInbound ? (
              <div className="inbound-webrtc-card" style={{ background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: 12, padding: '16px 20px', margin: '14px 0 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <b style={{ color: '#38bdf8', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Globe size={16} /> 100% In-Browser Inbound Enabled (Zero Extra Apps)
                    </b>
                    <p className="muted small" style={{ margin: '6px 0 0 0' }}>
                      FlyNumber forwards return calls to your Telnyx SIP connection. Telnyx streams incoming audio via WebRTC straight into this browser tab at <b>$0.00/min</b>.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: 'rgba(56, 189, 248, 0.15)', borderColor: 'rgba(56, 189, 248, 0.4)', color: '#38bdf8' }}
                    onClick={() => {
                      if (softphoneEngine?.simulateIncomingCall) {
                        softphoneEngine.simulateIncomingCall('+45 32 33 16 10');
                        toast('In-browser ringer triggered! Press Enter to answer.');
                      } else {
                        toast('Softphone ringer is ready in WebRTC mode.');
                      }
                    }}
                  >
                    <Bell size={13} /> Test In-Browser Ringer
                  </button>
                </div>

                <div style={{ marginTop: 14 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: 6 }}>
                    FlyNumber Call Forwarding Destination (SIP URI)
                  </label>
                  <div className="linphone-quick-box" style={{ display: 'flex', alignItems: 'center', background: 'rgba(15, 23, 42, 0.7)', borderRadius: 8, padding: '8px 12px', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 13, color: f.telnyx_sip_user ? '#f8fafc' : '#fbbf24', flex: 1 }}>
                      {f.telnyx_sip_user ? telnyxForwardingUri : '⚠️ Enter your Telnyx SIP username above to generate your forwarding address'}
                    </span>
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={!f.telnyx_sip_user}
                      style={{ padding: '4px 12px', fontSize: 12 }}
                      onClick={() => {
                        navigator.clipboard?.writeText(telnyxForwardingUri);
                        toast('Copied FlyNumber Forwarding SIP URI');
                      }}
                    >
                      <Copy size={13} /> Copy for FlyNumber
                    </button>
                  </div>
                  <small className="muted" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                    <b>In FlyNumber Console:</b> Select <code>+45 32 33 16 10</code> → <b>Call Forwarding</b> → Choose <b>SIP URI</b> → Paste this address.
                  </small>
                </div>
              </div>
            ) : (
              <>
                <div className="panel-title sub"><KeyRound size={15} /> FlyNumber Inbound SIP Credentials <em>sip.flynumber.com</em></div>
                {settings.has_flynumber_password && (
                  <div className="banner ok"><ShieldCheck size={15} /> FlyNumber SIP secret is saved locally. Leave blank to keep it.</div>
                )}
                <div className="form two">
                  <label>Inbound SIP server<input value={f.flynumber_sip_server || 'sip.flynumber.com'} onChange={set('flynumber_sip_server')} placeholder="sip.flynumber.com" autoComplete="off" /></label>
                  <label>Inbound SIP username<input value={f.flynumber_sip_user || ''} onChange={set('flynumber_sip_user')} placeholder="FlyNumber Account SIP User" autoComplete="off" /></label>
                  <label>Inbound SIP password<input type="password" value={f.flynumber_sip_password || ''} onChange={set('flynumber_sip_password')} placeholder={settings.has_flynumber_password ? '•••••••• (saved, leave blank to keep)' : 'FlyNumber SIP password'} autoComplete="new-password" /></label>
                  <label>
                    Linphone Quick-Connect Address
                    <div className="linphone-quick-box">
                      <span>{f.flynumber_sip_user ? `sip:${f.flynumber_sip_user}@${f.flynumber_sip_server || 'sip.flynumber.com'}` : 'sip:<username>@sip.flynumber.com'}</span>
                      <button
                        type="button"
                        className="btn sm"
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => {
                          const addr = f.flynumber_sip_user ? `sip:${f.flynumber_sip_user}@${f.flynumber_sip_server || 'sip.flynumber.com'}` : 'sip.flynumber.com';
                          navigator.clipboard?.writeText(addr);
                          toast('Copied Linphone SIP address');
                        }}
                      >
                        Copy
                      </button>
                    </div>
                  </label>
                </div>
              </>
            )}

            <div className="panel-title sub" style={{ marginTop: 18 }}><Headphones size={15} /> The Bridge: 4 Steps to Free Inbound &amp; Verified Outbound</div>
            <div className="bridge-wizard">
              <div className={`bridge-step-card ${f.flynumber_status === 'active' ? 'completed' : ''}`}>
                <div className="bridge-step-num">1</div>
                <div className="bridge-step-body">
                  <div className="bridge-step-title">
                    <span>1. FlyNumber Line Activation</span>
                    <button
                      type="button"
                      className={`btn sm ${f.flynumber_status === 'active' ? 'ok' : ''}`}
                      onClick={() => {
                        const next = f.flynumber_status === 'active' ? 'pending' : 'active';
                        setF({ ...f, flynumber_status: next });
                      }}
                    >
                      {f.flynumber_status === 'active' ? '✓ Line is Active' : 'Mark as Active'}
                    </button>
                  </div>
                  <div className="bridge-step-desc">
                    FlyNumber compliance verifies the Danish B2B service description (Scalix Elite). Status changes from "Pending" to "Active".
                  </div>
                </div>
              </div>

              <div className={`bridge-step-card ${f.flynumber_linphone_configured === '1' ? 'completed' : ''}`}>
                <div className="bridge-step-num">2</div>
                <div className="bridge-step-body">
                  <div className="bridge-step-title">
                    <span>{isWebRtcInbound ? '2. Route FlyNumber to Built-in App' : '2. Connect Linphone Softphone'}</span>
                    <button
                      type="button"
                      className={`btn sm ${f.flynumber_linphone_configured === '1' ? 'ok' : ''}`}
                      onClick={() => setF({ ...f, flynumber_linphone_configured: f.flynumber_linphone_configured === '1' ? '0' : '1' })}
                    >
                      {f.flynumber_linphone_configured === '1' ? (isWebRtcInbound ? '✓ Forwarding Active' : '✓ Linphone Logged In') : (isWebRtcInbound ? 'Mark as Forwarded' : 'Mark as Connected')}
                    </button>
                  </div>
                  <div className="bridge-step-desc">
                    {isWebRtcInbound
                      ? `In FlyNumber portal, set Call Forwarding on +45 32 33 16 10 to SIP URI: ${telnyxForwardingUri || 'sip:<telnyx_user>@sip.telnyx.com'}. Return calls will ring inside this browser tab.`
                      : `Add SIP account in Linphone with domain ${f.flynumber_sip_server || 'sip.flynumber.com'}, username, and secret. Confirm registration is green.`
                    }
                  </div>
                </div>
              </div>

              <div className={`bridge-step-card ${f.telnyx_caller_id_verified === '1' ? 'completed' : ''}`}>
                <div className="bridge-step-num">3</div>
                <div className="bridge-step-body">
                  <div className="bridge-step-title">
                    <span>3. Trigger Telnyx Verification Call</span>
                    <button
                      type="button"
                      className={`btn sm ${f.telnyx_caller_id_verified === '1' ? 'ok' : ''}`}
                      onClick={() => setF({ ...f, telnyx_caller_id_verified: f.telnyx_caller_id_verified === '1' ? '0' : '1' })}
                    >
                      {f.telnyx_caller_id_verified === '1' ? '✓ PIN Verified' : 'Confirm 6-Digit PIN'}
                    </button>
                  </div>
                  <div className="bridge-step-desc">
                    {isWebRtcInbound
                      ? 'In Telnyx Portal, click "Verify via Call" on +45 32 33 16 10. This browser tab will ring immediately for free! Click Answer, note the 6-digit PIN, and enter into Telnyx.'
                      : 'In Telnyx Portal, click "Verify via Call" on +45 32 33 16 10. Linphone rings for free over FlyNumber SIP. Answer call, note 6-digit PIN, and enter into Telnyx.'
                    }
                  </div>
                </div>
              </div>

              <div className={`bridge-step-card ${f.caller_id === '+45 32 33 16 10' || f.caller_id === '+4532331610' ? 'completed' : ''}`}>
                <div className="bridge-step-num">4</div>
                <div className="bridge-step-body">
                  <div className="bridge-step-title">
                    <span>4. Set Outbound Caller ID Override</span>
                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => {
                        setF({ ...f, caller_id: '+45 32 33 16 10' });
                        toast('Outbound caller ID set to Copenhagen DID');
                      }}
                    >
                      Set +45 32 33 16 10
                    </button>
                  </div>
                  <div className="bridge-step-desc">
                    With ownership verified, Telnyx stamps every outbound dial with your clean Copenhagen office number (+45 32 33 16 10).
                  </div>
                </div>
              </div>
            </div>
          </motion.section>
        );
      })()}

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
          <button className="btn" onClick={useLocalSink} title="Capture mail locally instead of sending it — no credentials needed">
            <ServerOff size={15} /> Use Local Mail Sink
          </button>
          <button className="btn" onClick={() => openOutbox(null)} title="Inspect everything the sink captured">
            <Inbox size={15} /> View Outbox{outboxCount ? ` (${outboxCount})` : ''}
          </button>
          <span className="btn primary" onClick={save} style={{ cursor: 'pointer' }}><Save size={15} /> Save settings</span>
        </div>
        {smtpTest && (
          <p className={`small ${smtpTest.ok ? 'ok-text' : 'err-text'}`}>{smtpTest.msg}</p>
        )}
        {f.smtp_host === 'local' && (
          <p className="muted small">
            <Inbox size={12} /> <b>Local Mail Sink is active.</b> Sends are captured into the outbox with their
            rendered HTML, headers and attachments — ideal for demos and dry runs. Point the host at a real
            SMTP account when you are ready for mail to leave this machine.
          </p>
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

      {/* AI COPILOT & LEAD SORTER */}
      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
        <div className="panel-title"><Sparkles size={16} /> AI Lead Sorter &amp; Copilot</div>
        <p className="muted small">
          Connect OpenRouter or Google Gemini to intelligently analyze and sort raw lead sheets, map primary contact fields,
          and automatically tuck secondary registry/social metadata into the dialer dropdown menu.
        </p>

        <div className="form two">
          <label>
            AI Provider
            <select value={f.ai_provider || 'openrouter'} onChange={set('ai_provider')}>
              <option value="openrouter">OpenRouter (Free Heavyweights: Meta-Router, MiniMax)</option>
              <option value="gemini">Google Gemini</option>
              <option value="openai">OpenAI</option>
              <option value="local">Local (Offline heuristic)</option>
            </select>
          </label>
          <label>
            Model
            <input
              value={f.ai_model || ''}
              onChange={set('ai_model')}
              placeholder={f.ai_provider === 'openrouter' ? 'openrouter/free' : f.ai_provider === 'openai' ? 'gpt-4o-mini' : 'gemini-2.5-flash'}
            />
          </label>
        </div>

        <div className="form" style={{ marginTop: 10 }}>
          <label>
            API Key
            <input
              type="password"
              value={f.ai_api_key || ''}
              onChange={set('ai_api_key')}
              placeholder={settings?.has_ai_key ? '•••••••• (saved — type to replace)' : f.ai_provider === 'openrouter' ? 'OpenRouter API key (sk-or-v1-...)' : 'Google Gemini API key (AIzaSy...)'}
              autoComplete="new-password"
            />
          </label>
        </div>

        <p className="muted small">
          Get a free API key at{' '}
          <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#38bdf8' }}>
            OpenRouter
          </a>{' '}
          or{' '}
          <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" style={{ color: '#38bdf8' }}>
            Google AI Studio
          </a>.
        </p>

        <div className="row gap" style={{ marginTop: 12 }}>
          <button className="btn primary glow" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save AI settings
          </button>
        </div>
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
