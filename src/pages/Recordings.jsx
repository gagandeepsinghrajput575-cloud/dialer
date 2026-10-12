import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Headphones, Play, Pause, Download, Trash2, Search, RotateCw,
  Sparkles, PhoneCall, PhoneIncoming, Clock, HardDrive, ShieldCheck,
  Check, X, Volume2, VolumeX, Filter, AlertCircle, ArrowRight
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Avatar } from '../components/ui.jsx';
import { OUTCOMES, fmtDateTime, fmtDur, outcomeMeta, timeAgo } from '../utils.js';

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

function RecordingPlayer({ recording, isPlaying, onPlayToggle, onDelete }) {
  const audioRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(recording.duration_sec || 0);
  const [speed, setSpeed] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const sliderId = useId();

  // Keep actual audio element synced with parent playing state
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (isPlaying) {
      el.play().catch(() => onPlayToggle(false));
    } else {
      el.pause();
    }
  }, [isPlaying, onPlayToggle]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = speed;
  }, [speed]);

  const onLoadedMetadata = () => {
    const el = audioRef.current;
    if (el && Number.isFinite(el.duration) && el.duration > 0) {
      setDuration(el.duration);
    }
  };

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (el) setCurrentTime(el.currentTime);
  };

  const onEnded = () => {
    setCurrentTime(0);
    onPlayToggle(false);
  };

  const handleSeek = (e) => {
    const val = Number(e.target.value);
    setCurrentTime(val);
    if (audioRef.current) audioRef.current.currentTime = val;
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2];
    const nextIdx = (speeds.indexOf(speed) + 1) % speeds.length;
    setSpeed(speeds[nextIdx]);
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    audioRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div className={`recording-player-box ${isPlaying ? 'active' : ''}`}>
      <audio
        ref={audioRef}
        src={recording.audio_url}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
      />

      <div className="player-controls">
        <button
          className={`play-circle-btn ${isPlaying ? 'playing' : ''}`}
          onClick={() => onPlayToggle(!isPlaying)}
          title={isPlaying ? 'Pause (Space)' : 'Play recording'}
          aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
        >
          {isPlaying ? <Pause size={17} /> : <Play size={17} className="play-icon-offset" />}
        </button>

        <Equalizer playing={isPlaying} />

        <div className="player-scrub-area">
          <label htmlFor={`scrub-${sliderId}`} className="sr-only">Audio seek slider</label>
          <input
            id={`scrub-${sliderId}`}
            type="range"
            min="0"
            max={duration > 0 ? duration : 100}
            step="0.1"
            value={currentTime}
            onChange={handleSeek}
            className="player-slider"
            style={{
              background: `linear-gradient(to right, #22d3ee ${progressPercent}%, rgba(255,255,255,0.12) ${progressPercent}%)`
            }}
            aria-valuemin="0"
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            aria-label="Seek position in recording"
          />
          <div className="player-time-display mono">
            <span>{fmtDur(currentTime)}</span>
            <span className="player-time-sep">/</span>
            <span>{fmtDur(duration || recording.duration_sec || 0)}</span>
          </div>
        </div>

        <div className="player-extra-actions">
          <button
            className="speed-badge-btn mono"
            onClick={cycleSpeed}
            title="Change playback speed"
            aria-label={`Playback speed: ${speed}x`}
          >
            {speed}x
          </button>

          <button
            className="player-icon-btn"
            onClick={toggleMute}
            title={isMuted ? 'Unmute audio' : 'Mute audio'}
            aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
          >
            {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>

          <a
            href={recording.audio_url}
            download={recording.filename || `pulse-call-${recording.call_id}.webm`}
            className="player-icon-btn download-link"
            title="Download audio recording file"
            aria-label="Download audio file"
          >
            <Download size={15} />
          </a>

          <button
            className="player-icon-btn delete-btn"
            onClick={() => onDelete(recording.call_id)}
            title="Delete this recording"
            aria-label="Delete recording"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="recording-card glass skeleton-loading">
      <div className="skeleton-line w-40" />
      <div className="skeleton-line w-70" />
      <div className="skeleton-player-box" />
    </div>
  );
}

