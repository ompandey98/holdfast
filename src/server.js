'use strict';

// The localhost servers that agent IDEs talk to. One HTTP listener per
// configured provider (Anthropic on :8787, OpenAI-compatible on :8788, ...).
// Each buffers an incoming request, hands it to the hold loop, and relays the
// response back — sending invisible keep-alive heartbeats to the client during
// a hold so even a 20-30 minute outage never idles the connection out.

const http = require('http');
const config = require('./config');
const log = require('./log');
const { forwardWithHold, openWithHold } = require('./holdloop');
const { targetFor } = require('./probe');
const stats = require('./stats');
const kiroFilter = require('./kiroFilter');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Does the client expect a streamed response we should pipe through live rather
// than buffer? Covers three styles:
//   • SSE            (Claude Code / Anthropic): Accept: text/event-stream
//   • AWS eventstream (Bedrock, CodeWhisperer/Kiro): application/vnd.amazon.eventstream
//   • an explicit "stream": true in the request body
function wantsStream(headers, body) {
  const accept = String(headers['accept'] || '');
  if (accept.includes('text/event-stream')) return true;
  if (accept.includes('application/vnd.amazon.eventstream')) return true;
  const text = body && body.length ? body.toString('utf8', 0, Math.min(body.length, 4096)) : '';
  return /"stream"\s*:\s*true/.test(text);
}

// Can we safely inject SSE keep-alive comments to this client during a hold?
// ONLY for genuine text/event-stream clients. AWS eventstream is a binary
// framing — injecting SSE comment bytes would corrupt it — so those get no
// heartbeat (a pre-first-byte hold is still held & replayed; it just can't emit
// keepalive bytes, so it's covered up to the client's own request timeout).
function canSseHeartbeat(headers, listener) {
  if (listener.aws) return false;
  const accept = String(headers['accept'] || '');
  return accept.includes('text/event-stream');
}

function sseError(message) {
  const payload = JSON.stringify({ type: 'error', error: { type: 'holdfast_error', message } });
  return `event: error\ndata: ${payload}\n\n`;
}

// Turn a failure into the response the client can actually act on.
//
//   • missing/broken AWS credentials -> 403 in the AWS error shape, so Claude
//     Code prints "could not obtain AWS credentials: <reason>" instead of an
//     opaque 502 that looks like a Holdfast bug;
//   • a TLS/cert or protocol error   -> 502 naming the error code (these are
//     never held, so they surface in seconds, not hours);
//   • an exhausted hold window       -> its own message, unchanged.
function describeFailure(err) {
  if (err && err.isCredentialError) {
    const message = `Holdfast: could not obtain AWS credentials: ${err.message}`;
    return {
      status: 403,
      headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'HoldfastCredentialError' },
      body: JSON.stringify({ message }),
      message,
    };
  }
  const message = err && err.isHoldTimeout
    ? err.message
    : err && err.isFastFail
      ? `Holdfast: upstream failed fast (${err.code}): ${err.message}`
      : `Holdfast internal error: ${err && err.message}`;
  return {
    status: 502,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'error',
      error: { type: 'holdfast_error', code: (err && err.code) || null, message },
    }),
    message,
  };
}

