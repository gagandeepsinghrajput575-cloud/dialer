import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Phone, PhoneIncoming, MessagesSquare, CalendarCheck, Target, Clock, Sparkles, ArrowRight, Upload } from 'lucide-react';
import { useStore } from '../store.jsx';
import { Avatar } from '../components/ui.jsx';
import { STAGES, outcomeMeta, pct, timeAgo, useCountUp, fmtDur } from '../utils.js';

function Stat({ icon: Icon, label, value, sub, color, delay = 0 }) {
  const v = useCountUp(value);
  return (
    <motion.div className="glass stat" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.4 }} whileHover={{ y: -3 }} style={{ '--c': color }}>
      <div className="stat-ico"><Icon size={18} /></div>
      <div className="stat-val">{Math.round(v)}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-sub">{sub}</div>
    </motion.div>
  );
}

function Ring({ value, goal }) {
  const R = 62, C = 2 * Math.PI * R;
  const frac = goal ? Math.min(1, value / goal) : 0;
  const n = useCountUp(value);
  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 160 160" width="170" height="170">
        <defs>
          <linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8b5cf6" /><stop offset="1" stopColor="#22d3ee" /></linearGradient>
        </defs>
        <circle cx="80" cy="80" r={R} className="ring-bg" />
        <motion.circle cx="80" cy="80" r={R} className="ring-fg" strokeDasharray={C} initial={{ strokeDashoffset: C }} animate={{ strokeDashoffset: C * (1 - frac) }} transition={{ duration: 1.1, ease: 'easeOut' }} />
      </svg>
      <div className="ring-center"><b>{Math.round(n)}</b><span>of {goal || '–'} dials</span></div>
    </div>
  );
}