export default function Recordings() {
  const { setDrawerId, setView, toast } = useStore();
  const [recordings, setRecordings] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const [generatingDemo, setGeneratingDemo] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const fetchRecordings = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.recordings({
        search,
        outcome: outcomeFilter,
        direction: directionFilter,
        limit: 100,
      });
      setRecordings(res.recordings || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err?.message || 'Could not load recordings');
    } finally {
      setLoading(false);
    }
  }, [search, outcomeFilter, directionFilter]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRecordings();
    }, 180);
    return () => clearTimeout(timer);
  }, [fetchRecordings]);

  // Handle generating sample recordings for zero-cost demo test
  const handleGenerateDemo = async () => {
    setGeneratingDemo(true);
    try {
      const res = await api.demoRecordings();
      if (res.created > 0) {
        toast(`Provisioned ${res.created} demo recordings to play`);
      } else {
        toast('Demo recordings already exist or make a call in the dialer first!');
      }
      await fetchRecordings();
    } catch (err) {
      toast(err?.message || 'Could not generate demo audio', 'error');
    } finally {
      setGeneratingDemo(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingId) return;
    const id = deletingId;
    setDeletingId(null);
    try {
      await api.deleteRecording(id);
      if (playingId === id) setPlayingId(null);
      toast('Recording deleted from disk');
      setRecordings((prev) => prev.filter((r) => r.call_id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      toast(err?.message || 'Could not delete recording', 'error');
    }
  };

  // Metrics calculations
  const totalSeconds = useMemo(() => {
    return recordings.reduce((acc, r) => acc + (r.duration_sec || r.call_duration || 0), 0);
  }, [recordings]);

  const totalBytes = useMemo(() => {
    return recordings.reduce((acc, r) => acc + (r.size_bytes || 0), 0);
  }, [recordings]);

  const storageLabel = useMemo(() => {
    if (totalBytes > 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(totalBytes / 1024)} KB`;
  }, [totalBytes]);

  const resetFilters = () => {
    setSearch('');
    setOutcomeFilter('');
    setDirectionFilter('');
  };

  return (
    <div className="recordings-page">
      {/* Header bar */}
      <header className="recordings-header">
        <div className="recordings-title-group">
          <div className="recordings-title-row">
            <h1>Call Recordings</h1>
            <span className="free-cost-badge" title="Recorded client-side via WebRTC stream directly to local storage">
              <ShieldCheck size={13} className="text-ok" />
              100% Free · $0.00 Extra Charges
            </span>
          </div>
          <p className="recordings-sub">
            In-browser WebRTC call recordings stored locally on disk with instant scrubbing and zero carrier storage markups.
          </p>
        </div>

        <div className="recordings-header-actions">
          <button
            className="btn xs glass"
            onClick={handleGenerateDemo}
            disabled={generatingDemo}
            title="Generate synthetic audio for recent calls so you can listen immediately"
          >
            <Sparkles size={14} className={generatingDemo ? 'spin' : ''} />
            <span>{generatingDemo ? 'Generating…' : 'Demo Audio'}</span>
          </button>

          <button
            className="btn xs glass"
            onClick={fetchRecordings}
            disabled={loading}
            title="Refresh recordings list"
          >
            <RotateCw size={14} className={loading ? 'spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {/* KPI Metrics strip */}
      <section className="recordings-kpi-grid">
        <motion.div className="glass kpi-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <div className="kpi-icon-wrap" style={{ background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6' }}>
            <Headphones size={18} />
          </div>
          <div>
            <div className="kpi-value mono">{total}</div>
            <div className="kpi-label">Recorded Calls</div>
          </div>
        </motion.div>

        <motion.div className="glass kpi-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.3 }}>
          <div className="kpi-icon-wrap" style={{ background: 'rgba(34, 211, 238, 0.15)', color: '#22d3ee' }}>
            <Clock size={18} />
          </div>
          <div>
            <div className="kpi-value mono">{fmtDur(totalSeconds)}</div>
            <div className="kpi-label">Total Audio Time</div>
          </div>
        </motion.div>

        <motion.div className="glass kpi-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.3 }}>
          <div className="kpi-icon-wrap" style={{ background: 'rgba(52, 211, 153, 0.15)', color: '#34d399' }}>
            <HardDrive size={18} />
          </div>
          <div>
            <div className="kpi-value mono">{storageLabel}</div>
            <div className="kpi-label">Local Disk Usage</div>
          </div>
        </motion.div>

        <motion.div className="glass kpi-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.3 }}>
          <div className="kpi-icon-wrap" style={{ background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }}>
            <Sparkles size={18} />
          </div>
          <div>
            <div className="kpi-value mono text-ok">$0.00</div>
            <div className="kpi-label">Carrier Fees Saved</div>
          </div>
        </motion.div>
      </section>

      {/* Filter and Search Bar */}
      <section className="recordings-toolbar glass">
        <div className="search-input-wrap">
          <Search size={15} className="search-icon" />
          <input
            type="text"
            placeholder="Search by prospect name, company, or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
            aria-label="Search recordings"
          />
          {search && (
            <button className="clear-search-btn" onClick={() => setSearch('')} title="Clear search">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="filters-group">
          <select
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
            className="filter-select"
            aria-label="Filter by call outcome"
          >
            <option value="">All Outcomes</option>
            {OUTCOMES.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>

          <select
            value={directionFilter}
            onChange={(e) => setDirectionFilter(e.target.value)}
            className="filter-select"
            aria-label="Filter by call direction"
          >
            <option value="">All Directions</option>
            <option value="outbound">Outbound</option>
            <option value="inbound">Inbound</option>
          </select>

          {(search || outcomeFilter || directionFilter) && (
            <button className="btn xs link-btn" onClick={resetFilters}>
              Reset filters
            </button>
          )}
        </div>
      </section>

      {/* Content State Handling */}
      <section className="recordings-content">
        {loading && recordings.length === 0 ? (
          <div className="recordings-list">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : error ? (
          <div className="glass error-card pad">
            <div className="row gap">
              <AlertCircle size={20} className="text-bad" />
              <div>
                <b>Failed to load recordings</b>
                <p className="muted small">{error}</p>
              </div>
            </div>
            <button className="btn xs primary mt-2" onClick={fetchRecordings}>
              <RotateCw size={14} /> Retry
            </button>
          </div>
        ) : recordings.length === 0 ? (
          <div className="glass empty-recordings-state pad-lg center">
            <div className="empty-icon-circle">
              <Headphones size={36} className="text-cyan" />
            </div>
            {search || outcomeFilter || directionFilter ? (
              <>
                <h3>No matching recordings found</h3>
                <p className="muted small max-w-md mx-auto">
                  Try adjusting your search keywords or clearing the active filters.
                </p>
                <button className="btn xs primary mt-4" onClick={resetFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <h3>No call recordings recorded yet</h3>
                <p className="muted small max-w-md mx-auto">
                  Pulse Dialer captures softphone calls directly in the browser and saves the audio files to your local disk at $0.00 cost.
                  Start dialing in the cockpit, or generate sample audio to test playback.
                </p>
                <div className="row center-row gap mt-4">
                  <button className="btn primary" onClick={() => setView('dialer')}>
                    <PhoneCall size={15} /> Go to Dialer
                  </button>
                  <button className="btn glass" onClick={handleGenerateDemo} disabled={generatingDemo}>
                    <Sparkles size={15} /> {generatingDemo ? 'Generating…' : 'Generate Demo Audio'}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="recordings-list">
            <AnimatePresence>
              {recordings.map((rec) => {
                const isOutbound = rec.direction !== 'inbound';
                const meta = outcomeMeta(rec.outcome);
                const isPlaying = playingId === rec.call_id;

                return (
                  <motion.article
                    key={rec.id}
                    className={`recording-card glass ${isPlaying ? 'is-playing' : ''}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                  >
                    {/* Header bar of the card */}
                    <div className="recording-card-head">
                      <div className="row gap">
                        <span className={`direction-badge ${isOutbound ? 'outbound' : 'inbound'}`}>
                          {isOutbound ? <PhoneCall size={12} /> : <PhoneIncoming size={12} />}
                          <span>{isOutbound ? 'Outbound' : 'Inbound'}</span>
                        </span>

                        {meta && (
                          <span className="outcome-pill" style={{ '--c': meta.color }}>
                            <i />{meta.label}
                          </span>
                        )}

                        <span className="mono muted small">
                          {fmtDateTime(rec.started_at || rec.created_at)}
                        </span>
                      </div>

                      <div className="row gap">
                        <span className="badge muted mono small">
                          {Math.round(rec.size_bytes / 1024)} KB
                        </span>
                      </div>
                    </div>

                    {/* Prospect metadata and summary */}
                    <div className="recording-prospect-row">
                      <div className="prospect-info-cluster">
                        <Avatar name={rec.prospect_name || rec.caller_id || 'Unknown'} size={38} />
                        <div>
                          <div className="prospect-title-line">
                            {rec.prospect_id ? (
                              <button
                                className="prospect-link-btn"
                                onClick={() => setDrawerId(rec.prospect_id)}
                                title="Open prospect details drawer"
                              >
                                {rec.prospect_name || 'Unnamed Lead'}
                                <ArrowRight size={12} className="arrow-hover" />
                              </button>
                            ) : (
                              <span className="prospect-static-name">
                                {rec.prospect_name || rec.caller_id || 'Direct Call'}
                              </span>
                            )}
                            {rec.company && <span className="prospect-company">· {rec.company}</span>}
                          </div>
                          <div className="prospect-phone-sub mono muted small">
                            {rec.phone || rec.caller_id || 'No phone'}
                          </div>
                        </div>
                      </div>

                      {rec.summary && (
                        <div className="recording-summary-snippet" title={rec.summary}>
                          <Sparkles size={12} className="text-cyan flex-none" />
                          <span className="summary-text">{rec.summary}</span>
                        </div>
                      )}
                    </div>

                    {/* Integrated audio player */}
                    <RecordingPlayer
                      recording={rec}
                      isPlaying={isPlaying}
                      onPlayToggle={(shouldPlay) => setPlayingId(shouldPlay ? rec.call_id : null)}
                      onDelete={(id) => setDeletingId(id)}
                    />
                  </motion.article>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </section>

      {/* Delete Confirmation Modal */}
      {deletingId && (
        <div className="scrim" onClick={() => setDeletingId(null)}>
          <div className="modal glass delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete Recording</h3>
              <button className="icon-btn" onClick={() => setDeletingId(null)}><X size={16} /></button>
            </div>
            <div className="pad">
              <p>Are you sure you want to permanently delete this audio recording from disk?</p>
              <p className="muted small mt-2">The call history log will remain intact, but the audio file will be removed.</p>
              <div className="row end gap mt-4">
                <button className="btn" onClick={() => setDeletingId(null)}>Cancel</button>
                <button className="btn danger" onClick={confirmDelete}>
                  <Trash2 size={14} /> Delete File
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