function makeHandler(listener) {
  const label = listener.name;

  return async function handle(req, res) {
    if (req.url === '/__holdfast/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, listener: label, upstream: listener.upstream, pid: process.pid }));
      return;
    }
    if (req.url === '/__holdfast/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stats.snapshot()));
      return;
    }

    // The Kiro listener answers non-KRS traffic locally instead of forwarding a
    // stranger's request to Kiro's backend (a dev server sharing the port was
    // seen having its .mp4 GETs proxied to kiro.dev).
    if (listener.kiro && config.kiroFilter && !kiroFilter.isKrsRequest(req.method, req.url)) {
      if (kiroFilter.shouldLog(`${label}:notkiro`)) {
        log.warn(
          `[${label}] ignoring non-Kiro request ${req.method} ${req.url} on :${listener.port} ` +
            `— something else on this machine is using the port. Move Holdfast with HOLDFAST_KIRO_PORT, ` +
            `or allow it with HOLDFAST_KIRO_ALLOW_PATHS. (further such logs suppressed for 60s)`
        );
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ holdfast: 'not a Kiro request' }));
      return;
    }

    const body = await readBody(req).catch(() => Buffer.alloc(0));
    const streaming = wantsStream(req.headers, body);
    const sseHeartbeatOk = canSseHeartbeat(req.headers, listener);
    const agent = stats.agentName(req.headers['user-agent']);

    // Heartbeat state — only engaged if we actually enter a hold.
    let headersSent = false;
    let heartbeat = null;

    const startHeartbeat = () => {
      // Keep-alive comments are only safe for genuine text/event-stream clients.
      // AWS eventstream (Bedrock, CodeWhisperer/Kiro) is binary framing — SSE
      // comment bytes would corrupt it — so those get no heartbeat. A
      // pre-first-byte hold there is still held & replayed; it just can't emit
      // keepalive bytes, so it's covered up to the client's own request timeout
      // (Claude Code: API_TIMEOUT_MS, default 10 min — raise it for longer).
      if (!sseHeartbeatOk) return;
      if (!streaming || headersSent) return;
      // Commit an SSE 200 so we can drip keep-alive comments during the outage.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      headersSent = true;
      // SSE comment lines (":" prefix) are ignored by every SSE parser, so the
      // client stays connected but sees nothing until the real response lands.
      res.write(': holdfast waiting for network to return\n\n');
      heartbeat = setInterval(() => {
        res.write(': holdfast still holding\n\n');
      }, config.heartbeatMs);
      if (heartbeat.unref) heartbeat.unref();
    };
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };

    const onState = (event, detail) => {
      switch (event) {
        case 'hold-enter':
          log.warn(`[${label}] [${agent}] DISCONNECT (${detail.code}) — entering hold` + (streaming ? ' (heartbeat on)' : ''));
          stats.record(label, req.headers['user-agent'], 'drop');
          startHeartbeat();
          break;
        case 'probe':
          log.info(`[${label}] [${agent}] probe ${detail.attempt}/${detail.max} … ${detail.online ? 'RECONNECTED — replaying' : 'no network'}`);
          break;
        case 'replay-failed':
          log.warn(`[${label}] [${agent}] probe passed but replay failed (${detail.code}) — still holding`);
          break;
        case 'recovered': {
          log.info(`[${label}] [${agent}] SAVED — response relayed after ${detail.heldSec}s hold, session intact`);
          const t = stats.record(label, req.headers['user-agent'], 'save', detail).listeners[label];
          log.info(`[${label}] lifetime: ${t.drops} drops caught, ${t.saves} sessions saved, ${Math.round(t.heldSeconds / 60)}m total held`);
          break;
        }
        case 'give-up':
          log.error(`[${label}] [${agent}] GAVE UP after ${detail.heldSec}s / ${detail.attempts} attempts`);
          stats.record(label, req.headers['user-agent'], 'giveup');
          break;
      }
    };

    log.info(`[${label}] [${agent}] ${req.method} ${req.url} — request in-flight`);
    stats.record(label, req.headers['user-agent'], 'request');

    const request = { method: req.method, path: req.url, headers: req.headers, body };

    try {
      if (streaming) {
        await handleStreaming(request);
      } else {
        await handleBuffered(request);
      }
    } catch (err) {
      stopHeartbeat();
      const failure = describeFailure(err);
      log.error(`[${label}] [${agent}] request failed (${failure.status}): ${failure.message}`);
      if (headersSent) {
        res.write(sseError(failure.message));
        res.end();
      } else {
        if (!res.headersSent) res.writeHead(failure.status, failure.headers);
        res.end(failure.body);
      }
    }

    // Streaming path: hold-and-replay only until the first response byte, then
    // pipe the LIVE upstream stream to the client so tokens arrive in real time.
    async function handleStreaming(rq) {
      const up = await openWithHold(listener, rq, onState);
      stopHeartbeat();

      if (headersSent) {
        // We already committed a 200 SSE for heartbeats during a hold. Continue
        // that same stream with the real body.
        if (up.statusCode >= 200 && up.statusCode < 300) {
          up.res.on('data', (c) => res.write(c));
          up.res.on('end', () => res.end());
          up.res.on('error', () => { res.write(sseError('upstream stream error after recovery')); res.end(); });
        } else {
          // Recovered, but the replay got a real API rejection. Can't change the
          // committed 200 now, so surface it as an SSE error event.
          const chunks = [];
          up.res.on('data', (c) => chunks.push(c));
          up.res.on('end', () => {
            res.write(sseError(`upstream returned ${up.statusCode} after recovery: ${Buffer.concat(chunks).toString('utf8', 0, 500)}`));
            res.end();
          });
          up.res.on('error', () => { res.write(sseError('upstream stream error after recovery')); res.end(); });
        }
        return;
      }

      // Fast path (no hold, or hold recovered before any heartbeat committed):
      // relay real status + headers, then stream the body through live.
      const outHeaders = Object.assign({}, up.headers);
      delete outHeaders['transfer-encoding'];
      delete outHeaders['connection'];
      res.writeHead(up.statusCode, outHeaders);
      up.res.on('data', (c) => res.write(c));
      up.res.on('end', () => res.end());
      up.res.on('error', () => res.end());
    }

    // Non-streaming path: buffer the full response, then relay it verbatim.
    async function handleBuffered(rq) {
      const up = await forwardWithHold(listener, rq, onState);
      stopHeartbeat();

      if (headersSent) {
        if (up.statusCode >= 200 && up.statusCode < 300) {
          res.end(up.body);
        } else {
          res.write(sseError(`upstream returned ${up.statusCode} after recovery: ${up.body.toString('utf8', 0, 500)}`));
          res.end();
        }
        return;
      }

      const outHeaders = Object.assign({}, up.headers);
      delete outHeaders['transfer-encoding'];
      delete outHeaders['connection'];
      res.writeHead(up.statusCode, outHeaders);
      res.end(up.body);
    }
  };
}

