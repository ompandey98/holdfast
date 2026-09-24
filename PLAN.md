# Holdfast

> Hold your Claude Code session fast through any network drop.

> **Status note (v1.1.0):** this is the original design document, kept for the
> reasoning behind the architecture. Where it differs from what shipped, the
> README is authoritative. The three material changes since: the hold window
> defaults to **180 minutes**, not 60; responses **stream through live** instead
> of the buffer-then-relay MVP in §4 (only a PRE-FIRST-BYTE drop is held and
> replayed); and there are four listeners plus managed, revertible routing for
> Claude Code (including Bedrock) and Kiro — see `holdfast claude enable`,
> `holdfast kiro enable` and `holdfast doctor`.

A tiny local proxy that sits between Claude Code and the Anthropic API. When your
VPN reconnects, wifi switches, or the internet blips for a few seconds, Holdfast
**holds the in-flight request**, polls connectivity every 30s for up to an hour,
and the instant the network is back it **replays the request and streams the
answer through** — so your chat/workflow never dies and you never have to type
"continue".

---

## 1. The core problem (and why a skill can't fix it)

When the network drops mid-request, Claude Code's HTTPS call to `api.anthropic.com`
fails with a connection/network error. That error surfaces in the CLI and the turn
stops. It only resumes when you manually type something.

A **skill cannot fix this**, because:
- A skill is instructions *inside* the model. Running it requires an API call.
- The API call is the exact thing that's failing.
- You can't recover a broken network call using a mechanism that itself needs the
  network. The fix must live **outside and underneath** Claude Code.

## 2. The architecture: a local resilient proxy

```
┌─────────────┐        ┌──────────────────────┐        ┌───────────────────┐
│ Claude Code │ ─────► │  Holdfast (localhost) │ ─────► │ api.anthropic.com │
│             │ ◄───── │  hold · poll · replay │ ◄───── │                   │
└─────────────┘        └──────────────────────┘        └───────────────────┘
      talks to localhost         the resilient layer          the real API
```

Claude Code is pointed at Holdfast instead of the real API using a single env var:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

Holdfast forwards every request to the real API. **The difference is what it does
on failure**: instead of passing the network error back to Claude Code, it swallows
the error, waits for the network to return, and retries the same request. From
Claude Code's point of view, the request simply "took a while" — the turn never
breaks.

## 3. How it behaves (the loop)

For each incoming request:

