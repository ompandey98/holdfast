# Holdfast

Holdfast keeps your AI coding session running when your internet drops. Normally, if the wifi blips mid-task, the tool's API request fails, the session freezes, and you have to come back and restart it by hand — Holdfast retries the failed request automatically until the network returns, so the session finishes on its own.

It works as a small proxy on `localhost`, sitting between your tool (Claude Code, Codex, other IDE agents) and the model API. When a request fails on a connection error, Holdfast holds it, checks for connectivity every 30 seconds, and replays it the moment you're back online. From the tool's side the request just took a little longer. Nothing to retype, nothing to resend.

It is deliberately not an MCP server, a plugin, or a skill. Anything living inside the model needs the network to function — exactly what's broken during a drop. Holdfast runs underneath as a plain background process, already awake before the connection ever fails. The label, if you want one: a local resilience proxy.

## What it does

- Sits on `localhost` and forwards your tool's API traffic to the real model API.
- On a network error, holds the in-flight request instead of failing the turn.
- Probes connectivity on an interval and replays the request the moment the connection is back.
- Sends invisible keep-alive pings during a hold so the client connection doesn't time out on long outages.
- Only retries genuine network failures. Real API responses (including 4xx/5xx) pass straight through, so a turn is never double-run.
- Streams responses through live — tokens arrive as the model produces them (SSE and AWS event-stream alike), so the screen never freezes waiting on a buffered blob. If the connection drops *before the first byte*, the request is held and replayed cleanly; a drop *after* streaming has begun is surfaced honestly rather than silently re-run (the client already holds a partial answer).
- Passes your API key or bearer token through untouched. It is never stored or logged.
- Holds for **3 hours** by default, so an outage that outlasts a coffee break still ends in a finished turn.
- Routes your tools for you — `holdfast claude enable` / `holdfast kiro enable` — writing the setting where the tool actually reads it, backing the file up, and reverting exactly. It refuses to route a tool unless Holdfast is supervised, so a tool is never left pointing at a dead port.
- Re-signs AWS (Bedrock) requests with the credentials your tool itself uses, for the region your tool itself uses.
- Tells you the truth about whether it is doing anything: `holdfast doctor`.

## Requirements

Node 16 or newer. That's the whole list: no dependencies, no build step.

## Usage

Run it straight from GitHub with npx, from anywhere, on any machine:

```bash
npx -y github:ompandey98/holdfast start
```

The `-y` tells npx to fetch and run without a confirmation prompt, so this is always a single command.

