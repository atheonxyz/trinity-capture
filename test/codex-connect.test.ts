import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchange } from "../src/connect.js";
import { codexHome, confirmedConfigPath, pendingConfigPath, promotePendingConfig, savedDeviceId, targetKeyForPluginData, writePendingConfig } from "../src/codex-connect.js";
import { loadConfig, loadPolicy, saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig } from "../src/config.js";
import { activationStatus } from "../src/activation.js";

const fetchOriginal = globalThis.fetch;
test.beforeEach(() => {
  mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/v1/ingest/policy")) {
      return Promise.resolve(Response.json({ etag: "new-policy", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] }));
    }
    return fetchOriginal(input, init);
  });
});
test.afterEach(() => mock.restoreAll());

test("reconnect cannot use the previous device policy when refresh fails", async (t) => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const previous = { token: "old-token", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "old-device" };
  saveConfig(pluginData, previous);
  saveFreshPolicy(pluginData);
  writePendingConfig(home, { ...previous, token: "new-token", deviceId: "new-device" });
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    return Promise.resolve(new Response(null, { status: 503 }));
  });

  await promotePendingConfig(home, pluginData, "https://api.example");

  assert.equal(requests, 1);
  assert.equal(loadPolicy(pluginData), null);
  assert.ok(existsSync(pendingConfigPath(home)));
  assert.equal(activationStatus(pluginData), "paired-awaiting-new-session");
});

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "trinity-codex-home-"));
}

function tmpPluginData(): string {
  const parent = mkdtempSync(join(tmpdir(), "trinity-codex-plugindata-"));
  const dir = join(parent, "trinity-capture-trinity");
  mkdirSync(dir);
  return dir;
}

function tmpPluginDataWithKey(key: string): string {
  const parent = mkdtempSync(join(tmpdir(), "trinity-codex-plugindata-"));
  const dir = join(parent, key);
  mkdirSync(dir);
  return dir;
}

// Writes a connection file directly (bypassing writePendingConfig's
// DeviceConfig typing) so a test can shape a malformed or partial record.
function writeConnectionFile(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function saveFreshPolicy(dataDir: string): void {
  savePolicy(dataDir, {
    etag: "policy-1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
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
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "dev1" };

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
  const cfg: DeviceConfig = { token: "tok-e2e", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "dev-e2e" };

  const exchanged = await withStubServer(cfg, (baseUrl) => exchange(baseUrl, "PAIR-CODE", null));
  assert.deepEqual(exchanged, cfg);

  writePendingConfig(home, exchanged);
  assert.ok(existsSync(pendingConfigPath(home)), "the pending record must exist before promotion");
  saveFreshPolicy(pluginData);

  // A simulated PostToolUse hook: the exact function codex-hook.ts's own
  // PostToolUse handler calls, given the same (CODEX_HOME, PLUGIN_DATA) pair.
  await promotePendingConfig(home, pluginData, "https://api.example");

  assert.ok(!existsSync(pendingConfigPath(home)), "promotion must remove the pending file");
  assert.ok(existsSync(confirmedConfigPath(home, targetKeyForPluginData(pluginData))), "promotion must write a confirmation marker");
  const configPath = join(pluginData, "config.json");
  assert.ok(existsSync(configPath), "promotion must write PLUGIN_DATA/config.json");
  assert.equal(mode(configPath), 0o600, "the promoted credential file must be mode 0600");
  assert.equal(activationStatus(pluginData), "paired-awaiting-new-session");

  const readBack = loadConfig(pluginData);
  assert.deepEqual(readBack, cfg, "read-back through config.ts's own loadConfig must succeed");
});

test("promotion rejects a pending config for an untrusted ingest origin", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  writePendingConfig(home, {
    token: "forged",
    ingestUrl: "https://attacker.example/api/v1/ingest/batches",
    deviceId: "forged-device",
  });

  await promotePendingConfig(home, pluginData);

  assert.ok(existsSync(pendingConfigPath(home)));
  assert.ok(!existsSync(join(pluginData, "config.json")));
});

