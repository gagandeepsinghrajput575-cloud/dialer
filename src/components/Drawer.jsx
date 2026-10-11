import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, PhoneCall, Trash2, Mail } from 'lucide-react';
import EmailComposer, { VerifyBadge } from './EmailComposer.jsx';
import { useStore } from '../store.jsx';
import { api } from '../api';
import ProspectCard from './ProspectCard.jsx';
import Notes, { CallHistory, useDetail } from './Notes.jsx';

function Inner({ id }) {
  const { prospects, setDrawerId, openInDialer, deleteProspect } = useStore();
  const p = prospects.find((x) => x.id === id);
  const { detail, reload } = useDetail(id);
  const [mailing, setMailing] = useState(false);
  const [verdict, setVerdict] = useState(null);
  if (!p) return null;
  const del = async () => {
    if (!confirm(`Delete ${p.name || 'this prospect'} and all their notes?`)) return;
    await deleteProspect(id);
  };
  // Check the address before the agent spends time writing to it.
  const checkEmail = async () => {
    try { setVerdict(await api.verifyEmail(p.email)); } catch { setVerdict(null); }
  };
  return (
    <>
      <div className="drawer-top">
        <button className="btn primary" onClick={() => openInDialer(id)} disabled={p.dnc || !p.phone}><PhoneCall size={16} /> Open in dialer</button>
        <button className="btn" onClick={() => setMailing(true)} disabled={!p.email} title={p.email ? 'Send an email' : 'No email address on this prospect'}><Mail size={16} /> Email</button>
        <button className="icon-btn danger" onClick={del} title="Delete prospect"><Trash2 size={16} /></button>
        <button className="icon-btn" onClick={() => setDrawerId(null)} title="Close"><X size={18} /></button>
      </div>
      {p.email && (
        <div className="drawer-verify">
          <button className="link-btn sm" onClick={checkEmail} title="Check whether this address can actually receive mail">
            {verdict ? <VerifyBadge result={verdict} /> : <>Check {p.email}</>}
          </button>
        </div>
      )}
      {mailing && (
        <EmailComposer
          prospectId={id}
          recipient={p.name}
          // The send logs a note; pull it in so the timeline below the composer is already
          // up to date when the modal closes.
          onSent={() => reload()}
          onClose={() => setMailing(false)}
        />
      )}
      <div className="drawer-body">
        <ProspectCard p={p} onSent={() => reload()} />
        <Notes pid={id} notes={detail?.notes || []} reload={reload} />
        <CallHistory calls={detail?.calls || []} />
      </div>
    </>
  );
}

export default function Drawer() {
  const { drawerId, setDrawerId } = useStore();
  return (
    <AnimatePresence>
      {drawerId && (
        <>
          <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawerId(null)} />
          <motion.aside className="drawer" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', stiffness: 320, damping: 34 }}>
            <Inner key={drawerId} id={drawerId} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
