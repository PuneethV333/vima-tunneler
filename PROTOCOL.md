# vima-tunneler Wire Protocol

This document is the contract between the relay server and this agent. Every
claim here is derived from the implementation in `src/` -- if the code and
this document ever disagree, the code wins and this file needs fixing.

## 1. Transport

### Pairing (the one REST call)

```
POST {serverUrl}/api/agent/pair
Content-Type: application/json

{"code": "<pairing code from the web UI>"}
```

The relay responds 2xx with a JSON body containing two string fields:

```json
{"agentId": "<id>", "token": "<long-lived token>"}
```

If either field is missing or not a string, the agent discards the response
and pairing fails. Non-2xx status codes fail the pairing call (axios
defaults). The call itself times out after 30 seconds. The agent persists
`agentId`, `token`, and `serverUrl` locally; the pairing code is never used
again.

### Agent connection

After pairing, all traffic runs over a single WebSocket:

```
GET {serverUrl}/agent          (WebSocket upgrade)
Authorization: Bearer <token>
```

An `https://` server URL becomes `wss://`, `http://` becomes `ws://`. The
token is sent only in the `Authorization` header -- never as a query
parameter. The relay should authenticate on the upgrade request itself.

The agent maintains exactly **one** connection to one relay at a time and
reconnects indefinitely until stopped.

## 2. Message shapes

All frames are single JSON objects sent as WebSocket text messages.
Unparseable frames and unknown `type` values are silently ignored by the
agent; the relay should ignore them too.

### relay -> agent: `request`

```json
{
  "type": "request",
  "jobId": "9f1c8e2a-...",
  "method": "POST",
  "url": "http://localhost:3000/api/users",
  "headers": { "Authorization": "Bearer xyz" },
  "bodyBase64": "aGVsbG8=",
  "timeoutMs": 5000
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"request"` | yes | |
| `jobId` | string | yes | Unique per logical request. If missing or not a string the frame is **silently dropped** -- no error frame comes back. |
| `method` | string | no | Defaults to `"GET"`. |
| `url` | string | no* | Target URL. Effectively required: absent or unparseable values produce an `error` frame (`refusing to proxy non-local target`). Accepted hosts: see 4.1. |
| `headers` | object of string->string | no | Passed through to the local request verbatim. Non-object values are ignored. |
| `bodyBase64` | string | no | Base64-decoded into the raw request body. |
| `timeoutMs` | number | no | Clamped to `[1000, 300000]`; anything non-numeric falls back to the 30 s default. |

Exactly one of `response` / `error` comes back per accepted `jobId` -- though
delivery is at-least-once (section 3), so the same frame may arrive multiple
times.

### agent -> relay: `response`

Sent when the local HTTP call completed, **regardless of status code** (a
404 or 503 from the local API arrives as a `response`, not an `error`):

```json
{
  "type": "response",
  "jobId": "9f1c8e2a-...",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "bodyBase64": "eyJ1c2VycyI6W119",
  "seq": 42
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"response"` | |
| `jobId` | string | Echoes the request's `jobId`. |
| `status` | number | The local server's HTTP status, as-is. |
| `headers` | object of string->string | Response headers with **lowercased** names; repeated headers joined with `", "`. |
| `bodyBase64` | string | Full response body, base64-encoded. |
| `seq` | number | Monotonic delivery sequence (section 3). |

### agent -> relay: `error`

Sent instead of `response` when nothing usable came back:

```json
{
  "type": "error",
  "jobId": "9f1c8e2a-...",
  "message": "connect ECONNREFUSED 127.0.0.1:3000",
  "seq": 43
}
```

Typical `message` contents: `refusing to proxy non-local target: <url>`
(target validation failed), connection errors (`ECONNREFUSED`, DNS failures),
`timeout of <N>ms exceeded`, `response body exceeded <N> bytes from <url>`
(body cap), and `agent busy: <N> jobs already in flight` (concurrency cap,
see 4.5).

### agent -> relay: `pong`

```json
{"type": "pong"}
```

Sent every 25 s while connected. Carries **no `seq`** and takes no
acknowledgement -- it exists so the relay can see the agent is alive.

### relay -> agent: `ping`

```json
{"type": "ping"}
```

No-op for the agent. Any inbound frame (including this one) refreshes the
liveness timer described in 4.7, so periodic pings are a good way for a
relay to keep idle connections healthy.

### relay -> agent: `ack`

```json
{"type": "ack", "upto": 41}
```

Cumulative acknowledgement: every buffered result frame with `seq <= upto`
is considered delivered and removed from the agent's outbox. `upto` is
**inclusive**. A non-numeric `upto` is ignored. See section 3.