function startListener(listener) {
  const server = http.createServer(makeHandler(listener));
  // No socket timeouts: a held request may legitimately take the full window.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;

  server.listen(listener.port, '127.0.0.1', () => {
    const t = targetFor(listener.upstream);
    log.info(`[${listener.name}] live on :${listener.port}  →  ${listener.upstream}  (probe ${t.host}:${t.port})`);
  });
  // A single listener failing must NEVER take down the process or the other
  // listeners — every other tool must keep being protected. A busy port almost
  // always means Holdfast is already running there (or something else owns it):
  // we skip THIS listener with a warning and leave the rest live. We do not set
  // a failing exit code, because from the user's point of view Holdfast is up
  // and doing its job for every port that bound cleanly.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`[${listener.name}] port ${listener.port} already in use — skipping this listener (Holdfast already running there?). Other listeners are unaffected.`);
    } else {
      log.warn(`[${listener.name}] could not start on :${listener.port} (${err.code || err.message}) — skipping; other listeners are unaffected.`);
    }
  });
  return server;
}

function start() {
  // Last-resort safety net. Holdfast's whole job is to keep sessions alive, so
  // it must be the most robust thing on the machine: a stray error in one
  // request, stream, or timer must NEVER crash the daemon and drop every IDE's
  // protection at once. We log and keep running instead of exiting. (Per-request
  // failures are already handled locally; this only catches the unexpected.)
  if (!start._guarded) {
    start._guarded = true;
    process.on('uncaughtException', (err) => {
      log.error(`uncaught error (ignored to keep Holdfast alive): ${err && err.stack ? err.stack : err}`);
    });
    process.on('unhandledRejection', (reason) => {
      log.error(`unhandled rejection (ignored to keep Holdfast alive): ${reason && reason.stack ? reason.stack : reason}`);
    });
  }

  const mins = config.holdMinutes;
  log.info(`Holdfast starting — hold window ~${mins} min (${config.maxRetries}×${config.retryIntervalMs / 1000}s), heartbeat ${config.heartbeatMs / 1000}s`);
  const servers = config.listeners.map(startListener);
  log.info(`${config.listeners.length} listeners: ${config.listeners.map((l) => l.name + ':' + l.port).join(', ')}. Use each tool as normal — Holdfast is invisible until the network drops. Ctrl-C to stop.`);
  return servers;
}

module.exports = { start };
