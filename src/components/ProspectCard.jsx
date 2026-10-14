import React, { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Phone, Mail, MapPin, Globe, Building2, Copy, Check, CalendarClock, ShieldAlert, PhoneCall, Clock,
  ChevronDown, ExternalLink, ShieldX, Volume2,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import { Avatar, Editable, StagePicker } from './ui.jsx';
import { outcomeMeta, phoneIssue, emailIssue, timeAgo } from '../utils.js';
import { clip, extraInsights, isUrlValue } from '../registry.js';
import { getDanishPronunciation, speakPronunciation } from '../utils/phonetics.js';
import EmailComposer from './EmailComposer.jsx';

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

// Registry metadata from an enriched lead sheet: CVR number, advertising-protection flag,
// source links, whatever else the sheet carried. Collapsed by default — an agent who has to
// scroll past eight registry rows to reach the Call button is being slowed down by data they
// did not ask for — with the two commercially important facts surfaced as pills on the trigger,
// so "this company is ad-protected" is visible without opening anything.
function RegistryDetails({ insights }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  // useId keeps two cards for the same prospect (dialer + drawer) from minting the same DOM id.
  const panelId = `registry-${useId().replace(/:/g, '')}`;
  const { count, entries, cvr, adProtected, protectionNote, urlCount } = insights;

  return (
    <div className="registry">
      <button
        type="button"
        className="registry-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <ChevronDown size={15} className={`registry-caret ${open ? 'open' : ''}`} aria-hidden />
        <span className="registry-label">
          More details &amp; registry data <em>{count}</em>
        </span>
        <span className="registry-pills">
          {cvr && <span className="pill pill-cvr" title="Danish company registration number (CVR)">CVR {cvr}</span>}
          {adProtected && (
            <span className="pill pill-protected" title={protectionNote}>
              <ShieldX size={12} /> Ad-protected
            </span>
          )}
          {!cvr && !adProtected && urlCount > 0 && <span className="pill pill-quiet">{urlCount} link{urlCount === 1 ? '' : 's'}</span>}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            className="registry-body"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0.12 : 0.2, ease: 'easeOut' }}
          >
            <div className="registry-grid">
              {entries.map((e) => (
                <div key={e.key} className="registry-item">
                  <label>{e.key}</label>
                  {e.isUrl ? (
                    <a
                      href={e.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="registry-link"
                      title={e.value}
                    >
                      {clip(e.value)} <ExternalLink size={11} aria-hidden />
                    </a>
                  ) : (
                    <span>{isUrlValue(e.value) ? clip(e.value) : e.value}</span>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// `onSent` is optional: the card is rendered by the dialer, the drawer and the prospects
// table, and each of those owns a different timeline to refresh.
export default function ProspectCard({ p, big = false, onSent }) {
  const { updateProspect, toast, settings } = useStore();
  const [mailing, setMailing] = useState(false);
  if (!p) return null;
  const save = (field) => (val) => updateProspect(p.id, { [field]: val });

  // Phone and email are the two fields the dialer actually acts on, so a typo there is not a
  // cosmetic problem: it is a call that never connects, or a follow-up that bounces. Both are
  // checked before the round-trip; everything else is free text and saves as typed.
  const savePhone = (val) => {
    const issue = phoneIssue(val, settings?.default_country_code);
    if (issue) return toast(issue, 'error');
    return updateProspect(p.id, { phone: String(val ?? '').trim() });
  };
  const saveEmail = (val) => {
    const issue = emailIssue(val);
    if (issue) return toast(issue, 'error');
    return updateProspect(p.id, { email: String(val ?? '').trim() });
  };
  const insights = extraInsights(p.extra);
  const lastOut = outcomeMeta(p.last_outcome);

  let extraData = {};
  if (typeof p.extra === 'string') {
    try { extraData = JSON.parse(p.extra); } catch {}
  } else if (typeof p.extra === 'object' && p.extra !== null) {
    extraData = p.extra;
  }
  const inferredName = p.name || extraData['Best Public Decision-Maker'] || extraData['Owner Name(s)'] || extraData['Kontaktperson'] || extraData['Navn'] || '';
  const displayName = p.name || inferredName;
  const pronunciation = p.pronunciation || (displayName ? getDanishPronunciation(displayName) : '');

  return (
    <motion.div className={`pcard ${big ? 'big' : ''}`} key={p.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <div className="pcard-head" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
        <div className="row gap" style={{ alignItems: 'center' }}>
          <Avatar name={p.name || inferredName || p.company} size={big ? 64 : 52} seed={p.id + (p.name || inferredName || '')} />
          <div className="pcard-title" style={{ flex: 1, minWidth: 0 }}>
            <div className="row gap sm center-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Editable
                className="h-name"
                value={p.name}
                placeholder={inferredName ? `Name (Found: ${inferredName})` : "Name"}
                onSave={save('name')}
              />
              {pronunciation && (
                <button
                  type="button"
                  className="pronounce-chip sm"
                  onClick={() => speakPronunciation(displayName, pronunciation)}
                  title="Click to hear Danish pronunciation in English phonetics"
                >
                  <Volume2 size={11} /> {pronunciation}
                </button>
              )}
              {(!p.name && inferredName) && (
                <button
                  type="button"
                  className="btn xs link-btn"
                  style={{ fontSize: '11px', padding: '1px 6px', height: '20px', color: 'var(--cyan, #38bdf8)' }}
                  title={`Click to save "${inferredName}" as name`}
                  onClick={() => save('name')(inferredName)}
                >
                  Use "{inferredName}"
                </button>
              )}
            </div>
            <div className="sub-line">
              <Editable className="h-sub" value={p.title} placeholder="Job title" onSave={save('title')} />
              <span className="dot-sep">·</span>
              <Editable className="h-sub" value={p.company} placeholder="Company" onSave={save('company')} />
            </div>
          </div>
        </div>
        <div>
          <StagePicker value={p.stage} onChange={save('stage')} />
        </div>
      </div>

      <div className="info-grid">
        <Row icon={Phone} label="Phone" extra={<CopyBtn text={p.phone} />}>
          <Editable className="phone-big" value={p.phone} placeholder="+45 20 12 34 56" onSave={savePhone} />
        </Row>
        <Row
          icon={Mail}
          label="Email"
          extra={
            <>
              <CopyBtn text={p.email} />
              {p.email && (
                <button type="button" className="icon-btn sm" title={`Email ${p.email} in the app`} onClick={() => setMailing(true)}>
                  <Mail size={14} />
                </button>
              )}
            </>
          }
        >
          <Editable value={p.email} placeholder="name@company.com" onSave={saveEmail} />
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

      {insights.count > 0 && <RegistryDetails insights={insights} />}

      <label className="dnc-toggle">
        <input type="checkbox" checked={!!p.dnc} onChange={(e) => updateProspect(p.id, { dnc: e.target.checked })} />
        <span>Mark as Do Not Call (blocks the Call button)</span>
      </label>

      {mailing && (
        <EmailComposer
          prospectId={p.id}
          recipient={p.name}
          onSent={onSent}
          onClose={() => setMailing(false)}
        />
      )}
    </motion.div>
  );
}
