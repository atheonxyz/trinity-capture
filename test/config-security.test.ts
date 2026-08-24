import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config.js";

test("the device credential file is private to the current user", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-config-data-"));
  saveConfig(dataDir, { token: "secret", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" });

  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, "config.json")).mode & 0o777, 0o600);
});
