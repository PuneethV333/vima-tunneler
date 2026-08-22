# vima-tunneler

## Repo status: spec only

No code exists yet — no `package.json`, no `src/`, no tests. This file is
the source of truth for what to build; a typical session here scaffolds the
project per **Tech stack** and **File layout** below. Don't add runtime
dependencies, frameworks, or build tooling beyond exactly those.

## What this is

The local agent half of a web-based Postman alternative. Browsers can't read
responses from `localhost` APIs (CORS blocks reading even when a request
fires), so the user runs this daemon once on their machine; it holds a
persistent WebSocket to a relay server and executes local HTTP requests on
the web app's behalf, streaming responses back up. Same pattern as Postman's
Desktop Agent.

Scope of this package: **the local agent only.** The relay server and web UI
are separate projects, out of scope here — the wire protocol below is the
contract this agent expects them to speak.

## Architecture

```
Browser (web UI)
   |  "run this request" over HTTPS/WS
   v
Relay Server            <-- NOT part of this package
   |  forwards job over the agent's open WebSocket
   v
vima-tunneler (this package, runs on user's machine)
   |  executes the real HTTP call, no CORS involved
   v
localhost:PORT (user's local API)
   ^  response streams back up the same path
```

Key properties:

- **Machine-level, not project-level.** Installs and pairs once per machine
  (config lives in `~/.vima-tunneler/config.json`), never per repo. It is a
  dumb generic executor — it knows nothing about "projects"; it just runs
  `{method, url, headers, body}` against whatever `host:port` a job
  specifies. The project/collection concept belongs entirely to the web UI.
- **Security boundary = target host, not job source.** Refuse to proxy any
  request whose target hostname isn't `localhost`, `127.0.0.1`, `::1`, or
  `0.0.0.0`. It must never become an open proxy into the rest of the
  user's network.
- **Auth = pairing token, not per-request checks.** A short-lived pairing
  code (shown in the web app) is exchanged once for a long-lived token via
  `POST {httpServerUrl}/api/agent/pair`. That token authenticates the
  WebSocket connection (`GET {serverUrl}/agent?token=<token>`) for every
  subsequent session.

## CLI surface

- `vima-tunneler pair --code <code> [--server <url>]` — exchange a pairing
  code for a token, store it in local config, print the resulting agent ID.
- `vima-tunneler start` — load stored config, connect to the relay, listen
  for jobs indefinitely, execute them, reconnect with exponential backoff.
- `vima-tunneler status` — print pairing state (agent ID, server URL,
  paired-at timestamp) without connecting.
- `vima-tunneler logout` — delete the stored config file.

## Wire protocol

Agent -> relay: `GET {serverUrl}/agent` (WebSocket upgrade), authenticated via
an `Authorization: Bearer <token>` header — never a query param, so the token
can't leak into access logs.

Relay -> agent, job message:

```json
{
  "type": "request",
  "jobId": "uuid",
  "method": "GET",
  "url": "http://localhost:3000/api/users",
  "headers": { "Authorization": "Bearer ..." },
  "bodyBase64": "optional, base64-encoded request body"
}
```

Agent -> relay, on success:

```json
{
  "type": "response",
  "jobId": "uuid",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "bodyBase64": "base64-encoded response body"
}
```

Agent -> relay, on failure (target not local, request threw, timeout):

```json
{ "type": "error", "jobId": "uuid", "message": "human-readable reason" }
```

Result delivery is **at-least-once** via sequence-ID + in-memory buffer + ACK:

- Every `response`/`error` frame carries an integer `"seq"`, monotonic per
  agent process run.
- Unacked frames are buffered in memory (cap 1000; oldest dropped first when
  full) and replayed in order after every (re)connect.
- Relay -> agent: `{"type": "ack", "upto": N}` cumulatively acknowledges all
  frames with `seq <= N`.
- Because redelivery can duplicate frames, the relay MUST treat results as
  idempotent per `jobId`.
- Frames evicted from a full buffer, or lost across an agent restart, are not
  redelivered — documented v1 limitation.

Agent -> relay heartbeat every ~25s while connected: `{"type": "pong"}`.
The relay may send `{"type": "ping"}` — the agent no-ops on it.

Bodies are always base64 (safe for binary payloads). Requests time out at
30s. Responses are read fully into memory — no streaming in v1. That is a
documented limitation, not something to silently work around.

## Tech stack

TypeScript, compiled with `tsc` to `dist/`, published as CommonJS.

- `ws` — WebSocket client for the relay connection
- `axios` — executes the actual local HTTP calls
- `commander` — CLI parsing

No other runtime dependencies. Keep it that way — this must install fast
and stay a small, auditable binary.

## File layout (intended)

```
src/
  cli.ts             entrypoint, wires up commander commands
  agent.ts           runAgent(): WS connect/reconnect loop, dispatches jobs
  executor.ts        executeRequest(): validates target is local, runs axios call
  config.ts          read/write ~/.vima-tunneler/config.json (mode 0600/0700)
  commands/
    pair.ts          POST /api/agent/pair, saves returned {agentId, token}
    start.ts         loads config, calls runAgent()
    status.ts        prints stored config, no network call
    logout.ts        clears config
  index.ts           re-exports for programmatic use (runAgent, executeRequest, config helpers, types)
```

## Non-negotiables

1. `executeRequest` must reject any URL whose hostname isn't in the local
   allowlist, before axios ever touches it.
2. Config file must be written with restrictive permissions (`0600` file,
   `0700` dir) — it holds a long-lived auth token.
3. Reconnect logic must use exponential backoff (base 1s, cap 30s), not a
   fixed interval or busy loop.
4. No project-scoping, no CWD-relative config — everything lives under
   `~/.vima-tunneler/`.

## Out of scope for v1 (flag, don't silently build)

- Streaming/chunked request or response bodies
- Multiple simultaneous agents per user / multiple concurrent local targets
  beyond what the token naturally allows
- A configurable host/port allowlist beyond the hardcoded loopback set
- Auto-start on login (systemd/launchd/Windows service registration)
