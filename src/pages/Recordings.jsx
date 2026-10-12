import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Headphones, Play, Pause, Download, Trash2, Search, RotateCw,
  Sparkles, PhoneCall, PhoneIncoming, Clock, HardDrive, ShieldCheck,
  Check, X, Volume2, VolumeX, AlertCircle, ArrowRight,
  MessageSquare, Send, ChevronDown, ChevronUp, Bot, User, FileText,
  Target, ShieldAlert, MailCheck, Key, Plus
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store.jsx';
import { Avatar } from '../components/ui.jsx';
import { OUTCOMES, fmtDateTime, fmtDur, getProspectDisplayName, outcomeMeta } from '../utils.js';

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
          aria-label={isPlaying ? 'Pause audio' : 'Play audio recording'}
        >
          {isPlaying ? <Pause size={17} /> : <Play size={17} style={{ marginLeft: '2px' }} />}
        </button>

        <Equalizer playing={isPlaying} />

        <div className="player-scrub-area">
          <div className="scrub-time-label mono">{fmtDur(currentTime)}</div>
          <div className="scrub-slider-wrap">
            <input
              id={sliderId}
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={currentTime}
              onChange={handleSeek}
              className="scrub-slider"
              style={{ '--val': `${progressPercent}%` }}
              aria-label="Seek call recording timeline"
            />
          </div>
          <div className="scrub-time-label mono text-muted">{fmtDur(duration)}</div>
        </div>

        <div className="player-aux-actions">
          <button
            className="player-icon-btn speed-btn mono"
            onClick={cycleSpeed}
            title={`Playback speed: ${speed}x`}
            aria-label={`Current speed ${speed}x. Click to change`}
          >
            {speed}x
          </button>

          <button
            className="player-icon-btn mute-btn"
            onClick={toggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
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

function ScriptEditorDrawer({ isOpen, onClose, onSave, initialScript }) {
  const [scriptText, setScriptText] = useState(initialScript || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setScriptText(initialScript || '');
  }, [initialScript]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(scriptText);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="coach-script-panel glass">
      <div className="coach-script-head">
        <div className="row gap center-row">
          <FileText size={15} className="text-cyan" />
          <b>Cold Call Pitch &amp; Objection Battlecard</b>
        </div>
        <button className="icon-btn xs" onClick={onClose} title="Close script panel">
          <X size={14} />
        </button>
      </div>
      <p className="small muted">
        Gemini compares the audio against this script to calculate exact adherence % and diversion timestamps.
      </p>
      <textarea
        className="coach-script-textarea mono"
        value={scriptText}
        onChange={(e) => setScriptText(e.target.value)}
        rows={9}
        placeholder="Enter your sales script, opening hook, qualifying questions, and objection handling guidelines..."
      />
      <div className="row justify-between center-row mt-2">
        <span className="small muted">{scriptText.length} characters</span>
        <button className="btn xs primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Script'}
        </button>
      </div>
    </div>
  );
}