Point your tool at it. For Claude Code on the Anthropic API:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude
```

Drop that export line into your shell profile (`~/.zshrc` or `~/.bashrc`) and you can forget it's there. Use your tool exactly as before; Holdfast is an invisible pass-through until the moment the network drops, and then it earns its keep.

Two limits of that one-liner, both worth knowing before you rely on it:

- **It only reaches a tool you launch from that shell.** A wrapper-launched
  Claude Code (common in corporate Bedrock setups) never sees the export — use
  `holdfast claude enable` instead, which writes it into `~/.claude/settings.json`.
- **A tool pointed at Holdfast is hard-down whenever Holdfast is not running.**
  Close the terminal and the proxy goes with it. Run `holdfast install` first so a
  supervisor keeps it alive; the managed routing commands insist on that.

Prefer a copy on disk (to auto-start it, tweak it, or skip the re-fetch)?

```bash
git clone https://github.com/ompandey98/holdfast.git
cd holdfast
node bin/holdfast start
```

### The recommended setup (three commands)

Exporting a base URL only protects a tool you launch yourself from that same
shell, and it leaves that tool dead if Holdfast ever stops. The managed commands
do it properly — they install Holdfast under a supervisor first, write the
setting where the tool really reads it, back up every file they touch, and revert
cleanly:

```bash
npx -y github:ompandey98/holdfast install        # stable path + auto-start on login
npx -y github:ompandey98/holdfast claude enable  # route Claude Code (API or Bedrock)
npx -y github:ompandey98/holdfast kiro enable    # route Kiro chat (then reload the Kiro window)
npx -y github:ompandey98/holdfast doctor         # prove your tools are actually protected
```

**Check it with `doctor`, not by assuming.** A tool that was never routed through
Holdfast still looks fine during an outage, because the tool has retries of its
own — so "it seemed to survive" is not evidence that Holdfast did anything.
`holdfast stats` showing zero requests for a tool means that tool is not routed.

## Stopping it

From any terminal, on any system:

```bash
npx -y github:ompandey98/holdfast stop
```

If you cloned it, `node bin/holdfast stop` does the same. Or press `Ctrl-C` in the window where it's running. `stop` frees the port; if you installed the auto-start service it also stops the current process, though it will start again on next login (use `uninstall` to prevent that).

## Always-on

```bash
node bin/holdfast install     # launchd (macOS), systemd (Linux), Task Scheduler notes (Windows)
node bin/holdfast status      # confirm it's running, and that it is supervised
node bin/holdfast uninstall   # remove auto-start (reverts tool routing first)
```

`install` copies the package to `~/.holdfast/app/<version>/` and points the
service at that path — never at the `npx` cache, which is deleted periodically
and would leave the supervisor restarting a program that no longer exists. It
also bakes the options you chose into the service's own environment, so
`holdfast install --minutes 999` really holds for 999 minutes after a reboot, and
sets a restart throttle so a broken build backs off instead of looping.

Being supervised is a prerequisite for routing a tool: `claude enable` and
`kiro enable` refuse to run without it, because a tool pointed at a localhost
port is **hard-down** whenever nothing is listening there.

## Using it with other tools

Holdfast starts a listener for every supported provider automatically — Anthropic, OpenAI, Bedrock, and Kiro are all on by default. There is nothing to enable and nothing to declare about which tool or IDE you use: run the one command and every supported tool is protected. A listener is passive (just a localhost port that does nothing until a tool points at it), so running all of them costs nothing.

Holdfast routes by port. Each port maps to one upstream API; your tool chooses the port by which base URL you give it. The defaults are baked in, so they're the same on every machine.

| Tool | Setting to change | Point it at |
|---|---|---|
| Claude Code (Anthropic API) | `ANTHROPIC_BASE_URL` | `http://localhost:8787` |
| Claude Code (Bedrock mode) | `ANTHROPIC_BEDROCK_BASE_URL` + `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1` | `http://localhost:8789` |
| Codex / OpenAI tools | OpenAI base URL or `OPENAI_BASE_URL` | `http://localhost:8788` |
| Kiro | `codewhisperer.config.krsEndpoints` in Kiro settings (see below) | `http://localhost:8790` |
| Other Anthropic tools | that provider's base URL field | `http://localhost:8787` |
| Anything else | its base URL / endpoint field | its matching port |

The base URL you give a tool must point at the port whose upstream matches that tool's provider. Anthropic tools go to the Anthropic port, OpenAI tools to the OpenAI port, Bedrock-mode tools to the Bedrock port.

### Claude Code in Bedrock mode (including wrapper-launched)

Many corporate setups run Claude Code against **Bedrock**, launched by a wrapper
script, with the region and credentials coming from `~/.claude/settings.json`
(`env.AWS_REGION` and an `awsCredentialExport` command). Two things follow, and
both used to break this:

- **An exported shell variable never reaches a wrapper-launched Claude Code.**
  The routing has to be written into `~/.claude/settings.json` itself.
- **The region and the account are Claude's, not Holdfast's.** A proxy that signs
  with its own `AWS_REGION` and `~/.aws/credentials [default]` sends requests to
  the wrong region signed by the wrong account — a 403 that looks like a proxy bug.

So use the managed command:

```bash
holdfast claude enable     # after: holdfast install
```

It detects the mode (Bedrock or Anthropic API), runs a **signed dry run** before
changing anything, backs the file up, and writes:

```json
"env": {
  "ANTHROPIC_BEDROCK_BASE_URL": "http://127.0.0.1:8789/region/us-west-2",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH": "1"
}
```

The `/region/<r>` prefix is the important part: Holdfast strips it, forwards to
`bedrock-runtime.<r>.amazonaws.com`, and signs with scope `<r>` — so one listener
serves whatever region each client is configured for, regardless of Holdfast's
own environment. Start a new Claude Code session to pick it up; revert with
`holdfast claude disable`.

