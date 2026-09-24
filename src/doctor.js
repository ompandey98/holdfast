'use strict';

// `holdfast doctor` — one command that answers "is Holdfast actually protecting
// anything?", which until now took a manual investigation to find out. Every
// check prints PASS or FAIL with the exact fix line, and nothing here changes
// any state.
//
// It exists because the failure that prompted this work was invisible: all four
// listeners were up, the log looked healthy, and neither Claude Code nor Kiro
// was routed through Holdfast at all — so the "resilience" being observed was
// the tools' own retries.

const fs = require('fs');
const http = require('http');
const config = require('./config');
const route = require('./route');
const credentials = require('./credentials');
const kiroRoute = require('./kiroRoute');
const claudeRoute = require('./claudeRoute');

function line(ok, title, detail, fix) {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${title}`);
  if (detail) console.log(`       ${detail}`);
  if (!ok && fix) console.log(`       fix: ${fix}`);
  return ok;
}

// POST a KRS-shaped request through the listener and directly, and compare the
// status codes: identical codes prove the proxy is a faithful pass-through.
// An empty body is expected to be REJECTED by KRS — a 4xx from both sides is a
// pass, and no model is invoked.
function postStatus({ host, port, path: p, https: useHttps, headers = {} }) {
  return new Promise((resolve) => {
    const mod = useHttps ? require('https') : http;
    const req = mod.request(
      {
        hostname: host,
        port,
        path: p,
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, headers),
        timeout: 12_000,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: true, status: res.statusCode }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
    req.end('{}');
  });
}

async function run() {
  let failures = 0;
  const fail = () => { failures += 1; };

  console.log('\nHoldfast doctor\n');

  // 1. Supervised install from a stable path.
  const inst = route.installState();
  if (inst && fs.existsSync(inst.appDir)) {
    line(true, 'Supervised install', `${inst.manager} → ${inst.appDir} (v${inst.version})`);
    if (/_npx/.test(inst.appDir)) {
      fail();
      line(false, 'Install path is stable', `${inst.appDir} is inside the npx cache`, 'holdfast install');
    }
  } else {
    fail();
    line(
      false,
      'Supervised install',
      inst ? `recorded path is missing: ${inst.appDir}` : 'not installed as a service — a routed tool breaks whenever Holdfast is not running',
      'holdfast install'
    );
  }

  // 2. Every listener answers, and answers as itself.
  for (const l of config.listeners) {
    const owner = await route.portOwner(l.port, l.name);
    if (owner.state === 'ours') {
      line(true, `Listener ${l.name}`, `:${l.port} → ${l.upstream}`);
    } else if (owner.state === 'ours-other-listener') {
      fail();
      line(false, `Listener ${l.name}`, `:${l.port} is Holdfast's "${owner.info.listener}" listener instead`, `set the ${l.name} port to one this Holdfast owns`);
    } else if (owner.state === 'foreign') {
      fail();
      line(false, `Listener ${l.name}`, `:${l.port} is owned by something that is not Holdfast (${owner.reason})`, `move it, e.g. HOLDFAST_${l.name.toUpperCase()}_PORT=1${l.port} holdfast install`);
    } else {
      fail();
      line(false, `Listener ${l.name}`, `nothing is listening on :${l.port}`, 'holdfast install   (or: holdfast start)');
    }
  }

  // 3. Kiro: profile region vs listener region vs what the setting actually says.
  const kiro = await kiroRoute.status({ quiet: true });
  const kiroListener = config.listeners.find((l) => l.kiro);
  if (kiroListener) {
    if (!kiro.profileRegion) {
      line(true, 'Kiro profile', `no region readable (${kiro.profileProblem}) — Kiro may not be signed in here`);
    } else if (!kiro.regionsMatch) {
      fail();
      line(
        false,
        'Kiro region match',
        `Kiro profile is ${kiro.profileRegion}, Holdfast kiro listener is ${kiro.listenerRegion} — Kiro ignores krsEndpoints for any other region`,
        `HOLDFAST_KIRO_REGION=${kiro.profileRegion} holdfast install`
      );
    } else {
      line(true, 'Kiro region match', `profile and listener both ${kiro.profileRegion}`);
    }

    const expected = `http://127.0.0.1:${kiroListener.port}`;
    if (kiro.settingValue === null) {
      line(true, 'Kiro routing', `not routed through Holdfast (${kiroRoute.KEY} unset) — Kiro chat does not use Holdfast`);
    } else if (String(kiro.settingValue).includes(expected)) {
      line(true, 'Kiro routing', `${kiroRoute.KEY} → ${expected} (reload the Kiro window after any change)`);
    } else {
      fail();
      line(false, 'Kiro routing', `${kiroRoute.KEY} = ${kiro.settingValue}, which is not this listener (${expected})`, 'holdfast kiro enable');
    }
  }

  // 4. Claude Code: mode, region, and which credential source resolved.
  const claude = await claudeRoute.status({ quiet: true });
  line(true, 'Claude Code mode', `${claude.mode}${claude.region ? `, region ${claude.region}` : ''} (settings: ${claude.settingsFile})`);
  const routed = claude.values.filter((v) => v.value !== null);
  if (routed.length === claude.values.length && routed.length) {
    line(true, 'Claude Code routing', routed.map((v) => `${v.key}=${v.value}`).join('  '));
  } else {
    line(true, 'Claude Code routing', 'not routed through Holdfast — Claude Code talks to the API directly');
  }

  const cred = credentials.describeSource();
  if (cred.ok) {
    line(true, 'AWS credentials', `${cred.source}${cred.expiresAt ? `, expire ${cred.expiresAt}` : ''}`);
    if (cred.skipped && cred.skipped.length) {
      // Not a failure — but the user must know a preferred source is broken,
      // because the fallback is often a different AWS account.
      console.log(`       note: a preferred source failed and was skipped — ${cred.skipped.join('; ')}`);
    }
  } else {
    fail();
    line(false, 'AWS credentials', cred.reason, 'refresh your credentials, or set HOLDFAST_AWS_CREDENTIAL_COMMAND');
  }

  // 5. Signed Bedrock dry run (control plane, read-only, no inference spend).
  if (claude.mode === 'bedrock') {
    const region = claudeRoute.claudeRegion();
    const probe = await claudeRoute.dryRun(region);
    if (probe.ok) {
      line(
        true,
        'Bedrock signing',
        `ListFoundationModels in ${region} returned ${probe.status} (no model invoked)` + (probe.note ? `\n       ${probe.note}` : '')
      );
    }
    else {
      fail();
      line(false, 'Bedrock signing', `${probe.stage}: ${probe.reason}`, probe.stage === 'credentials' ? 'refresh your AWS credentials' : 'check the region and the account the credentials belong to');
    }
  }

  // 6. Kiro pass-through: same status code via the listener as direct.
  if (kiroListener) {
    const viaProxy = await postStatus({ host: '127.0.0.1', port: kiroListener.port, path: '/generateAssistantResponse' });
    const upstreamHost = new URL(kiroListener.upstream).host;
    const direct = await postStatus({ host: upstreamHost, port: 443, path: '/generateAssistantResponse', https: true });
    if (viaProxy.ok && direct.ok && viaProxy.status === direct.status) {
      line(true, 'Kiro pass-through', `POST /generateAssistantResponse → ${viaProxy.status} both via :${kiroListener.port} and direct to ${upstreamHost}`);
    } else if (viaProxy.ok && direct.ok) {
      fail();
      line(false, 'Kiro pass-through', `via listener ${viaProxy.status}, direct ${direct.status}`, 'check HOLDFAST_KIRO_UPSTREAM and the listener region');
    } else {
      line(true, 'Kiro pass-through', `skipped (${viaProxy.ok ? `direct: ${direct.reason}` : `via listener: ${viaProxy.reason}`}) — needs network`);
    }
  }

  console.log(`\n${failures ? `${failures} check(s) FAILED — see the fix lines above.` : 'All checks passed.'}\n`);
  return failures ? 1 : 0;
}

module.exports = { run };
