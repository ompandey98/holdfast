'use strict';

// Tests for the managed routing commands — the ones that touch a user's editor
// configuration, where a mistake is expensive:
//
//   A) `kiro enable` edits JSONC surgically: comments, trailing commas and
//      formatting survive, only the one key changes, and `disable` restores the
//      file BYTE-FOR-BYTE.
//   B) `kiro enable` refuses when the port is owned by something that is not
//      Holdfast (otherwise Kiro would be pointed at a stranger's server).
//   C) `stop` reverts tool routing BEFORE freeing the port, so a tool is never
//      left pointing at a dead localhost port.
//   D) `install` writes a service definition that references the stable
//      ~/.holdfast/app/<version> path — never the ephemeral npx cache — and
//      bakes in the chosen hold window.
//   E) The Kiro listener answers non-Kiro traffic locally (404) instead of
//      forwarding a neighbouring dev server's request to kiro.dev.
//
// Everything runs against temp directories and mock upstreams: no network, and
// the real ~/.claude, ~/Library and ~/.holdfast are never touched.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'holdfast-routing-'));

const KIRO_PORT = 9271;
const UPSTREAM_PORT = 9272;

// --- sandbox ---------------------------------------------------------------

const KIRO_USER_DIR = path.join(sandbox, 'KiroUser');
const KIRO_SETTINGS = path.join(KIRO_USER_DIR, 'settings.json');
const PROFILE_DIR = path.join(KIRO_USER_DIR, 'globalStorage', 'kiro.kiroagent');

// A realistic JSONC settings file: line comment, block comment, a nested
// object, a trailing comma, tabs nowhere, and no final newline surprises.
const ORIGINAL_SETTINGS = `{
  // Kiro settings — hand-written, comments must survive
  "editor.fontSize": 13,
  /* the agent's own block */
  "kiroAgent.configureMCP": "Enabled",
  "files.exclude": { "**/.git": true },
  "workbench.colorTheme": "Kiro Dark",
}
`;

function resetSandbox({ region = 'us-east-1', settings = ORIGINAL_SETTINGS } = {}) {
  fs.rmSync(KIRO_USER_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(KIRO_SETTINGS, settings);
  fs.writeFileSync(
    path.join(PROFILE_DIR, 'profile.json'),
    JSON.stringify({ arn: `arn:aws:codewhisperer:${region}:111122223333:profile/TESTPROFILE`, name: 'Test' })
  );
  const home = path.join(sandbox, 'holdfast-home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function baseEnv(home) {
  process.env.HOLDFAST_HOME = home;
  process.env.HOLDFAST_KIRO_USER_DIR = KIRO_USER_DIR;
  process.env.HOLDFAST_CLAUDE_SETTINGS = path.join(sandbox, 'claude-settings.json');
  process.env.HOLDFAST_SERVICE_FILE = path.join(sandbox, 'service-definition');
  process.env.HOLDFAST_INSTALL_NO_ACTIVATE = '1';
  process.env.HOLDFAST_LOG_CONSOLE = '0';
  process.env.HOLDFAST_LISTENERS = JSON.stringify([
    { name: 'kiro', port: KIRO_PORT, upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, kiro: true, region: 'us-east-1' },
  ]);
}

// Reload src/* so the new environment is picked up (config is read at require).
function fresh(mod) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
  return require(path.join(SRC, mod));
}

// Pretend Holdfast is installed as a service, which routing requires.
function markInstalled(home, appDir) {
  const dir = appDir || path.join(home, 'app', '1.1.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'install.json'),
    JSON.stringify({ version: '1.1.0', manager: 'launchd', appDir: dir, env: { HOLDFAST_HOLD_MINUTES: '180' } })
  );
  return dir;
}

function listen(port, handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(port, '127.0.0.1', () => resolve(s));
  });
}

