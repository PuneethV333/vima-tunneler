#!/usr/bin/env node
import { Command } from "commander";
import { logout } from "./commands/logout";
import { pair } from "./commands/pair";
import { start } from "./commands/start";
import { status } from "./commands/status";

function fail(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

const program = new Command();

program
  .name("vima-tunneler")
  .description("Local agent that runs HTTP requests against localhost on behalf of the Vima web app.")
  .version("0.1.0");

program
  .command("pair")
  .description("Exchange a pairing code for a long-lived token and store it locally.")
  .requiredOption("--code <code>", "pairing code shown in the web app")
  .option("--server <url>", "relay server URL")
  .action(async (opts: { code: string; server?: string }) => {
    try {
      const config = await pair(opts.code, opts.server);
      console.log(`Paired successfully.`);
      console.log(`Agent ID: ${config.agentId}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("start")
  .description("Connect to the relay server and execute incoming jobs until stopped.")
  .action(() => {
    start();
  });

program
  .command("status")
  .description("Print the stored pairing state without connecting.")
  .action(async () => {
    await status();
  });

program
  .command("logout")
  .description("Delete the stored config file.")
  .action(async () => {
    await logout();
  });

program.parseAsync(process.argv).catch(fail);
