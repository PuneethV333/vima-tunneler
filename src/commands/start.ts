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
  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
