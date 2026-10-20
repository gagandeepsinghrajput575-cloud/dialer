// Offline-Resilient Recording Upload Outbox backed by IndexedDB (Challenge 5).
//
// Persists raw WebRTC call audio recordings inside IndexedDB (`pulse_recordings_outbox`) BEFORE
// attempting HTTP transmission to `/api/recordings/:callId`.
//   - On HTTP 200/201 upload success: deletes the record from `pulse_recordings_outbox`.
//   - On Wi-Fi drop, offline browser, or 5xx reboot: keeps the binary recording safely in
//     IndexedDB and retries automatically on app startup or `window` `online` events.

export const DB_NAME = 'pulse_recordings_outbox';
export const DB_VERSION = 1;
export const STORE_NAME = 'pending_recordings';

// Shared in-memory store strictly used when `indexedDB` is unavailable in headless Node tests.
const memoryFallback = new Map();
let customIdbFactory = null;
let drainPromise = null;

export function setIndexedDbFactory(factory) {
  customIdbFactory = factory || null;
}

function getIdbFactory() {
  if (customIdbFactory) return customIdbFactory;
  if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
  if (typeof window !== 'undefined' && window.indexedDB) return window.indexedDB;
  return null;
}

function openOutboxDb() {
  const idb = getIdbFactory();
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    try {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'callId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open pulse_recordings_outbox'));
    } catch (err) {
      reject(err);
    }
  });
}

async function blobToBytes(blob) {
  if (!blob) return new Uint8Array(0);
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (typeof blob.arrayBuffer === 'function') {
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  }
  return new Uint8Array(0);
}

function recordToBlob(record) {
  const type = record?.mimeType || 'audio/webm';
  if (record?.bytes) {
    return new Blob([record.bytes], { type });
  }
  if (record?.blob && typeof Blob !== 'undefined' && record.blob instanceof Blob) {
    return record.blob;
  }
  return new Blob([], { type });
}

export async function savePendingRecording({
  callId,
  blob,
  durationSec = 0,
  attempts = 0,
  lastError = '',
  createdAt = Date.now(),
} = {}) {
  const key = String(callId);
  const bytes = await blobToBytes(blob);
  const entry = {
    callId: key,
    bytes,
    mimeType: blob?.type || 'audio/webm',
    sizeBytes: bytes.byteLength,
    durationSec: Math.max(0, Math.round(durationSec || 0)),
    attempts,
    lastError: String(lastError || ''),
    createdAt,
  };

  const db = await openOutboxDb().catch(() => null);
  if (!db) {
    memoryFallback.set(key, entry);
    return entry;
  }

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);
      tx.oncomplete = () => { db.close?.(); resolve(entry); };
      tx.onerror = () => { db.close?.(); reject(tx.error || new Error('IndexedDB write failed')); };
    } catch (err) {
      db.close?.();
      memoryFallback.set(key, entry);
      resolve(entry);
    }
  });
}

export async function getPendingRecording(callId) {
  const key = String(callId);
  const db = await openOutboxDb().catch(() => null);
  if (!db) {
    const rec = memoryFallback.get(key) || null;
    return rec ? { ...rec, blob: recordToBlob(rec) } : null;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const rec = req.result || null;
        db.close?.();
        resolve(rec ? { ...rec, blob: recordToBlob(rec) } : null);
      };
      req.onerror = () => { db.close?.(); resolve(null); };
    } catch {
      db.close?.();
      resolve(null);
    }
  });
}

export async function deletePendingRecording(callId) {
  const key = String(callId);
  memoryFallback.delete(key);
  const db = await openOutboxDb().catch(() => null);
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => { db.close?.(); resolve(true); };
      tx.onerror = () => { db.close?.(); resolve(false); };
    } catch {
      db.close?.();
      resolve(false);
    }
  });
}

export async function listPendingRecordings() {
  const db = await openOutboxDb().catch(() => null);
  if (!db) {
    return [...memoryFallback.values()]
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((r) => ({ ...r, blob: recordToBlob(r) }));
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const list = Array.isArray(req.result) ? req.result : [];
        db.close?.();
        resolve(
          list
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
            .map((r) => ({ ...r, blob: recordToBlob(r) })),
        );
      };
      req.onerror = () => { db.close?.(); resolve([]); };
    } catch {
      db.close?.();
      resolve([]);
    }
  });
}

export async function uploadWithOutbox({
  callId,
  blob,
  durationSec = 0,
  uploadFn,
} = {}) {
  if (!callId || !blob || typeof uploadFn !== 'function') {
    return { ok: false, queued: false, error: 'Missing recording parameters' };
  }

  // 1. Always persist binary blob to pulse_recordings_outbox BEFORE network transmission
  const saved = await savePendingRecording({ callId, blob, durationSec, attempts: 0 });

  // 2. Dispatch upload; remove on 200/201 success, retain safely on any network/server error
  try {
    const response = await uploadFn(callId, blob, durationSec);
    await deletePendingRecording(callId);
    return { ok: true, queued: false, response };
  } catch (err) {
    await savePendingRecording({
      callId,
      blob,
      durationSec,
      attempts: (saved?.attempts || 0) + 1,
      lastError: err?.message || String(err),
      createdAt: saved?.createdAt || Date.now(),
    });
    return { ok: false, queued: true, error: err?.message || String(err) };
  }
}

export async function drainPendingRecordings({ uploadFn, onUploaded } = {}) {
  if (typeof uploadFn !== 'function') return { attempted: 0, uploaded: 0, remaining: 0 };
  if (drainPromise) return drainPromise;

  drainPromise = (async () => {
    const pending = await listPendingRecordings();
    let uploaded = 0;

    for (const item of pending) {
      try {
        await uploadFn(item.callId, item.blob, item.durationSec || 0);
        await deletePendingRecording(item.callId);
        uploaded += 1;
        try { onUploaded?.(item); } catch { /* non-fatal */ }
      } catch (err) {
        await savePendingRecording({
          callId: item.callId,
          blob: item.bytes || item.blob,
          durationSec: item.durationSec,
          attempts: (item.attempts || 0) + 1,
          lastError: err?.message || String(err),
          createdAt: item.createdAt || Date.now(),
        });
      }
    }

    const left = await listPendingRecordings();
    return {
      attempted: pending.length,
      uploaded,
      remaining: left.length,
    };
  })().finally(() => {
    drainPromise = null;
  });

  return drainPromise;
}
