import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceConfig } from "./config.js";
import { BatchRequestError, refreshPolicy, sendBatch } from "./send.js";

export interface CaptureEvent {
  captureEventId: string;
  tool: "claude_code";
  kind: string;
  externalSessionId: string;
  repo: string;
  repoCwd: string;
  occurredAt: string;
  turnKey?: string;
  payload: unknown;
}

export interface DropRecord {
  at: string;
  reason: "oversized" | "poison" | "expired";
  captureEventId: string;
  kind: string;
}

const MAX_BATCHES = 5;
const MAX_EVENTS_PER_BATCH = 100;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const MAX_RETRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DROP_RECORDS = 100;

interface OutboxEntry {
  file: string;
  bytes: number;
  event: CaptureEvent;
}

function outboxDir(dataDir: string): string {
  const dir = join(dataDir, "outbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(dir: string, ev: CaptureEvent): string {
  const stamp = ev.occurredAt.replace(/[^0-9]/g, "");
  return join(dir, `${stamp}-${ev.captureEventId}.jsonl`);
}

function isAlreadyQueued(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

function recordDrop(dataDir: string, drop: Omit<DropRecord, "at">): void {
  try {
    const path = join(dataDir, "status.json");
    let drops: DropRecord[] = [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { drops?: DropRecord[] };
      if (Array.isArray(parsed.drops)) drops = parsed.drops;
    } catch {
      drops = [];
    }
    drops.push({ at: new Date().toISOString(), ...drop });
    writeFileSync(path, JSON.stringify({ drops: drops.slice(-MAX_DROP_RECORDS) }, null, 2));
  } catch {
    return;
  }
}

export function appendEvent(dataDir: string, ev: CaptureEvent): void {
  const line = JSON.stringify(ev) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
    recordDrop(dataDir, { reason: "oversized", captureEventId: ev.captureEventId, kind: ev.kind });
    return;
  }
  const dir = outboxDir(dataDir);
  try {
    writeFileSync(fileFor(dir, ev), line, { flag: "wx" });
  } catch (err) {
    if (isAlreadyQueued(err)) return;
    throw err;
  }
}

export async function drain(dataDir: string, cfg: DeviceConfig): Promise<void> {
  const dir = outboxDir(dataDir);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  const entries: OutboxEntry[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let raw: string;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    let event: CaptureEvent;
    try {
      event = JSON.parse(raw) as CaptureEvent;
    } catch {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() - mtimeMs > MAX_RETRY_AGE_MS) {
      rmSync(path, { force: true });
      recordDrop(dataDir, { reason: "expired", captureEventId: event.captureEventId, kind: event.kind });
      continue;
    }
    entries.push({ file, bytes: Buffer.byteLength(raw, "utf8"), event });
  }

  let offset = 0;
  let policyStale = false;
  for (let batch = 0; batch < MAX_BATCHES && offset < entries.length; batch++) {
    const slice: OutboxEntry[] = [];
    let sliceBytes = 0;
    while (offset < entries.length && slice.length < MAX_EVENTS_PER_BATCH) {
      const next = entries[offset];
      if (slice.length > 0 && sliceBytes + next.bytes > MAX_BATCH_BYTES) break;
      slice.push(next);
      sliceBytes += next.bytes;
      offset++;
    }
    const outcome = await deliverBatch(dir, dataDir, cfg, slice);
    if (outcome === "abort") break;
    if (outcome.policyStale) policyStale = true;
  }

  if (policyStale) {
    try {
      await refreshPolicy(dataDir, cfg);
    } catch {
      return;
    }
  }
}

type DeliveryOutcome = { policyStale: boolean } | "abort";

async function deliverBatch(dir: string, dataDir: string, cfg: DeviceConfig, entries: OutboxEntry[]): Promise<DeliveryOutcome> {
  let results;
  try {
    results = await sendBatch(cfg, entries.map((e) => e.event));
  } catch (err) {
    if (err instanceof BatchRequestError && err.status === 413) {
      if (entries.length === 1) {
        rmSync(join(dir, entries[0].file), { force: true });
        recordDrop(dataDir, { reason: "poison", captureEventId: entries[0].event.captureEventId, kind: entries[0].event.kind });
        return { policyStale: false };
      }
      const mid = Math.ceil(entries.length / 2);
      const left = await deliverBatch(dir, dataDir, cfg, entries.slice(0, mid));
      if (left === "abort") return "abort";
      const right = await deliverBatch(dir, dataDir, cfg, entries.slice(mid));
      if (right === "abort") return "abort";
      return { policyStale: left.policyStale || right.policyStale };
    }
    return "abort";
  }

  const resultById = new Map(results.map((r) => [r.captureEventId, r]));
  let policyStale = false;
  for (const { file, event } of entries) {
    const result = resultById.get(event.captureEventId);
    if (result === undefined) continue;
    if (result.outcome === "stored" || result.outcome === "duplicate" || result.outcome === "rejected_permanent") {
      rmSync(join(dir, file), { force: true });
    } else if (result.outcome === "retry_later" && result.code === "policy_stale") {
      policyStale = true;
    }
  }
  return { policyStale };
}