function close(server) {
  return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

function post(port, p, headers = {}, body = '{}') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

// --- A: JSONC-safe edit, byte-identical revert ------------------------------

async function testJsoncEditAndRevert() {
  const home = resetSandbox();
  baseEnv(home);
  markInstalled(home);
  const servers = fresh('server').start();
  const kiroRoute = require(path.join(SRC, 'kiroRoute'));

  const code = await kiroRoute.enable();
  assert.strictEqual(code, 0, 'enable should succeed when supervised and the port is ours');

  const after = fs.readFileSync(KIRO_SETTINGS, 'utf8');
  assert(after.includes('// Kiro settings — hand-written, comments must survive'), 'line comment must survive');
  assert(after.includes("/* the agent's own block */"), 'block comment must survive');
  assert(after.includes('"workbench.colorTheme": "Kiro Dark",\n}'), 'trailing comma must survive');
  assert(
    after.includes(`"codewhisperer.config.krsEndpoints": [{"region":"us-east-1","endpoint":"http://127.0.0.1:${KIRO_PORT}"}]`),
    `the endpoint must be written, got:\n${after}`
  );

  // Exactly one key added, nothing else changed.
  const addedLines = after.split('\n').filter((l) => !ORIGINAL_SETTINGS.split('\n').includes(l));
  assert.strictEqual(addedLines.length, 1, `only one line should differ, got: ${JSON.stringify(addedLines)}`);

  // A backup was taken.
  const backups = fs.readdirSync(KIRO_USER_DIR).filter((f) => f.includes('holdfast-backup'));
  assert.strictEqual(backups.length, 1, 'enable must leave exactly one timestamped backup');
  assert.strictEqual(fs.readFileSync(path.join(KIRO_USER_DIR, backups[0]), 'utf8'), ORIGINAL_SETTINGS, 'the backup must be the original file');

  kiroRoute.disable({ quiet: true });
  assert.strictEqual(fs.readFileSync(KIRO_SETTINGS, 'utf8'), ORIGINAL_SETTINGS, 'disable must restore the file byte-for-byte');

  await Promise.all(servers.map(close));
  console.log('✅ A: kiro enable edits JSONC surgically; disable restores it byte-for-byte');
}

// --- B: refuse a foreign owner of the port ---------------------------------

async function testRefuseForeignPort() {
  const home = resetSandbox();
  baseEnv(home);
  markInstalled(home);
  // Something else owns the Kiro port and answers happily.
  const squatter = await listen(KIRO_PORT, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"some":"other local server"}');
  });

  const kiroRoute = fresh('kiroRoute');
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const code = await kiroRoute.enable();
  console.error = realError;

  assert.strictEqual(code, 1, 'enable must refuse when the port is not ours');
  assert(errors.join('\n').includes('not Holdfast'), `the refusal must say why, got: ${errors.join('\n')}`);
  assert(errors.join('\n').includes('HOLDFAST_KIRO_PORT'), 'the refusal must suggest moving the port');
  assert.strictEqual(fs.readFileSync(KIRO_SETTINGS, 'utf8'), ORIGINAL_SETTINGS, 'a refused enable must not touch the settings file');

  await close(squatter);
  console.log('✅ B: kiro enable refuses a port owned by a non-Holdfast server, and changes nothing');
}

// --- B2: refuse when Kiro's profile region differs --------------------------

async function testRefuseRegionMismatch() {
  const home = resetSandbox({ region: 'eu-central-1' }); // Kiro signed in to eu-central-1
  baseEnv(home); // listener is us-east-1
  markInstalled(home);
  const servers = fresh('server').start();
  const kiroRoute = require(path.join(SRC, 'kiroRoute'));

  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const code = await kiroRoute.enable();
  console.error = realError;

  assert.strictEqual(code, 1, 'enable must refuse a region mismatch');
  assert(errors.join('\n').includes('eu-central-1'), 'the refusal must name Kiro’s own region');
  assert.strictEqual(fs.readFileSync(KIRO_SETTINGS, 'utf8'), ORIGINAL_SETTINGS, 'nothing may be written on refusal');

  await Promise.all(servers.map(close));
  console.log('✅ B2: kiro enable refuses when Kiro’s profile region differs (the override would be ignored)');
}

// --- C: stop reverts routing before freeing the port -----------------------

async function testStopReverts() {
  const home = resetSandbox();
  baseEnv(home);
  markInstalled(home);
  const servers = fresh('server').start();
  const kiroRoute = require(path.join(SRC, 'kiroRoute'));
  assert.strictEqual(await kiroRoute.enable(), 0, 'precondition: routing enabled');
  assert(fs.readFileSync(KIRO_SETTINGS, 'utf8').includes('krsEndpoints'), 'precondition: the key is present');

  // Shut the listener down first so `stop` has no process to signal — it must
  // still revert the routing.
  await Promise.all(servers.map(close));

  const logs = [];
  const realLog = console.log;
  console.log = (m) => logs.push(String(m));
  require(path.join(SRC, 'stop')).stop();
  console.log = realLog;

  assert.strictEqual(fs.readFileSync(KIRO_SETTINGS, 'utf8'), ORIGINAL_SETTINGS, 'stop must revert Kiro routing byte-for-byte');
  assert(logs.join('\n').includes('Reverted kiro routing'), `stop must say it reverted, got: ${logs.join('\n')}`);
  assert(!kiroRoute.isEnabled(), 'routing state must be cleared');
  console.log('✅ C: stop reverts Kiro routing before freeing the port');
}

