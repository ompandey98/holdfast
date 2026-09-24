'use strict';

// AWS credential resolution for the SigV4 listener.
//
// The original signer read only environment variables and
// ~/.aws/credentials [default|AWS_PROFILE]. On a real Amazon laptop that is
// usually the WRONG account: Claude Code in Bedrock mode gets its credentials
// from a command (`awsCredentialExport` in ~/.claude/settings.json), and many
// profiles are `credential_process`-backed. Signing with [default] there yields
// a 403 that looks like a Holdfast bug.
//
// So credentials come from a chain, in this order:
//   1. HOLDFAST_AWS_CREDENTIAL_COMMAND          (explicit override)
//   2. ~/.claude/settings.json awsCredentialExport   (unless HOLDFAST_USE_CLAUDE_CREDS=0)
//   3. environment variables
//   4. ~/.aws/config  [profile X] credential_process  (X = HOLDFAST_AWS_PROFILE / AWS_PROFILE)
//   5. ~/.aws/credentials [X]
//
// Two shapes are accepted from a command: the nested
// {"Credentials":{AccessKeyId,SecretAccessKey,SessionToken,Expiration}} form
// and the flat credential_process form {Version:1,AccessKeyId,...}.
//
// Results are cached in memory until 5 minutes before expiry (10 minutes when
// no expiry is given), so a replay after a long hold re-resolves automatically
// instead of re-signing with dead credentials. Commands run through execFile
// (never a shell) with a timeout, and their output is NEVER logged or persisted.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const COMMAND_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 750;
const EXPIRY_SAFETY_MS = 5 * 60_000;
const NO_EXPIRY_TTL_MS = 10 * 60_000;

class CredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialError';
    this.code = 'NO_AWS_CREDENTIALS';
    this.isCredentialError = true;
  }
}

// Split a command string into argv without a shell. Honours single/double
// quotes so a quoted path like "/Users/x/.toolbox/bin/claude" arg stays intact.
function tokenize(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(command)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out.filter((t) => t.length > 0 || false);
}

// Accept both credential shapes. Returns null if the payload isn't credentials.
function parseCredentialJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const c = data && typeof data === 'object' && data.Credentials ? data.Credentials : data;
  if (!c || !c.AccessKeyId || !c.SecretAccessKey) return null;
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken || c.SessionToken === '' ? c.SessionToken : null,
    expiresAt: c.Expiration ? Date.parse(c.Expiration) || null : null,
  };
}

// Run a credential command ONCE. Throws CredentialError with a reason that
// never includes the command's output (it contains secrets).
function runCommandOnce(command, label) {
  const argv = tokenize(command);
  if (!argv.length) throw new CredentialError(`${label} is empty`);
  let stdout;
  try {
    stdout = execFileSync(argv[0], argv.slice(1), {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    const why = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM'
      ? `timed out after ${COMMAND_TIMEOUT_MS / 1000}s`
      : err.status != null
        ? `exited ${err.status}`
        : err.code === 'ENOENT'
          ? `command not found: ${argv[0]}`
          : 'could not be run';
    throw new CredentialError(`${label} ${why}`);
  }
  const creds = parseCredentialJson(stdout);
  if (!creds) throw new CredentialError(`${label} did not print recognisable credential JSON`);
  return creds;
}

// Real credential helpers are flaky: the Amazon toolbox helper on this machine
// exits 1 on roughly one call in three and succeeds on the next. One retry
// turns that into a non-event; without it the chain silently falls through to
// whatever static keys exist, which is usually a DIFFERENT account and produces
// a 403 that looks like a Holdfast bug.
function runCommand(command, label, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return runCommandOnce(command, label);
    } catch (err) {
      lastError = err;
      if (i + 1 < attempts) sleepSync(RETRY_DELAY_MS);
    }
  }
  lastError.message = `${lastError.message} (after ${attempts} attempts)`;
  throw lastError;
}

// A brief synchronous pause between attempts. Signing happens inside the
// request path, synchronously, so this cannot be a promise: Atomics.wait blocks
// the thread for exactly the interval without spinning the CPU.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* last-resort fallback */ }
  }
}

// Minimal INI parser, enough for ~/.aws/credentials and ~/.aws/config.
function parseIni(text) {
  const out = {};
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[\s*(.+?)\s*\]$/);
    if (sec) {
      section = sec[1].replace(/^profile\s+/, '');
      out[section] = out[section] || {};
      continue;
    }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && section) out[section][kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return out;
}

