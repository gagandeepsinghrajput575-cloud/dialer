import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Search, Phone, Plus, Upload, Users, ShieldAlert, X, Download, Trash2, Loader2, Mail,
  CheckSquare, Layers, ArrowRightLeft, Volume2,
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Avatar, Empty, StageBadge } from '../components/ui.jsx';
import EmailComposer from '../components/EmailComposer.jsx';
import { STAGES, timeAgo } from '../utils.js';
import { getDanishPronunciation, speakPronunciation } from '../utils/phonetics.js';

function AddModal({ onClose }) {
  const { refreshProspects, refreshStats, toast, setDrawerId } = useStore();
  const [f, setF] = useState({ name: '', phone: '', email: '', company: '', title: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!f.phone && !f.name) return toast('Add at least a name or phone number', 'error');
    setSaving(true);
    try {
      const p = await api.addProspect(f);
      await refreshProspects(); refreshStats(); toast('Prospect added'); onClose(); setDrawerId(p.id);
    } catch (e) {
      // Without this the modal just sat there: the rejection escaped to the console and the
      // agent got no message at all when the server rejected the row.
      toast(e.message, 'error');
    }
    setSaving(false);
  };
  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal glass" initial={{ opacity: 0, scale: 0.94, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
        <div className="modal-head"><h3>Add prospect</h3><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="form">
          <label>Name<input autoFocus value={f.name} onChange={set('name')} placeholder="Full name" /></label>
          <label>Phone<input value={f.phone} onChange={set('phone')} placeholder="+45 20 12 34 56" /></label>
          <label>Email<input value={f.email} onChange={set('email')} placeholder="name@company.com" /></label>
          <div className="two"><label>Company<input value={f.company} onChange={set('company')} /></label><label>Title<input value={f.title} onChange={set('title')} /></label></div>
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={saving}>{saving ? <Loader2 size={15} className="spin" /> : null} Add prospect</button></div>
      </motion.div>
    </>
  );
}

// Shown only while something is selected. Deliberately floating above the table: the actions
// that apply to a *selection* must not be mistaken for the ones that apply to a row.
function BulkBar({ count, allDnc, busy, onStage, onToggleDnc, onDelete, onClear }) {
  return (
    <motion.div
      className="bulk-bar glass"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="bulk-count"><b>{count}</b> selected</span>
      <label className="bulk-stage">
        <ArrowRightLeft size={13} />
        <select value="" onChange={(e) => { if (e.target.value) onStage(e.target.value); }} disabled={busy}>
          <option value="">Move to stage…</option>
          {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <button className="btn sm" onClick={onToggleDnc} disabled={busy}>
        <ShieldAlert size={13} /> {allDnc ? 'Clear DNC' : 'Mark as DNC'}
      </button>
      <button className="btn sm danger" onClick={onDelete} disabled={busy}>
        {busy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Delete selected
      </button>
      <button className="link-btn" onClick={onClear} disabled={busy}>Clear selection</button>
    </motion.div>
  );
}

function ConfirmDeleteModal({ count, calls, onCancel, onConfirm, busy }) {
  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel} />
      <motion.div
        className="modal glass confirm-modal"
        initial={{ opacity: 0, scale: 0.95, y: -12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -8 }}
        role="dialog"
        aria-label="Confirm delete"
      >
        <div className="modal-head">
          <h3><Trash2 size={16} /> Delete {count} prospect{count === 1 ? '' : 's'}?</h3>
          <button className="icon-btn" onClick={onCancel} title="Cancel"><X size={16} /></button>
        </div>
        <p className="muted small">
          Delete {count} prospect{count === 1 ? '' : 's'} and all their history?
          {calls > 0 ? ` That is ${calls} logged call${calls === 1 ? '' : 's'}, every note, and every captured email link.` : ' Every note and call record goes with them.'}
          {' '}This cannot be undone.
        </p>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>Keep them</button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} Delete {count}
          </button>
        </div>
      </motion.div>
    </>
  );
}

