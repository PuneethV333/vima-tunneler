import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearConfig, configPath, readConfig, writeConfig } from "../src/config";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vima-home-"));
let prevHome: string | undefined;

before(() => {
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test("config round-trips with restrictive permissions and clears", () => {
  clearConfig();
  assert.equal(readConfig(), null);

  writeConfig({
    agentId: "agent-1",
    token: "secret",
    serverUrl: "https://relay.example.dev",
    pairedAt: "2026-01-01T00:00:00.000Z",
  });

  const dirMode = fs.statSync(path.dirname(configPath())).mode & 0o777;
  const fileMode = fs.statSync(configPath()).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);

  const cfg = readConfig();
  assert.ok(cfg);
  assert.equal(cfg.agentId, "agent-1");
  assert.equal(cfg.token, "secret");

  assert.throws(() => writeConfig({ bogus: true } as never));

  clearConfig();
  assert.equal(readConfig(), null);
});
