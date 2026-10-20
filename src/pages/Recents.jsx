import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  History, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing,
  Search, RotateCw, Play, Pause, Volume2, VolumeX, Download,
  Clock, Calendar, User, Building2, Check, X, ArrowUpRight,
  ArrowDownLeft, Sparkles, Filter, ChevronRight, Voicemail, Headphones,
  Layers, AlertCircle
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Avatar } from '../components/ui.jsx';
import { OUTCOMES, fmtDateTime, fmtDur, outcomeMeta } from '../utils.js';

function Equalizer({ playing }) {
  return (
    <div className={`mini-eq ${playing ? 'playing' : ''}`} aria-hidden>
      <span className="eq-bar b1" />
      <span className="eq-bar b2" />
      <span className="eq-bar b3" />
      <span className="eq-bar b4" />
    </div>
  );
}

function InlineAudioPlayer({ callId, filename, durationSec = 0 }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationSec);
  const [speed, setSpeed] = useState(1);
  const [loadError, setLoadError] = useState(false);
  const sliderId = useId();

  const togglePlay = (e) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (loadError) {
      setLoadError(false);
      el.load();
    }
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play().then(() => setPlaying(true)).catch(() => {
        setPlaying(false);
      });
    }
  };

  const cycleSpeed = (e) => {
    e.stopPropagation();
    const next = speed === 1 ? 1.25 : speed === 1.25 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const onSeek = (e) => {
    e.stopPropagation();
    const val = parseFloat(e.target.value);
    setCurrent(val);
    if (audioRef.current) audioRef.current.currentTime = val;
  };

  return (
    <div className="recents-audio-player" onClick={(e) => e.stopPropagation()}>
      <audio
        ref={audioRef}
        src={`/api/recordings/${callId}/audio`}
        preload="metadata"
        onLoadedMetadata={(e) => {
          setLoadError(false);
          if (e.target.duration && Number.isFinite(e.target.duration)) setDuration(e.target.duration);
        }}
        onTimeUpdate={(e) => setCurrent(e.target.currentTime)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
        onError={() => { setPlaying(false); setLoadError(true); }}
      />
      <button
        type="button"
        className={`recents-play-btn ${playing ? 'playing' : ''}`}
        onClick={togglePlay}
        title={loadError ? 'Retry loading recording' : playing ? 'Pause recording' : 'Play call audio'}
        aria-label={loadError ? 'Retry loading recording' : playing ? 'Pause recording' : 'Play call audio'}
      >
        {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" style={{ marginLeft: 2 }} />}
      </button>

      {loadError ? (
        <span className="recents-audio-error">
          <AlertCircle size={13} /> Audio unavailable
        </span>
      ) : (
        <>
          <Equalizer playing={playing} />

          <div className="recents-progress-wrap">
            <input
              id={sliderId}
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={current}
              onChange={onSeek}
              className="recents-slider"
              aria-label="Audio scrubber"
            />
            <div className="recents-slider-time">
              <span>{fmtDur(Math.round(current))}</span>
              <span>{fmtDur(Math.round(duration))}</span>
            </div>
          </div>

          <button
            type="button"
            className="recents-speed-btn"
            onClick={cycleSpeed}
            title="Playback speed"
            aria-label={`Playback speed ${speed}x`}
          >
            {speed}x
          </button>
        </>
      )}

      <a
        href={`/api/recordings/${callId}/audio`}
        download={filename || `call_${callId}.webm`}
        className="recents-download-btn"
        title="Download audio"
        aria-label="Download audio"
        onClick={(e) => e.stopPropagation()}
      >
        <Download size={13} />
      </a>
    </div>
  );
}

export default function Recents() {
  const { setActiveId, setDrawerId, setView, toast, stats, inbound, ledgerVersion } = useStore();
  const [calls, setCalls] = useState([]);
  const [summary, setSummary] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'inbound' | 'outbound' | 'missed' | 'recordings' | 'voicemail'
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 40;

  const loadCalls = useCallback(async () => {
    setLoading(true);
    try {
      const directionParam = filter === 'inbound' || filter === 'outbound' ? filter : undefined;
      const filterParam = ['missed', 'voicemail', 'recordings'].includes(filter) ? filter : undefined;

      const data = await api.calls({
        search,
        direction: directionParam,
        filter: filterParam,
        outcome: outcome || undefined,
        limit: pageSize,
        offset: page * pageSize,
      });

      setCalls(data.calls || []);
      setTotal(data.total || 0);
      setSummary(data.summary || null);
    } catch (err) {
      toast(err.message || 'Could not load recent calls', 'error');
    } finally {
      setLoading(false);
    }
  }, [search, filter, outcome, page, toast]);

  useEffect(() => {
    loadCalls();
  }, [loadCalls, stats, ledgerVersion, inbound?.callId, inbound?.answered]);

  useEffect(() => {
    const interval = setInterval(loadCalls, 10000);
    const onFocus = () => { if (document.visibilityState === 'visible') loadCalls(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [loadCalls]);

  const handleRedial = (call) => {
    if (call.prospect_id) {
      setActiveId(call.prospect_id);
      setView('dialer');
      toast(`Loaded ${call.prospect_name || 'prospect'} into Dialer cockpit`);
    } else if (call.caller_id || call.phone) {
      setView('dialer');
      toast(`Opening dialer for ${call.caller_id || call.phone}`);
    }
  };

  const handleOpenProspect = (prospectId) => {
    if (prospectId) setDrawerId(prospectId);
  };

  // Group calls by date relative buckets: Today, Yesterday, Earlier
  const groupedCalls = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const groups = {
      Today: [],
      Yesterday: [],
      Earlier: [],
    };

    for (const c of calls) {
      const dateStr = (c.started_at || '').slice(0, 10);
      if (dateStr === todayStr) {
        groups.Today.push(c);
      } else if (dateStr === yesterday) {
        groups.Yesterday.push(c);
      } else {
        groups.Earlier.push(c);
      }
    }
    return groups;
  }, [calls]);

  return (
    <div className="recents-page">
      {/* Top Header */}
      <header className="recents-header">
        <div className="recents-title-group">
          <div className="recents-icon-badge">
            <History size={22} className="text-cyan" />
          </div>
          <div>
            <h1 className="recents-title">Recent Calls</h1>
            <p className="recents-subtitle">
              Live chronological activity log — inbound callbacks, outbound cold-dials, missed rings &amp; voicemail drops
            </p>
          </div>
        </div>

        <button
          type="button"
          className="btn sm"
          onClick={loadCalls}
          disabled={loading}
          title="Refresh recent calls"
        >
          <RotateCw size={14} className={loading ? 'spin' : ''} />
          <span>Refresh</span>
        </button>
      </header>

      {/* KPI Stat Ribbon */}
      <section className="recents-kpi-grid">
        <div className="kpi-card total">
          <div className="kpi-label"><History size={14} /> Total Dials &amp; Inbounds</div>
          <div className="kpi-value">{summary?.totalCalls || 0}</div>
          <div className="kpi-sub">Lifetime ledger records</div>
        </div>

        <div className="kpi-card inbound">
          <div className="kpi-label"><PhoneIncoming size={14} /> Inbound Callbacks</div>
          <div className="kpi-value">{summary?.inboundCalls || 0}</div>
          <div className="kpi-sub">Via FlyNumber / Telnyx WebRTC</div>
        </div>

        <div className="kpi-card outbound">
          <div className="kpi-label"><PhoneOutgoing size={14} /> Outbound Dials</div>
          <div className="kpi-value">{summary?.outboundCalls || 0}</div>
          <div className="kpi-sub">Stamped with Copenhagen DID</div>
        </div>

        <div className={`kpi-card missed ${(summary?.missedCalls || 0) > 0 ? 'has-missed' : ''}`}>
          <div className="kpi-label">
            <PhoneMissed size={14} /> Missed &amp; Declined
            {(summary?.missedCalls || 0) > 0 && <span className="kpi-alert-dot" />}
          </div>
          <div className="kpi-value">{summary?.missedCalls || 0}</div>
          <div className="kpi-sub">Action required callbacks</div>
        </div>

        <div className="kpi-card duration">
          <div className="kpi-label"><Clock size={14} /> Total Talk Time</div>
          <div className="kpi-value">{fmtDur(summary?.totalDurationSec || 0)}</div>
          <div className="kpi-sub">Connected phone audio</div>
        </div>
      </section>

      {/* Filter and Search Bar */}
      <div className="recents-controls-bar">
        <div className="recents-tabs">
          <button
            type="button"
            className={`recents-tab ${filter === 'all' ? 'active' : ''}`}
            onClick={() => { setFilter('all'); setPage(0); }}
          >
            All Calls <span className="count-pill">{total}</span>
          </button>
          <button
            type="button"
            className={`recents-tab ${filter === 'inbound' ? 'active' : ''}`}
            onClick={() => { setFilter('inbound'); setPage(0); }}
          >
            <ArrowDownLeft size={13} className="text-emerald" /> Incoming
          </button>
          <button
            type="button"
            className={`recents-tab ${filter === 'outbound' ? 'active' : ''}`}
            onClick={() => { setFilter('outbound'); setPage(0); }}
          >
            <ArrowUpRight size={13} className="text-cyan" /> Outgoing
          </button>
          <button
            type="button"
            className={`recents-tab missed ${filter === 'missed' ? 'active' : ''}`}
            onClick={() => { setFilter('missed'); setPage(0); }}
          >
            <PhoneMissed size={13} className="text-rose" /> Missed
            {(summary?.missedCalls || 0) > 0 && (
              <span className="missed-badge">{summary.missedCalls}</span>
            )}
          </button>
          <button
            type="button"
            className={`recents-tab ${filter === 'recordings' ? 'active' : ''}`}
            onClick={() => { setFilter('recordings'); setPage(0); }}
          >
            <Headphones size={13} /> Has Recording
          </button>
          <button
            type="button"
            className={`recents-tab ${filter === 'voicemail' ? 'active' : ''}`}
            onClick={() => { setFilter('voicemail'); setPage(0); }}
          >
            <Voicemail size={13} /> Voicemails
          </button>
        </div>

        <div className="recents-search-wrap">
          <Search size={15} className="search-icon" />
          <input
            type="text"
            className="recents-search-input"
            placeholder="Search lead name, company, or Danish +45 phone…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
          {search && (
            <button
              type="button"
              className="clear-search-btn"
              onClick={() => { setSearch(''); setPage(0); }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Main Call List */}
      <main className="recents-list-container">
        {loading && calls.length === 0 ? (
          <div className="recents-loading-state">
            <RotateCw size={24} className="spin text-cyan" />
            <p>Loading recent calls ledger…</p>
          </div>
        ) : calls.length === 0 ? (
          <div className="recents-empty-state">
            <History size={36} className="text-muted" />
            <h3>No matching calls found</h3>
            <p>Calls placed in the Dialer or received over FlyNumber appear here in real time.</p>
          </div>
        ) : (
          Object.entries(groupedCalls).map(([groupTitle, groupItems]) => {
            if (!groupItems.length) return null;
            return (
              <section key={groupTitle} className="recents-date-group">
                <div className="recents-date-header">
                  <Calendar size={13} />
                  <span>{groupTitle}</span>
                  <span className="date-count">({groupItems.length})</span>
                </div>

                <div className="recents-cards-grid">
                  <AnimatePresence>
                    {groupItems.map((c) => {
                      const isLiveRinging = c.direction === 'inbound' && c.status === 'ringing' && inbound?.callId === c.id && !inbound?.answered;
                      const isMissed = !isLiveRinging && c.direction === 'inbound' && ['ringing', 'missed', 'declined'].includes(c.status);
                      const isAbandoned = c.status === 'abandoned' || c.outcome === 'dropped';
                      const isLiveConnected = c.status === 'connected' && !c.ended_at;
                      const isInbound = c.direction === 'inbound';
                      const outcomeInfo = outcomeMeta(c.outcome);

                      return (
                        <motion.div
                          key={c.id}
                          className={`recents-card ${isMissed ? 'missed-border' : ''}`}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={{ duration: 0.16 }}
                          onClick={() => handleOpenProspect(c.prospect_id)}
                        >
                          <div className="recents-card-body">
                            {/* Direction Icon Badge */}
                            <div className={`direction-badge ${isMissed ? 'missed' : isInbound ? 'inbound' : 'outbound'}`}>
                              {isLiveRinging ? (
                                <PhoneIncoming size={16} />
                              ) : isMissed ? (
                                <PhoneMissed size={16} />
                              ) : isInbound ? (
                                <ArrowDownLeft size={16} />
                              ) : (
                                <ArrowUpRight size={16} />
                              )}
                            </div>

                            {/* Center Info */}
                            <div className="lead-info">
                              <div className="lead-primary">
                                <span className="lead-name">
                                  {c.prospect_name || c.caller_id || c.phone || 'Unknown Caller'}
                                </span>
                                {c.pronunciation && (
                                  <span className="pronunciation-badge" title="Danish pronunciation guide">
                                    /{c.pronunciation}/
                                  </span>
                                )}
                                {isLiveRinging && (
                                  <span className="ringing-pill">Incoming Ring…</span>
                                )}
                                {isLiveConnected && (
                                  <span className="connected-pill">Live Call</span>
                                )}
                                {isAbandoned && (
                                  <span className="abandoned-pill">Dropped / Reloaded</span>
                                )}
                                {isMissed && (
                                  <span className="missed-pill">Missed Call</span>
                                )}
                              </div>

                              <div className="lead-sub">
                                {c.company && (
                                  <span className="company-tag">
                                    <Building2 size={12} /> {c.company}
                                  </span>
                                )}
                                {c.phone && <span className="phone-tag">{c.phone}</span>}
                                {c.caller_id && !c.phone && <span className="phone-tag">{c.caller_id}</span>}
                              </div>

                              {/* AI summary snippet if present */}
                              {c.summary && (
                                <div className="recents-summary-box">
                                  <Sparkles size={12} className="text-cyan" />
                                  <span>{c.summary}</span>
                                </div>
                              )}

                              {/* Inline Audio Player if recording attached */}
                              {c.has_recording && (
                                <InlineAudioPlayer
                                  callId={c.id}
                                  filename={`recording_${c.id}.webm`}
                                  durationSec={c.duration_sec}
                                />
                              )}
                            </div>

                            {/* Meta & Actions Column */}
                            <div className="call-meta-column">
                              <div className="call-time-ago">
                                {fmtDateTime(c.started_at)}
                              </div>

                              <div className="call-pills-row">
                                <span className={`duration-pill ${c.duration_sec > 0 ? 'connected' : 'silent'}`}>
                                  {isMissed ? 'No Answer' : fmtDur(c.duration_sec)}
                                </span>

                                {c.outcome && (
                                  <span className="outcome-pill" style={{ color: outcomeInfo.color, borderColor: outcomeInfo.color }}>
                                    {outcomeInfo.label}
                                  </span>
                                )}

                                {c.vm_dropped === 1 && (
                                  <span className="vm-pill" title="Danish Voicemail Dropped">
                                    <Voicemail size={12} /> Voicemail
                                  </span>
                                )}
                              </div>

                              {/* Action Buttons */}
                              <div className="recents-actions-row" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  className="btn sm primary redial-btn"
                                  onClick={() => handleRedial(c)}
                                  title="Dial / Call Back in Dialer"
                                >
                                  <PhoneCall size={13} />
                                  <span>Call</span>
                                </button>

                                {c.prospect_id && (
                                  <button
                                    type="button"
                                    className="btn sm ghost"
                                    onClick={() => handleOpenProspect(c.prospect_id)}
                                    title="View Prospect CRM Details"
                                  >
                                    <User size={13} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </section>
            );
          })
        )}
      </main>
    </div>
  );
}
