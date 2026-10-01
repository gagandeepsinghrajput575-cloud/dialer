import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Save, Plug, Loader2, Trash2, ShieldCheck, FlaskConical, KeyRound, Phone, Target } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Switch } from '../components/ui.jsx';

export default function SettingsPage() {
  const { settings, refreshSettings, toast, refreshProspects, refreshStats } = useStore();
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { if (settings && !f) setF({ ...settings, sonetel_password: '', dry_run: settings.dry_run === '1' }); }, [settings, f]);
  if (!f) return <div className="muted pad">Loading…</div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setSaving(true);
    try { await api.saveSettings(f); await refreshSettings(); setF((x) => ({ ...x, sonetel_password: '' })); toast('Settings saved'); refreshStats(); } catch (e) { toast(e.message, 'error'); }
    setSaving(false);
  };
  const test = async () => {
    setTesting(true); setResult(null);
    try { await api.saveSettings(f); await refreshSettings(); const r = await api.testSettings(); setResult({ ok: true, msg: r.message }); }
    catch (e) { setResult({ ok: false, msg: e.message }); }
    setTesting(false);
  };
  const clearAll = async () => {
    if (!confirm('Delete ALL prospects, notes and call history? This cannot be undone.')) return;
    await api.clearProspects(); await refreshProspects(); await refreshStats(); toast('All prospects deleted');
  };

  return (
    <div className="settings">
      <header className="page-head"><div><h1>Settings</h1><p>Connect Sonetel and set your daily targets.</p></div>
        <button className="btn primary glow" onClick={save} disabled={saving}>{saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save changes</button>
      </header>

      <motion.section className={`glass pad-lg mode-card ${f.dry_run ? 'dry' : 'live'}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
        <div className="mode-row">
          <div className="mode-ico"><FlaskConical size={22} /></div>
          <div><h3>Test mode {f.dry_run ? 'is ON' : 'is OFF'}</h3><p>{f.dry_run ? 'Nothing is dialed. Use this to try the app safely.' : 'Calls are REAL and will use your Sonetel credit.'}</p></div>
          <Switch checked={f.dry_run} onChange={(v) => setF({ ...f, dry_run: v })} />
        </div>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <div className="panel-title"><KeyRound size={16} /> Sonetel account</div>
        {settings.env_credentials && <div className="banner ok"><ShieldCheck size={15} /> Credentials are being read from your .env file.</div>}
        <div className="form two">
          <label>Sonetel email (login)<input value={f.sonetel_username} onChange={set('sonetel_username')} placeholder="you@example.com" autoComplete="off" /></label>
          <label>Sonetel password<input type="password" value={f.sonetel_password} onChange={set('sonetel_password')} placeholder={settings.has_password ? '•••••••• (saved, leave blank to keep)' : 'Your password'} autoComplete="new-password" /></label>
        </div>
        <p className="muted small">Stored only on this computer in the app's local database (or use a .env file). It's never sent to the browser or anyone except Sonetel.</p>
        <div className="row gap">
          <button className="btn" onClick={test} disabled={testing}>{testing ? <Loader2 size={15} className="spin" /> : <Plug size={15} />} Test connection</button>
          {result && <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className={`test-result ${result.ok ? 'ok' : 'bad'}`}>{result.msg}</motion.span>}
        </div>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <div className="panel-title"><Phone size={16} /> How calls connect to you</div>
        <p className="muted small">Sonetel rings <b>you</b> first, then dials the prospect and joins you both. Enter where you want to pick up. Your softphone (Zoiper, Linphone…) works best.</p>
        <div className="form two">
          <label>Your phone / SIP address / Sonetel email<input value={f.my_number} onChange={set('my_number')} placeholder="you@yourdomain.com  or  +91…" /></label>
          <label>Caller ID shown to prospects<input value={f.caller_id} onChange={set('caller_id')} placeholder="automatic" /></label>
          <label>Default country code (for numbers without +)<input value={f.default_country_code} onChange={set('default_country_code')} placeholder="91" /></label>
        </div>
      </motion.section>

      <motion.section className="glass pad-lg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
        <div className="panel-title"><Target size={16} /> Daily targets</div>
        <div className="form two">
          <label>Daily dial goal<input type="number" min="0" value={f.daily_goal} onChange={set('daily_goal')} /></label>
          <label>Daily dial cap (safety limit)<input type="number" min="0" value={f.daily_cap} onChange={set('daily_cap')} /></label>
        </div>
        <p className="muted small">The cap stops the Call button once you hit it, which helps you stay at a human pace and avoid spam flags.</p>
      </motion.section>

      <section className="glass pad-lg danger-zone">
        <div className="panel-title">Danger zone</div>
        <button className="btn danger" onClick={clearAll}><Trash2 size={15} /> Delete all prospects &amp; history</button>
      </section>
    </div>
  );
}
