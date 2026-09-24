'use strict';

// A guard for the Kiro listener.
//
// Ports in the 87xx range are popular, and a local dev server sharing 8790 was
// observed having its traffic (GET /d01-....mp4) forwarded to
// runtime.us-east-1.kiro.dev. Forwarding a random local request to Kiro's
// backend is wrong in both directions, so the Kiro listener only proxies
// requests that have the SHAPE of a Kiro Runtime Service call and answers
// anything else locally with a 404.
//
// This is a shape check, not an operation allowlist: KRS RPCs are POSTs to a
// single PascalCase path segment (e.g. /generateAssistantResponse — the wire
// path Kiro's streaming client uses). We deliberately do not hard-code the set
// of operation names, because Kiro adds them over time and a stale allowlist
// would break real chat. Extend with HOLDFAST_KIRO_ALLOW_PATHS (comma-separated
// regular expressions) or switch the guard off with HOLDFAST_KIRO_FILTER=0.

const RPC_PATH = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

function extraPatterns() {
  const raw = process.env.HOLDFAST_KIRO_ALLOW_PATHS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new RegExp(s);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

// Does this look like a Kiro Runtime Service call?
function isKrsRequest(method, url) {
  const pathOnly = String(url || '').split('?')[0];
  if (extraPatterns().some((re) => re.test(pathOnly))) return true;
  if (String(method).toUpperCase() !== 'POST') return false;
  if (/\.[A-Za-z0-9]{1,8}$/.test(pathOnly)) return false; // /foo.mp4, /bundle.js
  return RPC_PATH.test(pathOnly);
}

// Log noise control: a busy neighbour on the port could otherwise fill the log.
const lastLogged = new Map();

function shouldLog(key, intervalMs = 60_000) {
  const now = Date.now();
  const prev = lastLogged.get(key) || 0;
  if (now - prev < intervalMs) return false;
  lastLogged.set(key, now);
  return true;
}

module.exports = { isKrsRequest, shouldLog };
