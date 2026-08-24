import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchange } from "../src/connect.js";
import { codexHome, pendingConfigPath, promotePendingConfig, writePendingConfig } from "../src/codex-connect.js";
import { loadConfig } from "../src/config.js";
import type { DeviceConfig } from "../src/config.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "trinity-codex-home-"));
}

function tmpPluginData(): string {
  return mkdtempSync(join(tmpdir(), "trinity-codex-plugindata-"));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

// A real local HTTP server standing in for the dashboard's exchange
// endpoint (spec's connect flow is a real fetch, not a mock) — the brief's
// "stub server".
async function withStubServer<T>(cfg: DeviceConfig, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/devices/exchange") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cfg));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("codexHome resolves CODEX_HOME, defaulting under the user's home directory", () => {
  assert.equal(codexHome({ CODEX_HOME: "/custom/codex" }), "/custom/codex");
  const withoutOverride = codexHome({});
  assert.ok(withoutOverride.endsWith(".codex"), withoutOverride);
});

test("writePendingConfig writes a mode-0600 file under a mode-0700 directory, atomically", () => {
  const home = tmpHome();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://api.example/ingest/batches", deviceId: "dev1" };

  writePendingConfig(home, cfg);

  const path = pendingConfigPath(home);
  assert.ok(existsSync(path));
  assert.equal(mode(path), 0o600, "pending DeviceConfig must be mode 0600");
  assert.equal(mode(join(home, "trinity-capture")), 0o700, "the plugin-managed CODEX_HOME subdirectory must be mode 0700");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), cfg);
});

test("the full connect flow: exchange against a stub server, write pending, promote, read back", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const cfg: DeviceConfig = { token: "tok-e2e", ingestUrl: "https://api.example/ingest/batches", deviceId: "dev-e2e" };

  const exchanged = await withStubServer(cfg, (baseUrl) => exchange(baseUrl, "PAIR-CODE"));
  assert.deepEqual(exchanged, cfg);

  writePendingConfig(home, exchanged);
  assert.ok(existsSync(pendingConfigPath(home)), "the pending record must exist before promotion");

  // A simulated PostToolUse hook: the exact function codex-hook.ts's own
  // PostToolUse handler calls, given the same (CODEX_HOME, PLUGIN_DATA) pair.
  promotePendingConfig(home, pluginData);

  assert.ok(!existsSync(pendingConfigPath(home)), "promotion must remove the pending file");
  const configPath = join(pluginData, "config.json");
  assert.ok(existsSync(configPath), "promotion must write PLUGIN_DATA/config.json");
  assert.equal(mode(configPath), 0o600, "the promoted credential file must be mode 0600");

  const readBack = loadConfig(pluginData);
  assert.deepEqual(readBack, cfg, "read-back through config.ts's own loadConfig must succeed");
});

test("promotePendingConfig is a no-op when nothing is pending", () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();

  assert.doesNotThrow(() => promotePendingConfig(home, pluginData));
  assert.ok(!existsSync(join(pluginData, "config.json")));
});

test("promotePendingConfig leaves a malformed pending record in place for a later, complete write", () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  writePendingConfig(home, { token: "", ingestUrl: "https://api.example/ingest/batches", deviceId: "dev1" } as DeviceConfig);

  promotePendingConfig(home, pluginData);

  assert.ok(existsSync(pendingConfigPath(home)), "an incomplete DeviceConfig must not be promoted");
  assert.ok(!existsSync(join(pluginData, "config.json")));
});

test("an untrusted/disabled hook leaves the pending record for the next trusted invocation, which then promotes it", () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://api.example/ingest/batches", deviceId: "dev1" };
  writePendingConfig(home, cfg);

  // First "invocation" simulates a hook that never ran (untrusted/disabled):
  // nothing calls promotePendingConfig, so the pending record must survive
  // untouched, secured, for the next one.
  assert.ok(existsSync(pendingConfigPath(home)));
  assert.equal(mode(pendingConfigPath(home)), 0o600);

  // The next trusted PostToolUse invocation promotes it.
  promotePendingConfig(home, pluginData);
  assert.deepEqual(loadConfig(pluginData), cfg);
});

test("promotion never leaves the destination writable to group or other", () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://api.example/ingest/batches", deviceId: "dev1" };
  writePendingConfig(home, cfg);
  promotePendingConfig(home, pluginData);

  const configMode = mode(join(pluginData, "config.json"));
  assert.equal(configMode & 0o077, 0, `group/other must have no access: mode ${configMode.toString(8)}`);
});
