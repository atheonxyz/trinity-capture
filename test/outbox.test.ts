import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, drain } from "../src/outbox.js";
import type { CaptureEvent } from "../src/outbox.js";
import type { DeviceConfig } from "../src/config.js";
import type { ItemResult } from "../src/send.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-outbox-"));
}

function makeEvent(id: string, occurredAt = new Date().toISOString()): CaptureEvent {
  return {
    captureEventId: id,
    tool: "claude_code",
    kind: "UserPromptSubmit",
    externalSessionId: "s1",
    repo: "github.com/a/r",
    repoCwd: "",
    occurredAt,
    payload: { user_input: "hello" },
  };
}

const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "d1" };

function stubFetch(handler: (body: { items: CaptureEvent[] }) => ItemResult[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { items: CaptureEvent[] };
    return new Response(JSON.stringify({ results: handler(body) }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("appendEvent writes a file that round-trips", () => {
  const dataDir = tmpDataDir();
  const ev = makeEvent("11111111-1111-1111-1111-111111111111");
  appendEvent(dataDir, ev);

  const files = readdirSync(join(dataDir, "outbox"));
  assert.equal(files.length, 1);
  const content = readFileSync(join(dataDir, "outbox", files[0]), "utf8");
  assert.deepEqual(JSON.parse(content.trim()), ev);
});

test("drain deletes acknowledged events and keeps retry_later ones", async () => {
  const dataDir = tmpDataDir();
  const e1 = makeEvent("11111111-1111-1111-1111-111111111111");
  const e2 = makeEvent("22222222-2222-2222-2222-222222222222");
  appendEvent(dataDir, e1);
  appendEvent(dataDir, e2);

  const restore = stubFetch((body) =>
    body.items.map((item) => ({
      captureEventId: item.captureEventId,
      outcome: item.captureEventId === e1.captureEventId ? "stored" : "retry_later",
    })),
  );
  try {
    await drain(dataDir, cfg);
  } finally {
    restore();
  }

  const remaining = readdirSync(join(dataDir, "outbox"));
  assert.equal(remaining.length, 1);
  assert.match(remaining[0], new RegExp(e2.captureEventId));
});

test("drain retains the whole outbox on a request-level failure", async () => {
  const dataDir = tmpDataDir();
  appendEvent(dataDir, makeEvent("33333333-3333-3333-3333-333333333333"));
  appendEvent(dataDir, makeEvent("44444444-4444-4444-4444-444444444444"));

  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    await drain(dataDir, cfg);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(readdirSync(join(dataDir, "outbox")).length, 2);
});

test("drain caps each request at 100 events", async () => {
  const dataDir = tmpDataDir();
  for (let i = 0; i < 101; i++) {
    appendEvent(dataDir, makeEvent(`${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`, new Date(i).toISOString()));
  }

  const batchSizes: number[] = [];
  const restore = stubFetch((body) => {
    batchSizes.push(body.items.length);
    return body.items.map((item) => ({ captureEventId: item.captureEventId, outcome: "stored" }));
  });
  try {
    await drain(dataDir, cfg);
  } finally {
    restore();
  }

  assert.deepEqual(batchSizes, [100, 1]);
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 0);
});

test("drain sends at most 5 batches per call", async () => {
  const dataDir = tmpDataDir();
  const total = 5 * 100 + 50;
  for (let i = 0; i < total; i++) {
    appendEvent(dataDir, makeEvent(`${String(i).padStart(8, "0")}-1111-0000-0000-000000000000`, new Date(i).toISOString()));
  }

  let calls = 0;
  const restore = stubFetch((body) => {
    calls++;
    return body.items.map((item) => ({ captureEventId: item.captureEventId, outcome: "stored" }));
  });
  try {
    await drain(dataDir, cfg);
  } finally {
    restore();
  }

  assert.equal(calls, 5);
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 50);
});
