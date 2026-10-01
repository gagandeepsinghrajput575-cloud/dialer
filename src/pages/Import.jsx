import React, { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { UploadCloud, FileSpreadsheet, ArrowRight, ArrowLeft, Check, Loader2, PhoneCall, Download } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';

const TARGETS = [
  { id: 'name', label: 'Full name', re: /^(full[\s_-]*)?name$|contact[\s_-]*name|prospect/i },
  { id: 'first_name', label: 'First name', re: /first[\s_-]*name|fname|given/i },
  { id: 'last_name', label: 'Last name', re: /last[\s_-]*name|lname|surname|family/i },
  { id: 'phone', label: 'Phone number', re: /phone|mobile|cell|number|contact[\s_-]*no|tel|whatsapp/i },
  { id: 'email', label: 'Email', re: /e-?mail/i },
  { id: 'company', label: 'Company', re: /company|organi[sz]ation|business|employer|firm/i },
  { id: 'title', label: 'Job title', re: /title|designation|role|position/i },
  { id: 'location', label: 'Location', re: /location|city|address|country|region|state/i },
  { id: 'website', label: 'Website', re: /website|url|web|domain|linkedin/i },
];

function guess(headers) {
  const m = {};
  const used = new Set();
  for (const t of TARGETS) {
    const h = headers.find((x) => !used.has(x) && t.re.test(x));
    if (h) { m[t.id] = h; used.add(h); }
  }
  return m;
}

const SAMPLE = 'Name,Phone,Email,Company,Title,City,Notes from list\nAarav Mehta,9810012345,aarav@northwind.in,Northwind Logistics,Operations Head,Delhi,Met at expo\nPriya Sharma,+919811123456,priya@brightlabs.io,BrightLabs,Founder,Noida,Referred by Rahul\n';

export default function ImportPage() {
  const { refreshProspects, refreshStats, setView, toast } = useStore();
  const [step, setStep] = useState(0); // 0 upload, 1 map, 2 done
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [mapping, setMapping] = useState({});
  const [skipDupes, setSkipDupes] = useState(true);
  const [result, setResult] = useState(null);
  const inp = useRef(null);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const d = await api.parseFile(file);
      if (!d.rows.length) throw new Error('That file has no rows.');
      setData(d); setMapping(guess(d.headers)); setStep(1);
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

  const hasKey = mapping.phone || mapping.name || mapping.first_name || mapping.email;
  const mappedHeaders = new Set(Object.values(mapping));
  const extras = data ? data.headers.filter((h) => !mappedHeaders.has(h)) : [];

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
              <p className="muted small">We matched what we could. Check each field and fix anything that's off.</p>
              <div className="map-list">
                {TARGETS.map((t, i) => (
                  <motion.div key={t.id} className="map-row" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}>
                    <span>{t.label}</span><ArrowRight size={14} className="muted" />
                    <select value={mapping[t.id] || ''} onChange={(e) => setMapping({ ...mapping, [t.id]: e.target.value || undefined })}>
                      <option value="">— skip —</option>
                      {data.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </motion.div>
                ))}
              </div>
              {extras.length > 0 && <p className="muted small">These other columns will be saved under "More details": {extras.join(', ')}</p>}
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
            <p className="muted">{result.dupes} duplicates skipped · {result.empty} empty rows ignored</p>
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
