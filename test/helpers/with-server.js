// Runs one unit suite against a real server on a throwaway port and database.
//
// backend-connectivity.test.js asserts HTTP behaviour (session tokens, CSRF, DNS-rebinding,
// carrier reachability), so unlike the pure suites it needs a listening API. Before this
// runner, `npm run test:unit` only passed if the developer happened to have `npm start`
// running on port 3001.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`server did not answer ${url} within ${timeoutMs}ms`);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node test/helpers/with-server.js test/unit/<suite>.test.js');
    process.exit(2);
  }

  const port = Number(process.env.PORT) || await freePort();
  const dataDir = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-srv-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, PULSE_TEST: '1' };

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });

  const stop = () => {
    if (server.exitCode === null) server.kill('SIGTERM');
  };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });

  try {
    await waitForServer(`http://127.0.0.1:${port}/api/session`, server);
  } catch (err) {
    stop();
    console.error(log);
    console.error(`[with-server] ${err.message}`);
    process.exit(1);
  }

  const run = spawnSync(process.execPath, [path.join(ROOT, target)], {
    cwd: ROOT,
    env: { ...env, API_BASE: `http://127.0.0.1:${port}`, DATA_DIR: dataDir },
    stdio: 'inherit',
  });
  stop();
  process.exit(run.status === null ? 1 : run.status);
}

main();
