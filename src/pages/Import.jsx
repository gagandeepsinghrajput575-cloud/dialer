import React, { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { UploadCloud, FileSpreadsheet, ArrowRight, ArrowLeft, Check, Loader2, PhoneCall, Download } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';

// Every header a Danish sales list actually arrives with. The English patterns stay first
// because they are the common case, but Navn/Telefon/Firma/Stilling/By used to fall through to
// "skip" and had to be matched by hand on every single import.
const TARGETS = [
  { id: 'name', label: 'Full name', re: /^(full[\s_-]*)?name$|contact[\s_-]*name|prospect|navn|kontaktperson|kunde/i },
  { id: 'first_name', label: 'First name', re: /first[\s_-]*name|fname|given|fornavn/i },
  { id: 'last_name', label: 'Last name', re: /last[\s_-]*name|lname|surname|family|efternavn/i },
  { id: 'phone', label: 'Phone number', re: /phone|mobile|cell|number|contact[\s_-]*no|tel|whatsapp|telefon|tlf|mobil|mobilnummer|hovednummer/i },
  { id: 'email', label: 'Email', re: /e-?mail|mailadresse/i },
  { id: 'company', label: 'Company', re: /company|organi[sz]ation|business|employer|firm|firma|virksomhed|selskab/i },
  { id: 'title', label: 'Job title', re: /title|designation|role|position|stilling|titel|rolle/i },
  { id: 'location', label: 'Location', re: /location|city|address|country|region|state|by|postnr|postnummer|adresse|kommune/i },
  { id: 'website', label: 'Website', re: /website|url|web|domain|linkedin|hjemmeside|webadresse|domæne/i },
  // Notes are a real field now: the text is written to the prospect's note feed at import
  // instead of being dumped into "More details" and forgotten.
  { id: 'notes', label: 'Notes', re: /note|notes|comment|comments|noter|bemærkning|bemærkninger|kommentar/i },
];

// Two passes. The first is strict: a header only wins if it matches nothing earlier in the
// list better. The second pass catches the leftovers with a looser "contains the word" test,
// so a column called "Telefonnummer (mobil)" is not silently skipped while "Navn" is taken.
function guess(headers) {
  const m = {};
  const used = new Set();
  for (const t of TARGETS) {
    const h = headers.find((x) => !used.has(x) && t.re.test(x));
    if (h) { m[t.id] = h; used.add(h); }
  }
  return m;
}

// The looser patterns used by the fallback pass, in priority order. Deliberately conservative:
// 'by' is a location word but also appears inside many English headers, so it is anchored.
const LOOSE = [
  ['phone', /(telefon|tlf|mobil|phone|tel)[\s_-]?(nr|nummer|number|no)?/i],
  ['email', /(e-?mail|mail)/i],
  ['company', /(firma|virksomhed|selskab|company|organisation|organization)/i],
  ['name', /(navn|name)/i],
  ['title', /(stilling|titel|rolle|title|position)/i],
  ['location', /^(by|city|adresse|address|postnr|postnummer|kommune|location)$/i],
  ['notes', /(noter?|bemærkning|kommentar|notes?|comment)/i],
];

function guessLoose(headers, alreadyMapped) {
  const m = { ...alreadyMapped };
  const used = new Set(Object.values(m).filter(Boolean));
  for (const [id, re] of LOOSE) {
    if (m[id]) continue;
    const h = headers.find((x) => !used.has(x) && re.test(x));
    if (h) { m[id] = h; used.add(h); }
  }
  return m;
}

// The sample is in Danish on purpose: this is a Danish dialer, and the file you export from a
// Danish CRM is what the mapper has to cope with.
const SAMPLE = 'Navn,Telefon,E-mail,Firma,Stilling,By,Noter\nMette Jensen,20123456,mette@nordiclogistik.dk,Nordic Logistik,Driftschef,København,Mødt på messe i Herning\nAnders Nielsen,+4522345678,anders@brightlab.dk,BrightLab ApS,Stifter,Aarhus,Henvist af Sofie\n';

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
      const first = guess(d.headers);
      setData(d); setMapping(guessLoose(d.headers, first)); setStep(1);
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
              <p className="muted small">
                We matched what we could. Check each field and fix anything that's off.
                A <b>Notes</b> column becomes each prospect's first note, so the context you
                exported with the list arrives with it.
              </p>
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
            <p className="muted">
              {result.dupes} duplicates skipped · {result.empty} empty rows ignored
              {result.notesCreated ? ` · ${result.notesCreated} notes carried over` : ''}
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
