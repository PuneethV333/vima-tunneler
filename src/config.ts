import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentConfig {
  agentId: string;
  token: string;
  serverUrl: string;
  pairedAt: string;
}

export function configDir(): string {
  return path.join(os.homedir(), ".vima-tunneler");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function readConfig(): AgentConfig | null {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!isAgentConfig(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeConfig(config: AgentConfig): void {
  if (!isAgentConfig(config)) {
    throw new Error("invalid agent config: agentId/token/serverUrl/pairedAt required");
  }
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir(), 0o700);
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function clearConfig(): void {
  try {
    fs.rmSync(configPath());
  } catch {
    // already absent
  }
}

function isAgentConfig(value: unknown): value is AgentConfig {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.agentId === "string" &&
    typeof c.token === "string" &&
    typeof c.serverUrl === "string" &&
    typeof c.pairedAt === "string"
  );
}
