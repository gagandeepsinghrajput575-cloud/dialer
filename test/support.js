'use strict';
/**
 * Shared test harness: boots the real Express server against a throwaway
 * SQLite file on a free port, so `npm test` can never touch data/dialer.db.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDbFile(label = 'test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pulse-${label}-`));
  return path.join(dir, 'dialer.db');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer({ label = 'test', dbPath, port, timeoutMs = 25000, env = {} } = {}) {
  const db = dbPath || tmpDbFile(label);
  const p = port || (await freePort());
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: db, PORT: String(p), NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${p}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${log}`);
    }
    try {
      const r = await fetch(`${base}/api/settings`);
      if (r.ok) {
        return {
          base,
          port: p,
          dbPath: db,
          log: () => log,
          stop: async () => {
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            const end = Date.now() + 4000;
            while (child.exitCode === null && Date.now() < end) await sleep(50);
            if (child.exitCode === null) child.kill('SIGKILL');
            await sleep(50);
            try { fs.rmSync(path.dirname(db), { recursive: true, force: true }); } catch { /* best effort */ }
          },
        };
      }
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not become ready on ${base}:\n${log}`);
}

/** fetch wrapper that never throws on a non-2xx status. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function client(base) {
  return async function req(method, url, body, opts = {}) {
    // Mirrors src/api.js: the server rejects mutating requests that do not
    // identify themselves, which is what blocks cross-site requests.
    const headers = SAFE_METHODS.has(method) ? {} : { 'X-Requested-With': 'pulse-dialer' };
    if (body) headers['Content-Type'] = 'application/json';
    Object.assign(headers, opts.headers || {});
    const res = await fetch(base + url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, json, ok: res.ok };
  };
}

/** Walk every page of /api/queue, failing loudly on duplicates or bad ordering. */
async function walkQueue(req, { tab = 'all', limit = 5, q = '' } = {}) {
  const seen = [];
  const pages = [];
  let cursor = null;
  let meta = null;
  for (let guard = 0; guard < 500; guard++) {
    const params = new URLSearchParams({ tab, limit: String(limit) });
    if (q) params.set('q', q);
    if (cursor) params.set('cursor', cursor);
    const r = await req('GET', `/api/queue?${params}`);
    if (r.status !== 200) throw new Error(`page ${pages.length + 1} failed: ${r.status} ${r.text}`);
    meta = r.json;
    pages.push(r.json.items.map((i) => i.id));
    for (const item of r.json.items) {
      if (seen.includes(item.id)) throw new Error(`duplicate id ${item.id} on page ${pages.length}`);
      seen.push(item.id);
    }
    if (r.json.items.length > limit) throw new Error(`page returned ${r.json.items.length} rows, limit was ${limit}`);
    if (!r.json.hasMore) {
      if (r.json.nextCursor !== null) throw new Error('hasMore=false but nextCursor was returned');
      break;
    }
    if (!r.json.nextCursor) throw new Error('hasMore=true but nextCursor is missing');
    cursor = r.json.nextCursor;
  }
  return { ids: seen, pages, meta, total: meta ? meta.total : 0, counts: meta ? meta.counts : null };
}

// ---------- tiny reporter ----------
const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n${name}`);
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ section: currentSection, name, ok: true, ms: Date.now() - t0 });
    console.log(`  \u2713 ${name}${note ? ` \u2014 ${note}` : ''}`);
  } catch (e) {
    results.push({ section: currentSection, name, ok: false, ms: Date.now() - t0, error: e });
    console.log(`  \u2717 ${name}`);
    const detail = (e && e.stack ? e.stack : String(e)).split('\n').slice(0, 5).join('\n      ');
    console.log(`      ${detail}`);
  }
}

function summarize(title) {
  const failed = results.filter((r) => !r.ok);
  const ms = results.reduce((a, r) => a + r.ms, 0);
  console.log('\n' + '='.repeat(58));
  if (failed.length === 0) {
    console.log(`${title}: ${results.length} passed, 0 failed (${ms}ms)`);
  } else {
    console.log(`${title}: ${results.length - failed.length} passed, ${failed.length} FAILED`);
    for (const f of failed) console.log(`  - [${f.section}] ${f.name}: ${f.error && f.error.message}`);
  }
  console.log('='.repeat(58));
  return failed.length;
}

module.exports = { ROOT, sleep, tmpDbFile, freePort, startServer, client, walkQueue, test, section, summarize, results };
