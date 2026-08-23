import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { AgentConfig } from "../src/config";
import { runAgent } from "../src/agent";

const CFG: AgentConfig = {
  agentId: "agent-1",
  token: "sekrit",
  serverUrl: "unused",
  pairedAt: "2026-01-01T00:00:00.000Z",
};

function listen(wss: WebSocketServer): Promise<number> {
  return new Promise((resolve) => {
    wss.on("listening", () => resolve((wss.address() as { port: number }).port));
  });
}

function listenHttp(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port)
    );
  });
}

function cfgFor(port: number): AgentConfig {
  return { ...CFG, serverUrl: `http://127.0.0.1:${port}` };
}

function stop(handle: ReturnType<typeof runAgent> | undefined) {
  handle?.stop();
}

function closeRelay(wss: WebSocketServer) {
  for (const client of wss.clients) client.terminate();
  wss.close();
}

async function waitFor(
  cond: () => boolean,
  label: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("authenticates via Authorization header; token never in URL", async () => {
  let auth = "";
  let url = "";
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws, req) => {
    auth = req.headers["authorization"] ?? "";
    url = req.url ?? "";
  });
  const port = await listen(wss);
  const handle = runAgent(cfgFor(port));
  try {
    await waitFor(() => auth !== "", "first connection");
    assert.equal(auth, `Bearer ${CFG.token}`);
    assert.equal(url, "/agent");
  } finally {
    stop(handle);
    closeRelay(wss);
  }
});

test("outbox: replays unacked frames with identical seq; cumulative ack stops replay", async () => {
  const seen: { conn: number; seq: number }[] = [];
  let connN = 0;
  let ackedSeq: number | null = null;

  const wss = new WebSocketServer({ port: 0 });
  let relaySocket: WebSocket | null = null;
  wss.on("connection", (ws) => {
    connN += 1;
    relaySocket = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "response") return;
      seen.push({ conn: connN, seq: msg.seq });
      if (seen.length === 2) {
        assert.equal(seen[0].seq, seen[1].seq, "redelivery must keep seq");
        setTimeout(() => {
          ackedSeq = msg.seq;
          ws.send(JSON.stringify({ type: "ack", upto: msg.seq }));
        }, 30);
      }
      if (seen.length > 2) {
        throw new Error("frame replayed even after ack");
      }
    });
  });
  const port = await listen(wss);

  const target = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  const tport = await listenHttp(target);

  const handle = runAgent(cfgFor(port), {
    backoffBaseMs: 40,
    backoffCapMs: 120,
  });

  try {
    await waitFor(() => relaySocket !== null, "agent connection");
    relaySocket!.send(
      JSON.stringify({
        type: "request",
        jobId: "job-1",
        method: "GET",
        url: `http://127.0.0.1:${tport}/echo`,
      })
    );

    await waitFor(() => seen.length >= 1, "first delivery");

    for (const c of wss.clients) c.terminate();
    await waitFor(() => seen.length >= 2, "replayed delivery");

    await waitFor(() => ackedSeq !== null, "ack sent by relay harness");
    const connsBefore = connN;

    for (const c of wss.clients) c.terminate();
    await waitFor(() => connN >= connsBefore + 1, "post-ack reconnect");
    await new Promise((r) => setTimeout(r, 400));

    const postAck = seen.filter((s) => s.conn > connsBefore).length;
    assert.equal(postAck, 0, "no frames may replay after cumulative ack");
  } finally {
    stop(handle);
    closeRelay(wss);
    target.close();
  }
});

test("rejects jobs beyond the inflight limit with busy error frames", async () => {
  const LIMIT = 2;
  const results = new Map<string, { type: string; message?: string; status?: number }>();
  let busyCount = 0;
  let releaseHeld: (() => void) | null = null;

  const held: http.ServerResponse[] = [];
  const target = http.createServer((req, res) => {
    if (held.length === LIMIT - 1) {
      releaseHeld = () => {
        for (const r of held.splice(0)) {
          r.writeHead(200);
          r.end("done");
        }
      };
    }
    held.push(res);
    if (held.length === LIMIT) {
      setTimeout(() => releaseHeld?.(), 150);
    }
  });
  const tport = await listenHttp(target);

  const wss = new WebSocketServer({ port: 0 });
  let sendToAgent: ((payload: object) => void) | null = null;
  wss.on("connection", (ws) => {
    sendToAgent = (p) => ws.send(JSON.stringify(p));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "response" || msg.type === "error") {
        results.set(msg.jobId, msg);
        if (msg.type === "error" && /busy/.test(msg.message)) busyCount += 1;
      }
    });
  });
  const port = await listen(wss);

  const handle = runAgent(cfgFor(port), { inflightLimit: LIMIT });
  try {
    await waitFor(() => sendToAgent !== null, "agent connection");

    for (let i = 1; i <= LIMIT + 2; i++) {
      sendToAgent!({
        type: "request",
        jobId: `hold-${i}`,
        method: "GET",
        url: `http://127.0.0.1:${tport}/hold`,
      });
    }

    await waitFor(() => busyCount === 2, "busy rejections");
    await waitFor(() => results.size === LIMIT + 2, "all jobs settled");

    let completed = 0;
    for (let i = 1; i <= LIMIT + 2; i++) {
      const m = results.get(`hold-${i}`);
      assert.ok(m, `no result for hold-${i}`);
      if (m.type === "response") {
        assert.equal(m.status, 200);
        completed += 1;
      }
    }
    assert.equal(completed, LIMIT);
  } finally {
    stop(handle);
    closeRelay(wss);
    target.close();
  }
});

test("terminates silent black-hole sockets and reconnects", async () => {
  const net = await import("node:net");
  let backendConns = 0;

  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", () => {
    backendConns += 1;
  });
  const backendPort = await listen(wss);

  const proxy = net.createServer((client) => {
    let forward = true;
    const backend = net.connect(backendPort, "127.0.0.1");
    client.pipe(backend);
    backend.on("data", (d) => {
      if (forward) client.write(d);
    });
    setTimeout(() => {
      forward = false;
      backend.destroy();
    }, 300);
  });
  const proxyPort = await new Promise<number>((resolve) => {
    proxy.listen(0, "127.0.0.1", () =>
      resolve((proxy.address() as { port: number }).port)
    );
  });

  const handle = runAgent(
    cfgFor(proxyPort),
    {
      heartbeatIntervalMs: 100,
      deadSocketMs: 250,
      backoffBaseMs: 50,
      backoffCapMs: 200,
    }
  );

  try {
    await waitFor(
      () => backendConns >= 2,
      "liveness-triggered reconnect",
      5_000
    );
  } finally {
    stop(handle);
    proxy.close();
    closeRelay(wss);
  }
});

test("heartbeat pongs flow to relay", async () => {
  let sawPong = false;
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "pong") sawPong = true;
    });
  });
  const port = await listen(wss);
  const handle = runAgent(cfgFor(port), { heartbeatIntervalMs: 60 });
  try {
    await waitFor(() => sawPong, "app-level pong frame");
  } finally {
    stop(handle);
    closeRelay(wss);
  }
});
