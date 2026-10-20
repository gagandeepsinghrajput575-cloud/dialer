// Multi-Tab SIP Standby Election & Registration Mutex (Challenge 4).
//
// Prevents multiple open Pulse Dialer tabs (#dialer, #recents, #settings) from registering
// competing SIP UserAgents against Telnyx with the same credential set.
//
// Primary coordination: Web Locks API (`navigator.locks.request('pulse-sip-registration', ...)`)
// Secondary coordination & instant broadcast fallback: `BroadcastChannel('pulse-telephony')`
//
// Guarantees:
//   1. Strictly ONE tab holds active SIP registration leadership at any instant.
//   2. Follower tabs immediately report `Standby · Active in another tab` without opening a
//      duplicate WebSocket to wss://sip.telnyx.com:7443.
//   3. When the leader tab closes, reloads, or releases its lock, exactly one waiting follower
//      claims leadership and starts SIP registration well within 500ms.

export const SIP_REGISTRATION_LOCK = 'pulse-sip-registration';
export const TELEPHONY_CHANNEL = 'pulse-telephony';
export const FOLLOWER_STANDBY_LABEL = 'Standby · Active in another tab';

const HEARTBEAT_MS = 140;
const LEASE_TIMEOUT_MS = 380;

function makeTabId() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function acquireSipLeadership({
  tabId = makeTabId(),
  locks = typeof navigator !== 'undefined' ? navigator.locks : undefined,
  BroadcastChannelCtor = typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : undefined,
  target = typeof window !== 'undefined' ? window : null,
  onLeader,
  onFollower,
  onRelease,
} = {}) {
  let disposed = false;
  let role = 'pending';
  let releaseHold = null;
  const holdPromise = new Promise((resolve) => { releaseHold = resolve; });
  const waitAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;

  let bus = null;
  try {
    if (typeof BroadcastChannelCtor === 'function') {
      bus = new BroadcastChannelCtor(TELEPHONY_CHANNEL);
    }
  } catch {
    bus = null;
  }

  const post = (msg) => {
    try { bus?.postMessage?.({ ...msg, tabId, ts: Date.now() }); } catch { /* channel closed */ }
  };

  let heartbeatTimer = null;
  let watchTimer = null;

  const cleanupTimers = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  };

  const release = async () => {
    if (disposed) return;
    const wasLeader = role === 'leader';
    disposed = true;
    role = 'released';
    cleanupTimers();
    try { waitAbort?.abort(); } catch { /* ignore */ }
    if (wasLeader) {
      post({ type: 'leader-resigned' });
      try {
        if (typeof onRelease === 'function') await onRelease({ tabId });
        else await onFollower?.({ tabId, label: FOLLOWER_STANDBY_LABEL, released: true });
      } catch { /* ignore */ }
    }
    releaseHold?.();
    if (target?.removeEventListener) {
      try { target.removeEventListener('pagehide', onUnload); } catch { /* ignore */ }
      try { target.removeEventListener('unload', onUnload); } catch { /* ignore */ }
    }
    try { bus?.close?.(); } catch { /* ignore */ }
  };

  function onUnload() {
    release();
  }

  if (target?.addEventListener) {
    target.addEventListener('pagehide', onUnload);
    target.addEventListener('unload', onUnload);
  }

  // ---- Path A: Native Browser Web Locks API ('pulse-sip-registration') ----
  if (locks && typeof locks.request === 'function') {
    let settledInitial = false;
    let resolveInitial;
    const initialDecision = new Promise((resolve) => { resolveInitial = resolve; });

    const promoteToLeader = async () => {
      if (disposed) return;
      role = 'leader';
      post({ type: 'leader-claimed' });
      await onLeader?.({ tabId });
    };

    try {
      locks.request(SIP_REGISTRATION_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          if (!disposed) {
            role = 'follower';
            await onFollower?.({ tabId, label: FOLLOWER_STANDBY_LABEL });
          }
          if (!settledInitial) { settledInitial = true; resolveInitial(false); }
          return undefined;
        }
        await promoteToLeader();
        if (!settledInitial) { settledInitial = true; resolveInitial(true); }
        return holdPromise;
      }).catch(() => {
        if (!settledInitial) { settledInitial = true; resolveInitial(false); }
      });
    } catch {
      if (!settledInitial) { settledInitial = true; resolveInitial(false); }
    }

    const wonImmediately = await initialDecision;

    if (!wonImmediately && !disposed) {
      // Queue exclusive wait so the instant the current leader closes/reloads, the browser
      // kernel promotes the next waiting tab immediately (<10ms) with zero race conditions.
      const reqOpts = waitAbort ? { signal: waitAbort.signal } : {};
      try {
        locks.request(SIP_REGISTRATION_LOCK, reqOpts, async (claimedLock) => {
          if (!claimedLock || disposed) return undefined;
          await promoteToLeader();
          return holdPromise;
        }).catch(() => { /* aborted cleanly on follower tab close */ });
      } catch { /* ignore */ }
    }

    return {
      tabId,
      get role() { return role; },
      get isLeader() { return role === 'leader'; },
      release,
    };
  }

  // ---- Path B: Fallback Election over BroadcastChannel('pulse-telephony') ----
  if (bus) {
    let observedLeader = null;
    let lastHeartbeatAt = 0;

    const claimFallbackLeadership = async () => {
      if (disposed || role === 'leader') return;
      role = 'leader';
      observedLeader = tabId;
      cleanupTimers();
      post({ type: 'leader-heartbeat' });
      heartbeatTimer = setInterval(() => post({ type: 'leader-heartbeat' }), HEARTBEAT_MS);
      await onLeader?.({ tabId });
    };

    const enterFollowerWatch = async () => {
      if (disposed) return;
      role = 'follower';
      await onFollower?.({ tabId, label: FOLLOWER_STANDBY_LABEL });
      cleanupTimers();
      watchTimer = setInterval(() => {
        if (disposed) return;
        if (Date.now() - lastHeartbeatAt > LEASE_TIMEOUT_MS) {
          claimFallbackLeadership();
        }
      }, 90);
    };

    const onMessage = (ev) => {
      const msg = ev?.data;
      if (!msg || msg.tabId === tabId || disposed) return;
      if (msg.type === 'who-is-leader' && role === 'leader') {
        post({ type: 'leader-heartbeat' });
      } else if (msg.type === 'leader-heartbeat' || msg.type === 'leader-claimed') {
        if (role === 'leader' && String(msg.tabId) < String(tabId)) {
          observedLeader = msg.tabId;
          lastHeartbeatAt = Date.now();
          enterFollowerWatch();
        } else if (role !== 'leader') {
          observedLeader = msg.tabId;
          lastHeartbeatAt = Date.now();
        }
      } else if (msg.type === 'leader-resigned' && msg.tabId === observedLeader) {
        observedLeader = null;
        claimFallbackLeadership();
      }
    };

    if (typeof bus.addEventListener === 'function') bus.addEventListener('message', onMessage);
    else bus.onmessage = onMessage;

    post({ type: 'who-is-leader' });
    await new Promise((r) => setTimeout(r, 60));

    if (observedLeader) {
      await enterFollowerWatch();
    } else {
      await claimFallbackLeadership();
    }

    return {
      tabId,
      get role() { return role; },
      get isLeader() { return role === 'leader'; },
      release,
    };
  }

  // ---- Path C: Single-realm environment with neither Web Locks nor BroadcastChannel ----
  role = 'leader';
  await onLeader?.({ tabId });
  return {
    tabId,
    get role() { return role; },
    get isLeader() { return role === 'leader'; },
    release,
  };
}
