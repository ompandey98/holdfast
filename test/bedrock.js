'use strict';

// Tests for the AWS side — the part that decided whether Claude Code in Bedrock
// mode worked at all:
//
//   A) A /region/<r> path prefix routes and SIGNS for <r>: the upstream host
//      takes that region, the SigV4 scope is that region, and the prefix is
//      stripped from the signed path (a signature over /region/... would be
//      rejected by AWS).
//   B) An invalid region in the prefix is rejected locally, fast.
//   C) The credential chain reads a command that prints the nested
//      {"Credentials":{...}} shape — the shape a wrapper-launched Claude Code's
//      awsCredentialExport actually emits — as well as the flat
//      credential_process shape.
//   D) A failing credential command produces a readable 403 (AWS error shape,
//      x-amzn-errortype) — never a bare 502, and never a hold.
//   E) A TLS/protocol failure fails FAST instead of being held for the whole
//      window (this was a real defect: with --minutes 999 a cert error hung for
//      16 hours).
//   F) Credentials are cached, and refreshed when they are about to expire.
//
// No network and no real AWS: mock upstreams on localhost, and a fake credential
// command that prints test keys.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'holdfast-bedrock-'));

const LISTEN_PORT = 9261;
const UPSTREAM_PORT = 9262;

// A credential command: prints the nested shape, counts its own invocations,
// and can be told to fail or to hand out a nearly-expired credential.
function writeCredentialCommand(name, { mode = 'nested', expiresInMs = 3600_000, exitCode = 0 } = {}) {
  const file = path.join(sandbox, `${name}.js`);
  const counter = path.join(sandbox, `${name}.count`);
  fs.writeFileSync(counter, '0');
  fs.writeFileSync(
    file,
    `const fs=require('fs');
const c=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))+1;
fs.writeFileSync(${JSON.stringify(counter)},String(c));
if (${exitCode} !== 0) { process.stderr.write('credential helper exploded\\n'); process.exit(${exitCode}); }
const expiry=new Date(Date.now()+${expiresInMs}).toISOString().replace(/\\.\\d{3}Z$/,'Z');
const creds={AccessKeyId:'AKIATESTKEY'+c,SecretAccessKey:'secret'+c,SessionToken:'token'+c,Expiration:expiry};
process.stdout.write(${mode === 'nested' ? "JSON.stringify({Credentials:creds})" : "JSON.stringify(Object.assign({Version:1},creds))"});
`
  );
  return { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`, counter };
}

function readCount(counter) {
  return Number(fs.readFileSync(counter, 'utf8'));
}

function fresh(mod) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
  return require(path.join(SRC, mod));
}

function baseEnv() {
  process.env.HOLDFAST_HOME = path.join(sandbox, 'home');
  process.env.HOLDFAST_CLAUDE_SETTINGS = path.join(sandbox, 'no-claude-settings.json');
  process.env.HOLDFAST_LOG_CONSOLE = '0';
  process.env.HOLDFAST_USE_CLAUDE_CREDS = '0';
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
}

function listen(port, handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(port, '127.0.0.1', () => resolve(s));
  });
}

function close(server) {
  return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

function post(port, p, body = '{}', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

// --- A: region prefix drives host, scope and signed path -------------------

async function testRegionPrefix() {
  baseEnv();
  const cred = writeCredentialCommand('cmdA');
  process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND = cred.command;
  process.env.HOLDFAST_LISTENERS = JSON.stringify([
    {
      name: 'bedrock',
      port: LISTEN_PORT,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      aws: true,
      regionPrefix: true,
      region: 'us-east-1', // the listener default, which the prefix must override
    },
  ]);

  let seen = null;
  const upstream = await listen(UPSTREAM_PORT, (req, res) => {
    seen = { url: req.url, headers: req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const servers = fresh('server').start();
  await new Promise((r) => setTimeout(r, 100));

  const out = await post(LISTEN_PORT, '/region/us-west-2/model/anthropic.claude-x/invoke');
  assert.strictEqual(out.status, 200, `expected the upstream 200, got ${out.status} ${out.body}`);
  assert.strictEqual(seen.url, '/model/anthropic.claude-x/invoke', `the /region/<r> prefix must be stripped, upstream saw ${seen.url}`);

  const auth = seen.headers.authorization || '';
  assert(auth.startsWith('AWS4-HMAC-SHA256 '), `the request must be re-signed, got: ${auth.slice(0, 40)}`);
  assert(/\/us-west-2\/bedrock\/aws4_request/.test(auth), `the SigV4 scope must be us-west-2, got: ${auth}`);
  assert(!/us-east-1/.test(auth), 'the listener default region must not leak into the signature');
  assert(seen.headers['x-amz-security-token'], 'the session token must be sent');
  assert(seen.headers['x-amz-content-sha256'], 'the payload hash must be sent');

  // The host header follows the upstream, and a REAL regional AWS host would be
  // rewritten to the requested region (unit-checked, since the mock is on localhost).
  const { hostForRegion } = require(path.join(SRC, 'forward'));
  assert.strictEqual(
    hostForRegion('bedrock-runtime.us-east-1.amazonaws.com', 'us-west-2'),
    'bedrock-runtime.us-west-2.amazonaws.com',
    'a regional AWS host must be rewritten to the requested region'
  );
  assert.strictEqual(hostForRegion('my-proxy.internal', 'us-west-2'), 'my-proxy.internal', 'a non-regional custom host must be left alone');

  // Without a prefix, behaviour is unchanged: listener region is used.
  seen = null;
  await post(LISTEN_PORT, '/model/anthropic.claude-x/invoke');
  assert.strictEqual(seen.url, '/model/anthropic.claude-x/invoke', 'a request with no prefix passes through unchanged');
  assert(/\/us-east-1\/bedrock\/aws4_request/.test(seen.headers.authorization), 'without a prefix the listener region signs');

  await Promise.all([...servers.map(close), close(upstream)]);
  console.log('✅ A: /region/us-west-2 routes, signs and strips the prefix (and no-prefix behaviour is unchanged)');
}

// --- B: an invalid region is rejected locally ------------------------------

async function testInvalidRegion() {
  baseEnv();
  const cred = writeCredentialCommand('cmdB');
  process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND = cred.command;
  process.env.HOLDFAST_LISTENERS = JSON.stringify([
    { name: 'bedrock', port: LISTEN_PORT, upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, aws: true, regionPrefix: true, region: 'us-east-1' },
  ]);
  process.env.HOLDFAST_RETRY_INTERVAL_MS = '60000'; // a hold would be obvious
  const servers = fresh('server').start();
  await new Promise((r) => setTimeout(r, 100));

  const started = Date.now();
  const out = await post(LISTEN_PORT, '/region/not-a-region/model/x/invoke');
  const elapsed = Date.now() - started;
  assert.strictEqual(out.status, 502, `an invalid region must fail, got ${out.status}`);
  assert(/EBADREGION/.test(out.body), `the error must name the cause, got ${out.body}`);
  assert(elapsed < 2000, `it must fail fast, took ${elapsed}ms`);

  delete process.env.HOLDFAST_RETRY_INTERVAL_MS;
  await Promise.all(servers.map(close));
  console.log(`✅ B: an invalid /region/<r> is rejected locally in ${elapsed}ms`);
}

// --- C: both credential shapes are accepted -------------------------------

async function testCredentialShapes() {
  baseEnv();
  const credentials = fresh('credentials');

  const nested = credentials.parseCredentialJson(
    JSON.stringify({ Credentials: { AccessKeyId: 'A', SecretAccessKey: 'B', SessionToken: 'C', Expiration: '2026-01-01T00:00:00Z' } })
  );
  assert.strictEqual(nested.accessKeyId, 'A', 'the nested {"Credentials":{...}} shape must parse');
  assert.strictEqual(nested.sessionToken, 'C');
  assert.strictEqual(typeof nested.expiresAt, 'number', 'the expiry must be parsed');

  const flat = credentials.parseCredentialJson(JSON.stringify({ Version: 1, AccessKeyId: 'X', SecretAccessKey: 'Y', SessionToken: 'Z' }));
  assert.strictEqual(flat.accessKeyId, 'X', 'the flat credential_process shape must parse');

  assert.strictEqual(credentials.parseCredentialJson('not json'), null, 'garbage must not be mistaken for credentials');
  assert.strictEqual(credentials.parseCredentialJson('{"hello":1}'), null, 'JSON without keys must not be mistaken for credentials');

  // A quoted command path (as in ~/.claude/settings.json) must tokenize intact.
  assert.deepStrictEqual(
    credentials.tokenize('"/Users/x/.toolbox/bin/claude" default-credential-export'),
    ['/Users/x/.toolbox/bin/claude', 'default-credential-export'],
    'a quoted executable path must survive tokenizing'
  );

  // End to end through the real chain, with the flat shape this time.
  const cred = writeCredentialCommand('cmdC', { mode: 'flat' });
  process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND = cred.command;
  credentials.clearCache();
  const resolved = credentials.resolve({ force: true });
  assert(resolved.accessKeyId.startsWith('AKIATESTKEY'), 'the chain must use the command');
  assert.strictEqual(resolved.source, 'HOLDFAST_AWS_CREDENTIAL_COMMAND');
  console.log('✅ C: both credential shapes parse, quoted command paths tokenize, and the chain uses them');
}

// --- D: a broken credential command yields a readable 403 -----------------

async function testCredentialFailure() {
  baseEnv();
  const cred = writeCredentialCommand('cmdD', { exitCode: 3 });
  process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND = cred.command;
  process.env.HOLDFAST_LISTENERS = JSON.stringify([
    { name: 'bedrock', port: LISTEN_PORT, upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, aws: true, regionPrefix: true, region: 'us-west-2' },
  ]);
  process.env.HOLDFAST_RETRY_INTERVAL_MS = '60000';
  const servers = fresh('server').start();
  await new Promise((r) => setTimeout(r, 100));

  const started = Date.now();
  const out = await post(LISTEN_PORT, '/model/x/invoke');
  const elapsed = Date.now() - started;

  assert.strictEqual(out.status, 403, `a credential failure must be a 403, got ${out.status} ${out.body}`);
  assert.strictEqual(out.headers['x-amzn-errortype'], 'HoldfastCredentialError', 'the AWS error type header must be set');
  const parsed = JSON.parse(out.body);
  assert(/could not obtain AWS credentials/.test(parsed.message), `the message must be readable, got ${out.body}`);
  assert(/exited 3/.test(parsed.message), `the message must say why, got ${parsed.message}`);
  assert(!/secret|token|AKIA/i.test(out.body), 'the error must never echo credential material');
  assert(elapsed < 2000, `a credential failure must never be held, took ${elapsed}ms`);

  delete process.env.HOLDFAST_RETRY_INTERVAL_MS;
  await Promise.all(servers.map(close));
  console.log(`✅ D: a broken credential command returns a readable 403 in ${elapsed}ms (never held, never 502)`);
}

// --- E: a TLS/protocol error fails fast ----------------------------------

async function testTlsFailsFast() {
  baseEnv();
  // Point an HTTPS upstream at a PLAIN HTTP server: the TLS handshake fails with
  // a protocol error, which must not be mistaken for a dropped connection.
  const plain = await listen(UPSTREAM_PORT, (_req, res) => {
    res.writeHead(200);
    res.end('plain');
  });
  process.env.HOLDFAST_LISTENERS = JSON.stringify([
    { name: 'anthropic', port: LISTEN_PORT, upstream: `https://127.0.0.1:${UPSTREAM_PORT}` },
  ]);
  process.env.HOLDFAST_RETRY_INTERVAL_MS = '60000'; // any hold would take >= 60s
  process.env.HOLDFAST_HOLD_MINUTES = '999';
  const servers = fresh('server').start();
  await new Promise((r) => setTimeout(r, 100));

  const started = Date.now();
  const out = await post(LISTEN_PORT, '/v1/messages');
  const elapsed = Date.now() - started;

  assert(elapsed < 2000, `a TLS error must fail fast, took ${elapsed}ms (it was being held)`);
  assert.strictEqual(out.status, 502, `expected 502, got ${out.status}`);
  const parsed = JSON.parse(out.body);
  assert(parsed.error && parsed.error.code, `the response must carry the error code, got ${out.body}`);
  assert(/EPROTO|ERR_TLS|CERT/.test(parsed.error.code), `the code must identify the TLS failure, got ${parsed.error.code}`);

  // And the classifier agrees about the two directions.
  const { classify } = require(path.join(SRC, 'forward'));
  assert(classify({ code: 'ECONNRESET', message: 'x' }).isNetworkError, 'a reset connection is still held');
  assert(classify({ code: 'ENOTFOUND', message: 'x' }).isNetworkError, 'DNS failure is still held');
  assert(classify({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'x' }).isNetworkError, 'undici connect timeouts are held');
  assert(classify({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'x' }).isFastFail, 'a self-signed cert fails fast');
  assert(classify({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'x' }).isFastFail, 'an unverifiable cert fails fast');
  assert(classify({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'x' }).isFastFail, 'a hostname mismatch fails fast');
  assert(classify({ code: 'EWEIRD', message: 'x' }).isFastFail, 'an unknown error no longer hides in a silent hold');

  delete process.env.HOLDFAST_RETRY_INTERVAL_MS;
  delete process.env.HOLDFAST_HOLD_MINUTES;
  await Promise.all([...servers.map(close), close(plain)]);
  console.log(`✅ E: a TLS/protocol failure is reported in ${elapsed}ms instead of being held`);
}