## 3. Delivery guarantees

Result delivery is **at-least-once**, built on sequence numbers plus an
in-memory outbox:

1. Every `response`/`error` frame gets a `seq` starting at 1, incremented by
   1 per result, monotonic for the lifetime of the agent process.
2. A result is enqueued first, then sent immediately if the socket is open;
   otherwise it waits in the outbox.
3. On every successful (re)connect, the agent replays all still-buffered
   frames in `seq` order before any new traffic.
4. The relay acknowledges cumulatively: `{"type":"ack","upto":N}` tells the
   agent to forget everything with `seq <= N`. Late or out-of-order acks are
   harmless because they are cumulative.
5. The outbox holds at most **1000** unacked frames. When full, the *oldest*
   frame is evicted (a warning is logged on the next flush).

Consequences the relay MUST design for:

- **Duplicates will happen.** If the relay processes a result but its ack is
  lost (or the connection drops right after), the agent replays that frame.
  The relay MUST treat `response`/`error` frames as idempotent per `jobId`.
- **Results can be lost.** If the relay stays unreachable long enough for
  more than 1000 jobs to complete, the oldest results are dropped forever,
  and an agent process restart empties the outbox entirely. There is no
  persistence layer -- plan relay-side job timeouts accordingly.

## 4. Invariants the relay can rely on

### 4.1 Target validation happens before any network call

Every request URL is parsed and checked against the allowlist
`{localhost, 127.0.0.1, ::1, 0.0.0.0}` (case-insensitive hostname comparison,
IPv6 brackets stripped, scheme must be `http:` or `https:`) *before* the
agent opens any connection. Anything else yields an `error` frame and zero
outbound traffic.

For `localhost` specifically, the agent tries candidates in order --
`127.0.0.1`, then `[::1]`, then the original spelling -- until one succeeds,
so a loopback server bound to only one address family still works.

### 4.2 Redirects are never followed

Requests are made with `maxRedirects: 0`. A 3xx from the local server is
returned to the relay as-is (status, `location` header, body) and never
chased. This closes the redirect escape hatch from the local-only rule.

### 4.3 Timeouts

Default 30000 ms; a per-job `timeoutMs` clamps to `[1000, 300000]`, with
non-finite values falling back to the default. The timeout governs time to
response start: once the local server begins streaming a body, a slow
trickle is bounded by the body cap (4.4) instead.

### 4.4 Body size cap

Response bodies larger than 25 MiB (26214400 bytes) abort mid-download with
an `error` frame (`response body exceeded <limit> bytes from <url>`). The
limit is overridable per machine via the `VIMA_MAX_BODY_BYTES` environment
variable.

### 4.5 Concurrency cap

At most 8 jobs run concurrently (overridable via `VIMA_MAX_INFLIGHT`). Jobs
arriving above the cap are rejected instantly, not queued:

```json
{"type": "error", "jobId": "...", "message": "agent busy: 8 jobs already in flight", "seq": ...}
```

The relay may retry such jobs later.

### 4.6 Reconnect backoff is full-jitter exponential

Delay before each reconnect attempt is
`floor(random() * min(30 s, 1 s x 2^attempt))`, with `attempt` incrementing
per failure and resetting to 0 on a successful open. Expect reconnect delays
anywhere from 0 ms up to the jittered ceiling -- do not assume fixed spacing.

### 4.7 Dead-socket detection

Every 25 s the agent sends an app-level `pong` frame plus a protocol-level
WS ping. It tracks the last inbound activity (any app frame or WS pong); if
the line stays silent for more than 60 s, the agent calls `terminate()` --
an abrupt teardown, not a graceful close -- which triggers the normal
close-and-reconnect path. A relay that stops reading but keeps the TCP
connection open will be dropped within roughly two heartbeat windows.

### 4.8 Graceful shutdown drains before exiting

On SIGINT/SIGTERM the agent stops reconnecting, waits for in-flight jobs to
settle (polling every 50 ms), flushes any still-unacked outbox frames over a
fresh one-shot connection if the main socket is already down, then closes
the socket and waits for the close to complete -- all within a 10 s budget.
A second signal force-exits immediately. Frames flushed this way are normal
`seq`-tagged results and are subject to the same dedupe requirement as any
other delivery.

## 5. Known limitations (v1)

- No incremental/streaming request or response bodies end-to-end: response
  bodies are downloaded whole (under the 4.4 cap) and buffered in memory
  before being sent upstream.
- No configurable target allowlist beyond the hardcoded loopback set.
- One agent connection per token; no fan-out to multiple relays.
- Frames evicted from a full outbox, or lost across an agent process
  restart, are not recoverable.
