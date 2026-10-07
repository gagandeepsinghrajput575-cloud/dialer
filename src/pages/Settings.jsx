import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Save, Loader2, Trash2, ShieldCheck, FlaskConical, PhoneCall, Target,
  Headphones, KeyRound, Radio, Globe, PlayCircle, DatabaseBackup, Download, FileJson, FileSpreadsheet,
  Mail, Plug, Video
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Switch } from '../components/ui.jsx';
import { dispatchDialUri, softphoneLabel } from '../utils.js';

const MODES = [
  { id: 'softphone', label: 'Desktop softphone', hint: 'Zoiper · Linphone · Telephone — Pulse hands the number to your OS softphone.' },
  { id: 'webrtc', label: 'In-browser WebRTC softphone', hint: 'The call stays in the browser (bring your own WebRTC softphone tab).' },
];
const PROTOCOLS = [
  { id: 'sip', label: 'sip:', hint: 'sip:+4520123456 — Zoiper registers the sip: scheme when you install it.' },
  { id: 'tel', label: 'tel:', hint: 'tel:+4520123456 — macOS Telephone, mobile diallers, some desk-phone apps.' },
];

export default function SettingsPage() {
  const { settings, refreshSettings, toast, refreshProspects, refreshStats } = useStore();
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [backups, setBackups] = useState([]);
  const [snapshotting, setSnapshotting] = useState(false);
  const [smtpTest, setSmtpTest] = useState(null);
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
  const sampleUri = `${proto}:+${cc}20123456`;
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
          Register your VOIP.SO credentials and Danish number in Zoiper. When you hit Call in Pulse Dialer,
          Zoiper will instantly place the call with zero callback lag. The SIP secret stays in this computer's
          local database and is never sent to the browser.
        </p>
        <div className="row gap">
          <button className="btn" onClick={testSoftphone} disabled={testing}>
            {testing ? <Loader2 size={15} className="spin" /> : <PlayCircle size={15} />} Test softphone launch
          </button>
          {result && <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className={`test-result ${result.ok ? 'ok' : 'bad'}`}>{result.msg}</motion.span>}
        </div>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <div className="panel-title"><Headphones size={16} /> Zoiper quick setup</div>
        <ol className="setup-steps">
          <li>Install <b>Zoiper 5</b> (or Linphone) and add a SIP account: domain <b>{f.voipso_sip_server || 'sip.voip.so'}</b>, username and password from your VOIP.SO portal.</li>
          <li>Wait for the green <b>Registered</b> badge, then set your outbound caller ID to your Danish <b>+45</b> number.</li>
          <li>Make Zoiper the default app for <b>{proto}:</b> links (Zoiper does this on install).</li>
          <li>Back here: turn <b>Test mode OFF</b> and press <b>C</b> in the Dialer — Zoiper dials the prospect instantly while your notes, timer and 1–8 shortcuts stay live.</li>
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
