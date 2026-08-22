import axios from "axios";
import { AgentConfig, writeConfig } from "../config";

export function normalizeServerUrl(raw: string): string {
  let candidate = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported server URL scheme: ${parsed.protocol}`);
  }
  return candidate;
}

interface PairResponse {
  agentId?: unknown;
  token?: unknown;
}

export async function pair(
  code: string,
  rawServerUrl: string | undefined
): Promise<AgentConfig> {
  if (!rawServerUrl) {
    throw new Error("no relay server given; pass --server <url>");
  }
  const serverUrl = normalizeServerUrl(rawServerUrl);

  const res = await axios.post<PairResponse>(
    `${serverUrl}/api/agent/pair`,
    { code },
    { timeout: 30_000 }
  );

  const { agentId, token } = res.data ?? {};
  if (typeof agentId !== "string" || typeof token !== "string") {
    throw new Error("relay returned an unexpected pairing response");
  }

  const config: AgentConfig = {
    agentId,
    token,
    serverUrl,
    pairedAt: new Date().toISOString(),
  };
  writeConfig(config);
  return config;
}