export default function Prospects() {
  const {
    prospects, loaded, setDrawerId, openInDialer, setView, refreshProspects, deleteProspect,
    bulkStageProspects, bulkMarkDnc, bulkDeleteProspects,
  } = useStore();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('all');
  const [adding, setAdding] = useState(false);
  const [mailTo, setMailTo] = useState(null);   // { id, name } being emailed straight from the row
  const [sel, setSel] = useState(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return prospects.filter((p) => (stage === 'all' || p.stage === stage) && (!n || `${p.name} ${p.company} ${p.phone} ${p.email} ${p.title}`.toLowerCase().includes(n)));
  }, [prospects, q, stage]);
  const visible = useMemo(() => rows.slice(0, 400), [rows]);

  // A selection that survives a filter change is a trap: you tick three rows, search for
  // someone else, and the bulk bar is still holding the three you can no longer see.
  useEffect(() => { setSel(new Set()); }, [q, stage]);

  // Anything that disappears from the list (deleted elsewhere, a refresh) must not stay ticked,
  // or "3 selected" would apply to two.
  useEffect(() => {
    setSel((cur) => {
      if (!cur.size) return cur;
      const alive = new Set(prospects.map((p) => p.id));
      const next = new Set([...cur].filter((id) => alive.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [prospects]);

  const toggleOne = (id) => setSel((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allVisibleSelected = visible.length > 0 && visible.every((p) => sel.has(p.id));
  const toggleAll = () => setSel(allVisibleSelected ? new Set() : new Set(visible.map((p) => p.id)));

  const selected = useMemo(() => prospects.filter((p) => sel.has(p.id)), [prospects, sel]);
  const selectedIds = useMemo(() => [...sel], [sel]);
  const allDnc = selected.length > 0 && selected.every((p) => p.dnc);
  const selectedCalls = selected.reduce((n, p) => n + (Number(p.call_count) || 0), 0);

  const clearSel = () => setSel(new Set());

  const applyStage = async (next) => {
    setBusy(true);
    await bulkStageProspects(selectedIds, next);
    setBusy(false);
    clearSel();
  };

  const applyDnc = async () => {
    setBusy(true);
    await bulkMarkDnc(selectedIds, !allDnc);
    setBusy(false);
    clearSel();
  };

  const applyDelete = async () => {
    setBusy(true);
    const r = await bulkDeleteProspects(selectedIds);
    setBusy(false);
    setConfirmBulk(false);
    if (r) clearSel();
  };

  const handleExport = () => {
    window.location.href = api.exportProspectsUrl();
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Prospects</h1>
          <p>
            {prospects.length} total · click anyone to see everything about them.
            {sel.size > 0 ? ` ${sel.size} selected.` : ''}
          </p>
        </div>
        <div className="row gap">
          <button className="btn" onClick={handleExport} title="Download CSV of all prospects, notes, and call results"><Download size={16} /> Export CSV</button>
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
            <thead>
              <tr>
                <th className="sel-col">
                  <input
                    type="checkbox"
                    className="row-check"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = sel.size > 0 && !allVisibleSelected; }}
                    onChange={toggleAll}
                    title={allVisibleSelected ? 'Clear selection' : `Select all ${visible.length} visible`}
                    aria-label="Select all visible prospects"
                  />
                </th>
                <th>Prospect</th><th>Phone</th><th>Email</th><th>Stage</th><th>Calls</th><th>Last call</th><th />
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {visible.map((p, i) => (
                  <motion.tr key={p.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(i, 12) * 0.015 }} onClick={() => setDrawerId(p.id)} className={sel.has(p.id) ? 'row-selected' : ''}>
                    <td className="sel-col">
                      <input
                        type="checkbox"
                        className="row-check"
                        checked={sel.has(p.id)}
                        onChange={() => toggleOne(p.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${p.name || 'prospect'}`}
                      />
                    </td>
                    <td>
                      <div className="cell-who">
                        <Avatar name={p.name || p.company} size={36} seed={p.id + p.name} />
                        <div>
                          <div className="row gap xs" style={{ alignItems: 'center' }}>
                            <b>{p.name || '(no name)'}</b>
                            {(p.pronunciation || (p.name && getDanishPronunciation(p.name))) && (
                              <button
                                type="button"
                                className="pronounce-chip sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  speakPronunciation(p.name, p.pronunciation || getDanishPronunciation(p.name));
                                }}
                                title="Click to hear pronunciation guide"
                              >
                                <Volume2 size={11} /> {p.pronunciation || getDanishPronunciation(p.name)}
                              </button>
                            )}
                          </div>
                          <span>{[p.title, p.company].filter(Boolean).join(' · ') || '—'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="mono">{p.phone || '—'}</td>
                    <td className="trunc">{p.email || '—'}</td>
                    <td>{p.dnc ? <span className="dnc-badge sm"><ShieldAlert size={12} /> DNC</span> : <StageBadge stage={p.stage} />}</td>
                    <td>{p.call_count}</td>
                    <td className="muted">{p.last_called_at ? timeAgo(p.last_called_at) : '—'}</td>
                    <td>
                      <div className="row gap sm" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn sm primary" disabled={p.dnc || !p.phone} onClick={(e) => { e.stopPropagation(); openInDialer(p.id); }} title="Dial in active queue"><Phone size={13} /> Call</button>
                        {p.email && (
                          <button
                            className="icon-btn sm"
                            title={`Email ${p.email} in the app`}
                            onClick={(e) => { e.stopPropagation(); setMailTo({ id: p.id, name: p.name }); }}
                          >
                            <Mail size={13} />
                          </button>
                        )}
                        <button className="icon-btn sm danger" title="Delete prospect" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete ${p.name || 'this prospect'}?`)) deleteProspect(p.id); }}><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
          {rows.length === 0 && <div className="muted center pad-lg">No one matches that filter.</div>}
          {rows.length > 400 && <div className="muted center pad">Showing first 400 of {rows.length}. Use search to narrow down.</div>}
        </div>
      )}
      {/* BULK ACTIONS — only while something is ticked */}
      <AnimatePresence>
        {sel.size > 0 && (
          <BulkBar
            count={sel.size}
            allDnc={allDnc}
            busy={busy}
            onStage={applyStage}
            onToggleDnc={applyDnc}
            onDelete={() => setConfirmBulk(true)}
            onClear={clearSel}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmBulk && (
          <ConfirmDeleteModal
            count={sel.size}
            calls={selectedCalls}
            busy={busy}
            onCancel={() => setConfirmBulk(false)}
            onConfirm={applyDelete}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>{adding && <AddModal onClose={() => setAdding(false)} />}</AnimatePresence>

      {/* 1-click email from the row, without leaving the table */}
      <AnimatePresence>
        {mailTo && (
          <EmailComposer
            key={mailTo.id}
            prospectId={mailTo.id}
            recipient={mailTo.name}
            onSent={refreshProspects}
            onClose={() => setMailTo(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
