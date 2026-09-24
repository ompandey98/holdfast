'use strict';

// Auto-start Holdfast on login, from a STABLE path, with the options you chose.
//
// The old version pointed launchd straight at wherever the CLI happened to be
// running from. Run via `npx`, that is the npx cache — an ephemeral directory.
// After a cache purge the service file referenced a path that no longer existed,
// so launchd (KeepAlive) crash-looped and every tool routed through Holdfast
// lost its proxy. That is the opposite of what this program is for.
//
// So `install` now:
//   1. copies the package into ~/.holdfast/app/<version>/ (atomically), and
//      points the service at THAT;
//   2. bakes the effective options into the service's own environment, so
//      `holdfast install --minutes 999` really keeps holding for 999 minutes;
//   3. adds a restart throttle so a broken build backs off instead of hot-looping;
//   4. records what it did in ~/.holdfast/install.json, which is also the proof
//      of supervision that `kiro enable` / `claude enable` require.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');
const paths = require('./paths');
const route = require('./route');

const LABEL = 'com.holdfast.proxy';
const pkg = require('../package.json');

// Everything needed to run; deliberately not the tests, docs sources or git.
const PAYLOAD = ['package.json', 'bin', 'src', 'README.md', 'LICENSE', 'NOTICE'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
    return;
  }
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, stat.mode);
}

function removeRecursive(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {}
}

// Copy the running package to ~/.holdfast/app/<version>/ via a temp directory,
// then swap it in with a rename so the destination is never half-written.
function installApp() {
  const projectRoot = path.join(__dirname, '..');
  const dest = paths.appDir(pkg.version);
  const staging = `${dest}.staging-${process.pid}`;

  fs.mkdirSync(paths.appRoot(), { recursive: true });
  removeRecursive(staging);
  fs.mkdirSync(staging, { recursive: true });
  for (const item of PAYLOAD) {
    const from = path.join(projectRoot, item);
    if (fs.existsSync(from)) copyRecursive(from, path.join(staging, item));
  }

  // If we are already running FROM the destination, leave it in place.
  if (path.resolve(projectRoot) === path.resolve(dest)) {
    removeRecursive(staging);
    return dest;
  }
  const retired = `${dest}.old-${Date.now()}`;
  if (fs.existsSync(dest)) fs.renameSync(dest, retired);
  fs.renameSync(staging, dest);
  removeRecursive(retired);
  return dest;
}

// The options the service should run with: the effective config of THIS
// invocation (so CLI flags stick), plus any explicit HOLDFAST_* overrides and a
// PATH — launchd's default PATH is minimal and credential helpers live in
// places like ~/.toolbox/bin.
function serviceEnvironment() {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOLDFAST_HOLD_MINUTES: String(config.holdMinutes),
    HOLDFAST_RETRY_INTERVAL_MS: String(config.retryIntervalMs),
    HOLDFAST_HEARTBEAT_MS: String(config.heartbeatMs),
  };
  for (const l of config.listeners) {
    const portVar = {
      anthropic: 'HOLDFAST_PORT',
      openai: 'HOLDFAST_OPENAI_PORT',
      bedrock: 'HOLDFAST_BEDROCK_PORT',
      kiro: 'HOLDFAST_KIRO_PORT',
    }[l.name];
    if (portVar) env[portVar] = String(l.port);
    if (l.name === 'bedrock' && l.region) env.HOLDFAST_BEDROCK_REGION = l.region;
    if (l.name === 'kiro' && l.region) env.HOLDFAST_KIRO_REGION = l.region;
  }
  // Carry through anything else the user set explicitly (upstreams, profiles,
  // log location, HOLDFAST_HOME, listener JSON, …).
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HOLDFAST_') && v != null && !(k in env)) env[k] = String(v);
  }
  return env;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// HOLDFAST_SERVICE_FILE redirects the service definition (used by the tests so
// they never write into the real LaunchAgents / systemd directories).
function macPlistPath() {
  return (
    process.env.HOLDFAST_SERVICE_FILE ||
    path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
  );
}

