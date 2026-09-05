import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, drain } from "../src/outbox.js";
import type { CaptureEvent, DropRecord } from "../src/outbox.js";
import { saveConfig, type DeviceConfig } from "../src/config.js";
import type { ItemResult } from "../src/send.js";
import { activationStatus, markPairedAwaitingNewSession } from "../src/activation.js";

type BatchBody = { readonly items: CaptureEvent[] };

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

test("a drain only sends events owned by its paired device", async () => {
  const dataDir = tmpDataDir();
  const current = makeEvent("current-event");
  appendEvent(dataDir, makeEvent("old-event"), "previous-device");
  appendEvent(dataDir, current, cfg.deviceId);

  await drainWithStubFetch(dataDir, ({ items }) => {
    assert.deepEqual(items, [current]);
    return storedResults(items);
  });

  assert.equal(readdirSync(join(dataDir, "outbox")).length, 1);
});

test("reconnecting quarantines legacy queued events without deleting them", async () => {
  const dataDir = tmpDataDir();
  saveConfig(dataDir, { ...cfg, deviceId: "previous-device" });
  const previous = makeEvent("legacy-event");
  appendEvent(dataDir, previous);

  saveConfig(dataDir, cfg);
  await drainWithStubFetch(dataDir, () => assert.fail("old-device events must not be transmitted"));

  assert.equal(readdirSync(join(dataDir, "outbox")).length, 0);
  const retired = readdirSync(join(dataDir, "retired"));
  assert.equal(retired.length, 1);
  const oldOutbox = join(dataDir, "retired", retired[0], "outbox");
  const files = readdirSync(oldOutbox);
  assert.deepEqual(JSON.parse(readFileSync(join(oldOutbox, files[0]), "utf8")), previous);
});

function batchBody(init?: RequestInit): BatchBody {
  return JSON.parse(String(init?.body)) as BatchBody;
}

function storedResults(items: readonly CaptureEvent[]): ItemResult[] {
  return items.map((item) => ({ captureEventId: item.captureEventId, outcome: "stored" }));
}

function readRetiredOutboxCaptureEventId(dataDir: string): string {
  const retired = readdirSync(join(dataDir, "retired"));
  assert.equal(retired.length, 1);
  const oldOutbox = join(dataDir, "retired", retired[0], "outbox");
  const files = readdirSync(oldOutbox);
  assert.equal(files.length, 1);
  const parsed: unknown = JSON.parse(readFileSync(join(oldOutbox, files[0]), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("captureEventId" in parsed)) {
    throw new Error("retired outbox event must be a JSON object with captureEventId");
  }
  if (typeof parsed.captureEventId !== "string") {
    throw new Error("retired outbox event captureEventId must be a string");
  }
  return parsed.captureEventId;
}

async function drainWithFetch(dataDir: string, fetchImpl: typeof fetch): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await drain(dataDir, cfg);
  } finally {
    globalThis.fetch = original;
  }
}

async function drainWithStubFetch(dataDir: string, handler: (body: BatchBody) => ItemResult[]): Promise<void> {
  await drainWithFetch(
    dataDir,
    async (_url: string | Request | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ results: handler(batchBody(init)) }), { status: 200 }),
  );
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

  await drainWithStubFetch(
    dataDir,
    (body) =>
      body.items.map((item) => ({
        captureEventId: item.captureEventId,
        outcome: item.captureEventId === e1.captureEventId ? "stored" : "retry_later",
      })),
  );

  const remaining = readdirSync(join(dataDir, "outbox"));
  assert.equal(remaining.length, 1);
  assert.match(remaining[0], new RegExp(e2.captureEventId));
});

test("drain marks a device captured only after an acknowledged delivery", async () => {
  const dataDir = tmpDataDir();
  markPairedAwaitingNewSession(dataDir, cfg.deviceId);
  saveConfig(dataDir, cfg);
  appendEvent(dataDir, makeEvent("23232323-2323-2323-2323-232323232323"));
  assert.equal(activationStatus(dataDir), "paired-awaiting-new-session");

  await drainWithStubFetch(dataDir, (body) => storedResults(body.items));

  assert.equal(activationStatus(dataDir), "captured");
});

