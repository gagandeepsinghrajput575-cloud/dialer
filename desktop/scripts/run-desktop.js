// `npm run desktop` — start the desktop app, and say exactly what is missing if it cannot.
//
// Electron is deliberately not a dependency of this repository. Its install downloads a platform
// binary from a release host, so on a locked-down network (or in CI) the postinstall fails and
// takes `npm install` down with it — and Pulse Dialer must still build, serve and pass its tests
// without it. The price is that starting the app is a two-step, and a two-step needs a good error
// message rather than `spawn electron ENOENT`.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DIST = path.join(REPO, 'dist', 'index.html');

const CANDIDATES = [
  path.join(REPO, 'node_modules', '.bin', 'electron'),
  path.join(REPO, 'desktop', 'node_modules', '.bin', 'electron'),
  'electron',                                  // installed globally (npm i -g electron)
];

/** Resolve `name` through PATH. Node has no `which`, so search it directly. */
function onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* not in this directory */ }
    }
  }
  return null;
}

function findElectron() {
  for (const candidate of CANDIDATES) {
    // The bare name used to be returned unconditionally, with a comment saying spawn would resolve
    // it through PATH later. That made `return null` below unreachable, so the guidance this whole
    // file exists to print could never print and the operator got `spawn electron ENOENT` instead —
    // the exact failure named in the header comment. Resolve it here so absence is detected.
    if (candidate === 'electron') {
      const found = onPath(candidate);
      if (found) return found;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const electron = findElectron();
if (!electron) {
  console.error(`
Pulse Dialer desktop needs Electron, and it is not installed.

  npm i -D electron@^33          # in the repository root (downloads a ~100 MB platform binary)
  npm run desktop                # then start the app

It is not a dependency of this repository on purpose: the download fails on a locked-down
network and would break \`npm install\` for everything else. See desktop/README.md.
`);
  process.exit(1);
}

if (!fs.existsSync(DIST)) {
  console.error(`
The renderer has not been built yet — the window would open on an instructions page.

  npm run build      # writes dist/
  npm start          # the local API server on port ${process.env.PORT || 3001}
  npm run desktop

(The app starts anyway: it will build nothing, but it does start the API server itself if
nothing is listening, and shows what to run.)
`);
}

// The API server is started by the supervisor when nothing is listening on its port, so
// `npm run desktop` on its own is enough for a normal launch.
const child = spawn(electron, [path.join(REPO, 'desktop')], { cwd: REPO, stdio: 'inherit' });
child.on('error', (e) => {
  console.error(`Could not start Electron (${e.message}).`);
  console.error('Install it with: npm i -D electron@^33');
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`The desktop app was killed by ${signal}.`);
  process.exit(code === null ? 0 : code);
});