test("promotion accepts the staging dashboard and API origin pair", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const cfg: DeviceConfig = {
    token: "staging-token",
    ingestUrl: "https://api-staging.usetrinity.ai/api/v1/ingest/batches",
    deviceId: "staging-device",
  };
  writePendingConfig(home, cfg);

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    if (!String(url).endsWith("/api/v1/ingest/policy")) throw new Error(`unexpected fetch: ${String(url)}`);
    return Response.json({
      etag: "staging-policy",
      ttlSeconds: 900,
      captureLevel: "metadata",
      workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
    });
  }) as typeof fetch;
  try {
    await promotePendingConfig(home, pluginData, "https://staging.usetrinity.ai");
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(loadConfig(pluginData), cfg);
  assert.ok(!existsSync(pendingConfigPath(home)));
});

test("promotePendingConfig is a no-op when nothing is pending", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();

  await assert.doesNotReject(promotePendingConfig(home, pluginData));
  assert.ok(!existsSync(join(pluginData, "config.json")));
});

test("promotePendingConfig leaves a malformed pending record in place for a later, complete write", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  writePendingConfig(home, { token: "", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "dev1" });

  await promotePendingConfig(home, pluginData);

  assert.ok(existsSync(pendingConfigPath(home)), "an incomplete DeviceConfig must not be promoted");
  assert.ok(!existsSync(join(pluginData, "config.json")));
});

test("promotion ignores the legacy pending filename so stale hooks cannot consume a new pairing", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const legacy = join(home, "trinity-capture", "pending-device.json");
  mkdirSync(join(home, "trinity-capture"), { recursive: true });
  writeFileSync(legacy, JSON.stringify({
    token: "legacy",
    ingestUrl: "https://api.usetrinity.ai/api/v1/ingest/batches",
    deviceId: "legacy-device",
  }));

  await promotePendingConfig(home, pluginData);

  assert.ok(existsSync(legacy));
  assert.ok(!existsSync(join(pluginData, "config.json")));
});

test("promotion keeps an existing different-environment config and pending record untouched", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const existing: DeviceConfig = {
    token: "staging-token",
    ingestUrl: "https://api-staging.usetrinity.ai/api/v1/ingest/batches",
    deviceId: "staging-device",
  };
  saveConfig(pluginData, existing);
  writePendingConfig(home, {
    token: "prod-token",
    ingestUrl: "https://api.usetrinity.ai/api/v1/ingest/batches",
    deviceId: "prod-device",
  });
  await promotePendingConfig(home, pluginData, "https://api.usetrinity.ai");

  assert.deepEqual(loadConfig(pluginData), existing);
  assert.ok(existsSync(pendingConfigPath(home)));
});

test("promotion is scoped to the hook's plugin data identity", async () => {
  const home = tmpHome();
  const prodData = tmpPluginDataWithKey("trinity-capture-trinity");
  const stageData = tmpPluginDataWithKey("trinity-capture-trinity-staging");
  const prodKey = targetKeyForPluginData(prodData);
  const stageKey = targetKeyForPluginData(stageData);
  const prod: DeviceConfig = { token: "prod", ingestUrl: "https://api.usetrinity.ai/api/v1/ingest/batches", deviceId: "prod-device" };
  const stage: DeviceConfig = { token: "stage", ingestUrl: "https://api-staging.usetrinity.ai/api/v1/ingest/batches", deviceId: "stage-device" };
  writePendingConfig(home, prod, prodKey);
  writePendingConfig(home, stage, stageKey);
  saveFreshPolicy(prodData);
  saveFreshPolicy(stageData);

  await promotePendingConfig(home, stageData, "https://api-staging.usetrinity.ai");

  assert.deepEqual(loadConfig(stageData), stage);
  assert.ok(!existsSync(pendingConfigPath(home, stageKey)));
  assert.ok(existsSync(pendingConfigPath(home, prodKey)));
  assert.equal(loadConfig(prodData), null);
});

test("an untrusted/disabled hook leaves the pending record for the next trusted invocation, which then promotes it", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "dev1" };
  writePendingConfig(home, cfg);

  // First "invocation" simulates a hook that never ran (untrusted/disabled):
  // nothing calls promotePendingConfig, so the pending record must survive
  // untouched, secured, for the next one.
  assert.ok(existsSync(pendingConfigPath(home)));
  assert.equal(mode(pendingConfigPath(home)), 0o600);

  // The next trusted PostToolUse invocation promotes it.
  saveFreshPolicy(pluginData);
  await promotePendingConfig(home, pluginData, "https://api.example");
  assert.deepEqual(loadConfig(pluginData), cfg);
});

