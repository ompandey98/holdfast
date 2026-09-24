'use strict';

// Forwards a request to a given upstream API. Two primitives:
//
//   forwardOnce(listener, req)   -> buffers the ENTIRE response, then resolves
//                                   with { statusCode, headers, body }. Used for
//                                   non-streaming requests: the client waits for
//                                   one blob anyway, so a mid-response drop can
//                                   be replayed safely (client never saw partial).
//
//   openUpstream(listener, req)  -> resolves the moment response HEADERS arrive,
//                                   with { statusCode, headers, res } where `res`
//                                   is the LIVE response stream. The caller pipes
//                                   it to the client so tokens arrive in real
//                                   time (no frozen screen, no first-byte
//                                   timeout on long turns). Rejects with a
//                                   NetworkError only if the line dies BEFORE any
//                                   response byte — pre-first-byte, safe to hold
//                                   and replay.
//
// A drop AFTER streaming has begun is NOT replayed: the client already holds a
// partial answer, so re-running would double-run the turn or corrupt output.
// That case surfaces on `res` and is passed through honestly.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('./config');

// Node network/connection error codes that mean "the line is down" rather than
// "the API rejected your request". Only these trigger the hold-and-retry loop.
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'EHOSTDOWN', 'ESOCKETTIMEDOUT', 'EADDRNOTAVAIL',
  // undici / fetch-style connect and socket failures.
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

class NetworkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
    this.isNetworkError = true;
  }
}

// Anything that is NOT a dropped line: a TLS/certificate rejection, a protocol
// error, a bug. Holding these was the bug — a cert failure used to be retried
// silently for the entire hold window (hours) instead of being reported in
// seconds. They fail fast, with the code, so the cause is visible.
class FastFailError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FastFailError';
    this.code = code;
    this.isFastFail = true;
  }
}

function isNetworkErrorCode(code) {
  if (NETWORK_ERROR_CODES.has(code)) return true;
  // undici wraps connect failures; treat any *_CONNECT_* socket code as network.
  return typeof code === 'string' && /^UND_ERR_(CONNECT|SOCKET)/.test(code);
}

// TLS/certificate problems are configuration or interception issues, never a
// blip. Node reports them with these shapes.
function isTlsErrorCode(code) {
  return (
    typeof code === 'string' &&
    (code.startsWith('ERR_TLS_') ||
      code.startsWith('CERT_') ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'EPROTO')
  );
}

// Classify a raw error into "hold it" (NetworkError) or "report it now"
// (FastFailError). Credential errors pass through untouched: they are neither,
// and the server renders them as a readable AWS-shaped 403.
function classify(err) {
  if (err && (err.isNetworkError || err.isFastFail || err.isCredentialError)) return err;
  const code = (err && err.code) || 'EUNKNOWN';
  const message = (err && err.message) || 'unknown error';
  if (isTlsErrorCode(code)) return new FastFailError(`TLS/certificate failure: ${message}`, code);
  if (isNetworkErrorCode(code)) return new NetworkError(message, code);
  return new FastFailError(message, code);
}

// A /region/<r> path prefix lets one Bedrock listener serve whichever region
// the client is configured for. Anything else is passed through unchanged.
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

function splitRegionPrefix(reqPath) {
  const m = /^\/region\/([^/?]+)(\/.*|\?.*)?$/.exec(String(reqPath));
  if (!m) return { region: null, path: reqPath };
  if (!REGION_RE.test(m[1])) return { region: null, path: reqPath, invalidRegion: m[1] };
  return { region: m[1], path: m[2] && m[2] !== '' ? m[2] : '/' };
}

// Swap the region label of a regional AWS host, so /region/us-west-2 really
// lands on bedrock-runtime.us-west-2.amazonaws.com. A custom upstream host that
// doesn't look regional is left alone (only the signing region changes).
function hostForRegion(host, region) {
  const m = /^([a-z0-9-]+?)\.[a-z]{2}(?:-gov)?-[a-z]+-\d\.(amazonaws\.com(?:\.cn)?)$/.exec(host);
  if (!m) return host;
  return `${m[1]}.${region}.${m[2]}`;
}

