import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LayoutDashboard, PhoneCall, Users, KanbanSquare, Upload, Settings as Cog, Activity, FlaskConical, Headphones, PanelLeftClose, PanelLeft } from 'lucide-react';
import { useStore } from './store.jsx';
import { softphoneLabel } from './utils.js';
import Dashboard from './pages/Dashboard.jsx';
import Dialer from './pages/Dialer.jsx';
import Prospects from './pages/Prospects.jsx';
import Pipeline from './pages/Pipeline.jsx';
import ImportPage from './pages/Import.jsx';
import SettingsPage from './pages/Settings.jsx';
import Recordings from './pages/Recordings.jsx';
import Drawer from './components/Drawer.jsx';
import Toasts from './components/Toasts.jsx';
import OutboxModal from './components/OutboxModal.jsx';
import IncomingCallModal from './components/IncomingCallModal.jsx';
import { SoftphoneProvider } from './softphone.jsx';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'dialer', label: 'Dialer', icon: PhoneCall },
  { id: 'prospects', label: 'Prospects', icon: Users },
  { id: 'pipeline', label: 'Pipeline', icon: KanbanSquare },
  { id: 'recordings', label: 'Recordings', icon: Headphones },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'settings', label: 'Settings', icon: Cog },
];
const PAGES = { dashboard: Dashboard, dialer: Dialer, prospects: Prospects, pipeline: Pipeline, recordings: Recordings, import: ImportPage, settings: SettingsPage };

// The softphone wraps the whole shell: one engine, one registration, and an incoming call
// rings on every page — a callback does not wait for the agent to be looking at the dialer.
export default function App() {
  return (
    <SoftphoneProvider>
      <Shell />
    </SoftphoneProvider>
  );
}

function Shell() {
  const { view, setView, settings, stats, prospects } = useStore();
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return localStorage.getItem('pulse_sidebar_collapsed') === '1'; } catch { return false; }
  });

  const toggleSidebar = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('pulse_sidebar_collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  // Object.hasOwn, not PAGES[view]: a hash like "#constructor" or "#__proto__" resolves
  // through the prototype chain to a truthy non-component, and React then renders a blank
  // page (verified: 0 nodes for "#constructor", 69 for a normal route).
  const Page = Object.hasOwn(PAGES, view) ? PAGES[view] : Dashboard;
  const dry = settings?.dry_run === '1';
  const today = stats?.today;

  return (
    <div className={`shell ${collapsed ? 'collapsed-sidebar' : ''}`}>
      <div className="aurora" aria-hidden>
        <span className="blob b1" /><span className="blob b2" /><span className="blob b3" />
      </div>

      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main Navigation">
        <div className="brand">
          <div
            className="logo"
            onClick={toggleSidebar}
            style={{ cursor: 'pointer' }}
            title={collapsed ? "Expand sidebar menu" : "Collapse sidebar menu"}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSidebar()}
          >
            <Activity size={20} strokeWidth={2.6} />
          </div>
          {!collapsed && (
            <div className="brand-info">
              <div className="brand-name">Pulse</div>
              <div className="brand-sub">Dialer + CRM</div>
            </div>
          )}
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={toggleSidebar}
            title={collapsed ? "Expand sidebar menu" : "Collapse sidebar menu"}
            aria-label={collapsed ? "Expand sidebar menu" : "Collapse sidebar menu"}
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="nav">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = view === n.id;
            return (
              <button
                key={n.id}
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => setView(n.id)}
                title={collapsed ? `${n.label}${n.id === 'prospects' ? ` (${prospects.length})` : ''}` : undefined}
              >
                {active && <motion.span layoutId="navpill" className="nav-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                <Icon size={18} />
                {!collapsed && <span>{n.label}</span>}
                {n.id === 'prospects' && <em className="count">{prospects.length}</em>}
              </button>
            );
          })}
        </nav>

        {!collapsed && (
          <div className="side-foot">
            {today && (
              <div className="mini-goal">
                <div className="mini-goal-top"><span>Today</span><b>{today.dials}<small>/{stats.goal || '–'}</small></b></div>
                <div className="bar"><motion.i initial={{ width: 0 }} animate={{ width: `${Math.min(100, stats.goal ? (today.dials / stats.goal) * 100 : 0)}%` }} transition={{ duration: 0.8, ease: 'easeOut' }} /></div>
                <span className="mini-goal-sub">dials toward your goal</span>
              </div>
            )}
            <div className={`mode-chip ${dry ? 'dry' : 'live'}`} onClick={() => setView('settings')} title="Change in Settings">
              <span className="dot" />
              {dry ? <><FlaskConical size={13} /> Test mode: simulated calls</> : <><Headphones size={13} /> Live: {softphoneLabel(settings?.telephony_mode)} dials directly</>}
            </div>
          </div>
        )}
      </aside>

      <main className="main">
        <AnimatePresence mode="wait">
          <motion.div key={view} className="page" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22, ease: 'easeOut' }}>
            <Page />
          </motion.div>
        </AnimatePresence>
      </main>

      <Drawer />
      {/* Root-level so Settings, the composer and the "captured" toast can all open it. */}
      <OutboxModal />
      {/* Root-level for the same reason, and because the phone does not care which page you
          are on when somebody calls back. */}
      <IncomingCallModal />
      <Toasts />
    </div>
  );
}