Anthropic-API users (an `ANTHROPIC_API_KEY`, no Bedrock) get
`env.ANTHROPIC_BASE_URL=http://127.0.0.1:8787` from the same command.

The dry run is `ListFoundationModels` on the Bedrock **control plane** — a
read-only call that invokes no model and costs nothing. An `AccessDenied` from it
still counts as success: it proves AWS accepted the credentials and the
signature, which is all Holdfast needs (it re-signs *your* request and never
needs a permission you did not already have).

**Credentials** are resolved through a chain, re-read on every attempt so a
refresh mid-hold is picked up and a replay after a long outage is signed freshly:

1. `HOLDFAST_AWS_CREDENTIAL_COMMAND` (explicit override)
2. `awsCredentialExport` from `~/.claude/settings.json` — the one a wrapper-launched
   Bedrock setup actually uses (disable with `HOLDFAST_USE_CLAUDE_CREDS=0`)
3. environment variables
4. `credential_process` for `HOLDFAST_AWS_PROFILE` / `AWS_PROFILE` in `~/.aws/config`
5. static keys in `~/.aws/credentials`

Both output shapes are accepted (`{"Credentials":{…}}` and the flat
`credential_process` form). A credential command that fails is retried once —
real helpers are flaky — and if a preferred source still fails, the fallback is
reported rather than used silently, because falling back usually means a
different AWS account. If no credentials can be had, the response is a readable
`403` with `x-amzn-errortype: HoldfastCredentialError` and a plain message, not
an opaque `502`, and it is **never** held.

### Kiro

Kiro does **not** go through Bedrock or the Anthropic API. Its agent chat streams
through the Kiro Runtime Service — `https://runtime.<region>.kiro.dev` — and
authenticates with an SSO **bearer token**, not SigV4, so Holdfast passes that
token through untouched.

```bash
holdfast kiro enable      # after: holdfast install
# then, in Kiro: Developer: Reload Window
```

That writes Kiro's own setting, for the right region, into the user
`settings.json`:

```json
"codewhisperer.config.krsEndpoints": [
  { "region": "us-east-1", "endpoint": "http://127.0.0.1:8790" }
]
```

Three caveats the command handles for you, each of which silently wastes an
afternoon otherwise:

- **The setting is read when the extension loads.** Nothing happens until you
  reload the Kiro window.
- **Only the region Kiro resolved from its profile ARN is honoured.** Kiro reads
  `globalStorage/kiro.kiroagent/profile.json`; an override for any other region
  is ignored without a word. `kiro enable` reads that ARN and refuses, with the
  fix, if the listener's region differs (`HOLDFAST_KIRO_REGION=<r> holdfast install`).
- **It is read from the user/global settings, in a trusted workspace only** —
  not from workspace settings.

