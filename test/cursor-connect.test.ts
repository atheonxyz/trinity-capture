import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeCursor, connectCursor } from "../src/cursor-connect.js";
import { cursorDialect } from "../src/cursor-hook.js";
import { loadConfig, saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";
import { activationStatus } from "../src/activation.js";

function tmpParentDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-cursor-connect-"));
}

function stubExchange(deviceConfig: DeviceConfig): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/api/v1/devices/exchange")) {
      return new Response(JSON.stringify(deviceConfig), { status: 200 });
    }
    if (href.endsWith("/api/v1/ingest/policy")) {
      return Response.json({
        etag: "policy-1",
        ttlSeconds: 900,
        captureLevel: "metadata",
        workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function policy(): Policy {
  return {
    etag: "policy-1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  };
}

test("connect writes a 0700 data dir and a 0600 config.json a device did not have before", async () => {
  const parent = tmpParentDir();
  const dataDir = join(parent, "cursor");
  const restore = stubExchange({ token: "tok-1", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-1" });
  try {
    await connectCursor("http://example.invalid", "PAIR-CODE", dataDir);
  } finally {
    restore();
  }

  assert.ok(existsSync(dataDir));
  const cfgPath = join(dataDir, "config.json");
  assert.ok(existsSync(cfgPath));

  if (platform() !== "win32") {
    assert.equal(statSync(dataDir).mode & 0o777, 0o700, "data dir must be 0700");
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600, "config.json must be 0600");
  }

  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { token: string; ingestUrl: string; deviceId: string };
  assert.deepEqual(cfg, { token: "tok-1", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-1" });
  assert.ok(existsSync(join(dataDir, "policy.json")));
  assert.equal(activationStatus(dataDir), "paired-awaiting-new-session");
});

test("browser authorization opens Trinity and waits until approval before saving credentials", async () => {
  const parent = tmpParentDir();
  const dataDir = join(parent, "cursor");
  const opened: string[] = [];
  const shownCodes: string[] = [];
  let exchanges = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/api/v1/devices/authorize/start")) {
      return Response.json({
        deviceCode: "device-secret",
        verificationUrl: "https://app.usetrinity.ai/?device_request=request-id",
        verificationCode: "A1B2-C3D4",
        expiresInSeconds: 600,
        intervalSeconds: 2,
      });
    }
    if (href.endsWith("/api/v1/devices/authorize/exchange")) {
      exchanges++;
      assert.deepEqual(JSON.parse(String(init?.body)), { deviceCode: "device-secret" });
      return exchanges === 1
        ? Response.json({ status: "pending" }, { status: 202 })
        : Response.json({ token: "tok-browser", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-browser" });
    }
    if (href.endsWith("/api/v1/ingest/policy")) {
      return Response.json({ etag: "policy-browser", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  try {
    await authorizeCursor({
      baseUrl: "https://api.usetrinity.ai",
      dataDir,
      deviceName: "Cursor on test",
      openURL: (url) => opened.push(url),
      showVerificationCode: (code) => shownCodes.push(code),
      wait: async () => undefined,
    });
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(opened, ["https://app.usetrinity.ai/?device_request=request-id"]);
  assert.deepEqual(shownCodes, ["A1B2-C3D4"]);
  assert.equal(exchanges, 2);
  const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { token: string; deviceId: string };
  assert.deepEqual(cfg, { token: "tok-browser", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-browser" });
});

test("browser authorization rejects a verification URL outside Trinity", async () => {
  const parent = tmpParentDir();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    deviceCode: "device-secret",
    verificationUrl: "https://attacker.example/?device_request=request-id",
    verificationCode: "A1B2-C3D4",
    expiresInSeconds: 600,
    intervalSeconds: 2,
  })) as typeof fetch;
  try {
    await assert.rejects(
      authorizeCursor({ baseUrl: "https://api.usetrinity.ai", dataDir: join(parent, "cursor"), deviceName: "Cursor" }),
      /untrusted verification URL/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("connect is idempotent: reconnecting re-secures permissions on an already-existing dir", async () => {
  const parent = tmpParentDir();
  const dataDir = join(parent, "cursor");
  const restore1 = stubExchange({ token: "tok-1", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-1" });
  try {
    await connectCursor("http://example.invalid", "CODE-1", dataDir);
  } finally {
    restore1();
  }
  const restore2 = stubExchange({ token: "tok-2", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-2" });
  try {
    await connectCursor("http://example.invalid", "CODE-2", dataDir);
  } finally {
    restore2();
  }

  const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { deviceId: string };
  assert.equal(cfg.deviceId, "dev-2", "the second connect must overwrite the first device's credentials");
  if (platform() !== "win32") {
    assert.equal(statSync(join(dataDir, "config.json")).mode & 0o777, 0o600);
  }
});

test("connect keeps an existing config and policy when the new device uses a different ingest origin", async () => {
  const parent = tmpParentDir();
  const dataDir = join(parent, "cursor");
  const existing: DeviceConfig = {
    token: "staging-token",
    ingestUrl: "https://api-staging.usetrinity.ai/api/v1/ingest/batches",
    deviceId: "staging-device",
  };
  saveConfig(dataDir, existing);
  savePolicy(dataDir, policy());
  const configPath = join(dataDir, "config.json");
  const policyPath = join(dataDir, "policy.json");
  const originalConfig = readFileSync(configPath, "utf8");
  const originalPolicy = readFileSync(policyPath, "utf8");
  const restore = stubExchange({
    token: "local-token",
    ingestUrl: "http://127.0.0.1:3000/api/v1/ingest/batches",
    deviceId: "local-device",
  });

  try {
    await assert.rejects(
      connectCursor("http://127.0.0.1:5173", "LOCAL-CODE", dataDir),
      /Existing Trinity connection kept.*disconnect.*switch/i,
    );
  } finally {
    restore();
  }

  assert.equal(readFileSync(configPath, "utf8"), originalConfig);
  assert.equal(readFileSync(policyPath, "utf8"), originalPolicy);
  assert.deepEqual(loadConfig(dataDir), existing);
});

test("the data directory connect writes to is ready for cursor-hook.js", async () => {
  const parent = tmpParentDir();
  const dataDir = join(parent, "cursor");
  const env = { ...process.env, TRINITY_CAPTURE_DATA: dataDir };
  assert.equal(cursorDialect.dataDir(env), dataDir);

  const restore = stubExchange({ token: "tok-x", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-x" });
  try {
    await connectCursor("http://example.invalid", "CODE-X", dataDir);
  } finally {
    restore();
  }

  assert.ok(loadConfig(dataDir), "loadConfig must read back what connect wrote");
  assert.ok(existsSync(join(dataDir, "policy.json")));
});

test("uninstall: the packaged plugin directory is self-contained (hooks.json references only files beneath it)", () => {
  const pluginDir = join(process.cwd(), "cursor");
  const hooksManifest = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, { command: string }[]>;
  };
  for (const [event, entries] of Object.entries(hooksManifest.hooks)) {
    for (const entry of entries) {
      assert.match(entry.command, /\$\{CURSOR_PLUGIN_ROOT\}\/dist\//, `${event}'s command must reference a file beneath the plugin's own root, not an absolute or external path`);
    }
  }
  const marketplace = JSON.parse(readFileSync(join(process.cwd(), ".cursor-plugin", "marketplace.json"), "utf8")) as {
    plugins: { source: string }[];
  };
  assert.ok(marketplace.plugins.some((p) => p.source === "./cursor"));
});

test("uninstall leaves the connected device's own credential directory untouched (outside the plugin tree)", async () => {
  const parent = tmpParentDir();
  const dataDir = join(parent, "cursor");
  const restore = stubExchange({ token: "tok-u", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev-u" });
  try {
    await connectCursor("http://example.invalid", "CODE-U", dataDir);
  } finally {
    restore();
  }
  assert.ok(existsSync(join(dataDir, "config.json")));

  const pluginCopy = join(parent, "installed-plugin");
  cpSync(join(process.cwd(), "cursor"), pluginCopy, { recursive: true });
  assert.ok(existsSync(join(pluginCopy, "dist", "cursor-hook.js")));

  rmSync(pluginCopy, { recursive: true, force: true });

  assert.ok(!existsSync(pluginCopy), "the simulated plugin install must be gone");
  assert.ok(existsSync(join(dataDir, "config.json")), "removing plugin files must never touch the separate data directory");
});
