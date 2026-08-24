// The single entry every Claude Code hook invokes, with the event name as
// argv[2] and the hook JSON on stdin. Must never throw to the IDE: the CLI
// bootstrap below always exits 0.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, loadPolicy } from "./config.js";
import { routeFor } from "./gate.js";
import { appendEvent, drain } from "./outbox.js";
import { gitRemoteOf, repoRelativeCwd, workspaceObserved } from "./observe.js";
import { refreshPolicy } from "./send.js";
// What leaves the machine is an ALLOWLIST, never a strip list: the vendor
// grows and renames payload fields without notice (tool_output became
// tool_response), and a strip list forwards whatever it has not heard of.
// Every key below was observed on a real captured hook stream (claude
// 2.1.241). Beyond them nothing is forwarded — not tool bodies under any
// name, not absolute local paths (cwd, transcript_path), not anything
// reasoning/thinking-named.
const ALLOW_EVERY_EVENT = ["hook_event_name", "session_id", "prompt_id", "permission_mode"];
const ALLOW_PER_EVENT = {
    SessionStart: ["source"],
    // The prompt text and the assistant reply are the capture contract (spec
    // §4.4): forwarded whole.
    UserPromptSubmit: ["prompt"],
    PostToolUse: ["tool_name", "tool_use_id", "duration_ms"],
    Stop: ["stop_hook_active", "last_assistant_message"],
    SessionEnd: ["reason"],
};
function filterPayload(eventName, raw) {
    const out = {};
    for (const key of [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[eventName] ?? [])]) {
        if (key in raw)
            out[key] = raw[key];
    }
    return out;
}
// The turn key is plugin-minted, never the vendor's: a fresh uuid at every
// UserPromptSubmit, persisted per (tool, external session) so each later
// event of the session carries the same key until the next prompt replaces
// it. The server treats it as an untrusted hint and falls back to
// open-turn-by-ordinal when it is absent.
function turnKeyFile(dataDir, tool, externalSessionId) {
    return join(dataDir, "turnkeys", `${tool}-${encodeURIComponent(externalSessionId)}`);
}
function resolveTurnKey(dataDir, eventName, externalSessionId) {
    if (externalSessionId === "" || eventName === "SessionStart")
        return undefined;
    const file = turnKeyFile(dataDir, "claude_code", externalSessionId);
    if (eventName === "UserPromptSubmit") {
        const minted = randomUUID();
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, minted);
        }
        catch {
            // this event still carries the key; later ones fall back server-side
        }
        return minted;
    }
    let key;
    try {
        key = readFileSync(file, "utf8").trim() || undefined;
    }
    catch {
        key = undefined; // no prompt observed yet (or state lost) — omit the hint
    }
    if (eventName === "SessionEnd") {
        try {
            unlinkSync(file);
        }
        catch {
            // best-effort cleanup; a leftover file is one stale key per session
        }
    }
    return key;
}
export async function runHook(eventName, input, dataDir) {
    const cfg = loadConfig(dataDir);
    if (!cfg)
        return; // never authorized — fail closed, zero network requests
    // Self-healing happens before the gate, not after: routeFor already fails
    // closed on a stale policy, so a refresh attempted only once send:false
    // has been decided can never run — the device would stay stuck past its
    // last-synced TTL until someone re-ran /trinity-connect. Scoped to
    // SessionStart (new-session cadence is enough to self-heal, and it keeps
    // SessionEnd's no-network, append-only, timeout-bounded contract intact).
    let policy = loadPolicy(dataDir);
    if (eventName === "SessionStart") {
        const stale = !policy || Date.now() > policy.fetchedAt + policy.ttlSeconds * 1000;
        if (stale) {
            try {
                policy = await refreshPolicy(dataDir, cfg);
            }
            catch {
                // best-effort: routeFor below still fails closed on whatever policy we have
            }
        }
    }
    const cwd = input.cwd ?? process.cwd();
    const route = routeFor(policy, Date.now(), gitRemoteOf(cwd));
    if (!route.send)
        return; // not allowlisted, or policy missing/still stale — no event, no drain
    const sessionId = input.session_id ?? "";
    const repoCwd = repoRelativeCwd(cwd);
    const turnKey = resolveTurnKey(dataDir, eventName, sessionId);
    appendEvent(dataDir, {
        captureEventId: randomUUID(),
        tool: "claude_code",
        kind: eventName,
        externalSessionId: sessionId,
        repo: route.canonicalRepo,
        repoCwd,
        occurredAt: new Date().toISOString(),
        ...(turnKey === undefined ? {} : { turnKey }),
        payload: filterPayload(eventName, input),
    });
    if (eventName === "SessionStart") {
        const observed = workspaceObserved(cwd);
        if (observed) {
            appendEvent(dataDir, { ...observed, externalSessionId: sessionId, repo: route.canonicalRepo, repoCwd });
        }
    }
    // SessionEnd is synchronous and timeout-bounded — it only appends to the
    // outbox, never drains.
    if (eventName !== "SessionEnd") {
        try {
            await drain(dataDir, cfg);
        }
        catch {
            // never let a drain failure reach the IDE
        }
    }
}
async function cli() {
    const eventName = process.argv[2];
    if (!eventName)
        return;
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (!dataDir)
        return;
    const input = JSON.parse(readFileSync(0, "utf8"));
    await runHook(eventName, input, dataDir);
}
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    cli()
        .catch(() => { })
        .finally(() => process.exit(0));
}
