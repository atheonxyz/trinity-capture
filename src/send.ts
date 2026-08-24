import type { CaptureEvent } from "./outbox.js";
import type { DeviceConfig, Policy } from "./config.js";
import { loadPolicy, savePolicy } from "./config.js";

export const REQUEST_TIMEOUT_MS = 10_000;

export interface ItemResult {
  captureEventId: string;
  outcome: "stored" | "duplicate" | "rejected_permanent" | "retry_later";
  code?: string;
}

export class BatchRequestError extends Error {
  constructor(readonly status: number) {
    super(`ingest batch failed: ${status}`);
  }
}

export async function sendBatch(cfg: DeviceConfig, events: CaptureEvent[]): Promise<ItemResult[]> {
  const res = await fetch(cfg.ingestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      "X-Trinity-Wire-Version": "1",
    },
    body: JSON.stringify({ items: events }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new BatchRequestError(res.status);
  const body = (await res.json()) as { results: ItemResult[] };
  return body.results;
}

export async function refreshPolicy(dataDir: string, cfg: DeviceConfig): Promise<Policy | null> {
  const current = loadPolicy(dataDir);
  const policyUrl = cfg.ingestUrl.replace(/\/batches$/, "/policy");
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
  if (current) headers["If-None-Match"] = current.etag;

  const res = await fetch(policyUrl, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 304 && current) {
    const refreshed: Policy = { ...current, fetchedAt: Date.now() };
    savePolicy(dataDir, refreshed);
    return refreshed;
  }
  if (!res.ok) return current;

  const doc = (await res.json()) as Omit<Policy, "fetchedAt">;
  const policy: Policy = { ...doc, fetchedAt: Date.now() };
  savePolicy(dataDir, policy);
  return policy;
}
