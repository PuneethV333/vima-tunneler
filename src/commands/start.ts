import { readConfig } from "../config";
import { runAgent } from "../agent";

export function start(): void {
  const config = readConfig();
  if (!config) {
    console.error(
      "Not paired yet. Run `vima-tunneler pair --code <code> --server <url>` first."
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Starting agent ${config.agentId}...`);
  const handle = runAgent(config);
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) {
      console.log("forcing exit");
      process.exit(130);
    }
    closing = true;
    console.log(`${signal} received; draining in-flight jobs (Ctrl+C again to force)...`);
    await handle.gracefulStop(10_000);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
