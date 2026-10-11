import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Mail, X, Trash2, Search, Loader2, Paperclip, Download, RefreshCw,
  FileCode2, FileText, Code2, ExternalLink, ShieldAlert, Inbox, AlertTriangle
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';

const TABS = [
  { id: 'rendered', label: 'Rendered', icon: FileCode2 },
  { id: 'text', label: 'Plain text', icon: FileText },
  { id: 'headers', label: 'Headers & data', icon: Code2 },
];

const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtWhen = (iso) => {
  if (!iso) return '';
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC; make it an unambiguous ISO instant.
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

// The sandboxed preview. srcDoc + sandbox="allow-same-origin" (deliberately *without*
// allow-scripts): the captured HTML is untrusted input — it came from whatever the agent
// pasted or the template produced — and must never get a script context in the dialer's
// origin. Without allow-scripts even a crafted payload cannot run code here.
function HtmlPreview({ html, text }) {
  const doc = useMemo(() => {
    if (html && html.trim()) return html;
    // No HTML part: show the text part as preformatted content so the pane is never blank.
    const escaped = String(text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return `<!doctype html><html><body style="font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px;white-space:pre-wrap">${escaped || '<em style="opacity:.6">This message has no body.</em>'}</body></html>`;
  }, [html, text]);
  return (
    <iframe
      className="outbox-frame"
      title="Captured email preview"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={doc}
    />
  );
}

// Mounted only while the modal is open (see the wrapper at the bottom), so every open starts
// from a clean slate and loads fresh — nobody wants yesterday's cached preview.
function OutboxPanel() {
  const { outboxFocusId, closeOutbox, toast, openInDialer } = useStore();
  const [messages, setMessages] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState('rendered');
  const [clearing, setClearing] = useState(false);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (search = '') => {
    setLoading(true);
    setError('');
    try {
      const r = await api.getOutbox({ limit: 100, q: search });
      if (!alive.current) return;
      setMessages(r.messages || []);
      setTotal(r.total || 0);
      setActiveId((cur) => {
        const preferred = outboxFocusId && (r.messages || []).some((m) => m.id === outboxFocusId) ? outboxFocusId : null;
        if (preferred) return preferred;
        return (r.messages || []).some((m) => m.id === cur) ? cur : (r.messages?.[0]?.id ?? null);
      });
    } catch (e) {
      if (alive.current) setError(e.message || 'Could not read the outbox.');
    }
    if (alive.current) setLoading(false);
  }, [outboxFocusId]);

  // Load on open, and again whenever the search term settles.
  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 220 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  // Escape closes, like every other modal in the app.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Only the topmost surface reacts: a confirm() or the classification dialog owns the
      // key while it is up.
      e.preventDefault();
      closeOutbox();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOutbox]);

  // The list row carries no attachment payloads (a 100-row list must not ship megabytes of
  // base64), so the opened message is fetched in full.
  useEffect(() => {
    if (!activeId) { setDetail(null); return undefined; }
    let cancelled = false;
    setDetailLoading(true);
    api.getOutboxMessage(activeId)
      .then((m) => { if (!cancelled) setDetail(m); })
      .catch((e) => { if (!cancelled) { setDetail(null); toast(e.message, 'error'); } })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [activeId, toast]);

  const removeOne = async (id) => {
    try {
      await api.deleteOutboxMessage(id);
      toast('Message removed from the outbox');
      setActiveId(null);
      await load(q);
    } catch (e) { toast(e.message, 'error'); }
  };

  const clearAll = async () => {
    if (!confirm(`Delete all ${total} captured message${total === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setClearing(true);
    try {
      const r = await api.clearOutbox();
      toast(`Outbox cleared (${r.deleted} removed)`);
      setActiveId(null);
      await load('');
      setQ('');
    } catch (e) { toast(e.message, 'error'); }
    setClearing(false);
  };

  const active = detail || messages.find((m) => m.id === activeId) || null;
  const headers = active?.headers || {};

  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeOutbox} />
      <motion.div
        className="modal glass outbox-modal"
        initial={{ opacity: 0, scale: 0.96, y: 18 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
      >
        <div className="modal-head">
          <h3><Inbox size={17} /> Outbox &amp; email preview <em>{total} captured</em></h3>
          <button className="icon-btn" onClick={closeOutbox} title="Close (Esc)"><X size={16} /></button>
        </div>

        <div className="outbox-toolbar">
          <div className="search">
            <Search size={14} />
            <input placeholder="Search subject, recipient, attachment…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn sm" onClick={() => load(q)} disabled={loading} title="Reload">
            {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
          </button>
          <button className="btn sm danger" onClick={clearAll} disabled={clearing || !total}>
            {clearing ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Clear outbox
          </button>
        </div>

        {error && <div className="banner warn"><AlertTriangle size={14} /> {error}</div>}

        <div className="outbox-split">
          {/* LEFT: what was captured */}
          <div className="outbox-list">
            {loading && !messages.length && <div className="muted pad"><Loader2 size={15} className="spin" /> Loading captured mail…</div>}
            {!loading && !messages.length && (
              <div className="outbox-empty">
                <Mail size={26} />
                <b>No captured email yet</b>
                <span>
                  {q
                    ? `Nothing matches “${q}”.`
                    : 'Send one from the composer while the local sink is on and it will land here — nothing leaves this machine.'}
                </span>
              </div>
            )}
            {messages.map((m) => (
              <button
                key={m.id}
                className={`outbox-row ${m.id === activeId ? 'on' : ''}`}
                onClick={() => { setActiveId(m.id); setTab('rendered'); }}
              >
                <div className="outbox-row-top">
                  <b>{m.subject || '(no subject)'}</b>
                  {m.isLocalSink && <em className="local-tag">local</em>}
                </div>
                <div className="outbox-row-sub">
                  {m.to.join(', ')}
                </div>
                <div className="outbox-row-foot">
                  <span>{fmtWhen(m.createdAt)}</span>
                  {m.prospectName && <em className="prospect-tag">{m.prospectName}</em>}
                  {m.attachments.length > 0 && <span className="attach-count"><Paperclip size={10} /> {m.attachments.length}</span>}
                </div>
              </button>
            ))}
          </div>

          {/* RIGHT: what the recipient would see */}
          <div className="outbox-preview">
            {!active && (
              <div className="outbox-empty tall">
                <Inbox size={26} />
                <b>Pick a message</b>
                <span>The rendered HTML, the plain text and every header appear here.</span>
              </div>
            )}
            {active && (
              <>
                <div className="outbox-subject">
                  <div>
                    <b>{active.subject || '(no subject)'}</b>
                    <span className="muted small">
                      From <code>{headers.From || active.from}</code> · To <code>{active.to.join(', ')}</code>
                    </span>
                  </div>
                  <div className="row gap">
                    {active.prospectId && (
                      <button className="btn xs" onClick={() => { openInDialer(active.prospectId); closeOutbox(); }}>
                        <ExternalLink size={12} /> Open prospect
                      </button>
                    )}
                    <button className="btn xs danger" onClick={() => removeOne(active.id)} title="Delete this captured message">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                <div className="outbox-tabs">
                  {TABS.map((t) => {
                    const Icon = t.icon;
                    return (
                      <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                        <Icon size={13} /> {t.label}
                      </button>
                    );
                  })}
                </div>

                <div className="outbox-body">
                  {detailLoading && <div className="muted small pad"><Loader2 size={13} className="spin" /> Opening…</div>}

                  {!detailLoading && tab === 'rendered' && <HtmlPreview html={active.html} text={active.text} />}

                  {!detailLoading && tab === 'text' && (
                    <pre className="outbox-text">{active.text || '(this message has no plain-text part)'}</pre>
                  )}

                  {!detailLoading && tab === 'headers' && (
                    <div className="outbox-headers">
                      <table>
                        <tbody>
                          {['From', 'To', 'Reply-To', 'Subject', 'Message-ID', 'Date', 'X-Pulse-Transport'].map((h) => (
                            <tr key={h}>
                              <th>{h}</th>
                              <td>{headers[h] ?? <em className="muted">—</em>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <details>
                        <summary>Raw record</summary>
                        <pre>{JSON.stringify({
                          id: active.id, prospectId: active.prospectId, createdAt: active.createdAt,
                          headers: active.headers, attachments: active.attachments.map(({ contentBase64, ...rest }) => rest),
                        }, null, 2)}</pre>
                      </details>
                    </div>
                  )}
                </div>

                {active.attachments.length > 0 && (
                  <div className="outbox-attachments">
                    {active.attachments.map((a, i) => (
                      <div className="attach-badge" key={`${a.filename}-${i}`}>
                        <Paperclip size={12} />
                        <span className="attach-name" title={a.filename}>{a.filename}</span>
                        <em>{fmtBytes(a.bytes)}</em>
                        {a.stored ? (
                          <a
                            className="attach-dl"
                            href={api.outboxAttachmentUrl(active.id, i)}
                            download={a.filename}
                            title={`Download ${a.filename}`}
                          >
                            <Download size={12} /> Download
                          </a>
                        ) : (
                          <span className="muted small" title="Too large to keep in the local ledger — metadata only">
                            <ShieldAlert size={11} /> metadata only
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </motion.div>
    </>
  );
}

// AnimatePresence has to own the removal to play the exit animation, so the open/closed
// decision lives in this thin wrapper rather than inside the panel.
export default function OutboxModal() {
  const { outboxOpen } = useStore();
  return <AnimatePresence>{outboxOpen && <OutboxPanel />}</AnimatePresence>;
}
