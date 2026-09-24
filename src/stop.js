'use strict';

// Stop any running Holdfast instances. Handles two cases:
//   1. A plain `holdfast start` process  -> kill it by the port it listens on.
//   2. An installed auto-start service   -> if we only kill the PID, launchd
//      (KeepAlive) or systemd (Restart=always) respawns it. So when a service
//      is installed we tell the service manager to stop it, which sticks.
//
// `stop` does NOT uninstall the auto-start entry — it just stops the running
// process now. To stop it starting again on next login, run `holdfast uninstall`.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const config = require('./config');

const LABEL = 'com.holdfast.proxy';

function macServiceInstalled() {
  return fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`));
}
function linuxServiceInstalled() {
  return fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'holdfast.service'));
}

// Find PIDs listening on our configured port(s) via lsof (macOS/Linux).
function pidsOnPort(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out ? out.split(/\s+/).map((n) => parseInt(n, 10)).filter(Boolean) : [];
  } catch (_) {
    return []; // lsof returns non-zero when nothing matches
  }
}

function stop() {
  const platform = os.platform();
  let stoppedService = false;

  // 0. Put any tool we redirected back on its own endpoint BEFORE the port goes
  //    away. A tool left pointing at a dead localhost port is hard-down — the
  //    exact failure this program exists to prevent.
  const reverted = require('./autostart').revertRouting();
  for (const tool of reverted) {
    console.log(`✓ Reverted ${tool} routing before stopping (so ${tool} keeps working without Holdfast).`);
  }
  if (reverted.includes('kiro')) console.log('  Reload the Kiro window (Developer: Reload Window) to apply.');
  if (reverted.includes('claude')) console.log('  Start a new Claude Code session to apply.');

  // 1. If installed as a managed service, stop it through the manager so it
  //    doesn't immediately respawn.
  if (platform === 'darwin' && macServiceInstalled()) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    try {
      execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
      console.log('✓ Told launchd to stop the Holdfast service (it will not respawn until reloaded).');
      console.log('  It WILL start again on next login. To prevent that permanently: holdfast uninstall');
      stoppedService = true;
    } catch (_) {}
  }
  if (platform === 'linux' && linuxServiceInstalled()) {
    try {
      execFileSync('systemctl', ['--user', 'stop', 'holdfast.service'], { stdio: 'ignore' });
      console.log('✓ Stopped the Holdfast systemd service (it will not respawn until started).');
      console.log('  It WILL start again on next login. To prevent that permanently: holdfast uninstall');
      stoppedService = true;
    } catch (_) {}
  }

  // 2. Kill any remaining processes still holding our port(s). Covers plain
  //    `holdfast start` runs and anything the service left behind.
  const ports = [...new Set(config.listeners.map((l) => l.port))];
  let killed = 0;
  for (const port of ports) {
    for (const pid of pidsOnPort(port)) {
      try {
        process.kill(pid, 'SIGTERM');
        killed++;
      } catch (_) {}
    }
  }

  // Give SIGTERM a moment, then hard-kill anything still clinging on.
  if (killed) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) { /* brief spin so SIGTERM can land */ }
    for (const port of ports) {
      for (const pid of pidsOnPort(port)) {
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      }
    }
  }

  // 3. Report.
  const stillUp = ports.flatMap(pidsOnPort);
  if (stillUp.length === 0) {
    if (killed || stoppedService) console.log(`✓ Holdfast stopped. Port(s) ${ports.join(', ')} are now free.`);
    else console.log(`Nothing to stop — no Holdfast was running on port(s) ${ports.join(', ')}.`);
  } else {
    console.log(`⚠ Some process is still on port(s) ${ports.join(', ')} (pid ${stillUp.join(', ')}).`);
    console.log(`  Force it: kill -9 ${stillUp.join(' ')}`);
    if (platform === 'win32') console.log('  On Windows: netstat -ano | findstr :8787   then  taskkill /PID <pid> /F');
  }
}

module.exports = { stop };
