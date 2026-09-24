'use strict';

// Regression tests for the streaming behaviour that makes Holdfast usable in
// practice (not just correct on paper):
//
//   A) A live SSE (text/event-stream) response streams THROUGH in real time —
//      it is NOT buffered to the end. Buffering froze the client screen and
//      could trip a first-byte timeout on long turns.
//   B) A pre-first-byte network failure on the streaming path is held and
//      replayed (drop survival still works with live streaming).
//   C) An AWS eventstream response (application/vnd.amazon.eventstream — used by
//      Bedrock and CodeWhisperer/Kiro) also streams live, and the client's
//      Authorization header is passed through untouched (bearer, not SigV4).
//
// Pure Node stdlib, no network required (mock upstreams on localhost).

const http = require('http');
const assert = require('assert');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function once(port, handler) {
  return http.createServer(handler).listen(port, '127.0.0.1');
}

function collect(res, onChunk) {
  return new Promise((resolve) => {
    const parts = [];
    res.on('data', (c) => { parts.push(c); if (onChunk) onChunk(c, Date.now()); });
    res.on('end', () => resolve(Buffer.concat(parts)));
  });
}

function post(port, headers, body, p = '/v1/messages') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers, agent: false },
      (res) => resolve(res)
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function testLiveSSE() {
  process.env.HOLDFAST_LISTENERS = JSON.stringify([{ name: 'a', port: 9188, upstream: 'http://127.0.0.1:9189' }]);
  const up = once(9189, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => { i++; res.write(`data: ${i}\n\n`); if (i >= 3) { clearInterval(t); res.end(); } }, 400);
  });
  const server = freshServer();
  const started = Date.now();
  const times = [];
  const res = await post(9188, { accept: 'text/event-stream' }, '{}');
  await collect(res, (_c, t) => times.push(t - started));
  up.close(); server.forEach((s) => s.close());

  // With live streaming, the LAST chunk lands well after the first. If buffered,
  // all chunks land together at the end (~1200ms). We assert the spread is real.
  const spread = times[times.length - 1] - times[0];
  assert(spread > 500, `SSE should stream live (spread ${spread}ms, expected >500ms — buffered?)`);
  console.log(`✅ A: live SSE streams through (chunk spread ${spread}ms)`);
}

async function testHoldReplayStreaming() {
  process.env.HOLDFAST_LISTENERS = JSON.stringify([{ name: 'a', port: 9186, upstream: 'http://127.0.0.1:9187' }]);
  process.env.HOLDFAST_RETRY_INTERVAL_MS = '400';
  process.env.HOLDFAST_HOLD_MINUTES = '1';
  process.env.HOLDFAST_HEARTBEAT_MS = '200';
  const server = freshServer();
  // upstream starts DOWN; bring it up mid-hold
  let up = null;
  setTimeout(() => {
    up = once(9187, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: recovered\n\n');
    });
  }, 900);

  const res = await post(9186, { accept: 'text/event-stream' }, '{}');
  const body = (await collect(res)).toString();
  if (up) up.close(); server.forEach((s) => s.close());
  assert(body.includes('recovered'), `held request should replay and deliver the recovered body, got: ${body.slice(0, 120)}`);
  console.log('✅ B: pre-first-byte drop held and replayed on streaming path');
}

async function testEventstreamAndBearer() {
  process.env.HOLDFAST_LISTENERS = JSON.stringify([{ name: 'cw', port: 9184, upstream: 'http://127.0.0.1:9185' }]);
  let sawAuth = null;
  const up = once(9185, (req, res) => {
    sawAuth = req.headers['authorization'] || null;
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    let i = 0;
    const t = setInterval(() => { i++; res.write(`c${i}`); if (i >= 3) { clearInterval(t); res.end(); } }, 400);
  });
  const server = freshServer();
  const started = Date.now();
  const times = [];
  const res = await post(9184, { accept: 'application/vnd.amazon.eventstream', authorization: 'Bearer TESTTOKEN' }, '{}');
  await collect(res, (_c, t) => times.push(t - started));
  up.close(); server.forEach((s) => s.close());

  const spread = times[times.length - 1] - times[0];
  assert(sawAuth === 'Bearer TESTTOKEN', `bearer must pass through untouched, upstream saw: ${sawAuth}`);
  assert(spread > 400, `eventstream should stream live (spread ${spread}ms — buffered?)`);
  console.log(`✅ C: AWS eventstream streams live (spread ${spread}ms) + bearer preserved`);
}