Because `8790` is a popular port, the Kiro listener also answers anything that is
not a KRS-shaped call locally with `404 {"holdfast":"not a Kiro request"}`,
instead of forwarding a neighbouring dev server's traffic (a real case: `GET
/d01-….mp4`) to Kiro's backend. If a port clash is the situation you are in, move
Holdfast: `HOLDFAST_KIRO_PORT=18790 holdfast install && holdfast kiro enable`.
Switch the guard off with `HOLDFAST_KIRO_FILTER=0`, or widen it with
`HOLDFAST_KIRO_ALLOW_PATHS` (comma-separated regular expressions).

Revert with `holdfast kiro disable` (and reload the window). `holdfast stop` and
`holdfast uninstall` revert it for you, before the port goes away.

### Is it actually protecting anything? `holdfast doctor`

```bash
holdfast doctor
```

One command, `PASS`/`FAIL` per check with the fix line: supervised install and
its path; every listener answering as itself; Kiro's profile region vs the
listener vs the setting that is really in the file; Claude Code's mode, region
and which credential source resolved (name only, never key material); a signed
Bedrock dry run; and a Kiro pass-through comparison (the same status code through
the listener as direct to `kiro.dev`).

All four listeners (Anthropic, OpenAI, Bedrock, Kiro) run by default. To replace that set entirely — fewer, more, or custom providers — define your own:

```bash
export HOLDFAST_LISTENERS='[
  {"name":"anthropic","port":8787,"upstream":"https://api.anthropic.com"},
  {"name":"openai","port":8788,"upstream":"https://api.openai.com"}
]'
node bin/holdfast start
```

If a port is already taken, that one listener is skipped with a warning and the rest keep running — a busy port (usually Holdfast already running there) never fails the others or the process. Change any default port with its `HOLDFAST_*_PORT` variable.

## Hold duration

**Defaults to 180 minutes (3 hours)** — long enough to sit through a flight, a
hotel-wifi collapse or a VPN outage and still come back to a finished turn.
Holding costs nothing while it waits. Override per run, or persist it into the
service:

```bash
node bin/holdfast start --minutes 30       # this run only
node bin/holdfast install --minutes 999    # baked into the auto-start service
```

## Commands

| Command | Description |
|---|---|
| `holdfast start [--minutes N] [--port P]` | start the proxy (default command) |
| `holdfast install [--minutes N]` | copy to a stable path + auto-start on login, options baked in |
| `holdfast uninstall` | remove auto-start (reverts tool routing first) |
| `holdfast stop` | revert tool routing, then stop the proxy and free the ports |
| `holdfast status` | report each listener, and whether Holdfast is supervised |
| `holdfast stats` | lifetime counters: drops caught, sessions saved, per provider and per tool |
| `holdfast doctor` | diagnose whether your tools are ACTUALLY protected |
| `holdfast claude enable\|disable\|status` | route Claude Code (Bedrock or API) through Holdfast, revertibly |
| `holdfast kiro enable\|disable\|status` | route Kiro chat through Holdfast, revertibly |
| `holdfast help` | show help |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOLDFAST_HOLD_MINUTES` | `180` | how long to keep holding (3 hours) |
| `HOLDFAST_RETRY_INTERVAL_MS` | `30000` | connectivity probe interval |
| `HOLDFAST_HEARTBEAT_MS` | `15000` | keep-alive ping interval |
| `HOLDFAST_PORT` | `8787` | Anthropic listener port |
| `HOLDFAST_OPENAI_PORT` | `8788` | OpenAI listener port |
| `HOLDFAST_OPENAI_UPSTREAM` | `https://api.openai.com` | full OpenAI endpoint override |
| `HOLDFAST_BEDROCK_PORT` | `8789` | Bedrock listener port |
| `HOLDFAST_BEDROCK_UPSTREAM` | regional bedrock-runtime | full Bedrock endpoint override |
| `HOLDFAST_AWS_PROFILE` | `default` | AWS credentials profile used for signing |
| `HOLDFAST_KIRO_PORT` | `8790` | Kiro listener port |
| `HOLDFAST_KIRO_REGION` | `us-east-1` | KRS region (`us-east-1` / `eu-central-1`) |
| `HOLDFAST_KIRO_UPSTREAM` | `runtime.<region>.kiro.dev` | full Kiro endpoint override |
| `HOLDFAST_LISTENERS` | all four (Anthropic, OpenAI, Bedrock, Kiro) | JSON array to replace the default set |
| `HOLDFAST_AWS_CREDENTIAL_COMMAND` | – | command printing AWS credential JSON (either shape) |
| `HOLDFAST_USE_CLAUDE_CREDS` | `1` | set `0` to ignore `awsCredentialExport` from Claude's settings |
| `HOLDFAST_KIRO_FILTER` | `1` | set `0` to forward non-KRS traffic on the Kiro port too |
| `HOLDFAST_KIRO_ALLOW_PATHS` | – | extra path patterns the Kiro listener should forward |
| `HOLDFAST_HOME` | `~/.holdfast` | state directory (log, stats, install + routing records) |
| `HOLDFAST_LOG_FILE` | `~/.holdfast/holdfast.log` | log location |

Less commonly needed:

