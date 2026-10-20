// Autonomous Stale Call & Zombie Ringing Garbage Collector (Challenge 2).
//
// Guards the ledger against hard power loss, OS kernel panics, or total network severance where
// even browser pagehide/sendBeacon packets cannot reach the server:
//   1. Any call stuck in `status = 'ringing'` older than 90 seconds is transitioned atomically
//      to `status = 'missed'` with `ended_at = sqlNow()`. If linked to an orphaned provisional
//      lead (`extra.provisional === 1` / `true`) with no notes or real calls, the placeholder
//      lead is garbage-collected.
//   2. Any call stuck in `status = 'connected'` or `status = 'in_progress'` older than 2 hours
//      is capped at the threshold window and transitioned to `status = 'abandoned'`.
const { db, withBusyRetry } = require('../db');
const calls = require('../repositories/callRepo');
const prospects = require('../repositories/prospectRepo');
const notes = require('../repositories/noteRepo');
const { sqlTime, parseSqlUtcMs, isProvisionalLead } = require('./callService');

const RINGING_MAX_AGE_SEC = 90;
const CONNECTED_MAX_AGE_SEC = 2 * 60 * 60; // 2 hours
const DEFAULT_INTERVAL_MS = 60 * 1000;     // 60 seconds

let timer = null;

function isOrphanProvisionalLead(prospectId) {
  const lead = prospects.get(prospectId);
  if (!isProvisionalLead(lead)) return false;
  if (notes.listByProspect(prospectId).length > 0) return false;
  const history = calls.listByProspect(prospectId, 20);
  return history.every((c) => ['ringing', 'missed', 'declined'].includes(c.status));
}

function sweepNow({
  now = new Date(),
  ringingMaxAgeSec = RINGING_MAX_AGE_SEC,
  connectedMaxAgeSec = CONNECTED_MAX_AGE_SEC,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const endedAt = sqlTime(nowDate);

  return withBusyRetry(() => db.transaction(() => {
    const sweptRingingIds = [];
    const cleanedProvisionalIds = [];
    const sweptConnectedIds = [];

    // 1. Sweep zombie ringing rows older than 90s
    const ringingRows = db.prepare("SELECT * FROM calls WHERE status = 'ringing'").all();
    const candidateProvisionalProspects = new Set();

    for (const row of ringingRows) {
      const startedMs = parseSqlUtcMs(row.started_at);
      if (!Number.isFinite(startedMs)) continue;
      const ageSec = (nowMs - startedMs) / 1000;
      if (ageSec <= ringingMaxAgeSec) continue;

      calls.patch(row.id, {
        status: 'missed',
        ended_at: endedAt,
        duration_sec: 0,
      });
      sweptRingingIds.push(row.id);
      if (row.prospect_id) candidateProvisionalProspects.add(row.prospect_id);
    }

    for (const prospectId of candidateProvisionalProspects) {
      if (isOrphanProvisionalLead(prospectId)) {
        prospects.remove(prospectId);
        cleanedProvisionalIds.push(prospectId);
      }
    }

    // 2. Sweep stale connected / in_progress calls older than 2 hours
    const liveRows = db.prepare("SELECT * FROM calls WHERE status IN ('connected', 'in_progress')").all();
    for (const row of liveRows) {
      const startedMs = parseSqlUtcMs(row.started_at);
      if (!Number.isFinite(startedMs)) continue;
      const elapsedSec = (nowMs - startedMs) / 1000;
      if (elapsedSec <= connectedMaxAgeSec) continue;

      const cappedDuration = Math.min(connectedMaxAgeSec, Math.max(0, Math.round(elapsedSec)));
      calls.patch(row.id, {
        status: 'abandoned',
        outcome: row.outcome || 'dropped',
        duration_sec: cappedDuration,
        ended_at: endedAt,
      });
      if (row.prospect_id && prospects.get(row.prospect_id)) {
        notes.insert(
          row.prospect_id,
          `⚠️ System Watchdog: Stale live call automatically closed after exceeding ${Math.round(connectedMaxAgeSec / 3600)}h timeout.`,
        );
      }
      sweptConnectedIds.push(row.id);
    }

    return {
      ok: true,
      sweptRinging: sweptRingingIds.length,
      sweptConnected: sweptConnectedIds.length,
      cleanedProvisional: cleanedProvisionalIds.length,
      sweptRingingIds,
      sweptConnectedIds,
      cleanedProvisionalIds,
    };
  })());
}

function start({ intervalMs = DEFAULT_INTERVAL_MS, runImmediately = true, ...opts } = {}) {
  stop();
  let initial = null;
  if (runImmediately) {
    try {
      initial = sweepNow(opts);
    } catch (err) {
      console.error('[staleCallWatchdog] startup sweep failed:', err?.message || err);
    }
  }
  timer = setInterval(() => {
    try {
      sweepNow(opts);
    } catch (err) {
      console.error('[staleCallWatchdog] periodic sweep failed:', err?.message || err);
    }
  }, Math.max(1000, intervalMs));
  // Unref so background maintenance never prevents clean process exit in CLI/tests.
  if (typeof timer.unref === 'function') timer.unref();
  return { timer, initial };
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  sweepNow,
  start,
  stop,
  RINGING_MAX_AGE_SEC,
  CONNECTED_MAX_AGE_SEC,
  DEFAULT_INTERVAL_MS,
};
