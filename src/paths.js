'use strict';

// Where things live on disk, per platform. Kept in one place so every command
// (install, kiro, claude, doctor) agrees, and so tests can redirect Holdfast's
// own state with HOLDFAST_HOME without touching the real home directory.

const os = require('os');
const path = require('path');

// Holdfast's own state directory (log, stats, install + routing state).
function holdfastHome() {
  return process.env.HOLDFAST_HOME || path.join(os.homedir(), '.holdfast');
}

function stateFile(name) {
  return path.join(holdfastHome(), name);
}

// Where `holdfast install` copies the package to. A stable path, deliberately
// NOT the npx cache (which is ephemeral — a purge would leave launchd
// crash-looping and every routed tool without a proxy).
function appRoot() {
  return path.join(holdfastHome(), 'app');
}

function appDir(version) {
  return path.join(appRoot(), version);
}

// --- Kiro ------------------------------------------------------------------
// User (global) settings + the agent's profile file, which carries the ARN we
// read the KRS region from.
function kiroUserDir() {
  if (process.env.HOLDFAST_KIRO_USER_DIR) return process.env.HOLDFAST_KIRO_USER_DIR;
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Kiro', 'User');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro', 'User');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Kiro', 'User');
  }
}

function kiroSettingsFile() {
  return path.join(kiroUserDir(), 'settings.json');
}

function kiroProfileFile() {
  return path.join(kiroUserDir(), 'globalStorage', 'kiro.kiroagent', 'profile.json');
}

// --- Claude Code -----------------------------------------------------------
function claudeSettingsFile() {
  return (
    process.env.HOLDFAST_CLAUDE_SETTINGS ||
    path.join(os.homedir(), '.claude', 'settings.json')
  );
}

module.exports = {
  holdfastHome,
  stateFile,
  appRoot,
  appDir,
  kiroUserDir,
  kiroSettingsFile,
  kiroProfileFile,
  claudeSettingsFile,
};