// --- F: credentials are cached, then refreshed near expiry ---------------

async function testCredentialCaching() {
  baseEnv();
  const cred = writeCredentialCommand('cmdF', { expiresInMs: 3600_000 });
  process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND = cred.command;
  const credentials = fresh('credentials');

  credentials.resolve();
  credentials.resolve();
  credentials.resolve();
  assert.strictEqual(readCount(cred.counter), 1, 'a long-lived credential must be resolved once and cached');

  // Now one that is already inside the 5-minute safety margin: every call must
  // re-resolve, which is what makes a replay after a long hold use fresh keys.
  const shortCred = writeCredentialCommand('cmdF2', { expiresInMs: 60_000 });
  process.env.HOLDFAST_AWS_CREDENTIAL_COMMAND = shortCred.command;
  credentials.clearCache();
  credentials.resolve();
  credentials.resolve();
  assert.strictEqual(readCount(shortCred.counter), 2, 'a credential inside the expiry margin must be re-resolved');
  console.log('✅ F: credentials are cached until shortly before expiry, then refreshed');
}

(async () => {
  try {
    await testRegionPrefix();
    await testInvalidRegion();
    await testCredentialShapes();
    await testCredentialFailure();
    await testTlsFailsFast();
    await testCredentialCaching();
    fs.rmSync(sandbox, { recursive: true, force: true });
    console.log('\n=== BEDROCK / CREDENTIAL TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ BEDROCK TEST FAILED:', err.message);
    console.error(`   sandbox kept for inspection: ${sandbox}`);
    process.exit(1);
  }
})();
