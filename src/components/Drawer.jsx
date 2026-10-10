import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, PhoneCall, Trash2 } from 'lucide-react';
import { useStore } from '../store.jsx';
import { api } from '../api';
import ProspectCard from './ProspectCard.jsx';
import Notes, { CallHistory, useDetail } from './Notes.jsx';

function Inner({ id }) {
  const { prospects, setDrawerId, openInDialer, deleteProspect, onProspectSaved } = useStore();
  const { detail, reload } = useDetail(id);
  // ProspectCard saves through the store, so re-read after a save instead of
  // showing the values from before the edit.
  useEffect(() => onProspectSaved((saved) => { if (saved?.id === id) reload(); }), [onProspectSaved, id, reload]);
  // Prefer the freshly fetched record: the full list is loaded lazily, so it may
  // not be in memory when the drawer is opened from the dashboard's recent calls.
  const p = detail || prospects.find((x) => x.id === id);
  if (!p) return null;
  const del = async () => {
    if (!confirm(`Delete ${p.name || 'this prospect'} and all their notes?`)) return;
    await deleteProspect(id);
  };
  return (
    <>
      <div className="drawer-top">
        <button className="btn primary" onClick={() => openInDialer(id)} disabled={p.dnc || !p.phone}><PhoneCall size={16} /> Open in dialer</button>
        <button className="icon-btn danger" onClick={del} title="Delete prospect"><Trash2 size={16} /></button>
        <button className="icon-btn" onClick={() => setDrawerId(null)} title="Close"><X size={18} /></button>
      </div>
      <div className="drawer-body">
        <ProspectCard p={p} />
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
