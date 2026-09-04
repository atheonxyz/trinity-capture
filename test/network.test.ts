import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchange } from "../src/connect.js";
import { refreshPolicy, REQUEST_TIMEOUT_MS, sendBatch } from "../src/send.js";
import type { CaptureEvent } from "../src/outbox.js";
import type { DeviceConfig } from "../src/config.js";
import { loadPolicy, saveConfig } from "../src/config.js";

test("an in-flight old-device policy cannot overwrite a replacement pairing", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-network-data-"));
  const cfg = { token: "old", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "old" };
  saveConfig(dataDir, cfg);
  t.mock.method(globalThis, "fetch", async () => {
    saveConfig(dataDir, { ...cfg, token: "new", deviceId: "new" });
    return Response.json({ etag: "old", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });
  });

  const policy = await refreshPolicy(dataDir, cfg);

  assert.equal(policy, null);
  assert.equal(loadPolicy(dataDir), null);
});

test("plugin HTTP requests carry a bounded abort signal", async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 5_000);
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-network-data-"));
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  const event: CaptureEvent = {
    captureEventId: "11111111-1111-4111-8111-111111111111",
    tool: "claude_code",
    kind: "SessionStart",
    externalSessionId: "s1",
    repo: "github.com/acme/work",
    repoCwd: ".",
    occurredAt: new Date().toISOString(),
    payload: { session_id: "s1" },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal, `${String(input)} has no timeout signal`);
    const url = String(input);
    if (url.endsWith("/devices/exchange")) {
      return Response.json({ token: "tok", deviceId: "dev1", ingestUrl: cfg.ingestUrl });
    }
    if (url.endsWith("/policy")) {
      return Response.json({ etag: "e1", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });
    }
    return Response.json({ results: [{ captureEventId: event.captureEventId, outcome: "stored" }] });
  }) as typeof fetch;
  try {
    await exchange("https://api.example", "ABCD1234EFGH");
    await refreshPolicy(dataDir, cfg);
    await sendBatch(cfg, [event]);
  } finally {
    globalThis.fetch = original;
  }
});