function plistFor(appDir, env) {
  const nodePath = process.execPath;
  const binPath = path.join(appDir, 'bin', 'holdfast');
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(binPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(path.join(paths.holdfastHome(), 'stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(paths.holdfastHome(), 'stderr.log'))}</string>
</dict>
</plist>
`;
}

function systemdPath() {
  return (
    process.env.HOLDFAST_SERVICE_FILE ||
    path.join(os.homedir(), '.config', 'systemd', 'user', 'holdfast.service')
  );
}

function unitFor(appDir, env) {
  const nodePath = process.execPath;
  const binPath = path.join(appDir, 'bin', 'holdfast');
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n');
  return `[Unit]
Description=Holdfast resilient AI-API proxy
After=network.target

[Service]
ExecStart=${nodePath} ${binPath} start
${envLines}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function recordInstall(extra) {
  route.writeState('install.json', Object.assign({
    version: pkg.version,
    installedAt: new Date().toISOString(),
    node: process.execPath,
  }, extra));
}

// Tests (and dry runs) set this to generate the service files without handing
// them to launchd/systemd.
function activationDisabled() {
  return process.env.HOLDFAST_INSTALL_NO_ACTIVATE === '1';
}

function installMac() {
  const appDir = installApp();
  const env = serviceEnvironment();
  const p = macPlistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(paths.holdfastHome(), { recursive: true });
  fs.writeFileSync(p, plistFor(appDir, env));

  if (!activationDisabled()) {
    try { execFileSync('launchctl', ['unload', p], { stdio: 'ignore' }); } catch (_) {}
    execFileSync('launchctl', ['load', p]);
  }
  recordInstall({ appDir, service: p, manager: 'launchd', env });

  console.log(`✓ Installed from a stable path: ${appDir}`);
  console.log(`✓ launchd agent: ${p}`);
  console.log(`  Options baked in: hold ${env.HOLDFAST_HOLD_MINUTES} min, ports ${config.listeners.map((l) => l.name + ':' + l.port).join(', ')}`);
  if (activationDisabled()) console.log('  (not loaded: HOLDFAST_INSTALL_NO_ACTIVATE=1)');
  else console.log('  Holdfast now starts on every login and is restarted if it ever exits.');
  console.log('  Verify with: holdfast status');
  return 0;
}

function uninstallMac() {
  const p = macPlistPath();
  if (!activationDisabled()) {
    try { execFileSync('launchctl', ['unload', p], { stdio: 'ignore' }); } catch (_) {}
  }
  if (fs.existsSync(p)) fs.unlinkSync(p);
  console.log(`✓ Removed launchd agent: ${p}`);
  return p;
}

function installLinux() {
  const appDir = installApp();
  const env = serviceEnvironment();
  const p = systemdPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(paths.holdfastHome(), { recursive: true });
  fs.writeFileSync(p, unitFor(appDir, env));

  let activated = false;
  if (!activationDisabled()) {
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', 'holdfast.service']);
      activated = true;
    } catch (err) {
      console.log(`Wrote unit file ${p}, but could not enable it automatically: ${err.message}`);
      console.log('  Enable manually: systemctl --user enable --now holdfast.service');
    }
  }
  recordInstall({ appDir, service: p, manager: 'systemd', env });

  console.log(`✓ Installed from a stable path: ${appDir}`);
  console.log(`✓ systemd user unit: ${p}${activated ? ' (enabled and started)' : ''}`);
  console.log(`  Options baked in: hold ${env.HOLDFAST_HOLD_MINUTES} min, ports ${config.listeners.map((l) => l.name + ':' + l.port).join(', ')}`);
  console.log('  Tip: run `loginctl enable-linger $USER` so it runs even when logged out.');
  return 0;
}

function uninstallLinux() {
  const p = systemdPath();
  if (!activationDisabled()) {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'holdfast.service']); } catch (_) {}
  }
  if (fs.existsSync(p)) fs.unlinkSync(p);
  console.log(`✓ Removed systemd user service: ${p}`);
  return p;
}

function windowsInstructions() {
  const appDir = installApp();
  const binPath = path.join(appDir, 'bin', 'holdfast');
  recordInstall({ appDir, service: null, manager: 'manual', env: serviceEnvironment() });
  console.log(`
✓ Installed from a stable path: ${appDir}

Windows auto-start (Task Scheduler):

1. Open Task Scheduler → Create Task…
2. General: name "Holdfast", check "Run only when user is logged on".
3. Triggers: New… → Begin the task: "At log on".
4. Actions: New… → Program/script:
     ${process.execPath}
   Add arguments:
     "${binPath}" start
5. OK. Holdfast now starts at every login.

Or run it manually anytime with:  node "${binPath}" start
`);
  return 0;
}

function install() {
  const platform = os.platform();
  if (platform === 'darwin') return installMac();
  if (platform === 'linux') return installLinux();
  if (platform === 'win32') return windowsInstructions();
  console.log(`Auto-start not scripted for platform "${platform}". Run \`holdfast start\` manually or add it to your startup.`);
  return 0;
}

// Uninstalling removes the reason a routed tool can rely on us, so tool routing
// is reverted FIRST — never leave Kiro or Claude Code pointing at a dead port.
function uninstall() {
  const reverted = revertRouting();
  const platform = os.platform();
  if (platform === 'darwin') uninstallMac();
  else if (platform === 'linux') uninstallLinux();
  else console.log('Nothing to unload on this platform (auto-start was manual).');

  const st = route.installState();
  route.clearState('install.json');
  if (st && st.appDir && fs.existsSync(st.appDir) && path.resolve(st.appDir) !== path.resolve(path.join(__dirname, '..'))) {
    removeRecursive(st.appDir);
    console.log(`✓ Removed installed copy: ${st.appDir}`);
  }
  if (reverted.length) console.log(`  Reverted routing for: ${reverted.join(', ')}. Reload Kiro / restart Claude Code.`);
  return 0;
}

// Shared with `stop`: put any tool we redirected back on its own endpoint.
function revertRouting() {
  const reverted = [];
  try {
    const kiro = require('./kiroRoute');
    if (kiro.isEnabled()) {
      kiro.disable({ quiet: true });
      reverted.push('kiro');
    }
  } catch (_) {}
  try {
    const claude = require('./claudeRoute');
    if (claude.isEnabled()) {
      claude.disable({ quiet: true });
      reverted.push('claude');
    }
  } catch (_) {}
  return reverted;
}

module.exports = {
  install,
  uninstall,
  revertRouting,
  installApp,
  serviceEnvironment,
  macPlistPath,
  systemdPath,
  plistFor,
  unitFor,
};
