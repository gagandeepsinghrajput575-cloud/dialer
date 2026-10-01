import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, Phone, Plus, Upload, Users, ShieldAlert, X } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Avatar, Empty, StageBadge } from '../components/ui.jsx';
import { STAGES, timeAgo } from '../utils.js';

function AddModal({ onClose }) {
  const { refreshProspects, refreshStats, toast, setDrawerId } = useStore();
  const [f, setF] = useState({ name: '', phone: '', email: '', company: '', title: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    if (!f.phone && !f.name) return toast('Add at least a name or phone number', 'error');
    const p = await api.addProspect(f);
    await refreshProspects(); refreshStats(); toast('Prospect added'); onClose(); setDrawerId(p.id);
  };
  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal glass" initial={{ opacity: 0, scale: 0.94, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
        <div className="modal-head"><h3>Add prospect</h3><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="form">
          <label>Name<input autoFocus value={f.name} onChange={set('name')} placeholder="Full name" /></label>
          <label>Phone<input value={f.phone} onChange={set('phone')} placeholder="+91 98100 12345" /></label>
          <label>Email<input value={f.email} onChange={set('email')} placeholder="name@company.com" /></label>
          <div className="two"><label>Company<input value={f.company} onChange={set('company')} /></label><label>Title<input value={f.title} onChange={set('title')} /></label></div>
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Add prospect</button></div>
      </motion.div>
    </>
  );
}

export default function Prospects() {
  const { prospects, loaded, setDrawerId, openInDialer, setView, refreshProspects } = useStore();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('all');
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return prospects.filter((p) => (stage === 'all' || p.stage === stage) && (!n || `${p.name} ${p.company} ${p.phone} ${p.email} ${p.title}`.toLowerCase().includes(n)));
  }, [prospects, q, stage]);

  return (
    <div>
      <header className="page-head">
        <div><h1>Prospects</h1><p>{prospects.length} total · click anyone to see everything about them.</p></div>
        <div className="row gap">
          <button className="btn" onClick={() => setView('import')}><Upload size={16} /> Import</button>
          <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add prospect</button>
        </div>
      </header>

      <div className="toolbar">
        <div className="search wide"><Search size={16} /><input placeholder="Search name, company, phone, email…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="chips">
          <button className={`chip-btn ${stage === 'all' ? 'on' : ''}`} onClick={() => setStage('all')}>All</button>
          {STAGES.map((s) => (
            <button key={s.id} className={`chip-btn ${stage === s.id ? 'on' : ''}`} style={{ '--c': s.color }} onClick={() => setStage(s.id)}><i />{s.label}</button>
          ))}
        </div>
      </div>

      {loaded && prospects.length === 0 ? (
        <Empty icon={<Users size={34} />} title="Your list is empty" sub="Import a CSV/Excel file or add a prospect manually.">
          <div className="row gap"><button className="btn primary" onClick={() => setView('import')}><Upload size={16} /> Import a list</button><button className="btn" onClick={async () => { await api.demo(); refreshProspects(); }}>Load demo data</button></div>
        </Empty>
      ) : (
        <div className="glass table-wrap">
          <table className="table">
            <thead><tr><th>Prospect</th><th>Phone</th><th>Email</th><th>Stage</th><th>Calls</th><th>Last call</th><th /></tr></thead>
            <tbody>
              <AnimatePresence initial={false}>
                {rows.slice(0, 400).map((p, i) => (
                  <motion.tr key={p.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(i, 12) * 0.015 }} onClick={() => setDrawerId(p.id)}>
                    <td><div className="cell-who"><Avatar name={p.name || p.company} size={36} seed={p.id + p.name} /><div><b>{p.name || '(no name)'}</b><span>{[p.title, p.company].filter(Boolean).join(' · ') || '—'}</span></div></div></td>
                    <td className="mono">{p.phone || '—'}</td>
                    <td className="trunc">{p.email || '—'}</td>
                    <td>{p.dnc ? <span className="dnc-badge sm"><ShieldAlert size={12} /> DNC</span> : <StageBadge stage={p.stage} />}</td>
                    <td>{p.call_count}</td>
                    <td className="muted">{p.last_called_at ? timeAgo(p.last_called_at) : '—'}</td>
                    <td><button className="btn sm primary" disabled={p.dnc || !p.phone} onClick={(e) => { e.stopPropagation(); openInDialer(p.id); }}><Phone size={13} /> Call</button></td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
          {rows.length === 0 && <div className="muted center pad-lg">No one matches that filter.</div>}
          {rows.length > 400 && <div className="muted center pad">Showing first 400 of {rows.length}. Use search to narrow down.</div>}
        </div>
      )}
      <AnimatePresence>{adding && <AddModal onClose={() => setAdding(false)} />}</AnimatePresence>
    </div>
  );
}
