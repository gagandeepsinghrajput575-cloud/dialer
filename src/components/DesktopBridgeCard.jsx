// Settings panel for the native macOS shell and the Linphone fallback. It reads the same
// token-guarded descriptor the shell consumes, so what the agent copies is exactly what the
// bundled app registers with — no second source of truth, and no secret on screen.
import React, { useEffect, useState } from 'react';
import { Check, Copy, Laptop, PhoneOutgoing, Radio } from 'lucide-react';
import { api } from '../api';
import { desktopBridge, isDesktop, openInSoftphone } from '../desktop/bridge.mjs';

const COPY = [
  ['username', 'SIP username'],
  ['domain', 'Domain / proxy'],
  ['transport', 'Transport'],
  ['callerId', 'Copenhagen caller ID'],
];

export default function DesktopBridgeCard() {
  const [contract, setContract] = useState(null);
  const [status, setStatus] = useState(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let alive = true;
    api.desktopContract().then((value) => { if (alive) setContract(value); }).catch(() => {});
    const bridge = desktopBridge();
    if (bridge && typeof bridge.status === 'function') {
      Promise.resolve(bridge.status()).then((value) => { if (alive) setStatus(value); }).catch(() => {});
    }
    return () => { alive = false; };
  }, []);

  const copy = async (key, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(''), 1600);
    } catch { /* clipboard is denied in some browsers; the value is still selectable */ }
  };

  const linphone = contract && contract.fallback ? contract.fallback.linphone : null;
  const native = isDesktop();

  return (
    <section className="glass pad-lg desktop-card" aria-label="Native desktop app">
      <div className="panel-title">
        <Laptop size={16} /> Native macOS app <em>{native ? 'running in the desktop shell' : 'downloadable build'}</em>
      </div>

      <p className="muted small">
        {native
          ? 'Audio is bound to CoreAudio by this shell: no autoplay suspension, no browser tab to keep open, and the dock rings even when the phone is a background window.'
          : 'This window is the web app. The native build runs the same CRM with the microphone and speakers bound directly, and keeps the call alive when the window is hidden.'}
      </p>

      <div className="desktop-kv">
        <div><span>Runtime</span><b>{contract ? contract.runtime : 'darwin-coreaudio-native'}</b></div>
        <div><span>Engine</span><b>{status ? status.engine : 'webrtc'}</b></div>
        <div><span>Carrier registration</span><b>{status && status.registered ? 'registered' : 'on demand'}</b></div>
        <div><span>Build</span><b>{contract && contract.build ? contract.build.version : '1.0.0-native'}</b></div>
      </div>

      <div className="panel-title sub"><Radio size={15} /> Linphone fallback <em>Option E/A</em></div>
      <p className="muted small">
        If native audio is unavailable, Pulse still owns the queue, phonetics, notes and the ledger;
        Linphone carries only the voice. Copy these into Linphone → SIP account.
      </p>
      <div className="desktop-grid">
        {COPY.map(([key, label]) => {
          const value = linphone ? String(linphone[key] || '') : '';
          return (
            <button key={key} type="button" className="copy-chip" disabled={!value} onClick={() => copy(key, value)}>
              <span>{label}</span>
              <b className="mono">{value || '—'}</b>
              {copied === key ? <Check size={13} /> : <Copy size={13} />}
            </button>
          );
        })}
      </div>

      <div className="row gap" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn sm"
          disabled={!native}
          title={native ? 'Open the system SIP handler' : 'Available inside the desktop shell'}
          onClick={() => openInSoftphone('+4520123456')}
        >
          <PhoneOutgoing size={14} /> Test Linphone handoff
        </button>
        <span className="muted small">
          {contract && contract.inbound ? `Inbound DID ${contract.inbound.display} → ${contract.inbound.forwardingUri}` : 'Inbound DID +45 32 33 16 10'}
        </span>
      </div>
    </section>
  );
}
