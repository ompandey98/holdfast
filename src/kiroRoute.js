'use strict';

// `holdfast kiro enable | disable | status`
//
// Kiro's agent chat does not go through Bedrock or the Anthropic API: it streams
// to the Kiro Runtime Service at https://runtime.<region>.kiro.dev with an SSO
// bearer token. The one supported way to redirect it is Kiro's own setting,
// "codewhisperer.config.krsEndpoints", in the USER settings.json.
//
// Three properties of that setting drive everything here:
//   • it is read when the extension loads, so a window reload is required;
//   • it is honoured only for the region Kiro resolved from its profile ARN —
//     a listener on the wrong region is silently ignored;
//   • it is read from the user/global settings only, and only in a trusted
//     workspace.
//
// And one consequence: once Kiro points at localhost, Kiro chat is hard-down
// whenever Holdfast isn't listening. That is why enable refuses unless Holdfast
// is supervised (launchd/systemd) and the port answers as ours, and why stop /
// uninstall revert this first.

const fs = require('fs');
const config = require('./config');
const paths = require('./paths');
const jsonc = require('./jsonc');
const route = require('./route');

const KEY = 'codewhisperer.config.krsEndpoints';
const STATE = 'kiro-enable.json';

function kiroListener() {
  return config.listeners.find((l) => l.kiro) || config.listeners.find((l) => l.name === 'kiro');
}

// The region Kiro itself resolved, from its profile ARN.
function profileRegion() {
  const file = paths.kiroProfileFile();
  try {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = /^arn:[^:]*:codewhisperer:([a-z0-9-]+):/.exec(String(profile.arn || ''));
    if (m) return { region: m[1], source: file, supported: config.krsRegions.has(m[1]) };
    return { region: null, source: file, reason: 'no codewhisperer ARN in profile.json' };
  } catch (_) {
    return { region: null, source: file, reason: 'no profile.json (Kiro not signed in on this machine?)' };
  }
}

function endpointValue(region, port) {
  return [{ region, endpoint: `http://127.0.0.1:${port}` }];
}

function currentSetting() {
  const file = paths.kiroSettingsFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { file, exists: false, raw: null };
  }
  return { file, exists: true, raw: jsonc.getPath(text, [KEY]), text };
}

async function status({ quiet = false } = {}) {
  const listener = kiroListener();
  const st = route.readState(STATE);
  const setting = currentSetting();
  const prof = profileRegion();
  const owner = listener ? await route.portOwner(listener.port, 'kiro') : { state: 'free' };

  const out = {
    enabled: !!st,
    key: KEY,
    settingsFile: setting.file,
    settingValue: setting.raw,
    listenerPort: listener ? listener.port : null,
    listenerRegion: listener ? listener.region : null,
    profileRegion: prof.region,
    profileRegionSupported: prof.supported === true,
    profileProblem: prof.reason || null,
    portState: owner.state,
    regionsMatch: !!(listener && prof.region && listener.region === prof.region),
    backup: st ? st.backup : null,
  };

  if (!quiet) {
    console.log(`\nKiro routing: ${out.enabled ? 'ENABLED by Holdfast' : 'not enabled by Holdfast'}`);
    console.log(`  settings file     ${out.settingsFile}`);
    console.log(`  ${KEY} = ${out.settingValue === null ? '(not set)' : out.settingValue}`);
    console.log(`  Kiro profile region  ${out.profileRegion || `unknown — ${out.profileProblem}`}`);
    console.log(`  Holdfast kiro listener  :${out.listenerPort} (region ${out.listenerRegion}) — port ${out.portState}`);
    if (out.profileRegion && !out.regionsMatch) {
      console.log(
        `  ⚠ region mismatch: Kiro honours krsEndpoints only for its profile region (${out.profileRegion}).\n` +
          `    Fix: HOLDFAST_KIRO_REGION=${out.profileRegion} holdfast install`
      );
    }
    if (out.enabled) console.log(`  backup            ${out.backup}`);
    console.log('');
  }
  return out;
}