test("an old-token drain cannot mark a same-device reconnect captured or delete queued events", async () => {
  const dataDir = tmpDataDir();
  const oldCfg: DeviceConfig = { ...cfg, token: "old-token" };
  const newCfg: DeviceConfig = { ...cfg, token: "new-token" };
  const event = makeEvent("24242424-2424-2424-2424-242424242424");
  saveConfig(dataDir, oldCfg);
  markPairedAwaitingNewSession(dataDir, oldCfg.deviceId);
  appendEvent(dataDir, event, oldCfg.deviceId);

  await drainWithFetch(
    dataDir,
    async (_url: string | Request | URL, init?: RequestInit) => {
      assert.deepEqual(batchBody(init).items, [event]);
      saveConfig(dataDir, newCfg);
      markPairedAwaitingNewSession(dataDir, newCfg.deviceId);
      return new Response(JSON.stringify({ results: storedResults([event]) }), { status: 200 });
    },
  );

  assert.equal(activationStatus(dataDir), "paired-awaiting-new-session");
  assert.equal(existsSync(join(dataDir, "outbox")), false);
  assert.equal(readRetiredOutboxCaptureEventId(dataDir), event.captureEventId);
});

test("an old-token 413 response cannot drop queued events after same-device reconnect", async () => {
  const dataDir = tmpDataDir();
  const oldCfg: DeviceConfig = { ...cfg, token: "old-token" };
  const event = makeEvent("25252525-2525-2525-2525-252525252525");
  saveConfig(dataDir, oldCfg);
  appendEvent(dataDir, event, oldCfg.deviceId);

  await drainWithFetch(
    dataDir,
    async () => {
      saveConfig(dataDir, { ...oldCfg, token: "new-token" });
      return new Response("batch body too large", { status: 413 });
    },
  );

  assert.equal(existsSync(join(dataDir, "outbox")), false);
  assert.equal(readRetiredOutboxCaptureEventId(dataDir), event.captureEventId);
  assert.equal(existsSync(join(dataDir, "status.json")), false);
});

test("drain retains the whole outbox on a request-level failure", async () => {
  const dataDir = tmpDataDir();
  appendEvent(dataDir, makeEvent("33333333-3333-3333-3333-333333333333"));
  appendEvent(dataDir, makeEvent("44444444-4444-4444-4444-444444444444"));

  await drainWithFetch(
    dataDir,
    async () => {
      throw new Error("network down");
    },
  );

  assert.equal(readdirSync(join(dataDir, "outbox")).length, 2);
});

test("drain caps each request at 100 events", async () => {
  const dataDir = tmpDataDir();
  for (let i = 0; i < 101; i++) {
    appendEvent(dataDir, makeEvent(`${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`, new Date(i).toISOString()));
  }

  const batchSizes: number[] = [];
  await drainWithStubFetch(
    dataDir,
    (body) => {
      batchSizes.push(body.items.length);
      return storedResults(body.items);
    },
  );

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
  await drainWithStubFetch(
    dataDir,
    (body) => {
      calls++;
      return storedResults(body.items);
    },
  );

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
  await drainWithStubFetch(
    dataDir,
    (body) => {
      batchSizes.push(body.items.length);
      return storedResults(body.items);
    },
  );

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
  await drainWithFetch(
    dataDir,
    async (_url: string | Request | URL, init?: RequestInit) => {
      const body = batchBody(init);
      batchSizes.push(body.items.length);
      if (body.items.some((item) => item.captureEventId === poisonId)) {
        return new Response("batch body too large", { status: 413 });
      }
      return new Response(JSON.stringify({ results: storedResults(body.items) }), { status: 200 });
    },
  );

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
  await drainWithFetch(
    dataDir,
    async (url: string | Request | URL, init?: RequestInit) => {
      if (String(url).endsWith("/policy")) {
        policyCalls++;
        return new Response(
          JSON.stringify({ etag: "fresh", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          results: batchBody(init).items.map((item) => ({
            captureEventId: item.captureEventId,
            outcome: "retry_later",
            code: "policy_stale",
          })),
        }),
        { status: 200 },
      );
    },
  );

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
  await drainWithStubFetch(
    dataDir,
    (body) => {
      sentIds.push(...body.items.map((i) => i.captureEventId));
      return storedResults(body.items);
    },
  );

  assert.deepEqual(sentIds, [fresh.captureEventId], "the expired event must never be sent");
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 0);
  const drops = readDrops(dataDir);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "expired");
  assert.equal(drops[0].captureEventId, stale.captureEventId);
});