1. **Forward** the request to `https://api.anthropic.com` (headers + body passed
   through untouched, including the user's API key / auth header).
2. **If it succeeds** → relay the response back to Claude Code. Done.
3. **If it fails with a network/connection error** (DNS fail, connection refused,
   timeout, socket reset, TLS handshake fail):
   - Do **not** return the error to Claude Code. Keep the client connection open.
   - Enter the **hold loop**: every **30 seconds**, run a lightweight connectivity
     probe. Retry for up to **1 hour** (= **120 attempts**).
   - The moment a probe succeeds → **replay the original request** and relay the
     response back.
   - If the full hour elapses with no network → *then* return the error (genuine
     long outage; nothing more we can do).
4. Log every state transition so you can see what happened without watching the
   screen.

**Connectivity probe:** a cheap `HEAD`/TCP check against a reliable host (e.g.
`api.anthropic.com:443` or `1.1.1.1`) rather than firing a full expensive API
request each time. Only when the probe passes do we replay the real request.

## 4. The one hard case: mid-stream drops

Claude Code uses **streaming** (Server-Sent Events). Two failure shapes:

- **(A) Drop before/at connection time** — nothing was sent to the client yet.
  Trivially safe to hold + replay. This covers most short blips (VPN/wifi switch
  happening between turns or at the very start of a turn).

- **(B) Drop mid-stream** — the client already received partial tokens. You cannot
  transparently "resume" an SSE stream: the Anthropic API has no resume-from-offset,
  and replaying would duplicate the tokens the client already saw.

**MVP decision — buffer-then-relay:** Holdfast reads the *entire* upstream response
before sending anything to Claude Code. If the upstream stream dies partway,
nothing was forwarded to the client yet, so a clean full replay is always safe.
Cost: within a turn you lose token-by-token streaming (the answer appears once
complete). This is an acceptable and honest trade — it's exactly the "request just
took a while" behavior you asked for, and it makes recovery 100% reliable.

**v2 option — pass-through streaming with mid-stream recovery:** stream normally;
on a mid-stream drop, buffer what was already sent and, on reconnect, issue a
continuation request (prefill the assistant turn with the partial text) so the
model continues rather than restarts. More complex and slightly lossy at the seam;
deferred until the MVP proves out.

## 5. Components / file layout

```
Holdfast/
├── PLAN.md            ← this file
├── README.md          ← quickstart (written with the code)
├── package.json       ← Node project (or pyproject.toml if we go Python)
├── src/
│   ├── server.js      ← HTTP server on localhost, request handler
│   ├── forward.js     ← forwards request upstream, detects network errors
│   ├── holdloop.js    ← the 30s×120 poll-and-retry loop + connectivity probe
│   ├── config.js      ← port, retry interval, max retries, upstream URL
│   └── log.js         ← timestamped state-transition logging to file + console
└── bin/
    └── holdfast       ← CLI entry: `holdfast start` / `holdfast status`
```

## 6. Config (defaults, all overridable)

| Setting              | Default                     | Meaning                                  |
|----------------------|-----------------------------|------------------------------------------|
| `PORT`               | `8787`                      | localhost port Claude Code points at     |
| `UPSTREAM`           | `https://api.anthropic.com` | real API                                 |
| `RETRY_INTERVAL`     | `30s`                       | how often to probe during a hold         |
| `MAX_RETRIES`        | `120`                       | 120 × 30s = 1 hour total hold window     |
| `PROBE_TARGET`       | `api.anthropic.com:443`     | connectivity probe host                  |
| `LOG_FILE`           | `~/.holdfast/holdfast.log`  | where transitions are recorded           |

## 7. Tech choice

**Node.js** (recommended for MVP):
- Native `http`/`https`, no build step, trivial streaming, one-file server.
- Claude Code users already have Node.
- Alternative: Python + `aiohttp` if you prefer — same design, either works.

## 8. Usage (target UX)

```bash
# one-time
npm install -g holdfast          # or: node bin/holdfast

# each session (or put in shell profile)
holdfast start                   # starts proxy on :8787, prints the export line
export ANTHROPIC_BASE_URL=http://localhost:8787
claude                           # Claude Code now runs through Holdfast
```

Live log during a blip:
```
holdfast start
  ↳ proxy live on :8787  →  api.anthropic.com
  ↳ [14:02:11] request in-flight
  ↳ [14:02:13] upstream network error (ECONNRESET) — entering hold
  ↳ [14:02:43] probe 1/120 … no network
  ↳ [14:03:13] probe 2/120 … no network
  ↳ [14:03:31] probe 3/120 … BACK ONLINE — replaying request
  ↳ [14:03:34] response relayed ✓  (held 81s, session intact)
```

## 9. Build order

1. **Skeleton server** — localhost HTTP server that forwards to upstream and relays
   the response (happy path only). Verify Claude Code works through it normally.
2. **Error classification** — detect network/connection errors vs real API errors
   (4xx/5xx from Anthropic must pass through unchanged — those are *not* our job).
3. **Buffer-then-relay** — read full upstream response before forwarding.
4. **Hold loop** — 30s × 120 poll with connectivity probe; replay on reconnect.
5. **Logging + CLI** — `holdfast start/status`, timestamped log file.
6. **Test** — start a session, pull wifi for 30–60s mid-turn, confirm it resumes
   with no user input.

## 10. Open decisions (confirm before coding)

- **Streaming vs buffer:** go with buffer-then-relay for MVP? (recommended — most
  reliable). ✅ default
- **Auth pass-through:** Holdfast forwards your existing auth header untouched and
  never stores it. ✅
- **Language:** Node.js. ✅ (say the word if you'd rather Python)
- **Idempotency guard:** only replay on *network* errors, never on a request that
  already got a response — so we never double-charge / double-run a turn. ✅