async function enable({ force = false } = {}) {
  const listener = kiroListener();
  if (!listener) {
    console.error('No Kiro listener is configured (HOLDFAST_LISTENERS overrides it?).');
    return 1;
  }

  // 1. Fail-safety: supervised install required.
  const problem = route.supervisionProblem('routing Kiro through it');
  if (problem && !force) {
    console.error(`Refusing to route Kiro: ${problem}`);
    return 1;
  }

  // 2. Fail-safety: the port must answer as OUR kiro listener.
  const owner = await route.portOwner(listener.port, 'kiro');
  if (owner.state === 'foreign') {
    console.error(
      `Refusing to route Kiro: port ${listener.port} is owned by something that is not Holdfast (${owner.reason}).\n` +
        `  Another local tool using this port would receive Kiro's chat traffic, and Kiro would talk to it.\n` +
        `  Fix: pick a free port, e.g.  HOLDFAST_KIRO_PORT=18790 holdfast install  then re-run this command.`
    );
    return 1;
  }
  if (owner.state === 'free') {
    console.error(
      `Refusing to route Kiro: nothing is listening on port ${listener.port} (${owner.reason}).\n` +
        `  Fix: holdfast install   (or: holdfast start) and re-run this command.`
    );
    return 1;
  }
  if (owner.state === 'ours-other-listener') {
    console.error(
      `Refusing to route Kiro: port ${listener.port} is Holdfast, but its "${owner.info.listener}" listener, not "kiro".\n` +
        `  Fix: set HOLDFAST_KIRO_PORT to a port the kiro listener owns.`
    );
    return 1;
  }

  // 3. Region: Kiro only honours the override for its own profile region.
  const prof = profileRegion();
  if (prof.region && prof.region !== listener.region) {
    console.error(
      `Refusing to route Kiro: Kiro's profile region is ${prof.region} but the Holdfast kiro listener is ${listener.region}.\n` +
        `  Kiro ignores krsEndpoints for any other region, so this would look like it worked and change nothing.\n` +
        `  Fix: HOLDFAST_KIRO_REGION=${prof.region} holdfast install   then re-run this command.`
    );
    return 1;
  }
  const region = prof.region || listener.region;
  if (!prof.region) {
    console.log(
      `Note: could not read Kiro's profile region (${prof.reason}). Using ${region}.\n` +
        `      If Kiro chat does not route after a reload, check the ARN region in ${prof.source}.`
    );
  }

  // 4. Edit the settings file — JSONC-safe, backed up, with an exact inverse.
  const file = paths.kiroSettingsFile();
  if (!fs.existsSync(file)) {
    console.error(
      `Refusing to route Kiro: ${file} does not exist.\n` +
        `  Open Kiro's user settings once (it creates the file), then re-run this command.`
    );
    return 1;
  }
  const before = fs.readFileSync(file, 'utf8');
  if (jsonc.rootObjectStart(before) === -1) {
    console.error(`Refusing to route Kiro: ${file} is not a JSON object — cannot find a safe insertion point.`);
    return 1;
  }

  const value = JSON.stringify(endpointValue(region, listener.port));
  let edit;
  try {
    edit = jsonc.setPath(before, [KEY], value);
  } catch (err) {
    console.error(`Refusing to route Kiro: ${err.message}`);
    return 1;
  }

  // Idempotent: nothing to do if it already says exactly this.
  if (edit.text === before) {
    console.log(`Kiro is already routed to http://127.0.0.1:${listener.port} (region ${region}). Nothing changed.`);
    if (!route.readState(STATE)) {
      route.writeState(STATE, {
        enabledAt: new Date().toISOString(),
        file,
        backup: null,
        region,
        port: listener.port,
        priorRaw: edit.priorRaw,
        undo: edit.undo,
        afterHash: route.sha256(before),
      });
    }
    return 0;
  }

  const backupPath = route.backup(file);
  route.writeAtomic(file, edit.text);
  route.writeState(STATE, {
    enabledAt: new Date().toISOString(),
    file,
    backup: backupPath,
    region,
    port: listener.port,
    priorRaw: edit.priorRaw,
    undo: edit.undo,
    afterHash: route.sha256(edit.text),
  });

  console.log(`✓ Kiro routed through Holdfast: ${KEY} = ${value}`);
  console.log(`  backup: ${backupPath}`);
  console.log('  Reload Kiro window (Developer: Reload Window) to apply.');
  console.log('  Undo any time with: holdfast kiro disable');
  return 0;
}

function disable({ quiet = false } = {}) {
  const st = route.readState(STATE);
  const file = (st && st.file) || paths.kiroSettingsFile();
  if (!fs.existsSync(file)) {
    if (!quiet) console.log(`Nothing to revert — ${file} does not exist.`);
    route.clearState(STATE);
    return 0;
  }
  const current = fs.readFileSync(file, 'utf8');

  // Untouched since we edited it? Then put the original bytes back exactly.
  if (st && st.undo && route.sha256(current) === st.afterHash) {
    route.writeAtomic(file, jsonc.applyUndo(current, st.undo));
    route.clearState(STATE);
    if (!quiet) {
      console.log(`✓ Kiro routing removed — ${file} restored byte-for-byte.`);
      console.log('  Reload Kiro window (Developer: Reload Window) to apply.');
    }
    return 0;
  }

  // Edited since (by the user or by Kiro). Fall back to a structural edit that
  // touches only our key.
  let next;
  if (st && st.priorRaw) {
    next = jsonc.setPath(current, [KEY], st.priorRaw).text;
  } else {
    const removed = jsonc.removePath(current, [KEY]);
    if (!removed.removed) {
      if (!quiet) console.log(`Nothing to revert — ${KEY} is not set in ${file}.`);
      route.clearState(STATE);
      return 0;
    }
    next = removed.text;
  }
  const backupPath = route.backup(file);
  route.writeAtomic(file, next);
  route.clearState(STATE);
  if (!quiet) {
    console.log(`✓ Kiro routing removed from ${file} (the file had changed since; only ${KEY} was touched).`);
    console.log(`  backup of the changed file: ${backupPath}`);
    console.log('  Reload Kiro window (Developer: Reload Window) to apply.');
  }
  return 0;
}

function isEnabled() {
  return !!route.readState(STATE);
}

module.exports = { enable, disable, status, isEnabled, profileRegion, KEY, STATE };
