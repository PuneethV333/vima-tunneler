import { clearConfig, configPath, readConfig } from "../config";

export async function logout(): Promise<void> {
  if (!readConfig()) {
    console.log("Not paired; nothing to remove.");
    return;
  }
  clearConfig();
  console.log(`Removed ${configPath()}.`);
}
