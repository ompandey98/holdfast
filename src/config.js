'use strict';

// Holdfast configuration. Every value has a sane default and can be overridden
// with an environment variable (or CLI flag, which sets the env var) so no code
// edits are ever needed.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// --- Hold window -----------------------------------------------------------
// How long to keep holding a request while the network is down. Expressed in
// friendly minutes; converted to a retry count against the probe interval.
// Three hours by default: a hotel/flight/VPN outage that outlasts an hour is
// exactly the case worth surviving, and holding costs nothing while idle.
const holdMinutes = intEnv('HOLDFAST_HOLD_MINUTES', 180);
const retryIntervalMs = intEnv('HOLDFAST_RETRY_INTERVAL_MS', 30_000);
const maxRetries =
  intEnv('HOLDFAST_MAX_RETRIES', 0) ||
  Math.max(1, Math.ceil((holdMinutes * 60_000) / retryIntervalMs));

// --- Region resolution -----------------------------------------------------
// The regions KRS actually serves. A region outside this set has no
// runtime.<region>.kiro.dev host at all, so we never forward to one.
const KRS_REGIONS = new Set(['us-east-1', 'eu-central-1', 'us-gov-west-1', 'us-gov-east-1']);

// Read a value out of ~/.claude/settings.json without letting a malformed file
// break startup.
function claudeSetting(pathParts) {
  try {
    let node = JSON.parse(fs.readFileSync(paths.claudeSettingsFile(), 'utf8'));
    for (const part of pathParts) {
      if (!node || typeof node !== 'object') return null;
      node = node[part];
    }
    return typeof node === 'string' ? node : null;
  } catch (_) {
    return null;
  }
}

// Kiro records the region it is signed in to in its profile ARN, e.g.
// arn:aws:codewhisperer:us-east-1:...:profile/ABC. That — not AWS_REGION — is
// the region whose krsEndpoints override Kiro will honour.
function detectKiroRegion() {
  try {
    const profile = JSON.parse(fs.readFileSync(paths.kiroProfileFile(), 'utf8'));
    const m = /^arn:[^:]*:codewhisperer:([a-z0-9-]+):/.exec(String(profile.arn || ''));
    if (m && KRS_REGIONS.has(m[1])) return m[1];
  } catch (_) {}
  return 'us-east-1';
}

// Bedrock's region: explicit override, then the process environment, then the
// region Claude Code itself uses (~/.claude/settings.json env.AWS_REGION) —
// which is what a wrapper-launched Bedrock setup actually talks to — then
// us-east-1.
function bedrockRegion() {
  return (
    process.env.HOLDFAST_BEDROCK_REGION ||
    process.env.AWS_REGION ||
    claudeSetting(['env', 'AWS_REGION']) ||
    'us-east-1'
  );
}