// Build the transport + request options for one attempt against `listener`.
// For AWS listeners the request is re-signed with SigV4 on EVERY attempt: the
// client's original signature was computed for localhost (or has expired during
// a hold), so it must be replaced, freshly, each time.
function buildOptions(listener, { method, path: reqPath, headers, body }) {
  const upstreamUrl = typeof listener === 'string' ? listener : listener.upstream;
  const isAws = typeof listener === 'object' && !!listener.aws;
  const upstream = new URL(upstreamUrl);

  // Optional /region/<r> prefix: strip it before signing and forwarding, and
  // use <r> as both the destination region and the SigV4 scope region.
  let clientPath = reqPath;
  let region = (typeof listener === 'object' && listener.region) || null;
  if (typeof listener === 'object' && listener.regionPrefix) {
    const split = splitRegionPrefix(reqPath);
    if (split.invalidRegion) {
      throw new FastFailError(
        `invalid region in path prefix: "${split.invalidRegion}" (expected e.g. /region/us-west-2/...)`,
        'EBADREGION'
      );
    }
    if (split.region) {
      region = split.region;
      clientPath = split.path;
      upstream.host = hostForRegion(upstream.host, region);
    }
  }

  const isHttps = upstream.protocol === 'https:';
  const transport = isHttps ? https : http;
  const wirePath = joinPath(upstream.pathname, clientPath);

  let outHeaders;
  if (isAws) {
    outHeaders = require('./sigv4').signedHeaders({
      method,
      path: wirePath,
      headers,
      body,
      host: upstream.host,
      region,
      service: (typeof listener === 'object' && listener.service) || undefined,
    });
    delete outHeaders.host;
    delete outHeaders.Host;
    outHeaders.host = upstream.host;
    // Recompute content-length for safety; drop hop-by-hop noise.
    delete outHeaders['content-length'];
    if (body && body.length) outHeaders['content-length'] = body.length;
  } else {
    // Copy headers untouched (auth included) but fix Host to match upstream.
    outHeaders = Object.assign({}, headers);
    delete outHeaders.host;
    delete outHeaders.Host;
    outHeaders.host = upstream.host;
  }

  return {
    transport,
    options: {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (isHttps ? 443 : 80),
      method,
      path: wirePath,
      headers: outHeaders,
    },
  };
}

// One buffered attempt. Resolves with { statusCode, headers, body } on any
// completed HTTP response (including 4xx/5xx — real API answers, passed through
// untouched). Rejects with a NetworkError only when the connection itself failed.
function forwardOnce(listener, request) {
  const { transport, options } = buildOptions(listener, request);
  const { body } = request;

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
      res.on('error', (err) => reject(classify(err)));
    });

    req.setTimeout(config.upstreamTimeoutMs, () => {
      req.destroy(new NetworkError('upstream timeout', 'ETIMEDOUT'));
    });
    req.on('error', (err) => reject(classify(err)));

    if (body && body.length) req.write(body);
    req.end();
  });
}

// One streaming attempt. Resolves with { statusCode, headers, res } as soon as
// response HEADERS arrive; the caller pipes `res` to the client for live tokens.
// Rejects with a NetworkError only if the connection fails BEFORE any response
// byte (pre-first-byte: safe to replay). Errors after headers surface on `res`.
function openUpstream(listener, request) {
  const { transport, options } = buildOptions(listener, request);
  const { body } = request;

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = transport.request(options, (res) => {
      settled = true;
      resolve({ statusCode: res.statusCode, headers: res.headers, res });
    });

    // The inactivity timeout only guards the pre-response phase; once we resolve
    // the caller owns the stream, and we must not kill a slow-but-legitimate
    // token stream on a long turn.
    req.setTimeout(config.upstreamTimeoutMs, () => {
      if (!settled) req.destroy(new NetworkError('upstream timeout', 'ETIMEDOUT'));
    });
    req.on('error', (err) => {
      if (!settled) reject(classify(err));
    });

    if (body && body.length) req.write(body);
    req.end();
  });
}

// If the upstream URL has a base path (rare), prefix it; otherwise pass the
// client path through unchanged.
function joinPath(basePath, reqPath) {
  if (!basePath || basePath === '/') return reqPath;
  return basePath.replace(/\/$/, '') + reqPath;
}

module.exports = {
  forwardOnce,
  openUpstream,
  NetworkError,
  FastFailError,
  isNetworkErrorCode,
  isTlsErrorCode,
  classify,
  splitRegionPrefix,
  hostForRegion,
};