// D) The Kiro listener, built by config.js as part of the DEFAULT set (all
//    listeners are on by default now), forwards to the Kiro Runtime Service as a
//    plain bearer pass-through and streams the event-stream response live. This
//    exercises the REAL config path (default listener creation, port,
//    aws:false pass-through) end to end against a mock KRS upstream — not just
//    config inspection.
async function testKiroListener() {
  // Build the full default set, but remap every default port into the test
  // range so the test never touches a real 8787/8788/8789/8790 a running
  // Holdfast might own. The kiro listener is still the one config.js creates.
  delete process.env.HOLDFAST_LISTENERS;
  process.env.HOLDFAST_PORT = '9180';           // anthropic
  process.env.HOLDFAST_OPENAI_PORT = '9181';    // openai
  process.env.HOLDFAST_BEDROCK_PORT = '9179';   // bedrock
  process.env.HOLDFAST_KIRO_PORT = '9182';      // kiro (under test)
  process.env.HOLDFAST_KIRO_UPSTREAM = 'http://127.0.0.1:9183';
  let sawAuth = null;
  let sawHost = null;
  const up = once(9183, (req, res) => {
    sawAuth = req.headers['authorization'] || null;
    sawHost = req.headers['host'] || null;
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    let i = 0;
    const t = setInterval(() => { i++; res.write(`k${i}`); if (i >= 3) { clearInterval(t); res.end(); } }, 400);
  });
  const server = freshServer();
  // Prove the default set really includes all four listeners (no opt-in).
  const names = require(path.join(SRC, 'config')).listeners.map((l) => l.name).sort().join(',');
  assert(names === 'anthropic,bedrock,kiro,openai', `default listeners should be all four, got: ${names}`);
  const started = Date.now();
  const times = [];
  // A real KRS wire path: the kiro listener answers anything that is not
  // KRS-shaped locally (see the port guard in server.js / kiroFilter.js), which
  // is what stops a neighbouring dev server's traffic reaching kiro.dev.
  const res = await post(9182, { accept: 'application/vnd.amazon.eventstream', authorization: 'Bearer KIROTOKEN' }, '{}', '/generateAssistantResponse');
  await collect(res, (_c, t) => times.push(t - started));
  up.close(); server.forEach((s) => s.close());
  delete process.env.HOLDFAST_PORT;
  delete process.env.HOLDFAST_OPENAI_PORT;
  delete process.env.HOLDFAST_BEDROCK_PORT;
  delete process.env.HOLDFAST_KIRO_PORT;
  delete process.env.HOLDFAST_KIRO_UPSTREAM;

  const spread = times[times.length - 1] - times[0];
  assert(sawAuth === 'Bearer KIROTOKEN', `kiro listener must pass bearer through untouched, upstream saw: ${sawAuth}`);
  assert(sawHost === '127.0.0.1:9183', `kiro listener must rewrite Host to the upstream, saw: ${sawHost}`);
  assert(spread > 400, `kiro event-stream should stream live (spread ${spread}ms — buffered?)`);
  console.log(`✅ D: default kiro listener streams live (spread ${spread}ms) + bearer preserved, Host rewritten`);
}

// E) The "never fail any system" guarantee: if ONE listener's port is already
//    taken, Holdfast must NOT crash and must NOT take down the other listeners —
//    every other tool stays protected. We pre-occupy one port, start Holdfast,
//    and assert a different listener still serves a request normally.
async function testPortConflictIsolation() {
  delete process.env.HOLDFAST_LISTENERS;
  // Two listeners on distinct test ports; a real upstream behind the second.
  const CONFLICT_PORT = 9177;
  const LIVE_PORT = 9178;
  process.env.HOLDFAST_PORT = String(CONFLICT_PORT);  // anthropic — we'll steal this port
  process.env.HOLDFAST_OPENAI_PORT = String(LIVE_PORT);
  process.env.HOLDFAST_OPENAI_UPSTREAM = 'http://127.0.0.1:9176';
  process.env.HOLDFAST_BEDROCK_PORT = '9175';
  process.env.HOLDFAST_KIRO_PORT = '9174';

  // Someone else already owns the anthropic port before Holdfast starts.
  const squatter = once(CONFLICT_PORT, (_req, res) => { res.writeHead(204); res.end(); });
  const upstream = once(9176, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });

  const server = freshServer(); // must NOT throw despite the port conflict
  // Give the EADDRINUSE error event a tick to fire.
  await new Promise((r) => setTimeout(r, 150));

  // The un-conflicted listener must still work end to end.
  const res = await post(LIVE_PORT, { 'content-type': 'application/json' }, '{}');
  const body = (await collect(res)).toString();

  squatter.close(); upstream.close(); server.forEach((s) => { try { s.close(); } catch (_) {} });
  delete process.env.HOLDFAST_PORT;
  delete process.env.HOLDFAST_OPENAI_PORT;
  delete process.env.HOLDFAST_OPENAI_UPSTREAM;
  delete process.env.HOLDFAST_BEDROCK_PORT;
  delete process.env.HOLDFAST_KIRO_PORT;

  assert(body.includes('"ok":true'), `un-conflicted listener must keep serving despite a port clash, got: ${body.slice(0, 120)}`);
  assert(process.exitCode !== 1, `a port conflict must NOT mark the process failed (exitCode=${process.exitCode})`);
  console.log('✅ E: a busy port is skipped; other listeners keep working (never fails the system)');
}

