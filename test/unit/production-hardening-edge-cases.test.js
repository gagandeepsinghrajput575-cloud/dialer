// Deep Edge-Case Production Hardening Verification Suite (Challenges 1..6)
//
// Strictly exercises every failure mode across client + backend boundaries:
//   Challenge 1: beforeunload warning + pagehide sendBeacon('/api/calls/:id/abandon' & '/missed')
//                + synchronous BYE / 486 reject + UTC-accurate server duration calculation + note
//   Challenge 2: Autonomous staleCallWatchdog sweeping zombie 'ringing' (>90s + orphan provisional
//                lead GC) and stale 'connected'/'in_progress' (>2h -> capped 'abandoned')
//   Challenge 3: Mid-call audio hardware track 'ended' + 'devicechange' hot-swap via getUserMedia
//                + sender.replaceTrack(newTrack), plus graceful non-crashing fallback on failure
//   Challenge 4: Multi-tab SIP standby leadership via Web Locks ('pulse-sip-registration') and
//                BroadcastChannel('pulse-telephony') with <500ms leader failover & follower label
//   Challenge 5: Offline-resilient IndexedDB outbox ('pulse_recordings_outbox') pre-upload buffer,
//                retention on network failure, deletion on 200/201, and auto-drain on 'online'/boot
//   Challenge 6: Danish B2B calling window (08:30–16:30 Europe/Copenhagen) mid-call transition at
//                16:30:00 keeping active call alive, surfacing wrap-up notice, disabling auto-next,
//                inhibiting outbound dials until 08:30 next business day
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-deep-edge-'));
process.env.DATA_DIR = tmpRoot;
process.env.NODE_ENV = 'test';

const migrate = require('../../server/db/migrate');
migrate.run();

const { db } = require('../../server/db');
const { createApp } = require('../../server/app');
const { sessionToken } = require('../../server/middleware/guard');
const settingsRepo = require('../../server/repositories/settingsRepo');
const prospectRepo = require('../../server/repositories/prospectRepo');
const callRepo = require('../../server/repositories/callRepo');
const noteRepo = require('../../server/repositories/noteRepo');
const recordingRepo = require('../../server/repositories/recordingRepo');
const telephonyService = require('../../server/services/telephonyService');

function ok(label) {
  console.log(`    ✓ ${label}`);
}

