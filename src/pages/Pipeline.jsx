import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { Phone, Building2, GripVertical } from 'lucide-react';
import { useStore } from '../store.jsx';
import { Avatar } from '../components/ui.jsx';
import { STAGES } from '../utils.js';

function CardView({ p, overlay = false, nodeRef, listeners, attributes, isDragging }) {
  const { setDrawerId, openInDialer } = useStore();
  return (
    <div ref={nodeRef} className={`kcard ${isDragging ? 'ghosted' : ''} ${overlay ? 'overlay' : ''}`} onClick={() => !overlay && setDrawerId(p.id)}>
      <div className="kcard-top">
        <Avatar name={p.name || p.company} size={30} seed={p.id + p.name} />
        <div className="kcard-who"><b>{p.name || '(no name)'}</b><span><Building2 size={11} /> {p.company || '—'}</span></div>
        <span className="grip" {...(listeners || {})} {...(attributes || {})} onClick={(e) => e.stopPropagation()}><GripVertical size={16} /></span>
      </div>
      <div className="kcard-foot">
        <span className="mono">{p.phone || 'no phone'}</span>
        <button className="icon-btn sm" disabled={p.dnc || !p.phone} onClick={(e) => { e.stopPropagation(); openInDialer(p.id); }} title="Call"><Phone size={13} /></button>
      </div>
    </div>
  );
}

function Card({ p }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: String(p.id), data: { p } });
  return <CardView p={p} nodeRef={setNodeRef} listeners={listeners} attributes={attributes} isDragging={isDragging} />;
}

function Column({ stage, items }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div className={`kcol ${isOver ? 'over' : ''}`} ref={setNodeRef} style={{ '--c': stage.color }}>
      <div className="kcol-head"><i /><b>{stage.label}</b><em>{items.length}</em></div>
      <div className="kcol-body">
        {items.map((p) => <motion.div layout key={p.id} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}><Card p={p} /></motion.div>)}
        {items.length === 0 && <div className="kcol-empty">Drop here</div>}
      </div>
    </div>
  );
}

export default function Pipeline() {
  const { prospects, updateProspect, toast } = useStore();
  const [dragging, setDragging] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onEnd = (e) => {
    setDragging(null);
    const to = e.over?.id;
    const p = e.active?.data?.current?.p;
    const targetStage = STAGES.find((s) => s.id === to);
    if (to && p && targetStage && p.stage !== to) {
      updateProspect(p.id, { stage: to });
      toast(`${p.name || 'Prospect'} → ${targetStage.label}`);
    }
  };

  return (
    <div className="pipeline-page">
      <header className="page-head"><div><h1>Pipeline</h1><p>Drag prospects between stages. Results you log in the dialer move them automatically.</p></div></header>
      <DndContext sensors={sensors} onDragStart={(e) => setDragging(e.active.data.current.p)} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
        <div className="kanban">
          {STAGES.map((s) => <Column key={s.id} stage={s} items={prospects.filter((p) => p.stage === s.id)} />)}
        </div>
        <DragOverlay dropAnimation={{ duration: 180 }}>{dragging ? <CardView p={dragging} overlay /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}
