import { loadPolicy, savePolicy } from "./config.js";
// Every network call carries this bound via AbortSignal.timeout, so a
// hanging server can never stall a hook indefinitely. An inline drain
// tightens it further to whatever remains of its own wall-clock budget.
export const NETWORK_TIMEOUT_MS = 5000;
// BatchRequestError carries the HTTP status so the outbox can tell a
// poisoned batch (413, worth bisecting) from a failure that retains the
// whole outbox.
export class BatchRequestError extends Error {
    status;
    constructor(status) {
        super(`ingest batch failed: ${status}`);
        this.status = status;
    }
}
// Throws on request-level failure (network error, timeout, or non-2xx) so
// the caller can retain the whole outbox rather than mis-acking individual
// items. timeoutMs defaults to the flat network bound; an inline drain
// passes whatever remains of its own budget instead.
export async function sendBatch(cfg, events, timeoutMs = NETWORK_TIMEOUT_MS) {
    const res = await fetch(cfg.ingestUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${cfg.token}`,
            "Content-Type": "application/json",
            "X-Trinity-Wire-Version": "1",
        },
        body: JSON.stringify({ items: events }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
        throw new BatchRequestError(res.status);
    const body = (await res.json());
    return body.results;
}
// Best-effort ETag sync; returns the caller's existing policy (possibly
// null) on any non-2xx/304 response rather than throwing.
export async function refreshPolicy(dataDir, cfg) {
    const current = loadPolicy(dataDir);
    const policyUrl = cfg.ingestUrl.replace(/\/batches$/, "/policy");
    const headers = { Authorization: `Bearer ${cfg.token}` };
    if (current)
        headers["If-None-Match"] = current.etag;
    const res = await fetch(policyUrl, { headers, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    if (res.status === 304 && current) {
        const refreshed = { ...current, fetchedAt: Date.now() };
        savePolicy(dataDir, refreshed);
        return refreshed;
    }
    if (!res.ok)
        return current;
    const doc = (await res.json());
    const policy = { ...doc, fetchedAt: Date.now() };
    savePolicy(dataDir, policy);
    return policy;
}