// --- D: install points at a stable path, with options baked in -------------

async function testInstallStablePath() {
  const home = resetSandbox();
  baseEnv(home);
  process.env.HOLDFAST_HOLD_MINUTES = '999';
  const autostart = fresh('autostart');

  const logs = [];
  const realLog = console.log;
  console.log = (m) => logs.push(String(m));
  autostart.install();
  console.log = realLog;

  const serviceFile = process.env.HOLDFAST_SERVICE_FILE;
  assert(fs.existsSync(serviceFile), 'install must write a service definition');
  const text = fs.readFileSync(serviceFile, 'utf8');
  const expectedBin = path.join(home, 'app', require('../package.json').version, 'bin', 'holdfast');

  assert(text.includes(expectedBin), `the service must reference the stable path ${expectedBin}, got:\n${text}`);
  assert(!/_npx/.test(text), 'the service must NEVER reference the npx cache');
  assert(text.includes('HOLDFAST_HOLD_MINUTES'), 'the chosen options must be baked into the service');
  assert(text.includes('999'), '--minutes/HOLDFAST_HOLD_MINUTES must be persisted');
  assert(/ThrottleInterval|RestartSec/.test(text), 'a restart throttle must be set so a bad build cannot hot-loop');

  // The copied app really exists and is runnable.
  assert(fs.existsSync(expectedBin), 'the app must actually be copied to the stable path');
  assert(fs.existsSync(path.join(home, 'app', require('../package.json').version, 'src', 'server.js')), 'src/ must be copied');

  // And the install is recorded, which is what routing checks for supervision.
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'));
  assert.strictEqual(state.env.HOLDFAST_HOLD_MINUTES, '999', 'install.json must record the effective options');
  delete process.env.HOLDFAST_HOLD_MINUTES;
  console.log('✅ D: install copies to ~/.holdfast/app/<version> (never _npx) and persists the hold window');
}

// --- E: the Kiro listener ignores traffic that is not Kiro's ---------------

async function testKiroPortGuard() {
  const home = resetSandbox();
  baseEnv(home);
  let forwarded = 0;
  const upstream = await listen(UPSTREAM_PORT, (_req, res) => {
    forwarded += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"__type":"ValidationException"}');
  });
  const servers = fresh('server').start();
  await new Promise((r) => setTimeout(r, 100));

  // A neighbouring dev server's request must NOT reach kiro.dev.
  const stray = await get(KIRO_PORT, '/d01-6f2b-video.mp4');
  assert.strictEqual(stray.status, 404, 'a non-Kiro request must be answered locally');
  assert(stray.body.includes('not a Kiro request'), `expected the local 404 body, got ${stray.body}`);
  assert.strictEqual(forwarded, 0, 'a non-Kiro request must never be forwarded upstream');

  // A real KRS call still passes through, status unchanged.
  const real = await post(KIRO_PORT, '/generateAssistantResponse', { 'content-type': 'application/json', authorization: 'Bearer T' });
  assert.strictEqual(real.status, 400, 'a KRS request must pass through and keep the upstream status');
  assert.strictEqual(forwarded, 1, 'the KRS request must be the only one forwarded');

  await Promise.all([...servers.map(close), close(upstream)]);
  console.log('✅ E: the Kiro listener answers non-Kiro traffic locally and still passes KRS calls through');
}

(async () => {
  try {
    await testJsoncEditAndRevert();
    await testRefuseForeignPort();
    await testRefuseRegionMismatch();
    await testStopReverts();
    await testInstallStablePath();
    await testKiroPortGuard();
    fs.rmSync(sandbox, { recursive: true, force: true });
    console.log('\n=== ROUTING TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ ROUTING TEST FAILED:', err.message);
    console.error(`   sandbox kept for inspection: ${sandbox}`);
    process.exit(1);
  }
})();
