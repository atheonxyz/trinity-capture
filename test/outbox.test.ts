import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, drain } from "../src/outbox.js";
import type { CaptureEvent, DropRecord } from "../src/outbox.js";
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
    payload: { prompt: "hello" },
  };
}

function readDrops(dataDir: string): DropRecord[] {
  const status = JSON.parse(readFileSync(join(dataDir, "status.json"), "utf8")) as { drops: DropRecord[] };
  return status.drops;
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

test("appendEvent treats the same capture event as already queued", () => {
  const dataDir = tmpDataDir();
  const ev = makeEvent("12121212-1212-1212-1212-121212121212");
  appendEvent(dataDir, ev);
  appendEvent(dataDir, ev);

  assert.equal(readdirSync(join(dataDir, "outbox")).length, 1);
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

test("appendEvent drops an event over the per-event cap and records the drop", () => {
  const dataDir = tmpDataDir();
  const oversized = makeEvent("55555555-5555-5555-5555-555555555555");
  oversized.payload = { prompt: "x".repeat(256 * 1024) };
  appendEvent(dataDir, oversized);

  assert.equal(existsSync(join(dataDir, "outbox")) ? readdirSync(join(dataDir, "outbox")).length : 0, 0);
  const drops = readDrops(dataDir);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "oversized");
  assert.equal(drops[0].captureEventId, oversized.captureEventId);
});

test("drain assembles batches under the byte budget, not just the count cap", async () => {
  const dataDir = tmpDataDir();
  for (let i = 0; i < 16; i++) {
    const ev = makeEvent(`${String(i).padStart(8, "0")}-2222-0000-0000-000000000000`, new Date(i).toISOString());
    ev.payload = { prompt: "x".repeat(200 * 1024) };
    appendEvent(dataDir, ev);
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

  assert.deepEqual(batchSizes, [15, 1]);
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 0);
});

test("a 413 batch is bisected until the poisoned event stands alone and is dropped", async () => {
  const dataDir = tmpDataDir();
  const poisonId = "00000002-3333-0000-0000-000000000000";
  for (let i = 0; i < 4; i++) {
    appendEvent(dataDir, makeEvent(`${String(i).padStart(8, "0")}-3333-0000-0000-000000000000`, new Date(i).toISOString()));
  }

  const batchSizes: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { items: CaptureEvent[] };
    batchSizes.push(body.items.length);
    if (body.items.some((item) => item.captureEventId === poisonId)) {
      return new Response("batch body too large", { status: 413 });
    }
    return new Response(
      JSON.stringify({ results: body.items.map((item) => ({ captureEventId: item.captureEventId, outcome: "stored" })) }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await drain(dataDir, cfg);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(readdirSync(join(dataDir, "outbox")).length, 0);
  const drops = readDrops(dataDir);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "poison");
  assert.equal(drops[0].captureEventId, poisonId);
  assert.ok(batchSizes[0] === 4 && batchSizes.includes(1), `bisection path was ${batchSizes}`);
});

test("a policy_stale outcome triggers exactly one policy refresh after the drain pass", async () => {
  const dataDir = tmpDataDir();
  appendEvent(dataDir, makeEvent("66666666-6666-6666-6666-666666666666"));
  appendEvent(dataDir, makeEvent("77777777-7777-7777-7777-777777777777"));

  let policyCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/policy")) {
      policyCalls++;
      return new Response(
        JSON.stringify({ etag: "fresh", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] }),
        { status: 200 },
      );
    }
    const body = JSON.parse(String(init?.body)) as { items: CaptureEvent[] };
    return new Response(
      JSON.stringify({
        results: body.items.map((item) => ({ captureEventId: item.captureEventId, outcome: "retry_later", code: "policy_stale" })),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await drain(dataDir, cfg);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(policyCalls, 1, "one refresh, not one per stale item");
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 2, "stale items stay queued for the next drain");
});

test("drain drops events older than the retry window without sending them", async () => {
  const dataDir = tmpDataDir();
  const stale = makeEvent("88888888-8888-8888-8888-888888888888", new Date(0).toISOString());
  const fresh = makeEvent("99999999-9999-9999-9999-999999999999");
  appendEvent(dataDir, stale);
  appendEvent(dataDir, fresh);
  const staleFile = readdirSync(join(dataDir, "outbox")).find((f) => f.includes(stale.captureEventId));
  assert.ok(staleFile);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(join(dataDir, "outbox", staleFile), eightDaysAgo, eightDaysAgo);

  const sentIds: string[] = [];
  const restore = stubFetch((body) => {
    sentIds.push(...body.items.map((i) => i.captureEventId));
    return body.items.map((item) => ({ captureEventId: item.captureEventId, outcome: "stored" }));
  });
  try {
    await drain(dataDir, cfg);
  } finally {
    restore();
  }

  assert.deepEqual(sentIds, [fresh.captureEventId], "the expired event must never be sent");
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 0);
  const drops = readDrops(dataDir);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "expired");
  assert.equal(drops[0].captureEventId, stale.captureEventId);
});
