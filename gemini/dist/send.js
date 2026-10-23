import { hostname } from "node:os";
import { isCurrentConfig, loadPolicy, savePolicy } from "./config.js";
export const REQUEST_TIMEOUT_MS = 5_000;
export class BatchRequestError extends Error {
    status;
    constructor(status) {
        super(`ingest batch failed: ${status}`);
        this.status = status;
    }
}
export async function sendBatch(cfg, events, timeoutMs = REQUEST_TIMEOUT_MS) {
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
    if (!res.ok)
        throw new BatchRequestError(res.status);
    const body = (await res.json());
    return body.results;
}
export async function refreshPolicy(dataDir, cfg, timeoutMs = REQUEST_TIMEOUT_MS) {
    const current = loadPolicy(dataDir);
    const policyUrl = cfg.ingestUrl.replace(/\/batches$/, "/policy");
    const headers = { Authorization: `Bearer ${cfg.token}` };
    if (current)
        headers["If-None-Match"] = current.etag;
    const res = await fetch(policyUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!isCurrentConfig(dataDir, cfg))
        return null;
    if (res.status === 304 && current) {
        const refreshed = { ...current, fetchedAt: Date.now() };
        savePolicy(dataDir, refreshed);
        return refreshed;
    }
    if (!res.ok)
        return current;
    const doc = (await res.json());
    if (!isCurrentConfig(dataDir, cfg))
        return null;
    const policy = { ...doc, fetchedAt: Date.now() };
    savePolicy(dataDir, policy);
    return policy;
}
function isCandidate(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const record = value;
    return typeof record.taskId === "string" && typeof record.title === "string" && typeof record.status === "string";
}
function isHandoff(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const record = value;
    return typeof record.taskId === "string" && typeof record.code === "string" && typeof record.title === "string" && typeof record.status === "string";
}
function toHandoff(record) {
    const text = (value) => (typeof value === "string" ? value : "");
    return {
        taskId: record.taskId,
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        code: record.code,
        ...(typeof record.key === "string" ? { key: record.key } : {}),
        ...(typeof record.url === "string" ? { url: record.url } : {}),
        title: record.title,
        status: record.status,
        priority: text(record.priority),
        brief: text(record.brief),
        note: text(record.note),
        source: text(record.source),
    };
}
// The one read a device makes per session: which tasks this branch and person are likely on.
// It sends nothing the capture allowlist does not already forward (the canonical repository,
// the branch workspace.observed carries, the prompt UserPromptSubmit forwards whole), as a
// body rather than a query string. Any failure is null: the pull never blocks capture.
// `ackHandoffs` asks the server to keep answering a handed task until the ack below names it,
// so a pull that gives up before the answer lands cannot lose one.
export async function fetchSessionContext(cfg, query, timeoutMs) {
    const res = await fetch(cfg.ingestUrl.replace(/\/batches$/, "/session-context"), {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repo: query.repo, branch: query.branch, ackHandoffs: true, ...(query.prompt === undefined ? {} : { prompt: query.prompt }) }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
        return null;
    const body = await res.json();
    if (typeof body !== "object" || body === null)
        return null;
    const record = body;
    if (!Array.isArray(record.candidates))
        return null;
    return {
        route: typeof record.route === "string" ? record.route : "",
        ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}),
        candidates: record.candidates.filter(isCandidate),
        ...(Array.isArray(record.handoffs) ? { handoffs: record.handoffs.filter(isHandoff).map(toHandoff) } : {}),
    };
}
// Names the handed tasks the agent was shown, so the server stops answering them. A failed
// ack only means the next session shows them again.
export async function ackHandoffs(cfg, ids, timeoutMs) {
    await fetch(cfg.ingestUrl.replace(/\/batches$/, "/handoffs/ack"), {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(timeoutMs),
    });
}