function AiRecordingCoach({ activeRecording, onSelectRecording, settings, onApiKeyNeeded }) {
  const { toast } = useStore();
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState('');
  const [showScriptDrawer, setShowScriptDrawer] = useState(false);
  const messagesEndRef = useRef(null);

  // Load sales script
  useEffect(() => {
    api.getRecordingScript()
      .then((res) => { if (res.script) setScript(res.script); })
      .catch(() => {});
  }, []);

  // Fetch chats whenever active recording changes
  const loadChats = useCallback(async () => {
    if (!activeRecording?.call_id) return;
    try {
      const res = await api.recordingChats(activeRecording.call_id);
      const list = res.chats || [];
      setChats(list);
      if (list.length > 0) {
        setActiveChatId(list[0].id);
      } else {
        setActiveChatId(null);
        setActiveChat(null);
        setMessages([]);
      }
    } catch {
      setChats([]);
    }
  }, [activeRecording?.call_id]);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  // Load active chat messages
  useEffect(() => {
    if (!activeRecording?.call_id || !activeChatId) {
      setActiveChat(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    api.getRecordingChat(activeRecording.call_id, activeChatId)
      .then((res) => {
        if (!cancelled && res.chat) {
          setActiveChat(res.chat);
          setMessages(res.chat.messages || []);
        }
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => { cancelled = true; };
  }, [activeRecording?.call_id, activeChatId]);

  // Auto-scroll messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  const handleCreateNewSession = async () => {
    if (!activeRecording?.call_id) return;
    try {
      const res = await api.createRecordingChat(activeRecording.call_id, `Session ${chats.length + 1}`);
      if (res.chat) {
        setChats((prev) => [res.chat, ...prev]);
        setActiveChatId(res.chat.id);
        setActiveChat(res.chat);
        setMessages([]);
        toast('New coaching session started');
      }
    } catch (err) {
      toast(err?.message || 'Could not create new session', 'error');
    }
  };

  const handleSaveScript = async (newScript) => {
    try {
      await api.updateRecordingScript(newScript);
      setScript(newScript);
      toast('Sales script & battlecard saved');
    } catch (err) {
      toast(err?.message || 'Failed to save script', 'error');
    }
  };

  const handleSendTurn = async (customText = null, action = 'freeform') => {
    const textToSend = (customText !== null ? customText : inputMessage).trim();
    if (!textToSend || !activeRecording?.call_id || loading) return;

    if (!customText) setInputMessage('');
    setLoading(true);

    // Optimistic user message in UI
    const tempUserMsg = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: textToSend,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await api.recordingAiChat(activeRecording.call_id, {
        chatId: activeChatId || undefined,
        message: textToSend,
        script: script || undefined,
        quickAction: action,
      });

      if (res.needsKey) {
        onApiKeyNeeded();
        toast('Gemini API key is required to analyze call audio', 'error');
        setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
        return;
      }

      if (!res.success) {
        toast(res.error || 'AI analysis failed', 'error');
        setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
        return;
      }

      if (res.chatId && res.chatId !== activeChatId) {
        setActiveChatId(res.chatId);
        loadChats();
      }

      if (res.message) {
        setMessages((prev) => [...prev.filter((m) => m.id !== tempUserMsg.id), tempUserMsg, res.message]);
      }
    } catch (err) {
      toast(err?.message || 'Error communicating with Gemini audio engine', 'error');
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
    } finally {
      setLoading(false);
    }
  };

  if (!activeRecording) {
    return (
      <aside className="recordings-coach-pane glass coach-empty-pane">
        <div className="coach-empty-inner center">
          <div className="coach-bot-badge">
            <Bot size={34} className="text-cyan" />
          </div>
          <h3>AI Multimodal Call Coach</h3>
          <p className="muted small max-w-sm mx-auto">
            Select any call recording from the catalog on the left to listen, analyze script adherence, pinpoint diversion points, and chat directly with Google Gemini Flash.
          </p>
          <div className="coach-perks-list">
            <div className="coach-perk"><Target size={14} className="text-ok" /> 0-100% Script Adherence Grading</div>
            <div className="coach-perk"><ShieldAlert size={14} className="text-warn" /> Objection Handling &amp; Diversion Map</div>
            <div className="coach-perk"><MailCheck size={14} className="text-cyan" /> 1-Click Follow-Up Re-Pitch Generation</div>
          </div>
        </div>
      </aside>
    );
  }

  const pName = activeRecording.prospect_name || activeRecording.caller_id || 'Lead Call';
  const meta = outcomeMeta(activeRecording.outcome);

  return (
    <aside className="recordings-coach-pane glass">
      {/* Active Recording Banner */}
      <div className="coach-top-bar">
        <div className="coach-title-cluster">
          <Avatar name={pName} size={36} />
          <div>
            <div className="coach-prospect-name">
              <b>{pName}</b>
              {activeRecording.company && <span className="muted small"> · {activeRecording.company}</span>}
            </div>
            <div className="row gap center-row mt-0.5">
              <span className="mono small muted">{fmtDur(activeRecording.duration_sec || 0)}</span>
              {meta && (
                <span className="outcome-pill sm" style={{ '--c': meta.color }}>
                  <i />{meta.label}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="coach-header-actions">
          {chats.length > 0 && (
            <select
              className="coach-session-select"
              value={activeChatId || ''}
              onChange={(e) => setActiveChatId(Number(e.target.value))}
              title="Switch between saved coaching sessions"
            >
              {chats.map((c) => (
                <option key={c.id} value={c.id}>{c.title || `Session ${c.id}`}</option>
              ))}
            </select>
          )}

          <button
            className="btn xs glass"
            onClick={handleCreateNewSession}
            title="Start a new chat session for this recording"
          >
            <Plus size={13} />
            <span>New Chat</span>
          </button>

          <button
            className={`btn xs ${showScriptDrawer ? 'primary' : 'glass'}`}
            onClick={() => setShowScriptDrawer((v) => !v)}
            title="View or customize target cold calling script & battlecard"
          >
            <FileText size={13} />
            <span>Script</span>
            {showScriptDrawer ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      {/* Script Drawer */}
      <ScriptEditorDrawer
        isOpen={showScriptDrawer}
        onClose={() => setShowScriptDrawer(false)}
        onSave={handleSaveScript}
        initialScript={script}
      />

      {/* Quick Audit Action Pills */}
      <div className="coach-quick-strip">
        <button
          className="coach-action-pill"
          onClick={() => handleSendTurn('Analyze this call against our script. Give me the exact script adherence score (0-100%), timestamps where I followed or diverted, and explain why.', 'adherence')}
          disabled={loading}
          title="Grade script adherence and diversion points"
        >
          <Target size={13} className="text-ok" />
          <span>Audit Script Adherence</span>
        </button>

        <button
          className="coach-action-pill"
          onClick={() => handleSendTurn('Break down this recording into What Went Good vs What Went Wrong. Critique opening hook, tone, questions, and closing.', 'good_wrong')}
          disabled={loading}
          title="Assess strengths and missed opportunities"
        >
          <Sparkles size={13} className="text-cyan" />
          <span>Good vs. Wrong</span>
        </button>

        <button
          className="coach-action-pill"
          onClick={() => handleSendTurn('Evaluate how the prospect objections were handled in this call. Give me the exact lines I should have said instead.', 'objections')}
          disabled={loading}
          title="Analyze objection resistance and better rebuttals"
        >
          <ShieldAlert size={13} className="text-warn" />
          <span>Objection Handling</span>
        </button>

        <button
          className="coach-action-pill"
          onClick={() => handleSendTurn('Generate a tailored follow-up email based on the exact conversation in this call, referencing their answers and next steps.', 'followup')}
          disabled={loading}
          title="Draft personalized follow-up email"
        >
          <MailCheck size={13} className="text-purple" />
          <span>Draft Follow-Up Email</span>
        </button>
      </div>

      {/* Chat Messages Feed */}
      <div className="coach-chat-stream">
        {messages.length === 0 && !loading ? (
          <div className="coach-chat-welcome center pad">
            <Bot size={28} className="text-cyan mb-2" />
            <b>Ready to audit this recording</b>
            <p className="small muted max-w-xs mx-auto mt-1">
              Click any quick audit button above or type your question below. Gemini Flash will process the acoustic recording natively.
            </p>
          </div>
        ) : (
          messages.map((m, idx) => {
            const isUser = m.role === 'user';
            const adherence = m.meta?.adherenceScore;

            return (
              <div key={m.id || idx} className={`coach-bubble-row ${isUser ? 'user' : 'assistant'}`}>
                <div className="coach-avatar-bubble">
                  {isUser ? <User size={13} /> : <Bot size={13} className="text-cyan" />}
                </div>
                <div className="coach-bubble-card">
                  {adherence !== null && adherence !== undefined && (
                    <div className="coach-score-banner">
                      <Target size={14} className="text-ok" />
                      <span>Script Adherence: <b>{adherence}%</b></span>
                      <div className="coach-score-bar">
                        <div className="coach-score-fill" style={{ width: `${adherence}%` }} />
                      </div>
                    </div>
                  )}
                  <div className="coach-bubble-text whitespace-pre-wrap">
                    {m.content}
                  </div>
                  <div className="coach-bubble-time mono small muted">
                    {m.created_at ? fmtDateTime(m.created_at) : ''}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {loading && (
          <div className="coach-bubble-row assistant">
            <div className="coach-avatar-bubble">
              <Bot size={13} className="text-cyan spin" />
            </div>
            <div className="coach-bubble-card loading-card">
              <div className="row gap center-row">
                <Sparkles size={14} className="text-cyan spin" />
                <span className="small">Gemini Flash is analyzing the call audio…</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Chat Input Bar */}
      <form
        className="coach-input-bar"
        onSubmit={(e) => { e.preventDefault(); handleSendTurn(); }}
      >
        <input
          type="text"
          className="coach-text-input"
          placeholder="Ask Gemini about this call (e.g. 'Why did he hesitate at 0:42?')..."
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          disabled={loading}
        />
        <button
          type="submit"
          className="btn xs primary coach-send-btn"
          disabled={loading || !inputMessage.trim()}
          title="Send message to AI Coach (Enter)"
        >
          <Send size={14} />
          <span>Send</span>
        </button>
      </form>
    </aside>
  );
}

export default function Recordings() {
  const { setDrawerId, setView, toast, settings, updateSettings } = useStore();
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
  const [activeRecordingId, setActiveRecordingId] = useState(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');

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
      const list = res.recordings || [];
      setRecordings(list);
      setTotal(res.total || 0);

      // Auto-select first recording if none selected
      if (list.length > 0 && !activeRecordingId) {
        setActiveRecordingId(list[0].call_id);
      }
    } catch (err) {
      setError(err?.message || 'Could not load recordings');
    } finally {
      setLoading(false);
    }
  }, [search, outcomeFilter, directionFilter, activeRecordingId]);

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
      if (activeRecordingId === id) setActiveRecordingId(null);
      toast('Recording deleted from disk');
      setRecordings((prev) => prev.filter((r) => r.call_id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      toast(err?.message || 'Could not delete recording', 'error');
    }
  };

  const handleSaveApiKey = async (e) => {
    e?.preventDefault();
    if (!apiKeyInput.trim()) return;
    try {
      await updateSettings({ ai_api_key: apiKeyInput.trim(), ai_provider: 'gemini' });
      setShowKeyModal(false);
      setApiKeyInput('');
      toast('Google Gemini API key saved! Ready for AI coaching.');
    } catch (err) {
      toast(err?.message || 'Could not save API key', 'error');
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

  const activeRec = useMemo(() => {
    return recordings.find((r) => r.call_id === activeRecordingId) || null;
  }, [recordings, activeRecordingId]);

  return (
    <div className="recordings-page">
      {/* Header bar */}
      <header className="recordings-header">
        <div className="recordings-title-group">
          <div className="recordings-title-row">
            <h1>Call Recordings &amp; AI Studio</h1>
            <span className="free-cost-badge" title="Recorded client-side via WebRTC stream directly to local storage">
              <ShieldCheck size={13} className="text-ok" />
              100% Free · $0.00 Extra Charges
            </span>
          </div>
          <p className="recordings-sub">
            In-browser WebRTC call recordings stored locally on disk paired with Google Gemini multimodal script auditing and coaching.
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

      {/* Main Dual-Pane Studio Layout */}
      <div className="recordings-studio-layout">
        {/* LEFT PANE: CATALOG & TOOLBAR */}
        <section className="recordings-catalog-pane">
          {/* Toolbar */}
          <div className="recordings-toolbar glass">
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
          </div>

          {/* List Content */}
          <div className="recordings-list-wrap">
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
                      Pulse Dialer captures calls directly in the browser at $0.00 cost. Start dialing or generate sample audio to test playback.
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
                    const isSelected = activeRecordingId === rec.call_id;
                    const displayName = getProspectDisplayName(rec);

                    return (
                      <motion.article
                        key={rec.id}
                        className={`recording-card glass ${isPlaying ? 'is-playing' : ''} ${isSelected ? 'is-selected-studio' : ''}`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        transition={{ duration: 0.2 }}
                      >
                        {/* Header bar of the card */}
                        <div className="recording-card-head">
                          <div className="row gap center-row">
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

                          <div className="row gap center-row">
                            <button
                              className={`studio-select-pill ${isSelected ? 'active' : ''}`}
                              onClick={() => setActiveRecordingId(rec.call_id)}
                              title={isSelected ? 'Active in AI Studio' : 'Load this call into AI Coaching Studio'}
                            >
                              <Bot size={13} className={isSelected ? 'text-cyan' : ''} />
                              <span>{isSelected ? 'Loaded in AI Studio' : 'Open in AI Coach'}</span>
                            </button>

                            <span className="badge muted mono small">
                              {Math.round(rec.size_bytes / 1024)} KB
                            </span>
                          </div>
                        </div>

                        {/* Prospect metadata and summary */}
                        <div className="recording-prospect-row">
                          <div className="prospect-info-cluster">
                            <Avatar name={displayName} size={38} />
                            <div>
                              <div className="prospect-title-line">
                                {rec.prospect_id ? (
                                  <button
                                    className="prospect-link-btn"
                                    onClick={() => setDrawerId(rec.prospect_id)}
                                    title="Open prospect details drawer"
                                  >
                                    {displayName}
                                    <ArrowRight size={12} className="arrow-hover" />
                                  </button>
                                ) : (
                                  <span className="prospect-static-name">
                                    {displayName}
                                  </span>
                                )}
                                {rec.company && rec.prospect_name && (
                                  <span className="prospect-company">· {rec.company}</span>
                                )}
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
          </div>
        </section>

        {/* RIGHT PANE: AI MULTIMODAL CALL COACH & CHATBOT */}
        <AiRecordingCoach
          activeRecording={activeRec}
          onSelectRecording={setActiveRecordingId}
          settings={settings}
          onApiKeyNeeded={() => setShowKeyModal(true)}
        />
      </div>

      {/* Delete Confirmation Modal */}
      {deletingId && (
        <div className="scrim" onClick={() => setDeletingId(null)}>
          <div className="modal glass delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="row gap center-row">
                <Trash2 size={18} className="text-bad" />
                <h3>Delete call recording?</h3>
              </div>
              <button className="icon-btn" onClick={() => setDeletingId(null)}><X size={16} /></button>
            </div>
            <div className="pad-v small muted">
              This will permanently delete the audio recording file from local storage. The call history record and prospect details will remain intact.
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDeletingId(null)}>Cancel</button>
              <button className="btn danger" onClick={confirmDelete}>Delete File</button>
            </div>
          </div>
        </div>
      )}

      {/* API Key Entry Modal */}
      {showKeyModal && (
        <div className="scrim" onClick={() => setShowKeyModal(false)}>
          <div className="modal glass delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="row gap center-row">
                <Key size={18} className="text-cyan" />
                <h3>Google Gemini API Key Required</h3>
              </div>
              <button className="icon-btn" onClick={() => setShowKeyModal(false)}><X size={16} /></button>
            </div>
            <form onSubmit={handleSaveApiKey}>
              <div className="pad-v small muted">
                To enable multimodal audio ingestion, script adherence grading, and conversational coaching with Gemini Flash, enter your Google Gemini API key:
              </div>
              <input
                type="password"
                className="input mb-3"
                placeholder="AIzaSy..."
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                autoFocus
              />
              <div className="modal-foot">
                <button type="button" className="btn" onClick={() => setShowKeyModal(false)}>Cancel</button>
                <button type="submit" className="btn primary" disabled={!apiKeyInput.trim()}>
                  Save &amp; Continue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