| Variable | Default | Meaning |
|---|---|---|
| `HOLDFAST_UPSTREAM` | `https://api.anthropic.com` | full Anthropic endpoint override |
| `HOLDFAST_BEDROCK_REGION` | `AWS_REGION`, else Claude's `env.AWS_REGION`, else `us-east-1` | Bedrock region (a `/region/<r>` prefix overrides it per request) |
| `HOLDFAST_MAX_RETRIES` | derived from the hold window | probe attempts, if you'd rather set the count than the minutes |
| `HOLDFAST_PROBE_HOST` / `HOLDFAST_PROBE_PORT` | the upstream host, `443` | what the connectivity probe connects to |
| `HOLDFAST_PROBE_TIMEOUT_MS` | `5000` | probe timeout |
| `HOLDFAST_UPSTREAM_TIMEOUT_MS` | `600000` | how long one upstream attempt may take before it counts as a failure |
| `HOLDFAST_LOG_CONSOLE` | `1` | set `0` to log only to the file |
| `HOLDFAST_CODEWHISPERER_PORT` / `_REGION` / `_UPSTREAM` | – | accepted as aliases of the `HOLDFAST_KIRO_*` variables |

Test and packaging hooks, not for normal use: `HOLDFAST_CLAUDE_SETTINGS` and
`HOLDFAST_KIRO_USER_DIR` (point the routing commands at copies of those files),
`HOLDFAST_SERVICE_FILE` (write the service definition elsewhere) and
`HOLDFAST_INSTALL_NO_ACTIVATE=1` (generate it without handing it to
launchd/systemd). The test suite uses all four so it never touches your real
configuration.

## Scope

Holdfast handles connection-level failures: dropped or switched networks, DNS failures, connection resets, refused connections, and timeouts, including repeated drops within a single turn and outages up to the configured window.

A drop *before* the first response byte is held and replayed cleanly. A drop *partway through* an already-streaming response is not re-run — the client is holding a partial answer, so replaying would double-run the turn; that case is surfaced honestly instead.

**What is deliberately NOT held.** Only connection-level failures are. A TLS or
certificate failure, a protocol error, or any other non-network error fails fast
with its error code in the response — holding those was a real defect: with a long
window a certificate problem sat silently for hours instead of being reported in
milliseconds. Missing AWS credentials likewise fail immediately, as a readable
`403`.

It does not cover: the model API itself being down or returning errors (passed through as-is), expired or invalid API keys (passed through so you can see them), or a machine that is fully powered off. If a tool enforces a hard per-request time limit, the keep-alive pings defeat idle timeouts but cannot override that limit.

## Testing

```bash
npm test          # or, individually:
node test/integration.js
node test/streaming.js
node test/routing.js
node test/bedrock.js
```

All four suites run offline against mock upstreams and temp directories — no
network, no AWS, and nothing outside the sandbox is touched.

`routing.js` covers the commands that edit your editor's configuration: that a
JSONC settings file keeps its comments and trailing commas and changes by exactly
one key, that `disable` restores it byte-for-byte, that `enable` refuses a port
owned by a stranger or a region Kiro would ignore, that `stop` reverts routing
before freeing the port, that `install` writes a service referencing
`~/.holdfast/app/<version>` and never the npx cache, and that the Kiro listener
answers non-Kiro traffic locally. `bedrock.js` covers the AWS side: the
`/region/<r>` prefix routing, signing scope and path stripping, both credential
shapes, a broken credential command returning a readable 403 without being held,
a TLS failure failing fast, and credential caching with refresh near expiry.

`integration.js` simulates an upstream outage and confirms the request is held, kept alive with heartbeats, and delivered once connectivity returns, plus a normal pass-through request. `streaming.js` confirms live streaming (tokens arrive as produced, not buffered), that a pre-first-byte drop is still held and replayed on the streaming path, that an AWS event-stream response streams live with its bearer token passed through untouched, and that the Kiro listener forwards live with the bearer preserved and Host rewritten to the upstream. It also confirms that a busy port is skipped without taking down the other listeners.

## Seeing what it's done

The running terminal logs every event as it happens: each request, each disconnect it catches, each probe, and a `SAVED` line with a running tally when a session is recovered. The same log goes to `~/.holdfast/holdfast.log`. For lifetime numbers across restarts, `holdfast stats` prints drops caught, sessions saved, give-ups, and total time held, broken down by provider and by client tool.

## License

Apache License 2.0. See [LICENSE](LICENSE).
