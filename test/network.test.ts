import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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

test("an in-flight old-token policy cannot overwrite a same-device reconnect", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-network-data-"));
  const cfg = { token: "old-token", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "device" };
  saveConfig(dataDir, cfg);
  t.mock.method(globalThis, "fetch", async () => {
    saveConfig(dataDir, { ...cfg, token: "new-token" });
    return Response.json({ etag: "old-token-policy", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });
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
    await exchange("https://api.example", "ABCD1234EFGH", async () => "d".repeat(64));
    await refreshPolicy(dataDir, cfg);
    await sendBatch(cfg, [event]);
  } finally {
    globalThis.fetch = original;
  }
});

test("exchange reports the hostname and stable machine id", async () => {
  const bodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ token: "tok", deviceId: "dev1", ingestUrl: "https://ingest.example/api/v1/ingest/batches" });
  }) as typeof fetch;
  try {
    await exchange("https://api.example", "ABCD1234EFGH", async () => "a".repeat(64));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(bodies, [{ code: "ABCD1234EFGH", hostname: hostname(), machineId: "a".repeat(64) }]);
});

test("exchange fails closed before network I/O when machine identity is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  try {
    await assert.rejects(
      exchange("https://api.example", "ABCD1234EFGH", async () => {
        throw new Error("Machine identity unavailable.");
      }),
      /Machine identity unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("a batch carries the machine's hostname beside its items", async () => {
  let body: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ results: [] });
  }) as typeof fetch;
  try {
    await sendBatch({ token: "tok", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" }, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(body, { items: [], hostname: hostname() });
});
