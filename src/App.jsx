import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LayoutDashboard, PhoneCall, Users, KanbanSquare, Upload, Settings as Cog, Activity, FlaskConical } from 'lucide-react';
import { useStore } from './store.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Dialer from './pages/Dialer.jsx';
import Prospects from './pages/Prospects.jsx';
import Pipeline from './pages/Pipeline.jsx';
import ImportPage from './pages/Import.jsx';
import SettingsPage from './pages/Settings.jsx';
import Drawer from './components/Drawer.jsx';
import Toasts from './components/Toasts.jsx';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'dialer', label: 'Dialer', icon: PhoneCall },
  { id: 'prospects', label: 'Prospects', icon: Users },
  { id: 'pipeline', label: 'Pipeline', icon: KanbanSquare },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'settings', label: 'Settings', icon: Cog },
];
const PAGES = { dashboard: Dashboard, dialer: Dialer, prospects: Prospects, pipeline: Pipeline, import: ImportPage, settings: SettingsPage };

export default function App() {
  const { view, setView, settings, stats, prospects } = useStore();
  const Page = PAGES[view] || Dashboard;
  const dry = settings?.dry_run === '1';
  const today = stats?.today;

  return (
    <div className="shell">
      <div className="aurora" aria-hidden>
        <span className="blob b1" /><span className="blob b2" /><span className="blob b3" />
      </div>

      <aside className="sidebar">
        <div className="brand">
          <div className="logo"><Activity size={20} strokeWidth={2.6} /></div>
          <div>
            <div className="brand-name">Pulse</div>
            <div className="brand-sub">Dialer + CRM</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = view === n.id;
            return (
              <button key={n.id} className={`nav-item ${active ? 'active' : ''}`} onClick={() => setView(n.id)}>
                {active && <motion.span layoutId="navpill" className="nav-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                <Icon size={18} />
                <span>{n.label}</span>
                {n.id === 'prospects' && <em className="count">{prospects.length}</em>}
              </button>
            );
          })}
        </nav>

        <div className="side-foot">
          {today && (
            <div className="mini-goal">
              <div className="mini-goal-top"><span>Today</span><b>{today.dials}<small>/{stats.goal || '–'}</small></b></div>
              <div className="bar"><motion.i initial={{ width: 0 }} animate={{ width: `${Math.min(100, stats.goal ? (today.dials / stats.goal) * 100 : 0)}%` }} transition={{ duration: 0.8, ease: 'easeOut' }} /></div>
              <span className="mini-goal-sub">dials toward your goal</span>
            </div>
          )}
          <div className={`mode-chip ${dry ? 'dry' : 'live'}`} onClick={() => setView('settings')} title="Change in Settings">
            <span className="dot" />{dry ? <><FlaskConical size={13} /> Test mode: no real calls</> : 'Live: calls are real'}
          </div>
        </div>
      </aside>

      <main className="main">
        <AnimatePresence mode="wait">
          <motion.div key={view} className="page" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22, ease: 'easeOut' }}>
            <Page />
          </motion.div>
        </AnimatePresence>
      </main>

      <Drawer />
      <Toasts />
    </div>
  );
}