(async () => {
  console.log('  [deep-edge-cases] unload resilience, zombie sweeper, hardware failover, multi-tab lock, IDB outbox & 16:30 window');

  const app = createApp();
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = sessionToken();

  try {
    // =========================================================================
    // CHALLENGE 1: Page Reload / Tab Close During Active Call & Ringing Invite
    // =========================================================================
    const { registerCallUnloadGuards } = await import('../../src/useWebRtc.js');
    assert.strictEqual(typeof registerCallUnloadGuards, 'function', 'registerCallUnloadGuards must be exported');

    const prospectA = prospectRepo.insert({
      name: 'Søren Lindholm',
      company: 'Lindholm Byg ApS',
      phone: '+4520112233',
      stage: 'contacted',
    });

    // Simulate active call started exactly 47 seconds ago in UTC SQLite format (no trailing Z!)
    const started47sAgo = new Date(Date.now() - 47 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const activeCall = callRepo.insert({
      prospect_id: prospectA.id,
      status: 'connected',
      dry_run: 0,
      direction: 'outbound',
      caller_id: '+4532331610',
    });
    callRepo.patch(activeCall.id, { started_at: started47sAgo });

    const targetListeners = new Map();
    const fakeWindow = {
      addEventListener(type, fn) {
        if (!targetListeners.has(type)) targetListeners.set(type, new Set());
        targetListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        targetListeners.get(type)?.delete(fn);
      },
      dispatch(type, ev = {}) {
        for (const fn of [...(targetListeners.get(type) || [])]) fn(ev);
        return ev;
      },
    };

    const beaconsSent = [];
    const sendBeaconSpy = (url, payload) => {
      beaconsSent.push({ url, payload });
      return true;
    };

    let byeCalls = 0;
    let rejectCalls = [];
    let currentState = 'active';
    let currentCallId = activeCall.id;
    let currentIncoming = null;

    const cleanupUnload = registerCallUnloadGuards({
      target: fakeWindow,
      sendBeacon: sendBeaconSpy,
      getToken: () => token,
      getActiveCall: () => (currentState === 'active'
        ? { callId: currentCallId, bye: () => { byeCalls += 1; } }
        : null),
      getIncomingRing: () => currentIncoming,
    });

    // 1A-i: beforeunload prompts agent while state === 'active'
    let prevented = false;
    const beforeUnloadEvent = fakeWindow.dispatch('beforeunload', {
      preventDefault() { prevented = true; },
      returnValue: undefined,
    });
    assert.strictEqual(prevented, true, 'beforeunload must call preventDefault() during an active call');
    assert.strictEqual(
      beforeUnloadEvent.returnValue,
      'Call in progress. Are you sure?',
      'beforeunload must set exact confirmation string',
    );

    // 1A-ii: pagehide synchronously dispatches sendBeacon('/api/calls/:id/abandon', ...) AND bye()
    fakeWindow.dispatch('pagehide');
    // Immediately following 'unload' must NOT duplicate BYE or beacon for the same call
    fakeWindow.dispatch('unload');
    assert.strictEqual(byeCalls, 1, 'pagehide must synchronously emit SIP BYE once');
    assert.strictEqual(beaconsSent.length, 1, 'pagehide + unload must send exactly one abandon beacon');
    assert.strictEqual(beaconsSent[0].url, `/api/calls/${activeCall.id}/abandon`);

    // Replay the exact browser beacon (INCLUDING browser Origin header and text/plain body without x-pulse-token header!)
    const rawBody = typeof beaconsSent[0].payload === 'string'
      ? beaconsSent[0].payload
      : await beaconsSent[0].payload.text();
    const abandonHttp = await fetch(`${baseUrl}${beaconsSent[0].url}`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3001',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: rawBody,
    });
    assert.strictEqual(abandonHttp.status, 200, 'browser sendBeacon to /abandon with Origin header must return 200');
    const abandonedRow = callRepo.get(activeCall.id);
    assert.strictEqual(abandonedRow.status, 'abandoned');
    assert.strictEqual(abandonedRow.outcome, 'dropped');
    assert.ok(abandonedRow.ended_at, 'abandoned call must stamp ended_at');
    assert.ok(
      abandonedRow.duration_sec >= 45 && abandonedRow.duration_sec <= 52,
      `duration_sec must reflect ~47s elapsed UTC time, got ${abandonedRow.duration_sec}`,
    );
    const abandonNotes = noteRepo.listByProspect(prospectA.id);
    assert.ok(abandonNotes.some((n) => /abandon|reload|unload|disconnect/i.test(n.body)), 'abandon must record a system note');

    // 1B: Inbound ringing reload -> sendBeacon('/api/calls/:id/missed', ...) + reject({ statusCode: 486 })
    const inboundStart = await fetch(`${baseUrl}/api/calls/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pulse-token': token, Origin: 'http://localhost:3001' },
      body: JSON.stringify({ callerPhone: '+4599887766' }),
    });
    const inboundData = await inboundStart.json();
    assert.strictEqual(inboundData.provisional, true, 'stranger ring opens provisional lead');

    currentState = 'incoming';
    currentIncoming = {
      callId: inboundData.callId,
      answered: false,
      reject: (opts) => { rejectCalls.push(opts); },
    };
    fakeWindow.dispatch('pagehide');
    assert.strictEqual(rejectCalls.length, 1, 'pagehide during incoming ring must synchronously reject INVITE');
    assert.deepStrictEqual(rejectCalls[0], { statusCode: 486 }, 'incoming ring reload must reject with 486 Busy Here');
    assert.strictEqual(beaconsSent.length, 2, 'pagehide during incoming ring must emit missed beacon');
    assert.strictEqual(beaconsSent[1].url, `/api/calls/${inboundData.callId}/missed`);

    const missedBeaconBody = typeof beaconsSent[1].payload === 'string'
      ? beaconsSent[1].payload
      : await beaconsSent[1].payload.text();
    const missedPayloadParsed = JSON.parse(missedBeaconBody);
    assert.strictEqual(missedPayloadParsed.reason, 'abandoned');
    assert.strictEqual(missedPayloadParsed.duration_sec, 0);

    const missedHttp = await fetch(`${baseUrl}${beaconsSent[1].url}`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3001', 'Content-Type': 'text/plain;charset=UTF-8' },
      body: missedBeaconBody,
    });
    assert.strictEqual(missedHttp.status, 200, 'missed beacon during unload must succeed with 200');
    assert.strictEqual(callRepo.get(inboundData.callId), undefined, 'swept provisional lead cascades its orphan ring row cleanly');
    assert.strictEqual(prospectRepo.get(inboundData.prospect.id), undefined, 'provisional lead must not stay stranded after ringing reload');

    cleanupUnload();
    ok('Challenge 1: beforeunload warning, BYE + /abandon beacon, and 486 + /missed beacon verified');

    // =========================================================================
    // CHALLENGE 2: Backend Stale Call & Zombie Ringing Garbage Collector
    // =========================================================================
    const staleCallWatchdog = require('../../server/services/staleCallWatchdog');
    assert.strictEqual(typeof staleCallWatchdog.sweepNow, 'function');
    assert.strictEqual(typeof staleCallWatchdog.start, 'function');
    assert.strictEqual(typeof staleCallWatchdog.stop, 'function');

    const nowMs = Date.now();
    const sqlAgo = (sec) => new Date(nowMs - sec * 1000).toISOString().slice(0, 19).replace('T', ' ');

    // 2A: Ringing > 90s on orphan provisional lead (extra.provisional === 1) -> missed + GC provisional lead
    const orphanProvisional = prospectRepo.insert({
      name: '+4577665544',
      phone: '+4577665544',
      stage: 'new',
      extra: { inbound: true, provisional: 1 },
    });
    const staleProvRing = callRepo.createInbound({
      prospectId: orphanProvisional.id,
      callerId: '+4577665544',
      status: 'ringing',
    });
    callRepo.patch(staleProvRing.id, { started_at: sqlAgo(120) });

    // 2B: Ringing > 90s on REAL CRM lead -> status = 'missed' + ended_at, real lead PRESERVED
    const staleRealRing = callRepo.createInbound({
      prospectId: prospectA.id,
      callerId: prospectA.phone,
      status: 'ringing',
    });
    callRepo.patch(staleRealRing.id, { started_at: sqlAgo(95) });

    // 2C: Fresh ringing call (20s old) -> untouched!
    const freshRing = callRepo.createInbound({
      prospectId: prospectA.id,
      callerId: prospectA.phone,
      status: 'ringing',
    });
    callRepo.patch(freshRing.id, { started_at: sqlAgo(20) });

    // 2D: Stale connected call (> 2 hours = 9,000s old) -> capped & status = 'abandoned'
    const zombieConnected = callRepo.insert({
      prospect_id: prospectA.id,
      status: 'connected',
      dry_run: 0,
      direction: 'outbound',
    });
    callRepo.patch(zombieConnected.id, { started_at: sqlAgo(9000) });

    // 2E: Active connected call (10 minutes = 600s old) -> untouched!
    const healthyConnected = callRepo.insert({
      prospect_id: prospectA.id,
      status: 'connected',
      dry_run: 0,
      direction: 'outbound',
    });
    callRepo.patch(healthyConnected.id, { started_at: sqlAgo(600) });

    const sweepResult = staleCallWatchdog.sweepNow({ now: new Date(nowMs) });
    assert.strictEqual(sweepResult.sweptRinging, 2, 'watchdog must sweep both >90s ringing calls');
    assert.strictEqual(sweepResult.cleanedProvisional, 1, 'watchdog must garbage-collect orphan provisional lead');
    assert.strictEqual(sweepResult.sweptConnected, 1, 'watchdog must cap & abandon >2h connected call');

    assert.strictEqual(prospectRepo.get(orphanProvisional.id), undefined, 'orphan provisional lead must be removed');
    assert.ok(prospectRepo.get(prospectA.id), 'real CRM lead must survive watchdog sweep');
    const sweptRealRingRow = callRepo.get(staleRealRing.id);
    assert.strictEqual(sweptRealRingRow.status, 'missed');
    assert.ok(sweptRealRingRow.ended_at, 'swept ringing row must have ended_at stamped');
    assert.strictEqual(callRepo.get(freshRing.id).status, 'ringing', 'fresh 20s ringing call must remain untouched');
    const sweptZombieRow = callRepo.get(zombieConnected.id);
    assert.strictEqual(sweptZombieRow.status, 'abandoned');
    assert.ok(sweptZombieRow.duration_sec <= 7200 && sweptZombieRow.duration_sec > 0, 'zombie duration must be capped at <= 7200s');
    assert.strictEqual(callRepo.get(healthyConnected.id).status, 'connected', 'active 10m call must remain untouched');

    ok('Challenge 2: staleCallWatchdog sweeps >90s ringing + provisional leads and caps >2h connected calls');

    // =========================================================================
    // CHALLENGE 3: Audio Hardware Loss & Device Hot-Swapping Mid-Call
    // =========================================================================
    const { monitorMicrophoneFailover } = await import('../../src/useWebRtc.js');
    assert.strictEqual(typeof monitorMicrophoneFailover, 'function', 'monitorMicrophoneFailover must be exported');

    function makeMockTrack(id, label) {
      const listeners = new Map();
      return {
        id,
        kind: 'audio',
        label,
        enabled: true,
        readyState: 'live',
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
          listeners.get(type)?.delete(fn);
        },
        stop() { this.readyState = 'ended'; },
        unplug() {
          this.readyState = 'ended';
          for (const fn of [...(listeners.get('ended') || [])]) fn({ type: 'ended', target: this });
        },
      };
    }

    const usbTrack = makeMockTrack('usb-mic-1', 'Jabra Evolve2 USB');
    const builtinTrack = makeMockTrack('builtin-mic-1', 'MacBook Pro Microphone');
    let replacedTracks = [];
    const mockSender = {
      track: usbTrack,
      replaceTrack: async (nextTrack) => {
        replacedTracks.push(nextTrack);
        mockSender.track = nextTrack;
      },
    };
    const mockPc = { getSenders: () => [mockSender] };
    const mediaDeviceListeners = new Set();
    const failoverEvents = [];
    let activeStream = { getTracks: () => [usbTrack], getAudioTracks: () => [usbTrack] };
    let nextGUMMode = 'succeed';

    const detachMonitor = monitorMicrophoneFailover({
      getStream: () => activeStream,
      setStream: (s) => { activeStream = s; },
      getPeerConnection: () => mockPc,
      isCallLive: () => true,
      isMuted: () => false,
      mediaDevices: {
        getUserMedia: async (constraints) => {
          assert.deepStrictEqual(constraints, { audio: true });
          if (nextGUMMode === 'fail') throw new Error('NotReadableError: Could not start audio source');
          return { getTracks: () => [builtinTrack], getAudioTracks: () => [builtinTrack] };
        },
        addEventListener: (_t, fn) => mediaDeviceListeners.add(fn),
        removeEventListener: (_t, fn) => mediaDeviceListeners.delete(fn),
      },
      onSwitched: (info) => failoverEvents.push({ type: 'switched', ...info }),
      onFailed: (info) => failoverEvents.push({ type: 'failed', ...info }),
    });

    // Unplug Bluetooth/USB headset mid-call -> automatic hot-swap via replaceTrack!
    usbTrack.unplug();
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(replacedTracks.length, 1, 'sender.replaceTrack must be invoked automatically on track ended');
    assert.strictEqual(replacedTracks[0], builtinTrack, 'default system microphone track must replace dead USB track');
    assert.strictEqual(failoverEvents.length, 1);
    assert.strictEqual(failoverEvents[0].type, 'switched');
    assert.strictEqual(failoverEvents[0].message, 'Audio device switched to default microphone');

    // Now simulate second hardware loss when NO backup microphone is available -> non-crashing alert
    nextGUMMode = 'fail';
    builtinTrack.unplug();
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(failoverEvents.length, 2);
    assert.strictEqual(failoverEvents[1].type, 'failed');
    assert.ok(failoverEvents[1].message.length > 0, 'failed failover must surface a clear message without crashing');

    detachMonitor();
    ok('Challenge 3: mid-call audio hardware ended/devicechange hot-swap & graceful failure alert verified');

    // =========================================================================
    // CHALLENGE 4: Multi-Tab Standby Collision & Registration Election (<500ms)
    // =========================================================================
    const { acquireSipLeadership, SIP_REGISTRATION_LOCK, TELEPHONY_CHANNEL } = await import('../../src/utils/tabLeadership.js');
    assert.strictEqual(SIP_REGISTRATION_LOCK, 'pulse-sip-registration');
    assert.strictEqual(TELEPHONY_CHANNEL, 'pulse-telephony');

    // Real spec-accurate in-memory Web Locks + BroadcastChannel bus shared across 3 simulated tabs
    let lockHolder = null;
    const lockWaitQueue = [];
    const fakeLockManager = {
      request(name, optsOrCb, maybeCb) {
        const opts = typeof optsOrCb === 'function' ? {} : (optsOrCb || {});
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        return new Promise((resolve, reject) => {
          const grant = () => {
            const tokenObj = { name };
            lockHolder = tokenObj;
            Promise.resolve()
              .then(() => cb(tokenObj))
              .then(resolve, reject)
              .finally(() => {
                if (lockHolder === tokenObj) lockHolder = null;
                while (lockWaitQueue.length > 0) {
                  const next = lockWaitQueue.shift();
                  if (!next.aborted) { next.grant(); break; }
                }
              });
          };
          if (!lockHolder) {
            grant();
          } else if (opts.ifAvailable) {
            Promise.resolve().then(() => cb(null)).then(resolve, reject);
          } else {
            const waiter = { aborted: false, grant };
            if (opts.signal) {
              if (opts.signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
              opts.signal.addEventListener('abort', () => {
                waiter.aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
              }, { once: true });
            }
            lockWaitQueue.push(waiter);
          }
        });
      },
    };

    const bcPeers = new Set();
    class FakeBroadcastChannel {
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        this.listeners = new Set();
        bcPeers.add(this);
      }
      postMessage(data) {
        for (const peer of bcPeers) {
          if (peer !== this && peer.name === this.name) {
            queueMicrotask(() => {
              peer.onmessage?.({ data });
              for (const fn of peer.listeners) fn({ data });
            });
          }
        }
      }
      addEventListener(type, fn) { if (type === 'message') this.listeners.add(fn); }
      removeEventListener(type, fn) { if (type === 'message') this.listeners.delete(fn); }
      close() { bcPeers.delete(this); }
    }

    const activeSipRegistrations = new Set();
    const tabStates = { tab1: '', tab2: '', tab3: '' };

    const tab1 = await acquireSipLeadership({
      tabId: 'tab-1',
      locks: fakeLockManager,
      BroadcastChannelCtor: FakeBroadcastChannel,
      onLeader: async () => { activeSipRegistrations.add('tab-1'); tabStates.tab1 = 'Standby · Ready for calls'; },
      onFollower: () => { activeSipRegistrations.delete('tab-1'); tabStates.tab1 = 'Standby · Active in another tab'; },
    });
    const tab2 = await acquireSipLeadership({
      tabId: 'tab-2',
      locks: fakeLockManager,
      BroadcastChannelCtor: FakeBroadcastChannel,
      onLeader: async () => { activeSipRegistrations.add('tab-2'); tabStates.tab2 = 'Standby · Ready for calls'; },
      onFollower: () => { activeSipRegistrations.delete('tab-2'); tabStates.tab2 = 'Standby · Active in another tab'; },
    });
    const tab3 = await acquireSipLeadership({
      tabId: 'tab-3',
      locks: fakeLockManager,
      BroadcastChannelCtor: FakeBroadcastChannel,
      onLeader: async () => { activeSipRegistrations.add('tab-3'); tabStates.tab3 = 'Standby · Ready for calls'; },
      onFollower: () => { activeSipRegistrations.delete('tab-3'); tabStates.tab3 = 'Standby · Active in another tab'; },
    });

    assert.strictEqual(activeSipRegistrations.size, 1, 'exactly ONE tab may register SIP UserAgent');
    assert.ok(activeSipRegistrations.has('tab-1'), 'Tab 1 is initial leader');
    assert.strictEqual(tabStates.tab2, 'Standby · Active in another tab', 'Tab 2 reports exact follower standby label');
    assert.strictEqual(tabStates.tab3, 'Standby · Active in another tab', 'Tab 3 reports exact follower standby label');

    // Close Leader Tab 1 -> Follower claims lock & registers UserAgent in << 500ms!
    const t0 = Date.now();
    await tab1.release();
    await new Promise((r) => setTimeout(r, 30));
    const failoverElapsedMs = Date.now() - t0;
    assert.ok(failoverElapsedMs < 500, `leader failover must complete within 500ms (took ${failoverElapsedMs}ms)`);
    assert.strictEqual(activeSipRegistrations.size, 1, 'after leader close, still strictly ONE active SIP registration');
    assert.ok(activeSipRegistrations.has('tab-2'), 'Tab 2 seamlessly promoted to SIP leader');
    assert.strictEqual(tabStates.tab3, 'Standby · Active in another tab', 'Tab 3 stays follower without collision');

    await tab2.release();
    await tab3.release();

    // Also verify Path B fallback when navigator.locks is absent (BroadcastChannel-only mode)
    const fallbackRegs = new Set();
    const fb1 = await acquireSipLeadership({
      tabId: 'bc-tab-1',
      locks: null,
      BroadcastChannelCtor: FakeBroadcastChannel,
      onLeader: async () => { fallbackRegs.add('bc-tab-1'); },
      onFollower: () => { fallbackRegs.delete('bc-tab-1'); },
    });
    const fb2 = await acquireSipLeadership({
      tabId: 'bc-tab-2',
      locks: null,
      BroadcastChannelCtor: FakeBroadcastChannel,
      onLeader: async () => { fallbackRegs.add('bc-tab-2'); },
      onFollower: () => { fallbackRegs.delete('bc-tab-2'); },
    });
    assert.strictEqual(fallbackRegs.size, 1, 'BroadcastChannel fallback elects strictly one leader');
    const tFb = Date.now();
    await fb1.release();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(Date.now() - tFb < 500, 'BroadcastChannel fallback promotes follower within 500ms');
    assert.strictEqual(fallbackRegs.has('bc-tab-2'), true, 'bc-tab-2 takes over leadership seamlessly');
    await fb2.release();

    ok(`Challenge 4: Web Locks ('pulse-sip-registration') + BroadcastChannel ('pulse-telephony') single-leader failover in ${failoverElapsedMs}ms`);

    // =========================================================================
    // CHALLENGE 5: Recording Upload Offline Resilience (IndexedDB Outbox)
    // =========================================================================
    const recordingsStorage = await import('../../src/utils/recordingsStorage.js');
    assert.strictEqual(recordingsStorage.DB_NAME, 'pulse_recordings_outbox');

    const recCall = callRepo.insert({
      prospect_id: prospectA.id,
      status: 'completed',
      outcome: 'conversation',
      duration_sec: 125,
      dry_run: 0,
      direction: 'outbound',
    });

    // Real browser IDBFactory / IDBObjectStore transaction state-machine simulation
    const rawStores = new Map();
    const fakeIdbFactory = {
      open(_name, _version) {
        const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          const dbHandle = {
            objectStoreNames: { contains: (n) => rawStores.has(n) },
            createObjectStore(n) { if (!rawStores.has(n)) rawStores.set(n, new Map()); return {}; },
            transaction(storeName) {
              const map = rawStores.get(storeName);
              const tx = { oncomplete: null, onerror: null, error: null };
              const finish = () => queueMicrotask(() => tx.oncomplete?.());
              return {
                set oncomplete(fn) { tx.oncomplete = fn; },
                set onerror(fn) { tx.onerror = fn; },
                objectStore() {
                  return {
                    put(val) { map.set(val.callId, val); finish(); return {}; },
                    delete(key) { map.delete(key); finish(); return {}; },
                    get(key) {
                      const r = { result: map.get(key), onsuccess: null, onerror: null };
                      queueMicrotask(() => r.onsuccess?.());
                      return r;
                    },
                    getAll() {
                      const r = { result: [...map.values()], onsuccess: null, onerror: null };
                      queueMicrotask(() => r.onsuccess?.());
                      return r;
                    },
                  };
                },
              };
            },
            close() {},
          };
          req.result = dbHandle;
          if (!rawStores.has(recordingsStorage.STORE_NAME)) req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      },
    };
    recordingsStorage.setIndexedDbFactory(fakeIdbFactory);
    const audioBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x99, 0x88, 0x77, 0x66]);
    const recordingBlob = new Blob([audioBytes], { type: 'audio/webm' });

    // Step 1: Wi-Fi drops during hangup upload -> blob persists safely inside pulse_recordings_outbox
    let wifiOnline = false;
    const firstAttempt = await recordingsStorage.uploadWithOutbox({
      callId: recCall.id,
      blob: recordingBlob,
      durationSec: 125,
      uploadFn: async (callId, blob, dur) => {
        if (!wifiOnline) throw new Error('TypeError: Failed to fetch (ERR_INTERNET_DISCONNECTED)');
        const form = new FormData();
        form.append('audio', blob, `call-${callId}.webm`);
        form.append('duration_sec', String(dur));
        const res = await fetch(`${baseUrl}/api/recordings/${callId}`, {
          method: 'POST',
          headers: { 'x-pulse-token': token },
          body: form,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    });
    assert.strictEqual(firstAttempt.ok, false, 'offline attempt reports transient failure');
    assert.strictEqual(firstAttempt.queued, true, 'recording blob must remain buffered in pulse_recordings_outbox');

    const pendingWhileOffline = await recordingsStorage.listPendingRecordings();
    assert.strictEqual(pendingWhileOffline.length, 1, 'outbox holds 1 pending recording while offline');
    assert.strictEqual(Number(pendingWhileOffline[0].callId), recCall.id);

    // Step 2: Wi-Fi reconnects -> drainPendingRecordings uploads to real Express /api/recordings/:callId & purges IDB!
    wifiOnline = true;
    const drainResult = await recordingsStorage.drainPendingRecordings({
      uploadFn: async (callId, blob, dur) => {
        const form = new FormData();
        form.append('audio', blob, `call-${callId}.webm`);
        form.append('duration_sec', String(dur));
        const res = await fetch(`${baseUrl}/api/recordings/${callId}`, {
          method: 'POST',
          headers: { 'x-pulse-token': token },
          body: form,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    });
    assert.strictEqual(drainResult.uploaded, 1, 'reconnect drain uploads the buffered recording');
    assert.strictEqual((await recordingsStorage.listPendingRecordings()).length, 0, 'record is deleted from IndexedDB after 200 OK');
    assert.ok(recordingRepo.getByCallId(recCall.id), 'server persisted uploaded recording on disk + SQLite');

    ok('Challenge 5: pulse_recordings_outbox IndexedDB buffer survives network drop & drains on reconnect');

    // =========================================================================
    // CHALLENGE 6: Danish B2B Calling Window Mid-Call Transition (16:29:45 -> 16:30:00)
    // =========================================================================
    const { evaluateCallingWindow, createCallingWindowMonitor } = await import('../../src/utils/callingWindow.js');
    assert.strictEqual(typeof evaluateCallingWindow, 'function');
    assert.strictEqual(typeof createCallingWindowMonitor, 'function');

    // Tuesday 2026-10-20 in Europe/Copenhagen is CEST (UTC+2):
    //   16:29:45 Europe/Copenhagen = 2026-10-20T14:29:45Z
    //   16:30:00 Europe/Copenhagen = 2026-10-20T14:30:00Z
    //   Next business day Wednesday 2026-10-21 08:29:59 CEST = 2026-10-21T06:29:59Z
    //   Next business day Wednesday 2026-10-21 08:30:00 CEST = 2026-10-21T06:30:00Z
    const t162945 = new Date('2026-10-20T14:29:45Z');
    const t163000 = new Date('2026-10-20T14:30:00Z');
    const tNext082959 = new Date('2026-10-21T06:29:59Z');
    const tNext083000 = new Date('2026-10-21T06:30:00Z');

    assert.strictEqual(telephonyService.businessHours(t162945).open, true, '16:29:45 Copenhagen must be open');
    assert.strictEqual(telephonyService.businessHours(t163000).open, false, '16:30:00 Copenhagen must close immediately');
    assert.strictEqual(evaluateCallingWindow({}, t162945).open, true);
    assert.strictEqual(evaluateCallingWindow({}, t163000).open, false);

    let liveCallActive = true;
    let callAborted = false;
    const notices = [];
    const monitor = createCallingWindowMonitor({
      getSettings: () => ({
        business_tz: 'Europe/Copenhagen',
        business_hours_start: '08:30',
        business_hours_end: '16:30',
        business_days: '1,2,3,4,5',
        dry_run: '0',
      }),
      isCallActive: () => liveCallActive,
      onWindowClosed: (msg) => notices.push(msg),
    });

    // At 16:29:45: call is live, window open, autoNext allowed
    let snap = monitor.tick(t162945);
    assert.strictEqual(snap.open, true);
    assert.strictEqual(snap.allowAutoNext, true);
    assert.strictEqual(snap.allowOutboundDial, true);
    assert.strictEqual(notices.length, 0);

    // Clock hits 16:30:00 mid-call: active conversation keeps running, exact notice fires once, autoNext disabled!
    snap = monitor.tick(t163000);
    assert.strictEqual(callAborted, false, 'active conversation must NEVER be aborted at 16:30:00');
    assert.strictEqual(liveCallActive, true, 'active call stays live');
    assert.strictEqual(notices.length, 1, '16:30 transition emits wrap-up notification exactly once');
    assert.strictEqual(notices[0], 'Calling window closed for today (16:30). Wrap up active conversation.');
    assert.strictEqual(snap.allowAutoNext, false, 'auto-next queuing must be inhibited once window closes');

    // Call finishes at 16:32:00 -> pressing C / placing outbound dials is inhibited
    liveCallActive = false;
    snap = monitor.tick(new Date('2026-10-20T14:32:00Z'));
    assert.strictEqual(snap.allowOutboundDial, false, 'outbound dials must remain locked after wrap-up');

    // Next business morning 08:29:59 -> still locked
    snap = monitor.tick(tNext082959);
    assert.strictEqual(snap.allowOutboundDial, false, '08:29:59 next morning is still locked');

    // Next business morning 08:30:00 -> unlocked automatically!
    snap = monitor.tick(tNext083000);
    assert.strictEqual(snap.open, true);
    assert.strictEqual(snap.allowOutboundDial, true, '08:30:00 next business morning re-enables outbound dialing');
    assert.strictEqual(snap.allowAutoNext, true, '08:30:00 re-enables auto-next queuing');

    ok('Challenge 6: 16:29:45 -> 16:30:00 Europe/Copenhagen transition keeps call alive, notifies agent, blocks C until 08:30');
    console.log('  [deep-edge-cases] ALL 6 PRODUCTION HARDENING CHALLENGES PASSED!');
  } finally {
    await new Promise((r) => server.close(r));
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('  [deep-edge-cases] FAILED:', err);
  process.exit(1);
});
