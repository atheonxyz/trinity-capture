import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadPolicy, saveConfig, savePolicy } from "../src/config.js";

test("replacing a device invalidates its cached capture policy", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-config-data-"));
  const config = { token: "old-token", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "old-device" };
  saveConfig(dataDir, config);
  savePolicy(dataDir, { etag: "old-policy", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });

  saveConfig(dataDir, { ...config, token: "new-token", deviceId: "new-device" });

  assert.equal(loadPolicy(dataDir), null);
});

test("pairing without a credential invalidates an orphaned capture policy", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-config-data-"));
  savePolicy(dataDir, { etag: "orphan", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });

  saveConfig(dataDir, { token: "token", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "device" });

  assert.equal(loadPolicy(dataDir), null);
});

test("saving the same device preserves its cached capture policy", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-config-data-"));
  const config = { token: "token", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "device" };
  saveConfig(dataDir, config);
  savePolicy(dataDir, { etag: "policy", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });

  saveConfig(dataDir, config);

  assert.equal(loadPolicy(dataDir)?.etag, "policy");
});

test("rotating the same device token retires credential-scoped local capture state", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-config-data-"));
  const config = { token: "old-token", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "device" };
  saveConfig(dataDir, config);
  savePolicy(dataDir, { etag: "old-token-policy", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });
  mkdirSync(join(dataDir, "outbox"));
  mkdirSync(join(dataDir, "active-sessions"));
  mkdirSync(join(dataDir, "turnkeys"));
  writeFileSync(join(dataDir, "github-repositories.json"), JSON.stringify([{ name: "old-token-repo" }]));

  saveConfig(dataDir, { ...config, token: "new-token" });

  assert.equal(loadPolicy(dataDir), null);
  assert.equal(existsSync(join(dataDir, "github-repositories.json")), false);
  assert.equal(existsSync(join(dataDir, "outbox")), false);
  assert.equal(existsSync(join(dataDir, "active-sessions")), false);
  assert.equal(existsSync(join(dataDir, "turnkeys")), false);

  const retired = readdirSync(join(dataDir, "retired"));
  assert.equal(retired.length, 1);
  assert.equal(existsSync(join(dataDir, "retired", retired[0], "outbox")), true);
  assert.equal(existsSync(join(dataDir, "retired", retired[0], "active-sessions")), true);
  assert.equal(existsSync(join(dataDir, "retired", retired[0], "turnkeys")), true);
});

test("the device credential file is private to the current user", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-config-data-"));
  saveConfig(dataDir, { token: "secret", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" });

  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, "config.json")).mode & 0o777, 0o600);
});

test("loading an existing credential repairs permissive legacy permissions", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-config-data-"));
  const configPath = join(dataDir, "config.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ token: "secret", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" }));
  chmodSync(dataDir, 0o755);
  chmodSync(configPath, 0o644);

  assert.notEqual(loadConfig(dataDir), null);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
});
