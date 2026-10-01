import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Phone, Mail, MapPin, Globe, Building2, Copy, Check, CalendarClock, ShieldAlert, PhoneCall, Clock } from 'lucide-react';
import { useStore } from '../store.jsx';
import { Avatar, Editable, StagePicker } from './ui.jsx';
import { outcomeMeta, timeAgo } from '../utils.js';

function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  if (!text) return null;
  return (
    <button className="icon-btn sm" title="Copy" onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}>
      {ok ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function Row({ icon: Icon, label, children, extra }) {
  return (
    <div className="info-row">
      <div className="info-ico"><Icon size={16} /></div>
      <div className="info-body">
        <label>{label}</label>
        <div className="info-val">{children}</div>
      </div>
      {extra}
    </div>
  );
}

export default function ProspectCard({ p, big = false }) {
  const { updateProspect } = useStore();
  if (!p) return null;
  const save = (field) => (val) => updateProspect(p.id, { [field]: val });
  const extra = p.extra || {};
  const extraKeys = Object.keys(extra);
  const lastOut = outcomeMeta(p.last_outcome);

  return (
    <motion.div className={`pcard ${big ? 'big' : ''}`} key={p.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <div className="pcard-head">
        <Avatar name={p.name || p.company} size={big ? 72 : 56} seed={p.id + p.name} />
        <div className="pcard-title">
          <Editable className="h-name" value={p.name} placeholder="Name" onSave={save('name')} />
          <div className="sub-line">
            <Editable className="h-sub" value={p.title} placeholder="Job title" onSave={save('title')} />
            <span className="at">@</span>
            <Editable className="h-sub" value={p.company} placeholder="Company" onSave={save('company')} />
          </div>
        </div>
        {p.dnc && <span className="dnc-badge"><ShieldAlert size={14} /> Do not call</span>}
      </div>

      <StagePicker value={p.stage} onChange={(s) => updateProspect(p.id, { stage: s })} />

      <div className="info-grid">
        <Row icon={Phone} label="Phone" extra={<CopyBtn text={p.phone} />}>
          <Editable className="phone-big" value={p.phone} placeholder="+91…" onSave={save('phone')} />
        </Row>
        <Row icon={Mail} label="Email" extra={<><CopyBtn text={p.email} />{p.email && <a className="icon-btn sm" href={`mailto:${p.email}`} title="Send email"><Mail size={14} /></a>}</>}>
          <Editable value={p.email} placeholder="name@company.com" onSave={save('email')} />
        </Row>
        <Row icon={Building2} label="Company"><Editable value={p.company} placeholder="Company" onSave={save('company')} /></Row>
        <Row icon={MapPin} label="Location"><Editable value={p.location} placeholder="City, Country" onSave={save('location')} /></Row>
        <Row icon={Globe} label="Website"><Editable value={p.website} placeholder="https://…" onSave={save('website')} /></Row>
        <Row icon={CalendarClock} label="Follow-up on">
          <Editable type="date" value={p.follow_up_at || ''} onSave={(v) => updateProspect(p.id, { follow_up_at: v })} />
        </Row>
      </div>

      <div className="mini-stats">
        <div><PhoneCall size={14} /><b>{p.call_count}</b><span>calls</span></div>
        <div><Clock size={14} /><b>{p.last_called_at ? timeAgo(p.last_called_at) : 'never'}</b><span>last call</span></div>
        <div>{lastOut ? <i className="dot" style={{ background: lastOut.color }} /> : <i className="dot" />}<b>{lastOut ? lastOut.label : '—'}</b><span>last result</span></div>
      </div>

      {extraKeys.length > 0 && (
        <div className="extra">
          <h4>More details</h4>
          <div className="extra-grid">
            {extraKeys.map((k) => (
              <div key={k} className="extra-item"><label>{k}</label><span>{String(extra[k])}</span></div>
            ))}
          </div>
        </div>
      )}

      <label className="dnc-toggle">
        <input type="checkbox" checked={!!p.dnc} onChange={(e) => updateProspect(p.id, { dnc: e.target.checked })} />
        <span>Mark as Do Not Call (blocks the Call button)</span>
      </label>
    </motion.div>
  );
}
