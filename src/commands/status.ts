import { readConfig } from "../config";

export async function status(): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.log("Not paired. Run `vima-tunneler pair --code <code>` first.");
    return;
  }
  console.log(`Agent ID:   ${config.agentId}`);
  console.log(`Server:     ${config.serverUrl}`);
  console.log(`Paired at:  ${config.pairedAt}`);
}
