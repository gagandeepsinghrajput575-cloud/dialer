import React, { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { UploadCloud, FileSpreadsheet, ArrowRight, ArrowLeft, Check, Loader2, PhoneCall, Download } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { IMPORT_TARGETS as TARGETS, canImport, extrasOf, guessMapping, isRegistryHeader } from '../importMap.js';

const SAMPLE = 'Name,Phone,Email,Company,Title,City,Notes from list\nMette Jensen,20123456,mette@nordiclogistik.dk,Nordic Logistik,Driftschef,København,Met at expo\nAnders Nielsen,+4522345678,anders@brightlab.dk,BrightLab ApS,Founder,Aarhus,Referred by Sofie\n';

export default function ImportPage() {
  const { refreshProspects, refreshStats, setView, toast } = useStore();
  const [step, setStep] = useState(0); // 0 upload, 1 map, 2 done
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [mapping, setMapping] = useState({});
  // What the matcher guessed before anybody touched it: the "auto" pill is only honest while
  // the row still holds that guess.
  const [guessed, setGuessed] = useState({});
  const [skipDupes, setSkipDupes] = useState(true);
  const [result, setResult] = useState(null);
  const inp = useRef(null);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const d = await api.parseFile(file);
      if (!d.rows.length) throw new Error('That file has no rows.');
      const auto = guessMapping(d.headers);
      setData(d); setMapping(auto); setGuessed(auto); setStep(1);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }, [toast]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.bulk({ rows: data.rows, mapping, skipDuplicates: skipDupes });
      await Promise.all([refreshProspects(), refreshStats()]);
      setResult(r); setStep(2);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };

  const downloadSample = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([SAMPLE], { type: 'text/csv' }));
    a.download = 'sample-prospects.csv'; a.click();
  };

  const hasKey = canImport(mapping);
  const extras = data ? extrasOf(data.headers, mapping) : [];
  // Registry columns (CVR, protection flags, source URLs) are filed as metadata rather than
  // shown as "unmapped" — they were never contact fields in the first place.
  const registryExtras = extras.filter(isRegistryHeader);
  const otherExtras = extras.filter((h) => !isRegistryHeader(h));

  return (
    <div className="import-page">
      <header className="page-head"><div><h1>Import your list</h1><p>CSV or Excel. Every column is kept, so nothing about a prospect is lost.</p></div>
        <div className="steps">{['Upload', 'Match columns', 'Done'].map((s, i) => <div key={s} className={`step ${step >= i ? 'on' : ''}`}><i>{step > i ? <Check size={12} /> : i + 1}</i>{s}</div>)}</div>
      </header>

      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div key="s0" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <div className={`dropzone glass ${drag ? 'drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }} onClick={() => inp.current?.click()}>
              <input ref={inp} type="file" accept=".csv,.xlsx,.xls,.tsv,.txt" hidden onChange={(e) => onFile(e.target.files[0])} />
              <motion.div className="drop-ico" animate={{ y: [0, -8, 0] }} transition={{ repeat: Infinity, duration: 2.6, ease: 'easeInOut' }}>
                {busy ? <Loader2 size={40} className="spin" /> : <UploadCloud size={44} />}
              </motion.div>
              <h3>{drag ? 'Drop it!' : 'Drag & drop your file here'}</h3>
              <p>or click to browse · .csv .xlsx .xls</p>
            </div>
            <div className="center pad"><button className="link-btn" onClick={downloadSample}><Download size={14} /> Download a sample CSV</button></div>
          </motion.div>
        )}

        {step === 1 && data && (
          <motion.div key="s1" className="map-grid" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <div className="glass pad-lg">
              <div className="panel-title"><FileSpreadsheet size={16} /> {data.filename} <em>{data.rows.length} rows</em></div>
              <p className="muted small">
                We matched what we could. Check each field and fix anything that's off.
                A <b>Notes</b> column becomes each prospect's first note, so the context you
                exported with the list arrives with it.
              </p>
              <div className="map-list">
                {TARGETS.map((t, i) => (
                  <motion.div key={t.id} className="map-row" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}>
                    <span>{t.label}</span><ArrowRight size={14} className="muted" />
                    <select
                      value={mapping[t.id] || ''}
                      aria-label={`Column for ${t.label}`}
                      onChange={(e) => setMapping({ ...mapping, [t.id]: e.target.value || undefined })}
                    >
                      <option value="">— skip —</option>
                      {data.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                    {mapping[t.id] && guessed[t.id] === mapping[t.id] && (
                      <span className="map-auto" title="Matched automatically from the column name">auto</span>
                    )}
                  </motion.div>
                ))}
              </div>
              {otherExtras.length > 0 && <p className="muted small">Saved under "More details": {otherExtras.join(', ')}</p>}
              {registryExtras.length > 0 && (
                <p className="muted small">
                  Kept as registry data (CVR, protection flags and source links live there, not in the contact fields): {registryExtras.join(', ')}
                </p>
              )}
              {mapping.notes && <p className="muted small">“{mapping.notes}” becomes the first note on every prospect.</p>}
              <label className="check-row"><input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} /> Skip numbers that are already in the app</label>
              <div className="row gap end">
                <button className="btn" onClick={() => { setStep(0); setData(null); }}><ArrowLeft size={15} /> Back</button>
                <button className="btn primary glow" disabled={!hasKey || busy} onClick={run}>{busy ? <Loader2 size={15} className="spin" /> : null} Import {data.rows.length} prospects</button>
              </div>
            </div>
            <div className="glass pad-lg">
              <div className="panel-title">Preview</div>
              <div className="preview-scroll">
                <table className="table compact">
                  <thead><tr>{data.headers.slice(0, 6).map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{data.rows.slice(0, 6).map((r, i) => <tr key={i}>{data.headers.slice(0, 6).map((h) => <td key={h} className="trunc">{String(r[h])}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

        {step === 2 && result && (
          <motion.div key="s2" className="glass done-card" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }}>
            <motion.div className="done-ico" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}><Check size={38} strokeWidth={3} /></motion.div>
            <h2>{result.added} prospects imported</h2>
            <p className="muted">
              {result.dupes} duplicates skipped · {result.empty} empty rows ignored
              {(result.noted || result.notesCreated) ? ` · ${result.noted || result.notesCreated} notes carried over` : ''}
            </p>
            <div className="row gap center-row">
              <button className="btn" onClick={() => { setStep(0); setData(null); }}>Import another</button>
              <button className="btn primary glow" onClick={() => setView('dialer')}><PhoneCall size={16} /> Start dialing</button>
            </div>
            <div className="confetti" aria-hidden>{Array.from({ length: 26 }).map((_, i) => <motion.i key={i} style={{ left: `${(i * 37) % 100}%`, background: ['#8b5cf6', '#22d3ee', '#34d399', '#f472b6', '#fbbf24'][i % 5] }} initial={{ y: -20, opacity: 1, rotate: 0 }} animate={{ y: 360, opacity: 0, rotate: 360 + i * 20 }} transition={{ duration: 1.8 + (i % 5) * 0.2, delay: (i % 8) * 0.05, ease: 'easeIn' }} />)}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
