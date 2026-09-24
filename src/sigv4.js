'use strict';

// Minimal AWS Signature Version 4 signer, pure Node stdlib. Holdfast re-signs
// requests bound for AWS endpoints (Bedrock) with this machine's own AWS
// credentials, because the signature the client sent was computed for
// localhost and would be rejected upstream. Signing happens per attempt:
// SigV4 signatures expire ~5 minutes after their timestamp, so a request
// replayed after a long hold must be re-signed, and credentials are re-read
// from disk each time so refreshes (ada, SSO) are picked up automatically.

const crypto = require('crypto');

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

// RFC 3986 strict encoding, AWS canonical form.
function uriEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// Credential resolution lives in credentials.js (full chain: explicit command,
// Claude Code's awsCredentialExport, environment, credential_process, static
// keys — cached until shortly before expiry). Kept exported under the old name
// for compatibility; returns null instead of throwing, as it always did.
function loadCredentials() {
  try {
    return require('./credentials').resolve();
  } catch (_) {
    return null;
  }
}

// bedrock-runtime.us-east-1.amazonaws.com -> service 'bedrock', region 'us-east-1'.
// The BedrockRuntime API signs under the service name 'bedrock'.
//
// `looksAws` matters: a custom upstream (a VPC endpoint, a corporate proxy, a
// test double) tells us nothing about the service or region, and guessing from
// its hostname produced nonsense scopes like ".../us-west-2/127/aws4_request".
// In that case the caller's explicit service/region win.
function serviceAndRegion(host) {
  const bare = String(host).split(':')[0];
  const labels = bare.split('.');
  const looksAws = /\.amazonaws\.com(\.cn)?$/.test(bare) && labels.length >= 4;
  let service = looksAws ? labels[0] : null;
  if (service === 'bedrock-runtime') service = 'bedrock';
  return { service, region: looksAws ? labels[1] : null, looksAws };
}

// Sign and return the outbound headers: original headers minus the client's
// stale auth, plus fresh x-amz-date / x-amz-content-sha256 / authorization.
// `path` must be the exact wire path that will be sent upstream.
function signedHeaders({ method, path: reqPath, headers, body, host, region: regionOverride, service: serviceOverride }) {
  // Full credential chain, cached and auto-refreshed near expiry. Throws a
  // CredentialError, which the server renders as a readable AWS-shaped 403
  // instead of a bare 502 — and which is never held (it is not a network fault).
  const creds = require('./credentials').resolve();
  const derived = serviceAndRegion(host);
  // An explicit region (from a /region/<r> prefix or the listener config) wins
  // over the one inferred from the host, so a signature is never scoped to the
  // wrong region. Same for the service, which a non-AWS upstream cannot imply.
  const service = derived.service || serviceOverride || 'bedrock';
  const region = regionOverride || derived.region || 'us-east-1';

  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const [rawPath, rawQuery = ''] = String(reqPath).split('?');
  // Canonical URI: for non-S3 services each (already wire-encoded) segment is
  // encoded once more.
  const canonicalUri = rawPath.split('/').map(uriEncode).join('/') || '/';
  const canonicalQuery = rawQuery
    ? rawQuery
        .split('&')
        .filter(Boolean)
        .map((pair) => {
          const [k, v = ''] = pair.split('=');
          return `${uriEncode(decodeURIComponent(k))}=${uriEncode(decodeURIComponent(v))}`;
        })
        .sort()
        .join('&')
    : '';

  const payloadHash = sha256hex(body && body.length ? body : Buffer.alloc(0));

  const toSign = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (creds.sessionToken) toSign['x-amz-security-token'] = creds.sessionToken;

  const signedNames = Object.keys(toSign).sort();
  const canonicalHeaders = signedNames.map((h) => `${h}:${String(toSign[h]).trim()}\n`).join('');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  const out = Object.assign({}, headers);
  delete out.authorization;
  delete out.Authorization;
  delete out['x-amz-date'];
  delete out['x-amz-security-token'];
  delete out['x-amz-content-sha256'];

  out['x-amz-date'] = amzDate;
  out['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) out['x-amz-security-token'] = creds.sessionToken;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
  return out;
}

module.exports = { signedHeaders, loadCredentials, serviceAndRegion };
