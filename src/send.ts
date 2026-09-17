import { hostname } from "node:os";
import type { DeviceConfig, Policy } from "./config.js";
import { isCurrentConfig, loadPolicy, savePolicy } from "./config.js";
import type { CaptureEvent } from "./outbox.js";

export const REQUEST_TIMEOUT_MS = 5_000;

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

export async function sendBatch(
  cfg: DeviceConfig,
  events: CaptureEvent[],
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ItemResult[]> {
  const res = await fetch(cfg.ingestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      "X-Trinity-Wire-Version": "1",
    },
    body: JSON.stringify({ items: events, hostname: hostname() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new BatchRequestError(res.status);
  const body = (await res.json()) as { results: ItemResult[] };
  return body.results;
}

export async function refreshPolicy(
  dataDir: string,
  cfg: DeviceConfig,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Policy | null> {
  const current = loadPolicy(dataDir);
  const policyUrl = cfg.ingestUrl.replace(/\/batches$/, "/policy");
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
  if (current) headers["If-None-Match"] = current.etag;

  const res = await fetch(policyUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!isCurrentConfig(dataDir, cfg)) return null;
  if (res.status === 304 && current) {
    const refreshed: Policy = { ...current, fetchedAt: Date.now() };
    savePolicy(dataDir, refreshed);
    return refreshed;
  }
  if (!res.ok) return current;

  const doc = (await res.json()) as Omit<Policy, "fetchedAt">;
  if (!isCurrentConfig(dataDir, cfg)) return null;
  const policy: Policy = { ...doc, fetchedAt: Date.now() };
  savePolicy(dataDir, policy);
  return policy;
}

export interface SessionContextCandidate {
  taskId: string;
  key?: string;
  url?: string;
  title: string;
  status: string;
  priority: string;
  via: string;
  dueDate?: string;
  whyToday?: string[];
  workableNow?: boolean;
  milestone?: { id: string; name: string; targetDate: string };
  resolutions?: { openCount: number };
}

export interface SessionContextAnswer {
  route: string;
  projectId?: string;
  candidates: SessionContextCandidate[];
}

function isCandidate(value: unknown): value is SessionContextCandidate {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.taskId === "string" && typeof record.title === "string" && typeof record.status === "string";
}

// The one read a device makes per session: which tasks this branch and person are likely on.
// It sends nothing the capture allowlist does not already forward (the canonical repository,
// the branch workspace.observed carries, the prompt UserPromptSubmit forwards whole), as a
// body rather than a query string. Any failure is null: the pull never blocks capture.
export async function fetchSessionContext(
  cfg: DeviceConfig,
  query: { repo: string; branch: string; prompt?: string },
  timeoutMs: number,
): Promise<SessionContextAnswer | null> {
  const res = await fetch(cfg.ingestUrl.replace(/\/batches$/, "/session-context"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repo: query.repo, branch: query.branch, ...(query.prompt === undefined ? {} : { prompt: query.prompt }) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.candidates)) return null;
  return {
    route: typeof record.route === "string" ? record.route : "",
    ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}),
    candidates: record.candidates.filter(isCandidate),
  };
}
