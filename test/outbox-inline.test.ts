import { mkdtempSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceConfig } from "../src/config.js";
import { appendEvent, drain, type CaptureEvent } from "../src/outbox.js";

const cfg: DeviceConfig = {
  token: "tok",
  ingestUrl: "https://ingest.example/api/v1/ingest/batches",
  deviceId: "dev1",
};

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-inline-outbox-"));
}

function event(id: number): CaptureEvent {
  return {
    captureEventId: `${String(id).padStart(8, "0")}-4444-4444-8444-000000000000`,
    tool: "claude_code",
    kind: "PostToolUse",
    externalSessionId: "s1",
    repo: "github.com/acme/widgets",
    repoCwd: ".",
    occurredAt: new Date(id).toISOString(),
    payload: {},
  };
}

test("an elapsed inline deadline skips network delivery", async () => {
  const dir = dataDir();
  appendEvent(dir, event(1));
  const original = globalThis.fetch;
  let calls = 0;
  const stub: typeof fetch = async () => {
    calls++;
    throw new Error("unexpected fetch");
  };
  globalThis.fetch = stub;
  try {
    await drain(dir, cfg, { inline: true, deadline: Date.now() - 1 });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls, 0);
  assert.equal(readdirSync(join(dir, "outbox")).length, 1);
});

test("an inline request aborts at the remaining hook budget", async () => {
  const dir = dataDir();
  appendEvent(dir, event(2));
  const original = globalThis.fetch;
  const stalled: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      const guard = setTimeout(() => reject(new Error("abort signal did not fire")), 1_000);
      const abort = () => {
        clearTimeout(guard);
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  globalThis.fetch = stalled;
  const started = Date.now();
  try {
    await drain(dir, cfg, { inline: true, deadline: started + 50 });
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(Date.now() - started < 1_000);
  assert.equal(readdirSync(join(dir, "outbox")).length, 1);
});

test("an inline drain sends one batch and leaves the remainder queued", async () => {
  const dir = dataDir();
  const events = Array.from({ length: 150 }, (_, index) => event(index + 10));
  for (const item of events) appendEvent(dir, item);
  const original = globalThis.fetch;
  let calls = 0;
  const stub: typeof fetch = async () => {
    calls++;
    return Response.json({
      results: events.slice(0, 100).map((item) => ({ captureEventId: item.captureEventId, outcome: "stored" })),
    });
  };
  globalThis.fetch = stub;
  try {
    await drain(dir, cfg, { inline: true, deadline: Date.now() + 2_000 });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls, 1);
  assert.equal(readdirSync(join(dir, "outbox")).length, 50);
});
