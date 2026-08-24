// JSONL outbox: one file per pending event under <dataDir>/outbox/, written
// before any network I/O; deleted only once its outcome is terminal
// (stored/duplicate/rejected_permanent). drain() groups files into batches
// at send time (spec §4.5/§5).
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceConfig } from "./config.js";
import { sendBatch } from "./send.js";

export interface CaptureEvent {
  captureEventId: string;
  tool: "claude_code";
  kind: string;
  externalSessionId: string;
  repo: string;
  repoCwd: string;
  occurredAt: string;
  payload: unknown;
}

const MAX_BATCHES = 5;
const MAX_EVENTS_PER_BATCH = 100;

function outboxDir(dataDir: string): string {
  const dir = join(dataDir, "outbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(dir: string, ev: CaptureEvent): string {
  const stamp = ev.occurredAt.replace(/[^0-9]/g, "");
  return join(dir, `${stamp}-${ev.captureEventId}.jsonl`);
}

export function appendEvent(dataDir: string, ev: CaptureEvent): void {
  const dir = outboxDir(dataDir);
  writeFileSync(fileFor(dir, ev), JSON.stringify(ev) + "\n", { flag: "wx" });
}

export async function drain(dataDir: string, cfg: DeviceConfig): Promise<void> {
  const dir = outboxDir(dataDir);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  let offset = 0;
  for (let batch = 0; batch < MAX_BATCHES && offset < files.length; batch++) {
    const slice = files.slice(offset, offset + MAX_EVENTS_PER_BATCH);
    offset += slice.length;

    const entries: { file: string; event: CaptureEvent }[] = [];
    for (const file of slice) {
      const path = join(dir, file);
      try {
        entries.push({ file, event: JSON.parse(readFileSync(path, "utf8").trim()) as CaptureEvent });
      } catch {
        unlinkSync(path); // corrupt entry — cannot be retried meaningfully
      }
    }
    if (entries.length === 0) continue;

    let results;
    try {
      results = await sendBatch(cfg, entries.map((e) => e.event));
    } catch {
      return; // request-level failure (network/401/403/429/5xx) — retain the whole outbox
    }

    const outcomeById = new Map(results.map((r) => [r.captureEventId, r.outcome]));
    for (const { file, event } of entries) {
      const outcome = outcomeById.get(event.captureEventId);
      if (outcome === "stored" || outcome === "duplicate" || outcome === "rejected_permanent") {
        unlinkSync(join(dir, file));
      }
      // retry_later (or an outcome missing from the response): kept for the next drain.
    }
  }
}
