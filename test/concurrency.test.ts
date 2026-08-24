import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, drain, type CaptureEvent } from "../src/outbox.js";
import type { DeviceConfig } from "../src/config.js";

test("overlapping drains settle the same acknowledged event without throwing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-concurrent-data-"));
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
  appendEvent(dataDir, event);
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" };
  let calls = 0;
  let releaseResponses: (() => void) | undefined;
  const responsesReady = new Promise<void>((resolve) => {
    releaseResponses = resolve;
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 2) releaseResponses?.();
    await responsesReady;
    return Response.json({ results: [{ captureEventId: event.captureEventId, outcome: "stored" }] });
  }) as typeof fetch;
  try {
    const results = await Promise.allSettled([drain(dataDir, cfg), drain(dataDir, cfg)]);
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
  } finally {
    globalThis.fetch = original;
  }
});