// --- Listeners -------------------------------------------------------------
// Each listener is one local port mapped to one upstream API. A single
// Holdfast process can protect many tools/providers at once. Route by port:
// each IDE points its base-URL setting at the matching port.
//
// Advanced: set HOLDFAST_LISTENERS to a JSON array, e.g.
//   [{"name":"anthropic","port":8787,"upstream":"https://api.anthropic.com"},
//    {"name":"openai","port":8788,"upstream":"https://api.openai.com"}]
function parseListeners() {
  if (process.env.HOLDFAST_LISTENERS) {
    try {
      const arr = JSON.parse(process.env.HOLDFAST_LISTENERS);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) {
      // fall through to default
    }
  }
  // Every listener is ON by default. A listener is passive — it is just a
  // localhost port that does nothing until a tool actually points its base URL
  // at it — so running all of them costs nothing and requires zero decisions
  // from the user: run one command and every supported IDE/tool is protected.
  // (A port already in use is skipped with a warning at startup; it never takes
  // down the others — see server.js.) Power users can still fully override the
  // set with HOLDFAST_LISTENERS.

  // KRS (Kiro's chat backend) is region-gated to a small set and is INDEPENDENT
  // of the AWS SDK region — Kiro itself falls back to the KRS default
  // (us-east-1) for any unsupported region, so we do NOT read AWS_REGION here
  // (that's Bedrock's region and is often unsupported by KRS, which would
  // forward to a non-existent runtime.<region>.kiro.dev host).
  //
  // Kiro only honours a krsEndpoints override for the region it resolved from
  // its profile ARN, so the listener's region MUST match that ARN or the
  // override is silently ignored. We therefore detect it (see kiroRegion()).
  const krsRequested =
    process.env.HOLDFAST_KIRO_REGION || process.env.HOLDFAST_CODEWHISPERER_REGION;
  const krsRegion = KRS_REGIONS.has(krsRequested) ? krsRequested : detectKiroRegion();

  const listeners = [
    {
      name: 'anthropic',
      port: intEnv('HOLDFAST_PORT', 8787),
      upstream: process.env.HOLDFAST_UPSTREAM || 'https://api.anthropic.com',
    },
    {
      name: 'openai',
      port: intEnv('HOLDFAST_OPENAI_PORT', 8788),
      upstream: process.env.HOLDFAST_OPENAI_UPSTREAM || 'https://api.openai.com',
    },
    {
      name: 'bedrock',
      port: intEnv('HOLDFAST_BEDROCK_PORT', 8789),
      upstream:
        process.env.HOLDFAST_BEDROCK_UPSTREAM ||
        `https://bedrock-runtime.${bedrockRegion()}.amazonaws.com`,
      // AWS endpoints need SigV4: Holdfast re-signs each attempt with this
      // machine's own AWS credentials (credential chain in credentials.js).
      aws: true,
      // The service to sign as. Stated rather than inferred, so a custom
      // upstream (VPC endpoint, corporate proxy) still signs correctly.
      service: 'bedrock',
      // Accepts a /region/<r> path prefix so ONE listener can serve whichever
      // region the client is actually configured for (Claude Code's region is
      // its own setting, not Holdfast's) — see forward.js.
      regionPrefix: true,
      region: bedrockRegion(),
    },
    {
      // Kiro's chat streams through the Kiro Runtime Service (KRS). The agent
      // extension builds ONE streaming client:
      //   new CodeWhispererStreaming({ ...getKrsConfig(), token: { token } })
      // whose endpoint defaults to https://runtime.<region>.kiro.dev (NOT
      // q.amazonaws.com and NOT codewhisperer.amazonaws.com — those are legacy /
      // unused-for-chat). Auth is an SSO Bearer token, NOT SigV4, so Holdfast
      // passes Authorization through untouched (aws:false).
      //
      // To route Kiro through this listener the client's endpoint must be set —
      // Kiro sets an EXPLICIT endpoint, so the AWS SDK ignores AWS_ENDPOINT_URL*;
      // the hook is Kiro's own trusted setting, in Kiro settings.json:
      //   "codewhisperer.config.krsEndpoints": [
      //     { "region": "us-east-1", "endpoint": "http://localhost:8790" }
      //   ]
      // That touches ONLY Kiro and cannot affect Claude Code or any other tool.
      name: 'kiro',
      port: intEnv('HOLDFAST_KIRO_PORT', 0) || intEnv('HOLDFAST_CODEWHISPERER_PORT', 8790),
      upstream:
        process.env.HOLDFAST_KIRO_UPSTREAM ||
        process.env.HOLDFAST_CODEWHISPERER_UPSTREAM ||
        `https://runtime.${krsRegion}.kiro.dev`,
      // Bearer-token auth, not SigV4 — pass Authorization through untouched.
      aws: false,
      // Marks this listener for the KRS request-shape filter: a stray local
      // tool that happens to use this port must not be proxied to Kiro.
      kiro: true,
      region: krsRegion,
    },
  ];

  return listeners;
}

const config = {
  holdMinutes,
  retryIntervalMs,
  maxRetries,

  listeners: parseListeners(),

  // Invisible SSE keep-alive pings sent to the client while holding, so the
  // client's socket never idles out during a long outage. THIS is what lets a
  // 20-30 minute outage survive without the turn dying.
  heartbeatMs: intEnv('HOLDFAST_HEARTBEAT_MS', 15_000),

  // Connectivity probe.
  probeTimeoutMs: intEnv('HOLDFAST_PROBE_TIMEOUT_MS', 5_000),
  probeHost: process.env.HOLDFAST_PROBE_HOST || null, // resolved from upstream if null
  probePort: intEnv('HOLDFAST_PROBE_PORT', 443),

  // Max time for a single upstream attempt before it counts as a network
  // failure. Generous — model responses can take minutes.
  upstreamTimeoutMs: intEnv('HOLDFAST_UPSTREAM_TIMEOUT_MS', 600_000),

  logFile:
    process.env.HOLDFAST_LOG_FILE || path.join(paths.holdfastHome(), 'holdfast.log'),
  logConsole: process.env.HOLDFAST_LOG_CONSOLE !== '0',

  // Reject requests on the Kiro listener that are not KRS-shaped (a local dev
  // server sharing the port would otherwise be forwarded to kiro.dev). Set
  // HOLDFAST_KIRO_FILTER=0 to forward everything, as before.
  kiroFilter: process.env.HOLDFAST_KIRO_FILTER !== '0',

  krsRegions: KRS_REGIONS,
  bedrockRegion: bedrockRegion(),
  detectKiroRegion,
  claudeSetting,
};

module.exports = config;
