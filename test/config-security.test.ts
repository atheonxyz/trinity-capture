import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";

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