function readIniFile(file) {
  try {
    return parseIni(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

function claudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(require('./paths').claudeSettingsFile(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function profileName() {
  return process.env.HOLDFAST_AWS_PROFILE || process.env.AWS_PROFILE || 'default';
}

function awsFile(kind) {
  if (kind === 'credentials') {
    return (
      process.env.AWS_SHARED_CREDENTIALS_FILE ||
      path.join(os.homedir(), '.aws', 'credentials')
    );
  }
  return process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
}

// The chain. Each link returns credentials + a source label, or null to fall
// through. Only a link that is CONFIGURED but BROKEN throws.
function resolveUncached() {
  const problems = [];

  // 1. Explicit override.
  if (process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND) {
    const c = runCommand(process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND, 'HOLDFAST_AWS_CREDENTIAL_COMMAND');
    return Object.assign(c, { source: 'HOLDFAST_AWS_CREDENTIAL_COMMAND' });
  }

  // 2. Claude Code's own credential command — the one that actually works on a
  //    wrapper-launched Bedrock setup.
  if (process.env.HOLDFAST_USE_CLAUDE_CREDS !== '0') {
    const settings = claudeSettings();
    const cmd = settings && settings.awsCredentialExport;
    if (cmd) {
      try {
        const c = runCommand(cmd, 'awsCredentialExport (~/.claude/settings.json)');
        return Object.assign(c, { source: 'claude awsCredentialExport', problems });
      } catch (err) {
        problems.push(err.message);
      }
    }
  }

  // 3. Environment variables.
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN || null,
      expiresAt: null,
      source: 'environment',
      problems,
    };
  }

  // 4. credential_process for the selected profile.
  const profile = profileName();
  const cfg = readIniFile(awsFile('config'))[profile];
  if (cfg && cfg.credential_process) {
    try {
      const c = runCommand(cfg.credential_process, `credential_process [${profile}]`);
      return Object.assign(c, { source: `credential_process [${profile}]`, problems });
    } catch (err) {
      problems.push(err.message);
    }
  }

  // 5. Static keys in the shared credentials file.
  const shared = readIniFile(awsFile('credentials'))[profile];
  if (shared && shared.aws_access_key_id && shared.aws_secret_access_key) {
    return {
      accessKeyId: shared.aws_access_key_id,
      secretAccessKey: shared.aws_secret_access_key,
      sessionToken: shared.aws_session_token || shared.aws_security_token || null,
      expiresAt: null,
      source: `~/.aws/credentials [${profile}]`,
      problems,
    };
  }

  const detail = problems.length
    ? problems.join('; ')
    : `nothing configured (checked HOLDFAST_AWS_CREDENTIAL_COMMAND, ~/.claude/settings.json awsCredentialExport, environment, credential_process [${profile}], ~/.aws/credentials [${profile}])`;
  throw new CredentialError(detail);
}

// Falling back to a lower-priority credential source is reported once per
// process. Silence here is how "it used to work" turns into unexplained 403s:
// the preferred source (usually Claude Code's own credential command) failed,
// and static keys for another account signed the request instead.
const warned = new Set();

function warnOnce(creds) {
  const key = `${creds.source}|${creds.problems.join('|')}`;
  if (warned.has(key)) return;
  warned.add(key);
  try {
    require('./log').warn(
      `credentials: using ${creds.source} because an earlier source failed — ${creds.problems.join('; ')}`
    );
  } catch (_) {}
}

let cache = null; // { creds, goodUntil }

function cacheKey() {
  // Anything that changes which link of the chain wins invalidates the cache.
  return [
    process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND || '',
    process.env.HOLDFAST_USE_CLAUDE_CREDS || '',
    process.env.AWS_ACCESS_KEY_ID || '',
    profileName(),
  ].join('|');
}

// Resolve credentials, using the in-memory cache unless it is near expiry.
// Throws CredentialError when the chain cannot produce anything.
function resolve(opts = {}) {
  const key = cacheKey();
  const now = Date.now();
  if (!opts.force && cache && cache.key === key && cache.goodUntil > now) {
    return cache.creds;
  }
  const creds = resolveUncached();
  if (creds.problems && creds.problems.length) warnOnce(creds);
  const goodUntil = creds.expiresAt
    ? creds.expiresAt - EXPIRY_SAFETY_MS
    : now + NO_EXPIRY_TTL_MS;
  cache = { key, creds, goodUntil };
  return creds;
}

// Source label only — never the key material. For `doctor` / `status`.
function describeSource() {
  try {
    const c = resolve();
    return {
      ok: true,
      source: c.source,
      expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
      // A source EARLIER in the chain that was configured but failed. Reported,
      // never swallowed: silently falling back to stale static keys is how a
      // working setup starts returning 403s with no explanation.
      skipped: (c.problems || []).slice(),
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function clearCache() {
  cache = null;
}

module.exports = { resolve, describeSource, clearCache, CredentialError, tokenize, parseCredentialJson };
