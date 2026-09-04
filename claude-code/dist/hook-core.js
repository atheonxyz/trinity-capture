// Shared hook engine every dialect's thin entrypoint calls (see
// claude-hook.ts for the first one). Owns config/policy gating, race-safe
// turn-key correlation, the outbox append, and bounded-network draining. A
// dialect supplies only vendor-specific field extraction and event naming.
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadPolicy } from "./config.js";
import { allowSessionCapture } from "./activation.js";
import { isPolicyFresh, resolveRoute } from "./gate.js";
import { resolveGitHubRepository } from "./github-repo.js";
import { appendEvent, drain, INLINE_DRAIN_BUDGET_MS } from "./outbox.js";
import { gitRemoteOf, repoRelativeCwd, workspaceObserved } from "./observe.js";
import { refreshPolicy } from "./send.js";
const SETUP_PROMPT_PREFIX = "[Trinity setup]\n";
function isENOENT(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function suppressSetupSession(dataDir, dialect, event, payload) {
    const sessionId = dialect.sessionId(event, payload);
    if (dialect.isPromptSubmit(event)) {
        const prompt = payload.prompt;
        if (typeof prompt === "string" && prompt.startsWith(SETUP_PROMPT_PREFIX)) {
            if (sessionId === null || sessionId === "")
                return true;
            const marker = join(dataDir, "suppressed-sessions", `${dialect.tool}-${encodeURIComponent(sessionId)}`);
            mkdirSync(join(dataDir, "suppressed-sessions"), { recursive: true, mode: 0o700 });
            writeFileSync(marker, "", { flag: "a", mode: 0o600 });
            return true;
        }
    }
    if (sessionId === null || sessionId === "")
        return false;
    const marker = join(dataDir, "suppressed-sessions", `${dialect.tool}-${encodeURIComponent(sessionId)}`);
    try {
        readFileSync(marker);
        return true;
    }
    catch (error) {
        if (isENOENT(error))
            return false;
        return true;
    }
}
function filterPayload(payload, allowed) {
    const out = {};
    for (const key of allowed) {
        if (key in payload)
            out[key] = payload[key];
    }
    return out;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
// One write-once file per vendor turn id, never a shared map: two hook
// processes racing to mint the same vendor id can only ever collide on the
// SAME file's exclusive-create, and the loser reads the winner back rather
// than overwriting it. A shared JSON map under temp+rename would still lose
// updates when two processes each read-modify-write a distinct key at once.
// Hex encoding is injective and keeps hostile ids from becoming path segments.
function sanitizeTurnId(id) {
    return `id-${Buffer.from(id, "utf8").toString("hex") || "empty"}`;
}
export function turnKeyDir(dataDir, tool, sessionId) {
    // sessionId comes straight from untrusted hook stdin — join() does not
    // neutralize a "/" or ".." embedded inside one path segment, so it goes
    // through the same sanitizer as a vendor turn id before touching disk.
    return join(dataDir, "turnkeys", `${tool}-${sanitizeTurnId(sessionId)}`);
}
export function claimTurnKey(sessionDir, vendorTurnId) {
    const file = join(sessionDir, sanitizeTurnId(vendorTurnId));
    mkdirSync(sessionDir, { recursive: true });
    const minted = randomUUID();
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, minted, { flag: "wx", mode: 0o600 });
    try {
        linkSync(temporary, file);
        return minted;
    }
    catch (err) {
        if (err instanceof Error && "code" in err && err.code === "EEXIST") {
            return readFileSync(file, "utf8");
        }
        throw err;
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
// latest is a separate one-line temp+rename file, consulted only by events
// whose dialect returns no vendor turn id — those are inherently
// order-ambiguous (no vendor identity to correlate on), so its benign race
// between two id-less events is documented, not hidden behind a lock.
function mintLatest(sessionDir) {
    mkdirSync(sessionDir, { recursive: true });
    const minted = randomUUID();
    const tmp = join(sessionDir, `.latest.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, minted);
    renameSync(tmp, join(sessionDir, "latest"));
    return minted;
}
function readLatest(sessionDir) {
    try {
        return readFileSync(join(sessionDir, "latest"), "utf8").trim() || undefined;
    }
    catch {
        return undefined; // no prompt observed yet (or state lost) — omit the hint
    }
}
function resolveTurnKey(dataDir, dialect, event, sessionId, payload) {
    const sessionDir = turnKeyDir(dataDir, dialect.tool, sessionId);
    try {
        const vendorTurnId = dialect.vendorTurnId(event, payload);
        if (vendorTurnId !== null && vendorTurnId !== "")
            return claimTurnKey(sessionDir, vendorTurnId);
        if (dialect.isPromptSubmit(event))
            return mintLatest(sessionDir);
        return readLatest(sessionDir);
    }
    catch {
        return undefined; // best-effort; the server falls back to open-turn-by-ordinal
    }
}
export async function runHook(dialect, event, stdin, env) {
    // Taken at hook entry, before any I/O: an inline drain's budget covers
    // this whole invocation, not just the time spent inside drain() itself.
    const hookEntryDeadline = Date.now() + INLINE_DRAIN_BUDGET_MS;
    const dataDir = dialect.dataDir(env);
    if (!dataDir)
        return; // dialect found no durable writable dir — never paired, or the host gave none
    const parsed = JSON.parse(stdin);
    if (!isRecord(parsed))
        return;
    const payload = parsed;
    const suppressionDirs = dialect.suppressionDirs?.(env, dataDir, payload) ?? [dataDir];
    if (suppressionDirs.some((dir) => suppressSetupSession(dir, dialect, event, payload)))
        return;
    const suppress = dialect.suppress;
    if (suppress && suppressionDirs.some((dir) => suppress(dir, event, payload)))
        return;
    const cfg = loadConfig(dataDir);
    if (!cfg)
        return; // never authorized — fail closed, zero network requests
    const sessionId = dialect.sessionId(event, payload) ?? "";
    if (!allowSessionCapture({
        dataDir,
        tool: dialect.tool,
        sessionId,
        deviceId: cfg.deviceId,
        isSessionStart: dialect.isSessionStart(event),
        isFreshSessionStart: dialect.isFreshSessionStart?.(event, payload) ?? dialect.isSessionStart(event),
    }))
        return;
    const cwd = dialect.cwd(event, payload) ?? process.cwd();
    const gitRemote = gitRemoteOf(cwd);
    let policy = loadPolicy(dataDir);
    const remaining = dialect.drainInline ? hookEntryDeadline - Date.now() : undefined;
    if (dialect.isSessionStart(event) && !isPolicyFresh(policy, Date.now())) {
        if (remaining === undefined || remaining > 0) {
            try {
                policy = await refreshPolicy(dataDir, cfg, remaining);
            }
            catch {
                policy = null;
            }
        }
    }
    const route = await resolveRoute(policy, gitRemote, (fullName) => {
        const lookupBudget = dialect.drainInline ? hookEntryDeadline - Date.now() : 1_500;
        return lookupBudget > 0 ? resolveGitHubRepository(dataDir, fullName, lookupBudget) : Promise.resolve(null);
    });
    if (!route.send)
        return; // not allowlisted, or policy missing/still stale — no event, no drain
    if (loadConfig(dataDir)?.deviceId !== cfg.deviceId)
        return;
    const repoCwd = repoRelativeCwd(cwd);
    const turnKey = sessionId === "" || dialect.isSessionStart(event)
        ? undefined
        : resolveTurnKey(dataDir, dialect, event, sessionId, payload);
    const captureEvent = {
        captureEventId: randomUUID(),
        tool: dialect.tool,
        kind: event,
        externalSessionId: sessionId,
        repo: route.canonicalRepo,
        repoCwd,
        occurredAt: new Date().toISOString(),
        ...(turnKey === undefined ? {} : { turnKey }),
        payload: filterPayload(payload, dialect.allow(event)),
    };
    appendEvent(dataDir, captureEvent, cfg.deviceId);
    if (dialect.isSessionStart(event)) {
        const observed = workspaceObserved(cwd);
        if (observed) {
            appendEvent(dataDir, { ...observed, tool: dialect.tool, externalSessionId: sessionId, repo: route.canonicalRepo, repoCwd }, cfg.deviceId);
        }
    }
    // Whether THIS event drains at all is the dialect's call (a synchronous
    // dialect may only want its own lifecycle boundaries to drain); drainInline
    // above governs how a drain that does happen behaves.
    if (dialect.drainsOn(event)) {
        await drain(dataDir, cfg, { inline: dialect.drainInline, deadline: hookEntryDeadline }).catch(() => undefined);
    }
}
