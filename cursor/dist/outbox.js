// JSONL outbox: one file per pending event under <dataDir>/outbox/, written
// before any network I/O; deleted only once its outcome is terminal
// (stored/duplicate/rejected_permanent) or the event is unsendable — over
// the per-event size cap at append, poisoning a batch with 413, or older
// than the retry window. Every such drop is recorded in <dataDir>/status.json
// rather than vanishing. drain() groups files into size-aware batches at
// send time (spec §4.5/§5).
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BatchRequestError, NETWORK_TIMEOUT_MS, refreshPolicy, sendBatch } from "./send.js";
const MAX_BATCHES = 5;
// An inline drain sends at most one batch, bounded by a wall-clock budget
// taken at hook entry rather than at drain's own call time — the budget
// covers everything the hook did before reaching drain(), too.
export const INLINE_DRAIN_BUDGET_MS = 2000;
const MAX_EVENTS_PER_BATCH = 100;
// One event over 256 KiB serialized can never be accepted (the server's
// per-item cap), so it is dropped at append rather than wedging the outbox.
const MAX_EVENT_BYTES = 256 * 1024;
// Keeps every assembled batch body comfortably under the server's 4 MiB
// request cap, so a 413 means a genuinely poisoned batch, not routine load.
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
// An event retry_later has kept alive this long is never going to land.
const MAX_RETRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DROP_RECORDS = 100;
function outboxDir(dataDir) {
    const dir = join(dataDir, "outbox");
    mkdirSync(dir, { recursive: true });
    return dir;
}
function fileFor(dir, ev) {
    const stamp = ev.occurredAt.replace(/[^0-9]/g, "");
    return join(dir, `${stamp}-${ev.captureEventId}.jsonl`);
}
// recordDrop appends one entry to status.json, capped to the most recent
// MAX_DROP_RECORDS. Best-effort: recording a drop must never fail the hook.
// Exported so a dialect that must drop an event before it ever reaches the
// outbox (Cursor's multi-root fail-closed rule) can still surface it in the
// same plugin status a normal outbox drop would.
export function recordDrop(dataDir, drop) {
    try {
        const path = join(dataDir, "status.json");
        let drops = [];
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            if (Array.isArray(parsed.drops))
                drops = parsed.drops;
        }
        catch {
            // missing or corrupt status file — start fresh
        }
        drops.push({ at: new Date().toISOString(), ...drop });
        writeFileSync(path, JSON.stringify({ drops: drops.slice(-MAX_DROP_RECORDS) }, null, 2));
    }
    catch {
        // status is best-effort; the drop already is the failure path
    }
}
export function appendEvent(dataDir, ev) {
    const line = JSON.stringify(ev) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
        recordDrop(dataDir, { reason: "oversized", captureEventId: ev.captureEventId, kind: ev.kind });
        return;
    }
    const dir = outboxDir(dataDir);
    writeFileSync(fileFor(dir, ev), line, { flag: "wx" });
}
export async function drain(dataDir, cfg, opts) {
    if (opts.inline && Date.now() >= opts.deadline)
        return; // budget already spent — skip the send entirely
    const dir = outboxDir(dataDir);
    const files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    const entries = [];
    for (const file of files) {
        const path = join(dir, file);
        let raw;
        let mtimeMs;
        try {
            mtimeMs = statSync(path).mtimeMs;
            raw = readFileSync(path, "utf8").trim();
        }
        catch {
            continue; // a sibling drain already consumed it
        }
        let event;
        try {
            event = JSON.parse(raw);
        }
        catch {
            unlinkSync(path); // corrupt entry — cannot be retried meaningfully
            continue;
        }
        if (Date.now() - mtimeMs > MAX_RETRY_AGE_MS) {
            unlinkSync(path);
            recordDrop(dataDir, { reason: "expired", captureEventId: event.captureEventId, kind: event.kind });
            continue;
        }
        entries.push({ file, bytes: Buffer.byteLength(raw, "utf8"), event });
    }
    const maxBatches = opts.inline ? 1 : MAX_BATCHES;
    let offset = 0;
    let policyStale = false;
    for (let batch = 0; batch < maxBatches && offset < entries.length; batch++) {
        const slice = [];
        let sliceBytes = 0;
        while (offset < entries.length && slice.length < MAX_EVENTS_PER_BATCH) {
            const next = entries[offset];
            if (slice.length > 0 && sliceBytes + next.bytes > MAX_BATCH_BYTES)
                break;
            slice.push(next);
            sliceBytes += next.bytes;
            offset++;
        }
        const outcome = await deliverBatch(dir, dataDir, cfg, slice, opts);
        if (outcome === "abort")
            break; // request-level failure — retain the rest
        if (outcome.policyStale)
            policyStale = true;
    }
    // A policy_stale outcome means the server knows a repo this device's
    // cached policy does not: refresh once now so the next drain retries the
    // kept events against a current document instead of looping stale. Not
    // attempted inline — a bounded drain's whole point is returning within
    // its budget, and the next hook invocation's own staleness check will
    // pick this up.
    if (policyStale && !opts.inline) {
        try {
            await refreshPolicy(dataDir, cfg);
        }
        catch {
            // best-effort; the kept events simply wait for the next refresh
        }
    }
}
// deliverBatch sends one batch and settles its files. A 413 means the batch
// as a whole is unacceptable even though every event passed the append-time
// cap: bisect it until the poisoned event stands alone, drop that one as
// recorded, and let everything else land. Any other request-level failure
// (network/timeout/401/403/429/5xx) aborts the drain and retains the
// outbox. Each attempt's timeout is recomputed from the shrinking inline
// budget, or the flat network bound outside inline mode.
async function deliverBatch(dir, dataDir, cfg, entries, opts) {
    const timeoutMs = opts.inline ? Math.min(NETWORK_TIMEOUT_MS, opts.deadline - Date.now()) : NETWORK_TIMEOUT_MS;
    if (timeoutMs <= 0)
        return "abort"; // budget ran out mid-drain — leave this batch queued
    let results;
    try {
        results = await sendBatch(cfg, entries.map((e) => e.event), timeoutMs);
    }
    catch (err) {
        if (err instanceof BatchRequestError && err.status === 413) {
            if (entries.length === 1) {
                unlinkSync(join(dir, entries[0].file));
                recordDrop(dataDir, { reason: "poison", captureEventId: entries[0].event.captureEventId, kind: entries[0].event.kind });
                return { policyStale: false };
            }
            const mid = Math.ceil(entries.length / 2);
            const left = await deliverBatch(dir, dataDir, cfg, entries.slice(0, mid), opts);
            if (left === "abort")
                return "abort";
            const right = await deliverBatch(dir, dataDir, cfg, entries.slice(mid), opts);
            if (right === "abort")
                return "abort";
            return { policyStale: left.policyStale || right.policyStale };
        }
        return "abort";
    }
    const resultById = new Map(results.map((r) => [r.captureEventId, r]));
    let policyStale = false;
    for (const { file, event } of entries) {
        const result = resultById.get(event.captureEventId);
        if (result === undefined)
            continue; // missing from the response: kept for the next drain
        if (result.outcome === "stored" || result.outcome === "duplicate" || result.outcome === "rejected_permanent") {
            unlinkSync(join(dir, file));
        }
        else if (result.outcome === "retry_later" && result.code === "policy_stale") {
            policyStale = true;
        }
    }
    return { policyStale };
}