export default function Dashboard() {
  const { stats, refreshStats, setView, setDrawerId, settings } = useStore();
  useEffect(() => { refreshStats(); }, [refreshStats]);

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const t = stats?.today;
  if (!stats || !t) return <div className="muted pad">Loading…</div>;

  const maxWeek = Math.max(5, ...stats.week.map((d) => d.dials));
  const funnel = [
    { label: 'Dials', n: t.dials, color: '#8b5cf6' },
    { label: 'Pickups', n: t.pickups, color: '#38bdf8' },
    { label: 'Conversations', n: t.conversations, color: '#22d3ee' },
    { label: 'Meetings', n: t.meetings, color: '#34d399' },
  ];
  const totalPros = stats.total || 1;

  return (
    <div className="dash">
      <header className="page-head">
        <div>
          <h1>{greet}</h1>
          <p>Here's how your calling day is going.</p>
        </div>
        <div className="row gap">
          <button className="btn" onClick={() => setView('import')}><Upload size={16} /> Import list</button>
          <button className="btn primary glow" onClick={() => setView('dialer')}><Phone size={16} /> Start dialing <ArrowRight size={15} /></button>
        </div>
      </header>

      {settings?.dry_run === '1' && (
        <div className="banner"><Sparkles size={16} /> Test mode is on. Calls are simulated, so numbers below include test calls. Switch to live in <a onClick={() => setView('settings')}>Settings</a> once your Sonetel details are in.</div>
      )}

      <div className="stat-grid">
        <Stat icon={Phone} label="Dials today" value={t.dials} sub={stats.cap ? `cap ${stats.cap}/day` : 'no cap'} color="#8b5cf6" delay={0} />
        <Stat icon={PhoneIncoming} label="Pickups" value={t.pickups} sub={`${pct(t.pickupRate)} pickup rate`} color="#38bdf8" delay={0.06} />
        <Stat icon={MessagesSquare} label="Conversations" value={t.conversations} sub={`${pct(t.conversationRate)} of pickups`} color="#22d3ee" delay={0.12} />
        <Stat icon={CalendarCheck} label="Meetings booked" value={t.meetings} sub={`${pct(t.meetingRate)} of conversations`} color="#34d399" delay={0.18} />
      </div>

      <div className="dash-grid">
        <motion.section className="glass pad-lg goal" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <div className="panel-title"><Target size={16} /> Daily goal</div>
          <Ring value={t.dials} goal={stats.goal} />
          <div className="goal-foot">
            <div><Clock size={14} /> <b>{fmtDur(t.talkSec)}</b><span>talk time</span></div>
            <div><MessagesSquare size={14} /> <b>{t.avgTalkSec ? fmtDur(t.avgTalkSec) : '–'}</b><span>avg convo</span></div>
          </div>
        </motion.section>

        <motion.section className="glass pad-lg funnel" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.26 }}>
          <div className="panel-title">Today's funnel</div>
          {funnel.map((f, i) => (
            <div key={f.label} className="f-row">
              <div className="f-label"><span>{f.label}</span><b>{f.n}</b></div>
              <div className="bar big"><motion.i style={{ background: f.color }} initial={{ width: 0 }} animate={{ width: `${funnel[0].n ? (f.n / funnel[0].n) * 100 : 0}%` }} transition={{ duration: 0.9, delay: 0.3 + i * 0.1, ease: 'easeOut' }} /></div>
            </div>
          ))}
          <div className="muted small">Pickup = a live person answered (voicemail doesn't count).</div>
        </motion.section>

        <motion.section className="glass pad-lg week" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }}>
          <div className="panel-title">Last 7 days</div>
          <div className="bars">
            {stats.week.map((d, i) => {
              const day = new Date(d.date).toLocaleDateString(undefined, { weekday: 'short' });
              return (
                <div key={d.date} className="bar-col" title={`${d.dials} dials, ${d.conversations} conversations`}>
                  <div className="bar-stack">
                    <motion.div className="bar-dials" initial={{ height: 0 }} animate={{ height: `${(d.dials / maxWeek) * 100}%` }} transition={{ duration: 0.8, delay: 0.35 + i * 0.05, ease: 'easeOut' }}>
                      <motion.div className="bar-convo" initial={{ height: 0 }} animate={{ height: d.dials ? `${(d.conversations / d.dials) * 100}%` : 0 }} transition={{ duration: 0.8, delay: 0.5 + i * 0.05 }} />
                    </motion.div>
                  </div>
                  <span>{day}</span>
                  <em>{d.dials}</em>
                </div>
              );
            })}
          </div>
          <div className="legend"><span><i style={{ background: '#8b5cf6' }} />Dials</span><span><i style={{ background: '#22d3ee' }} />Conversations</span></div>
        </motion.section>

        <motion.section className="glass pad-lg pipe-mini" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.38 }}>
          <div className="panel-title">Pipeline <a className="link" onClick={() => setView('pipeline')}>Open board <ArrowRight size={13} /></a></div>
          <div className="stack-bar">
            {STAGES.map((s) => (stats.stageCounts[s.id] ? <motion.i key={s.id} title={`${s.label}: ${stats.stageCounts[s.id]}`} style={{ background: s.color }} initial={{ flexGrow: 0 }} animate={{ flexGrow: stats.stageCounts[s.id] / totalPros }} transition={{ duration: 0.9, ease: 'easeOut' }} /> : null))}
          </div>
          <div className="stage-legend">
            {STAGES.map((s) => (
              <div key={s.id}><i style={{ background: s.color }} /><span>{s.label}</span><b>{stats.stageCounts[s.id] || 0}</b></div>
            ))}
          </div>
        </motion.section>

        <motion.section className="glass pad-lg recent" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.44 }}>
          <div className="panel-title">Recent calls</div>
          {stats.recent.length === 0 && <div className="muted small pad center">No calls yet. Hit "Start dialing".</div>}
          {stats.recent.map((r) => {
            const o = outcomeMeta(r.outcome);
            return (
              <div key={r.id} className="recent-row" onClick={() => setDrawerId(r.prospect_id)}>
                <Avatar name={r.name || r.company} size={32} seed={r.prospect_id + r.name} />
                <div><b>{r.name || '(no name)'}</b><span>{r.company}</span></div>
                <span className="chip" style={{ '--c': o ? o.color : '#64748b' }}>{o ? o.label : 'Not logged'}</span>
                <em>{timeAgo(r.started_at)}</em>
              </div>
            );
          })}
        </motion.section>
      </div>
    </div>
  );
}