test("promotion never leaves the destination writable to group or other", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "dev1" };
  writePendingConfig(home, cfg);
  saveFreshPolicy(pluginData);
  await promotePendingConfig(home, pluginData, "https://api.example");

  const configMode = mode(join(pluginData, "config.json"));
  assert.equal(configMode & 0o077, 0, `group/other must have no access: mode ${configMode.toString(8)}`);
});

test("savedDeviceId prefers the plugin data dir's config over both connection files", () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const key = "test-target";
  saveConfig(pluginData, { token: "tok", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "data-dir-device" });
  writeConnectionFile(confirmedConfigPath(home, key), { deviceId: "confirmed-device" });
  writeConnectionFile(pendingConfigPath(home, key), { deviceId: "pending-device" });

  assert.equal(savedDeviceId(home, key, pluginData), "data-dir-device");
});

test("savedDeviceId falls through to the connection files when the plugin data dir holds no config", () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const key = "test-target";
  writeConnectionFile(confirmedConfigPath(home, key), { deviceId: "confirmed-device" });

  assert.equal(savedDeviceId(home, key, pluginData), "confirmed-device");
});

test("savedDeviceId falls back to the confirmed file when no plugin data dir is given", () => {
  const home = tmpHome();
  const key = "test-target";
  writeConnectionFile(confirmedConfigPath(home, key), { deviceId: "confirmed-device" });

  assert.equal(savedDeviceId(home, key, undefined), "confirmed-device");
});

test("savedDeviceId falls back to the pending file when only it exists", () => {
  const home = tmpHome();
  const key = "test-target";
  writeConnectionFile(pendingConfigPath(home, key), { deviceId: "pending-device" });

  assert.equal(savedDeviceId(home, key, undefined), "pending-device");
});

test("savedDeviceId prefers the confirmed file over the pending file when both exist", () => {
  const home = tmpHome();
  const key = "test-target";
  writeConnectionFile(confirmedConfigPath(home, key), { deviceId: "confirmed-device" });
  writeConnectionFile(pendingConfigPath(home, key), { deviceId: "pending-device" });

  assert.equal(savedDeviceId(home, key, undefined), "confirmed-device");
});

test("savedDeviceId returns null when neither a data dir config nor a connection file exists", () => {
  const home = tmpHome();
  const pluginData = tmpPluginData();
  const key = "test-target";

  assert.equal(savedDeviceId(home, key, pluginData), null);
  assert.equal(savedDeviceId(home, key, undefined), null);
});

test("savedDeviceId allows reconnect when a saved connection file contains malformed JSON", () => {
  const home = tmpHome();
  const key = "test-target";
  writeConnectionFile(confirmedConfigPath(home, key), { deviceId: "old-device" });
  writeFileSync(confirmedConfigPath(home, key), "{");

  assert.equal(savedDeviceId(home, key, undefined), null);

  writeConnectionFile(pendingConfigPath(home, key), { deviceId: "pending-device" });
  assert.equal(savedDeviceId(home, key, undefined), "pending-device");
});

test("savedDeviceId skips a confirmed file with an empty deviceId and falls through to the pending file", () => {
  const home = tmpHome();
  const key = "test-target";
  writeConnectionFile(confirmedConfigPath(home, key), { deviceId: "" });
  writeConnectionFile(pendingConfigPath(home, key), { deviceId: "pending-device" });

  assert.equal(savedDeviceId(home, key, undefined), "pending-device");
});

test("savedDeviceId skips a confirmed file with no deviceId field and falls through to the pending file", () => {
  const home = tmpHome();
  const key = "test-target";
  writeConnectionFile(confirmedConfigPath(home, key), { note: "no deviceId here" });
  writeConnectionFile(pendingConfigPath(home, key), { deviceId: "pending-device" });

  assert.equal(savedDeviceId(home, key, undefined), "pending-device");
});
