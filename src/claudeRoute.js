'use strict';

// `holdfast claude enable | disable | status`
//
// Why this exists: the README used to tell people to `export
// ANTHROPIC_BEDROCK_BASE_URL=...`, which does nothing when Claude Code is
// launched by a wrapper (the export never reaches it), and pointed at a
// listener whose region came from HOLDFAST's environment rather than Claude's
// own AWS_REGION. On a real Bedrock machine that combination means requests to
// the wrong region signed with the wrong account.
//
// So routing is written where Claude Code actually reads it — the `env` block of
// ~/.claude/settings.json — and it points at a region-tagged URL
// (http://127.0.0.1:8789/region/<r>) so the proxy signs for the region Claude
// is really using, whatever Holdfast's own environment says.
//
// Fail-safety, as for Kiro: refuse unless Holdfast is supervised and the port
// answers as ours, and additionally refuse unless a SIGNED DRY RUN against
// Bedrock succeeds — otherwise we would hand Claude Code a proxy that cannot
// authenticate, and every turn would 403.

const fs = require('fs');
const https = require('https');
const config = require('./config');
const paths = require('./paths');
const jsonc = require('./jsonc');
const route = require('./route');
const credentials = require('./credentials');

const STATE = 'claude-enable.json';

function listenerNamed(name) {
  return config.listeners.find((l) => l.name === name);
}

function settingsPath() {
  return paths.claudeSettingsFile();
}

function readSettingsText() {
  try {
    return fs.readFileSync(settingsPath(), 'utf8');
  } catch (_) {
    return null;
  }
}

// Which API is Claude Code talking to here? Bedrock mode is what a wrapper
// usually injects, and an `awsCredentialExport` in the settings is a strong
// signal of it even when the env var is set elsewhere.
function detectMode() {
  const text = readSettingsText();
  const get = (p) => (text ? jsonc.getPath(text, p) : null);
  const bedrockEnv =
    process.env.CLAUDE_CODE_USE_BEDROCK === '1' || get(['env', 'CLAUDE_CODE_USE_BEDROCK']) === '"1"';
  const hasCredExport = !!(text && jsonc.getPath(text, ['awsCredentialExport']));
  const apiKey = !!process.env.ANTHROPIC_API_KEY;
  if (bedrockEnv || hasCredExport) return 'bedrock';
  if (apiKey) return 'api';
  return 'bedrock';
}

function claudeRegion() {
  return config.bedrockRegion;
}

// Did AWS reject the CALLER (bad/expired credentials, bad signature), or merely
// the ACTION (the role is authenticated but lacks this permission)? The second
// is a pass: it proves the credential chain and the signature are good, which is
// all the dry run is asking. Holdfast itself only ever needs the permissions the
// client already had — it re-signs the client's own request.
function classifyAwsRejection(status, errorType, body) {
  const text = `${errorType || ''} ${body || ''}`;
  if (/InvalidSignature|SignatureDoesNotMatch|UnrecognizedClient|InvalidClientTokenId|InvalidAccessKeyId|ExpiredToken|TokenRefreshRequired|AuthorizationHeaderMalformed/i.test(text)) {
    return { authenticated: false, reason: `AWS rejected the credentials/signature: ${text.trim().slice(0, 200)}` };
  }
  if (/AccessDenied|is not authorized to perform|no identity-based policy/i.test(text)) {
    return {
      authenticated: true,
      note: 'credentials and signature accepted by AWS; this role is not allowed bedrock:ListFoundationModels (Holdfast needs no extra permissions — it re-signs your own request)',
    };
  }
  return { authenticated: false, reason: `unexpected ${status} from AWS: ${text.trim().slice(0, 200)}` };
}

// A signed, read-only, zero-spend probe: ListFoundationModels on the Bedrock
// CONTROL plane (GET https://bedrock.<region>.amazonaws.com/foundation-models).
// It exercises exactly what a proxied turn needs — the credential chain and the
// SigV4 signer, for this region — without invoking a model, so it costs nothing.
// An IAM denial still counts as success (see classifyAwsRejection).
function dryRun(region) {
  return new Promise((resolve) => {
    const host = `bedrock.${region}.amazonaws.com`;
    let headers;
    try {
      headers = require('./sigv4').signedHeaders({
        method: 'GET',
        path: '/foundation-models',
        headers: { accept: 'application/json' },
        body: Buffer.alloc(0),
        host,
        region,
      });
    } catch (err) {
      resolve({ ok: false, reason: err.message, stage: 'credentials' });
      return;
    }
    delete headers.host;
    headers.host = host;

    const req = https.request(
      { hostname: host, port: 443, method: 'GET', path: '/foundation-models', headers, timeout: 15_000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, region });
            return;
          }
          const body = Buffer.concat(chunks).toString('utf8', 0, 400);
          const verdict = classifyAwsRejection(res.statusCode, res.headers['x-amzn-errortype'], body);
          if (verdict.authenticated) {
            resolve({ ok: true, status: res.statusCode, region, note: verdict.note });
          } else {
            resolve({ ok: false, status: res.statusCode, stage: 'aws', reason: `${res.statusCode} from ${host}: ${verdict.reason}` });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, stage: 'network', reason: `no reply from ${host} within 15s` });
    });
    req.on('error', (err) => resolve({ ok: false, stage: 'network', reason: `${err.code || err.message}` }));
    req.end();
  });
}