// F) The Kiro path end to end: a drop BEFORE the first response byte on an AWS
//    eventstream (binary) response is held and replayed, and the client receives
//    the complete, byte-identical binary stream. Binary framing is the risk here
//    — a stray keep-alive byte or a truncated replay would corrupt Kiro's chat —
//    so this asserts the exact bytes, not just "something arrived".
async function testKiroEventstreamHoldReplay() {
  delete process.env.HOLDFAST_LISTENERS;
  process.env.HOLDFAST_KIRO_PORT = '9172';
  process.env.HOLDFAST_KIRO_UPSTREAM = 'http://127.0.0.1:9173';
  process.env.HOLDFAST_PORT = '9171';
  process.env.HOLDFAST_OPENAI_PORT = '9170';
  process.env.HOLDFAST_BEDROCK_PORT = '9169';
  process.env.HOLDFAST_RETRY_INTERVAL_MS = '300';
  process.env.HOLDFAST_HOLD_MINUTES = '1';

  // Bytes an SSE parser would mangle and a text round-trip would corrupt.
  const frame = Buffer.from([0x00, 0x00, 0x01, 0x2f, 0x0a, 0x3a, 0x20, 0xff, 0xfe, 0x7b, 0x22, 0x61, 0x22, 0x7d, 0x00]);
  const expected = Buffer.concat([frame, frame, frame]);

  const server = freshServer();
  let up = null;
  // The upstream is DOWN when the request arrives, and comes back mid-hold.
  setTimeout(() => {
    up = once(9173, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      let i = 0;
      const t = setInterval(() => {
        i++;
        res.write(frame);
        if (i >= 3) { clearInterval(t); res.end(); }
      }, 150);
    });
  }, 700);

  const res = await post(9172, { accept: 'application/vnd.amazon.eventstream', authorization: 'Bearer KIROTOKEN', 'content-type': 'application/json' }, '{}', '/generateAssistantResponse');
  assert.strictEqual(res.statusCode, 200, `the replayed response must carry the real status, got ${res.statusCode}`);
  assert.strictEqual(
    String(res.headers['content-type']),
    'application/vnd.amazon.eventstream',
    'the binary content type must be relayed unchanged'
  );
  const body = await collect(res);
  if (up) up.close();
  server.forEach((s) => s.close());
  delete process.env.HOLDFAST_KIRO_PORT;
  delete process.env.HOLDFAST_KIRO_UPSTREAM;
  delete process.env.HOLDFAST_PORT;
  delete process.env.HOLDFAST_OPENAI_PORT;
  delete process.env.HOLDFAST_BEDROCK_PORT;
  delete process.env.HOLDFAST_RETRY_INTERVAL_MS;
  delete process.env.HOLDFAST_HOLD_MINUTES;

  assert.strictEqual(body.length, expected.length, `the client must receive every byte (${body.length} of ${expected.length})`);
  assert(body.equals(expected), 'the replayed binary stream must be byte-identical — no injected keep-alive bytes, no truncation');
  console.log(`✅ F: Kiro eventstream drop held and replayed; ${body.length} bytes delivered byte-identical`);
}

// Load a fresh server module with current env (config is read at require time).
function freshServer() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(SRC)) delete require.cache[k];
  }
  return require(path.join(SRC, 'server')).start();
}

(async () => {
  try {
    await testLiveSSE();
    await testHoldReplayStreaming();
    await testEventstreamAndBearer();
    await testKiroListener();
    await testPortConflictIsolation();
    await testKiroEventstreamHoldReplay();
    console.log('\n=== STREAMING TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ STREAMING TEST FAILED:', err.message);
    process.exit(1);
  }
})();
