import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  X, Send, Paperclip, Loader2, ShieldCheck, ShieldAlert, ShieldQuestion, Video, CheckCircle2,
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';

// One icon + one colour per verdict. Kept in one place so the badge in the composer and the
// badge on the prospect card can never drift apart.
export const VERIFY_STYLE = {
  valid: { Icon: ShieldCheck, cls: 'ok', label: 'Looks good' },
  risky: { Icon: ShieldAlert, cls: 'warn', label: 'Check this' },
  invalid: { Icon: ShieldAlert, cls: 'bad', label: 'Will not arrive' },
  unknown: { Icon: ShieldQuestion, cls: 'muted', label: 'Not checked' },
};

export function VerifyBadge({ result, compact }) {
  const st = VERIFY_STYLE[result?.level] || VERIFY_STYLE.unknown;
  const Icon = st.Icon;
  const tip = (result?.reasons || []).join(' ') || 'Not checked yet';
  return (
    <span className={`verify-badge ${st.cls}`} title={tip}>
      <Icon size={12} />
      {!compact && <span>{st.label}</span>}
      {result?.suggestion && <b className="suggest">{result.suggestion}</b>}
    </span>
  );
}

// `noteText` seeds the server-side template with the call the agent just finished, so the
// draft arrives already carrying the outcome, the notes summary and the meeting link.
// `onSent` lets every host (dialer, drawer, card, table) refresh its own timeline — the
// composer cannot know which panels are showing this prospect.
export default function EmailComposer({ prospectId, recipient, initial, noteText, onClose, onSent }) {
  const { toast, refreshProspects } = useStore();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [smtp, setSmtp] = useState({ configured: false, missing: [] });
  const [f, setF] = useState({ to: '', subject: '', body: '', meetLink: '' });
  const [verification, setVerification] = useState(null);
  const [checking, setChecking] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const checkTimer = useRef(null);

  // Load the draft (template already filled in) and SMTP readiness together.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [draft, status] = await Promise.all([
          prospectId ? api.emailDraft(prospectId, noteText ? { noteText } : {}) : Promise.resolve(null),
          api.emailStatus(),
        ]);
        if (!alive) return;
        setSmtp(status);
        setF({
          to: initial?.to || draft?.to || '',
          subject: initial?.subject || draft?.subject || '',
          body: initial?.body || draft?.body || '',
          meetLink: draft?.meetLink || '',
        });
        setVerification(draft?.verification || null);
      } catch (e) {
        if (alive) toast(e.message, 'error');
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [prospectId, initial, noteText, toast]);

  // Verify as they type, but only once they stop — a DNS lookup per keystroke is wasteful.
  const scheduleCheck = useCallback((email) => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    const addr = String(email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { setVerification(null); return; }
    checkTimer.current = setTimeout(async () => {
      setChecking(true);
      try { setVerification(await api.verifyEmail(addr)); }
      catch { setVerification(null); }
      finally { setChecking(false); }
    }, 450);
  }, []);

  useEffect(() => () => { if (checkTimer.current) clearTimeout(checkTimer.current); }, []);

  const onAttach = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const a = await api.attachFile(file);
      setAttachments((list) => [...list, a]);
      toast(`Attached ${a.filename}`);
    } catch (e) { toast(e.message, 'error'); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';   // allow re-picking the same file
  };

  const dropFile = async (id) => {
    setAttachments((list) => list.filter((a) => a.id !== id));
    try { await api.dropAttachment(id); } catch { /* already expired — harmless */ }
  };

  // meet.google.com/new mints a room instantly in your own logged-in browser. There is no
  // way to generate a code server-side without Google OAuth, so the link comes back to you
  // to paste — honest, and it works with zero setup.
  const openMeet = () => {
    window.open('https://meet.google.com/new', '_blank', 'noopener,noreferrer,width=900,height=700');
    toast('Google Meet is opening — copy the link and paste it below', 'ok');
  };

  const insertMeet = (link) => {
    const clean = String(link || '').trim();
    setF((x) => ({
      ...x,
      meetLink: clean,
      body: clean ? `${x.body}\n\nMødelink: ${clean}` : x.body,
    }));
  };

  const send = async (force = false) => {
    if (!f.to.trim()) return toast('Who should receive this?', 'error');
    if (!f.subject.trim()) return toast('The email needs a subject.', 'error');
    if (verification && !verification.ok && !force) {
      const go = confirm(
        `${f.to} will probably not receive this.\n\n${(verification.reasons || []).join('\n')}\n\nSend anyway?`,
      );
      if (!go) return;
      return send(true);
    }
    setSending(true);
    try {
      const r = await api.sendEmail({
        to: f.to.trim(),
        subject: f.subject.trim(),
        body: f.body,
        attachments: attachments.map((a) => a.id),
        prospectId,
        force,
      });
      toast(`Sent to ${r.accepted?.join(', ') || f.to}`);
      // Refresh the prospect list, then hand off to the host so it can reload the notes and
      // call history the send was just appended to. Order matters: the note exists server-side
      // by the time send() resolves, so both reads see it.
      if (prospectId) await refreshProspects();
      try { await onSent?.(r); } catch { /* a host refresh must never break the send path */ }
      onClose?.(true);
    } catch (e) {
      toast(e.message, 'error');
    }
    setSending(false);
  };

  if (loading) return <div className="scrim" />;

  const st = VERIFY_STYLE[verification?.level] || VERIFY_STYLE.unknown;

  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => onClose?.(false)} />
      <motion.div
        className="modal glass email-modal"
        initial={{ opacity: 0, scale: 0.96, y: 18 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
      >
        <div className="modal-head">
          <h3>Email{recipient ? ` — ${recipient}` : ''}</h3>
          <button className="icon-btn" onClick={() => onClose?.(false)} title="Close"><X size={16} /></button>
        </div>

        {!smtp.configured && (
          <div className="banner warn">
            <ShieldAlert size={15} />
            <span>
              Sending is not set up yet — add your SMTP host, username and password in
              <b> Settings → Email</b>. Gmail users need an <i>App password</i>, not their normal one.
            </span>
          </div>
        )}

        <div className="form">
          <label>
            To
            <span className="to-row">
              <input
                value={f.to}
                onChange={(e) => { setF({ ...f, to: e.target.value }); scheduleCheck(e.target.value); }}
                placeholder="name@company.dk"
                autoFocus
              />
              {checking && <Loader2 size={14} className="spin" />}
            </span>
          </label>

          {verification && (
            <div className={`verify-panel ${st.cls}`}>
              <VerifyBadge result={verification} />
              <ul>
                {(verification.reasons || []).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
              {verification.suggestion && (
                <button className="btn sm" onClick={() => { setF({ ...f, to: verification.suggestion }); setVerification(null); }}>
                  <CheckCircle2 size={13} /> Use {verification.suggestion}
                </button>
              )}
            </div>
          )}

          <label>Subject<input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>

          <label>
            Message
            <textarea
              rows={10}
              value={f.body}
              onChange={(e) => setF({ ...f, body: e.target.value })}
              placeholder="Write your message…"
            />
          </label>

          <div className="meet-row">
            <button className="btn sm" onClick={openMeet} type="button"><Video size={14} /> New Google Meet room</button>
            <input
              value={f.meetLink}
              onChange={(e) => setF({ ...f, meetLink: e.target.value })}
              onBlur={(e) => e.target.value && insertMeet(e.target.value)}
              placeholder="paste the meet.google.com link here"
            />
          </div>

          <div className="attach-row">
            <input ref={fileRef} type="file" hidden onChange={onAttach} />
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={uploading} type="button">
              {uploading ? <Loader2 size={14} className="spin" /> : <Paperclip size={14} />} Attach a file
            </button>
            <span className="muted small">up to 5 files, 10 MB each</span>
          </div>

          {attachments.length > 0 && (
            <div className="attach-list">
              {attachments.map((a) => (
                <span className="chip" key={a.id}>
                  <Paperclip size={12} /> {a.filename}
                  <em>{Math.round(a.bytes / 1024)} KB</em>
                  <button onClick={() => dropFile(a.id)} title="Remove"><X size={11} /></button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={() => onClose?.(false)}>Cancel</button>
          <button className="btn primary" onClick={() => send(false)} disabled={sending}>
            {sending ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Send email
          </button>
        </div>
      </motion.div>
    </>
  );
}