// The settings we write, per mode.
function plannedEnv(mode) {
  if (mode === 'api') {
    const l = listenerNamed('anthropic');
    return [['env', 'ANTHROPIC_BASE_URL', `http://127.0.0.1:${l.port}`]];
  }
  const l = listenerNamed('bedrock');
  const region = claudeRegion();
  return [
    ['env', 'ANTHROPIC_BEDROCK_BASE_URL', `http://127.0.0.1:${l.port}/region/${region}`],
    // Claude Code must stop signing: Holdfast re-signs with the credential
    // chain (including Claude's own awsCredentialExport) on every attempt.
    ['env', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', '1'],
  ];
}

async function status({ quiet = false } = {}) {
  const st = route.readState(STATE);
  const mode = detectMode();
  const text = readSettingsText();
  const planned = plannedEnv(mode);
  const listener = listenerNamed(mode === 'api' ? 'anthropic' : 'bedrock');
  const owner = await route.portOwner(listener.port, listener.name);
  const cred = credentials.describeSource();

  const values = planned.map(([a, b]) => ({
    key: `${a}.${b}`,
    value: text ? jsonc.getPath(text, [a, b]) : null,
  }));

  const out = {
    enabled: !!st,
    mode,
    region: mode === 'api' ? null : claudeRegion(),
    settingsFile: settingsPath(),
    values,
    listenerPort: listener.port,
    portState: owner.state,
    credentialSource: cred.ok ? cred.source : null,
    credentialProblem: cred.ok ? null : cred.reason,
    credentialExpiry: cred.ok ? cred.expiresAt : null,
    backup: st ? st.backup : null,
  };

  if (!quiet) {
    console.log(`\nClaude Code routing: ${out.enabled ? 'ENABLED by Holdfast' : 'not enabled by Holdfast'}`);
    console.log(`  mode              ${out.mode}${out.region ? ` (region ${out.region})` : ''}`);
    console.log(`  settings file     ${out.settingsFile}`);
    for (const v of out.values) console.log(`  ${v.key} = ${v.value === null ? '(not set)' : v.value}`);
    console.log(`  listener          :${out.listenerPort} (${out.listenerName || listener.name}) — port ${out.portState}`);
    console.log(
      `  credentials       ${out.credentialSource || `UNAVAILABLE — ${out.credentialProblem}`}` +
        (out.credentialExpiry ? `  (expires ${out.credentialExpiry})` : '')
    );
    if (out.enabled) console.log(`  backup            ${out.backup}`);
    console.log('');
  }
  return out;
}

async function enable({ force = false } = {}) {
  const mode = detectMode();
  const listener = listenerNamed(mode === 'api' ? 'anthropic' : 'bedrock');

  const problem = route.supervisionProblem('routing Claude Code through it');
  if (problem && !force) {
    console.error(`Refusing to route Claude Code: ${problem}`);
    return 1;
  }

  const owner = await route.portOwner(listener.port, listener.name);
  if (owner.state === 'foreign') {
    console.error(
      `Refusing to route Claude Code: port ${listener.port} is owned by something that is not Holdfast (${owner.reason}).\n` +
        `  Fix: move the listener (HOLDFAST_BEDROCK_PORT / HOLDFAST_PORT), re-run holdfast install, then retry.`
    );
    return 1;
  }
  if (owner.state !== 'ours') {
    console.error(
      `Refusing to route Claude Code: port ${listener.port} is not serving Holdfast's "${listener.name}" listener (${owner.reason || owner.state}).\n` +
        `  Fix: holdfast install   (or: holdfast start) and retry.`
    );
    return 1;
  }

  // Bedrock mode: prove we can sign for this region before making Claude depend
  // on us. This is the check that would have caught the wrong-account signing.
  if (mode === 'bedrock') {
    const region = claudeRegion();
    const probe = await dryRun(region);
    if (!probe.ok && !force) {
      console.error(
        `Refusing to route Claude Code: the signed Bedrock dry run failed (${probe.stage}).\n` +
          `  ${probe.reason}\n` +
          `  Nothing was changed. Diagnose with: holdfast doctor` +
          (probe.stage === 'credentials' ? '\n  (refresh your AWS credentials and retry)' : '')
      );
      return 1;
    }
    if (probe.ok) {
      const cred = credentials.describeSource();
      console.log(`Dry run OK: signed ListFoundationModels in ${region} returned ${probe.status} using ${cred.source}.`);
      if (probe.note) console.log(`  note: ${probe.note}`);
    }
  }

  const file = settingsPath();
  const before = readSettingsText();
  if (before === null) {
    console.error(
      `Refusing to route Claude Code: ${file} does not exist.\n` +
        `  Run Claude Code once (it creates the file), then retry.`
    );
    return 1;
  }
  if (jsonc.rootObjectStart(before) === -1) {
    console.error(`Refusing to route Claude Code: ${file} is not a JSON object — cannot find a safe insertion point.`);
    return 1;
  }

  const planned = plannedEnv(mode);
  let text = before;
  const undos = [];
  const priors = [];
  for (const [a, b, value] of planned) {
    const edit = jsonc.setPath(text, [a, b], JSON.stringify(value));
    text = edit.text;
    undos.push(edit.undo);
    priors.push({ path: [a, b], priorRaw: edit.priorRaw });
  }

  if (text === before) {
    console.log('Claude Code is already routed through Holdfast. Nothing changed.');
    return 0;
  }

  const backupPath = route.backup(file);
  route.writeAtomic(file, text);
  route.writeState(STATE, {
    enabledAt: new Date().toISOString(),
    file,
    backup: backupPath,
    mode,
    region: mode === 'bedrock' ? claudeRegion() : null,
    priors,
    undos,
    afterHash: route.sha256(text),
  });

  console.log(`✓ Claude Code routed through Holdfast (${mode} mode):`);
  for (const [a, b, value] of planned) console.log(`    ${a}.${b} = ${value}`);
  console.log(`  backup: ${backupPath}`);
  console.log('  Start a NEW Claude Code session to pick it up.');
  console.log('  Undo any time with: holdfast claude disable');
  return 0;
}

function disable({ quiet = false } = {}) {
  const st = route.readState(STATE);
  const file = (st && st.file) || settingsPath();
  const current = readSettingsText();
  if (current === null) {
    if (!quiet) console.log(`Nothing to revert — ${file} does not exist.`);
    route.clearState(STATE);
    return 0;
  }

  // Untouched since our edit: undo the splices in reverse order for a
  // byte-for-byte restore.
  if (st && st.undos && route.sha256(current) === st.afterHash) {
    let text = current;
    for (let i = st.undos.length - 1; i >= 0; i--) text = jsonc.applyUndo(text, st.undos[i]);
    route.writeAtomic(file, text);
    route.clearState(STATE);
    if (!quiet) {
      console.log(`✓ Claude Code routing removed — ${file} restored byte-for-byte.`);
      console.log('  Start a new Claude Code session to pick it up.');
    }
    return 0;
  }

  // Changed since: restore each key individually to its recorded prior value.
  let text = current;
  let touched = 0;
  const priors = (st && st.priors) || plannedEnv(detectMode()).map(([a, b]) => ({ path: [a, b], priorRaw: null }));
  for (const p of priors) {
    if (p.priorRaw) {
      const res = jsonc.setPath(text, p.path, p.priorRaw);
      if (res.text !== text) touched++;
      text = res.text;
    } else {
      const res = jsonc.removePath(text, p.path);
      if (res.removed) touched++;
      text = res.text;
    }
  }
  if (!touched) {
    if (!quiet) console.log(`Nothing to revert — Holdfast's keys are not present in ${file}.`);
    route.clearState(STATE);
    return 0;
  }
  const backupPath = route.backup(file);
  route.writeAtomic(file, text);
  route.clearState(STATE);
  if (!quiet) {
    console.log(`✓ Claude Code routing removed from ${file} (the file had changed since; only Holdfast's keys were touched).`);
    console.log(`  backup of the changed file: ${backupPath}`);
    console.log('  Start a new Claude Code session to pick it up.');
  }
  return 0;
}

function isEnabled() {
  return !!route.readState(STATE);
}

module.exports = { enable, disable, status, isEnabled, detectMode, dryRun, claudeRegion, STATE };
