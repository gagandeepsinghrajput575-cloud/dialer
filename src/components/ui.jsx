import React, { useEffect, useId, useState } from 'react';
import { motion } from 'framer-motion';
import { initials, gradFor, stageMeta, STAGES } from '../utils.js';

export function Avatar({ name, size = 44, seed }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: gradFor(seed || name) }}>
      {initials(name)}
    </div>
  );
}

export function StageBadge({ stage }) {
  const m = stageMeta(stage);
  return (
    <span className="badge" style={{ '--c': m.color }}>
      <i />{m.label}
    </span>
  );
}

export function StagePicker({ value, onChange }) {
  const uid = useId();
  return (
    <div className="stage-picker">
      {STAGES.map((s) => (
        <button key={s.id} className={`stage-pill ${value === s.id ? 'on' : ''}`} style={{ '--c': s.color }} onClick={() => onChange(s.id)}>
          {value === s.id && <motion.span layoutId={`sp-${uid}`} className="stage-pill-bg" />}
          <i />{s.label}
        </button>
      ))}
    </div>
  );
}

export function Editable({ value, onSave, placeholder, className = '', type = 'text', ...rest }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => { if ((v ?? '') !== (value ?? '')) onSave(v); };
  return (
    <input
      {...rest}
      type={type}
      className={`inline-edit ${className}`}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(value ?? ''); e.currentTarget.blur(); } }}
    />
  );
}

export function Empty({ icon, title, sub, children }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {sub && <p>{sub}</p>}
      {children}
    </div>
  );
}

export function Switch({ checked, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 32 }} />
    </button>
  );
}
