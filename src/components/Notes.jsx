import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { NotebookPen, Trash2, Send, PhoneCall } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { fmtDateTime, fmtDur, outcomeMeta, timeAgo } from '../utils.js';

export function useDetail(id) {
  const [detail, setDetail] = useState(null);
  const reload = React.useCallback(async () => {
    if (!id) { setDetail(null); return; }
    try { setDetail(await api.prospect(id)); } catch { /* ignore */ }
  }, [id]);
  useEffect(() => { setDetail(null); reload(); }, [reload]);
  return { detail, reload };
}

export default function Notes({ pid, notes = [], reload, autoFocusKey, draftValue, onDraftChange }) {
  const { toast } = useStore();
  const [internalDraft, setInternalDraft] = useState('');
  const draft = draftValue !== undefined ? draftValue : internalDraft;
  const setDraft = onDraftChange || setInternalDraft;
  const draftRef = useRef('');
  const ta = useRef(null);
  draftRef.current = draft;

  // never lose an unsaved note: save it when switching prospect / leaving
  useEffect(() => () => {
    const t = draftRef.current.trim();
    if (t) api.addNote(pid, t).catch(() => {});
  }, [pid]);

  useEffect(() => { if (autoFocusKey) ta.current?.focus(); }, [autoFocusKey]);

  const add = async () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    try { await api.addNote(pid, t); await reload?.(); toast('Note saved'); } catch (e) { setDraft(t); toast(e.message, 'error'); }
  };
  const del = async (id) => { await api.deleteNote(id); reload?.(); };

  return (
    <div className="notes">
      <div className="panel-title"><NotebookPen size={16} /> Notes <em>{notes.length}</em></div>
      <div className="note-compose">
        <textarea
          ref={ta}
          value={draft}
          placeholder="Write notes during the call…  (Ctrl/⌘ + Enter to save)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } }}
        />
        <button className="btn primary sm" onClick={add} disabled={!draft.trim()}><Send size={14} /> Save note</button>
      </div>
      <div className="note-list">
        <AnimatePresence initial={false}>
          {notes.map((n) => (
            <motion.div key={n.id} layout className="note" initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 30 }}>
              <p>{n.body}</p>
              <div className="note-meta"><span>{fmtDateTime(n.created_at)} · {timeAgo(n.created_at)}</span><button className="icon-btn sm ghost" onClick={() => del(n.id)} title="Delete"><Trash2 size={13} /></button></div>
            </motion.div>
          ))}
        </AnimatePresence>
        {notes.length === 0 && <div className="muted small center pad">No notes yet. Anything you type above is kept with this prospect.</div>}
      </div>
    </div>
  );
}

export function CallHistory({ calls = [] }) {
  return (
    <div className="history">
      <div className="panel-title"><PhoneCall size={16} /> Call history <em>{calls.length}</em></div>
      {calls.length === 0 && <div className="muted small center pad">No calls yet.</div>}
      <div className="hist-list">
        {calls.map((c) => {
          const o = outcomeMeta(c.outcome);
          return (
            <div key={c.id} className="hist-item">
              <i className="dot" style={{ background: o ? o.color : c.status === 'failed' ? '#f87171' : '#64748b' }} />
              <div>
                <b>{o ? o.label : c.status === 'failed' ? 'Failed to connect' : 'No result logged'}</b>
                <span>{fmtDateTime(c.started_at)}{c.dry_run ? ' · test' : ''}</span>
              </div>
              <em>{c.duration_sec ? fmtDur(c.duration_sec) : ''}</em>
            </div>
          );
        })}
      </div>
    </div>
  );
}
