# vima-tunneler

The local agent half of a web-based Postman alternative. Browsers can't read
responses from `localhost` APIs — CORS blocks reading even when a request
fires — so this small daemon runs once on your machine, holds a persistent
WebSocket to your relay server, and executes HTTP requests against your local
APIs on the web app's behalf. Same pattern as Postman's Desktop Agent.

This repository is **the local agent only**. The relay server and web UI are
separate projects that speak the wire protocol described below.

```
Browser (web UI)
   |  "run this request" over HTTPS/WS
   v
Relay Server                <- not part of this package
   |  forwards job over the agent's open WebSocket
   v
vima-tunneler               <- this package, on your machine
   |  executes the real HTTP call, no CORS involved
   v
localhost:PORT (your local API)
   ^  response streams back up the same path
```

## Requirements

- Node.js >= 18

## Build & install

```bash
npm ci
npm run build          # tsc -> dist/
npm link               # optional: puts `vima-tunneler` on your PATH
npm test               # runs the node:test suite
```

## Quick start

```bash
# 1. Pair once per machine with a code from the web app
vima-tunneler pair --code <code> --server https://relay.example.com

# 2. Leave it running while you use the web app
vima-tunneler start
```

Config lives in `~/.vima-tunneler/config.json` (created `0700`, written
`0600`). It is machine-level: pair once, then any project in the web app can
use this agent.

## CLI

| Command | Purpose |
|---|---|
| `pair --code <code> [--server <url>]` | Exchange a pairing code for a long-lived token, store it locally, print the agent ID. `--server` is effectively required — no default relay URL is baked in. |
| `start` | Connect to the relay and execute jobs until stopped. Reconnects automatically with jittered exponential backoff. SIGINT/SIGTERM drain in-flight jobs and flush pending results (~10s max; press Ctrl+C again to force exit). |
| `status` | Print pairing state without connecting. |
| `logout` | Delete the stored config. |

## Runtime knobs

| Knob | Default | Meaning |
|---|---|---|
| `VIMA_MAX_INFLIGHT` | `8` | Concurrent job cap; excess jobs get an immediate error frame ("agent busy"). |
| `VIMA_MAX_BODY_BYTES` | `26214400` (25 MB) | Response body cap; larger bodies abort mid-download with an error frame. |

Per-job timeouts come from the relay: each request frame may carry
`timeoutMs`, clamped by the agent to `[1000, 300000]`; default is 30 s.

## Security model

- **Loopback only.** The agent refuses to proxy any target whose hostname is
  not exactly `localhost`, `127.0.0.1`, `::1`, or `0.0.0.0`. It never becomes
  an open proxy into your network.
- **Token stays out of URLs.** The pairing token is sent as an
  `Authorization: Bearer` header on the WebSocket upgrade, so it cannot leak
  into access logs.
- **Restrictive config permissions.** The token file is `0600` inside a
  `0700` directory (POSIX); on Windows the ACL inheritance is stripped and
  only the current user keeps access (best-effort via `icacls`).
- Redirects are **not** followed — a local server cannot bounce the agent
  onto non-local targets.

## Reliability

Result delivery is at-least-once: every response/error frame carries a
monotonic `seq`; unacked frames are buffered in memory (cap 1000) and
replayed after reconnects; the relay acknowledges cumulatively with
`{"type":"ack","upto":N}` and must treat results as idempotent per `jobId`.
Half-open connections are detected via WS pings (~60 s of silence forces a
reconnect).

See [AGENTS.md](AGENTS.md) for the full wire-protocol contract.

## Limitations (v1)

- No incremental streaming to the browser: responses are buffered whole
  before delivery (capped at 25 MB by default).
- Frames evicted from a full outbox, or lost across an agent restart, are
  not redelivered.
- One agent per machine; no configurable host allowlist beyond loopback;
  no auto-start on login.

## License

[Apache-2.0](LICENSE)
