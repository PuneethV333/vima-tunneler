import WebSocket from "ws";
import { AgentConfig } from "./config";
import { clampTimeout, executeRequest, JobRequest } from "./executor";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const DEAD_SOCKET_MS = 60_000;
const MAX_BUFFERED_FRAMES = 1_000;

export interface AgentRuntimeOptions {
  heartbeatIntervalMs?: number;
  deadSocketMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  inflightLimit?: number;
}

const DEFAULT_INFLIGHT_LIMIT = 8;

function inflightLimit(): number {
  const raw = Number(process.env.VIMA_MAX_INFLIGHT);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_INFLIGHT_LIMIT;
}

interface RequestMessage {
  type: "request";
  jobId?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  bodyBase64?: unknown;
  timeoutMs?: unknown;
}

export interface RunAgentHandle {
  stop(): void;
  gracefulStop(timeoutMs?: number): Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface BufferedFrame {
  seq: number;
  payload: Record<string, unknown>;
}

class Outbox {
  private nextSeq = 1;
  private buffer: BufferedFrame[] = [];
  private droppedCount = 0;

  enqueue(payload: Record<string, unknown>): number {
    const seq = this.nextSeq++;
    this.buffer.push({ seq, payload });
    while (this.buffer.length > MAX_BUFFERED_FRAMES) {
      this.buffer.shift();
      this.droppedCount += 1;
    }
    return seq;
  }

  ackUpto(seq: number): void {
    while (this.buffer.length > 0 && this.buffer[0].seq <= seq) {
      this.buffer.shift();
    }
  }

  frames(): BufferedFrame[] {
    return this.buffer;
  }

  dropped(): number {
    return this.droppedCount;
  }
}

function toWebSocketUrl(serverUrl: string): string {
  if (/^https:\/\//i.test(serverUrl)) {
    return "wss://" + serverUrl.slice("https://".length);
  }
  return serverUrl.replace(/^http:\/\//i, "ws://");
}

export function runAgent(
  config: AgentConfig,
  opts: AgentRuntimeOptions = {},
): RunAgentHandle {
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const deadSocketMs = opts.deadSocketMs ?? DEAD_SOCKET_MS;
  const backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS;
  const backoffCapMs = opts.backoffCapMs ?? BACKOFF_CAP_MS;
  const maxInflight = opts.inflightLimit ?? inflightLimit();

  let stopped = false;
  let attempt = 0;
  let activeJobs = 0;
  let socket: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastActivityAt = Date.now();
  const outbox = new Outbox();

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const sendRaw = (payload: Record<string, unknown>) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const deliverResult = (payload: Record<string, unknown>) => {
    const seq = outbox.enqueue(payload);
    sendRaw({ ...payload, seq });
  };

  const flushOutbox = () => {
    for (const frame of outbox.frames()) {
      sendRaw({ ...frame.payload, seq: frame.seq });
    }
    if (outbox.dropped() > 0) {
      console.warn(
        `outbox overflowed earlier; ${outbox.dropped()} oldest result(s) were lost`,
      );
    }
  };

  const handleJob = async (msg: RequestMessage) => {
    if (typeof msg.jobId !== "string") return;
    const job: JobRequest = {
      jobId: msg.jobId,
      method: typeof msg.method === "string" ? msg.method : "GET",
      url: typeof msg.url === "string" ? msg.url : "",
      headers:
        typeof msg.headers === "object" && msg.headers !== null
          ? (msg.headers as Record<string, string>)
          : undefined,
      bodyBase64:
        typeof msg.bodyBase64 === "string" ? msg.bodyBase64 : undefined,
      timeoutMs: clampTimeout(msg.timeoutMs),
    };
    activeJobs += 1;
    try {
      const res = await executeRequest(job);
      deliverResult({ type: "response", jobId: job.jobId, ...res });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "request failed unexpectedly";
      deliverResult({ type: "error", jobId: job.jobId, message });
    } finally {
      activeJobs -= 1;
    }
  };

  const rejectIfBusy = (msg: RequestMessage): boolean => {
    if (typeof msg.jobId !== "string") return false;
    if (activeJobs < maxInflight) return false;
    deliverResult({
      type: "error",
      jobId: msg.jobId,
      message: `agent busy: ${maxInflight} jobs already in flight`,
    });
    return true;
  };

  const onMessage = (data: WebSocket.RawData) => {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const typed = msg as { type?: unknown; upto?: unknown };
    if (typed.type === "request") {
      const req = msg as RequestMessage;
      if (!rejectIfBusy(req)) {
        void handleJob(req);
      }
    } else if (typed.type === "ack" && typeof typed.upto === "number") {
      outbox.ackUpto(typed.upto);
    }
    lastActivityAt = Date.now();
    // {"type":"ping"} -> no-op
  };

  const connect = () => {
    if (stopped) return;

    socket = new WebSocket(`${toWebSocketUrl(config.serverUrl)}/agent`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });

    socket.on("open", () => {
      attempt = 0;
      lastActivityAt = Date.now();
      console.log(`connected to relay ${config.serverUrl}`);
      stopHeartbeat();
      heartbeat = setInterval(() => {
        sendRaw({ type: "pong" });
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.ping();
        }
        const silentFor = Date.now() - lastActivityAt;
        if (silentFor > deadSocketMs) {
          console.warn(
            `no traffic from relay for ${silentFor}ms; forcing reconnect`,
          );
          socket?.terminate();
        }
      }, heartbeatIntervalMs);
      flushOutbox();
    });

    socket.on("pong", () => {
      lastActivityAt = Date.now();
    });

    socket.on("message", onMessage);

    const scheduleReconnect = () => {
      stopHeartbeat();
      socket = null;
      if (stopped) return;
      const delay = Math.floor(
        Math.random() * Math.min(backoffCapMs, backoffBaseMs * 2 ** attempt),
      );
      attempt += 1;
      console.log(`reconnecting in ${delay}ms...`);
      reconnectTimer = setTimeout(connect, delay);
    };

    socket.on("close", scheduleReconnect);
    socket.on("error", (err) => {
      console.error(`websocket error: ${err.message}`);
    });
  };

  connect();

  const oneShotFlush = (done: () => void, windowMs: number) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        done();
      }
    };
    const giveUp = setTimeout(finish, windowMs);
    try {
      const ws = new WebSocket(`${toWebSocketUrl(config.serverUrl)}/agent`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      ws.on("open", () => {
        for (const frame of outbox.frames()) {
          ws.send(JSON.stringify({ ...frame.payload, seq: frame.seq }));
        }
        setTimeout(() => {
          clearTimeout(giveUp);
          ws.close();
          finish();
        }, 250);
      });
      ws.on("error", () => {});
    } catch {
      clearTimeout(giveUp);
      finish();
    }
  };

  return {
    stop() {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      stopHeartbeat();
      if (socket) socket.close();
    },
    gracefulStop: async (timeoutMs = 10_000): Promise<void> => {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      stopHeartbeat();

      const deadline = Date.now() + timeoutMs;
      while (activeJobs > 0 && Date.now() < deadline) {
        await sleep(50);
      }

      const socketOpen =
        socket !== null && socket.readyState === WebSocket.OPEN;
      if (!socketOpen && outbox.frames().length > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          oneShotFlush(resolve, Math.max(2_000, deadline - Date.now())),
        );
      }

      const remaining = deadline - Date.now();
      if (
        socket !== null &&
        socket.readyState !== WebSocket.CLOSED &&
        remaining > 0
      ) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          socket!.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          try {
            socket!.close();
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    },
  };
}
