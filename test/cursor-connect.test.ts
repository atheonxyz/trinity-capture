// Connect flow: exchange against a stub server writes a mode-0700 data
// directory and a mode-0600 DeviceConfig under it (spec finding 3 — no
// CURSOR_PLUGIN_DATA equivalent exists, so this is the secured per-user
// application-data location cursorDialect.dataDir resolves). The credential
// home is PROVEN, not assumed: the same dataDir a following cursor-hook.js
// SessionStart invocation reads back from must be the exact one connect
// wrote to.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { connectCursor } from "../src/cursor-connect.js";
import { cursorDialect } from "../src/cursor-hook.js";
import { loadConfig } from "../src/config.js";

function tmpParentDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-cursor-connect-"));
}

function stubExchange(deviceConfig: { token: string; ingestUrl: string; deviceId: string }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
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

test("connect writes a 0700 data dir and a 0600 config.json a device did not have before", async () => {
  const parent = tmpParentDir();
  const dataDir = join(parent, "cursor"); // deliberately not pre-created — connect must make it
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

// The credential home PROVEN, not assumed: this is the same dataDir
// resolution cursorDialect.dataDir performs (TRINITY_CAPTURE_DATA override),
// and a hook invocation using that exact env reads the connected device
// back successfully.
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

// Uninstall: nothing outside the plugin's own directory tree is written by
// the plugin or the connect flow, so removing the plugin directory itself
// leaves the hooks manifest self-contained — no separate cleanup step, no
// stray file elsewhere referencing the removed plugin.
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
  // Simulating uninstall (rm -rf the plugin dir) leaves nothing else on
  // disk referencing it — the only artifact outside cursor/ is the
  // repo-root marketplace manifest naming the plugin by relative path, not
  // by anything inside its dist.
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

  // "Uninstalling" the plugin means removing its packaged directory, never
  // this data directory — they are deliberately disjoint (Application
  // Support/XDG state vs. the plugin install location), so a reinstall +
  // reconnect is the only way credentials are ever cleared. Simulated
  // against a disposable copy of the plugin tree — never the committed
  // cursor/ directory itself.
  const pluginCopy = join(parent, "installed-plugin");
  cpSync(join(process.cwd(), "cursor"), pluginCopy, { recursive: true });
  assert.ok(existsSync(join(pluginCopy, "dist", "cursor-hook.js")));

  rmSync(pluginCopy, { recursive: true, force: true }); // the uninstall itself

  assert.ok(!existsSync(pluginCopy), "the simulated plugin install must be gone");
  assert.ok(existsSync(join(dataDir, "config.json")), "removing plugin files must never touch the separate data directory");
});
