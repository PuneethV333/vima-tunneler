import WebSocket from "ws";
import { AgentConfig } from "./config";
import { executeRequest, JobRequest } from "./executor";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

interface RequestMessage {
  type: "request";
  jobId?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  bodyBase64?: unknown;
}

export interface RunAgentHandle {
  stop(): void;
}

function toWebSocketUrl(serverUrl: string): string {
  if (/^https:\/\//i.test(serverUrl)) {
    return "wss://" + serverUrl.slice("https://".length);
  }
  return serverUrl.replace(/^http:\/\//i, "ws://");
}

export function runAgent(config: AgentConfig): RunAgentHandle {
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const send = (payload: Record<string, unknown>) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
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
      bodyBase64: typeof msg.bodyBase64 === "string" ? msg.bodyBase64 : undefined,
    };
    try {
      const res = await executeRequest(job);
      send({ type: "response", jobId: job.jobId, ...res });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "request failed unexpectedly";
      send({ type: "error", jobId: job.jobId, message });
    }
  };

  const onMessage = (data: WebSocket.RawData) => {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const typed = msg as { type?: unknown };
    if (typed.type === "request") {
      void handleJob(msg as RequestMessage);
    }
    // {"type":"ping"} -> no-op
  };

  const connect = () => {
    if (stopped) return;

    socket = new WebSocket(`${toWebSocketUrl(config.serverUrl)}/agent`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });

    socket.on("open", () => {
      attempt = 0;
      console.log(`connected to relay ${config.serverUrl}`);
      stopHeartbeat();
      heartbeat = setInterval(() => send({ type: "pong" }), HEARTBEAT_INTERVAL_MS);
    });

    socket.on("message", onMessage);

    const scheduleReconnect = () => {
      stopHeartbeat();
      socket = null;
      if (stopped) return;
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
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

  return {
    stop() {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      stopHeartbeat();
      if (socket) socket.close();
    },
  };
}
