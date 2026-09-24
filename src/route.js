'use strict';

// Shared machinery for the two "point a tool at Holdfast" commands
// (`holdfast kiro enable` / `holdfast claude enable`).
//
// The rule these enforce is fail-safety. Once a tool's endpoint points at
// localhost, that tool is DEAD whenever Holdfast isn't listening — which is
// exactly what happens when Holdfast was started by hand in a terminal that
// later got closed. So routing is only ever written when:
//
//   1. Holdfast is installed as a supervised service from a stable path
//      (launchd/systemd restart it, and the path survives an npx cache purge), and
//   2. the port answers /__holdfast/health AND identifies itself as the
//      expected Holdfast listener — proving we are not pointing the tool at
//      some unrelated local server that happens to own the port.
//
// Every file we touch is backed up first, the exact inverse edit is recorded,
// and `disable` restores the original bytes.

const fs = require('fs');
const http = require('http');
const path = require('path');
const paths = require('./paths');

function ensureHome() {
  fs.mkdirSync(paths.holdfastHome(), { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(name, obj) {
  ensureHome();
  fs.writeFileSync(paths.stateFile(name), JSON.stringify(obj, null, 2));
}

function readState(name) {
  return readJson(paths.stateFile(name));
}

function clearState(name) {
  try {
    fs.unlinkSync(paths.stateFile(name));
  } catch (_) {}
}

// The record `holdfast install` leaves behind: proof of a supervised, stable
// installation, and where it lives.
function installState() {
  return readState('install.json');
}

// Ask a port whether it is one of our listeners.
function health(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/__holdfast/health',
        timeout: timeoutMs,
        // A fresh socket every time: Node's global agent keeps connections
        // alive, and a pooled socket to a Holdfast that has since restarted
        // comes back as ECONNRESET — which would look like "nothing there".
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const info = (() => {
            try {
              return JSON.parse(Buffer.concat(chunks).toString());
            } catch (_) {
              return null;
            }
          })();
          if (info && info.ok && info.listener) resolve({ ok: true, info });
          else resolve({ ok: false, reason: 'the port answered, but not as Holdfast', foreign: true });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'no reply before the timeout', foreign: true });
    });
    req.on('error', (err) => {
      // Only a refused connection or an unresolvable host proves the port is
      // free. Anything else means SOMETHING is there but not speaking our
      // protocol, and routing must refuse rather than guess.
      const free = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';
      resolve({
        ok: false,
        reason: free ? 'nothing is listening' : `unreachable (${err.code})`,
        foreign: !free,
      });
    });
  });
}

// Is *something else* sitting on this port? Distinguishes "free" from "taken by
// a stranger", which is the difference between "start Holdfast" and "move the
// port".
async function portOwner(port, expectListener) {
  const h = await health(port);
  if (h.ok) {
    return h.info.listener === expectListener
      ? { state: 'ours', info: h.info }
      : { state: 'ours-other-listener', info: h.info };
  }
  return h.foreign ? { state: 'foreign', reason: h.reason } : { state: 'free', reason: h.reason };
}

// Timestamped backup beside the original. Returns the backup path.
function backup(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const dest = `${file}.holdfast-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function sha256(text) {
  return require('crypto').createHash('sha256').update(text).digest('hex');
}

// Write `text` to `file` atomically (temp file in the same directory, then
// rename) so a crash can never leave a half-written settings file.
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.holdfast-tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Explain, in one line, why routing is refused. Kept identical across commands
// so the fix is always obvious.
function supervisionProblem(what) {
  const st = installState();
  if (!st) {
    return `Holdfast is not installed as a service, so ${what} would break whenever Holdfast isn't running.\n  Fix: holdfast install    (then re-run this command)`;
  }
  if (!fs.existsSync(st.appDir)) {
    return `the installed Holdfast path is missing (${st.appDir}).\n  Fix: holdfast install    (re-installs from this copy)`;
  }
  return null;
}

module.exports = {
  ensureHome,
  readJson,
  readState,
  writeState,
  clearState,
  installState,
  health,
  portOwner,
  backup,
  writeAtomic,
  sha256,
  supervisionProblem,
};
