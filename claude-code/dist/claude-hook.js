import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, loadPolicy } from "./config.js";
import { isPolicyFresh, matchRoute, routeFor } from "./gate.js";
import { appendEvent, drain } from "./outbox.js";
import { gitRemoteOf, repoRelativeCwd, workspaceObserved } from "./observe.js";
import { refreshPolicy } from "./send.js";
const SHARED_PAYLOAD_KEYS = ["hook_event_name", "session_id", "prompt_id", "permission_mode"];
const CONNECT_COMMAND = /^\/trinity:connect(?:\s|$)/;
const EVENT_PAYLOAD_KEYS = {
    SessionStart: ["source"],
    UserPromptSubmit: ["prompt"],
    PostToolUse: ["tool_name", "tool_use_id", "duration_ms"],
    Stop: ["stop_hook_active", "last_assistant_message"],
    SessionEnd: ["reason"],
};
function filterPayload(eventName, raw) {
    const out = {};
    for (const key of [...SHARED_PAYLOAD_KEYS, ...(EVENT_PAYLOAD_KEYS[eventName] ?? [])]) {
        if (key in raw)
            out[key] = raw[key];
    }
    return out;
}
function turnKeyFile(dataDir, tool, externalSessionId) {
    return join(dataDir, "turnkeys", `${tool}-${encodeURIComponent(externalSessionId)}`);
}
function suppressedSessionFile(dataDir, externalSessionId) {
    return join(dataDir, "suppressed-sessions", `claude_code-${encodeURIComponent(externalSessionId)}`);
}
function shouldSuppressSession(dataDir, eventName, input) {
    const sessionId = input.session_id ?? "";
    if (eventName === "UserPromptSubmit" && typeof input.prompt === "string" && CONNECT_COMMAND.test(input.prompt.trimStart())) {
        if (sessionId !== "") {
            const file = suppressedSessionFile(dataDir, sessionId);
            try {
                mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
                writeFileSync(file, "", { mode: 0o600 });
            }
            catch {
                return true;
            }
        }
        return true;
    }
    if (sessionId === "")
        return false;
    try {
        readFileSync(suppressedSessionFile(dataDir, sessionId));
        return true;
    }
    catch {
        return false;
    }
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
            return minted;
        }
        return minted;
    }
    let key;
    try {
        key = readFileSync(file, "utf8").trim() || undefined;
    }
    catch {
        key = undefined;
    }
    if (eventName === "SessionEnd") {
        try {
            unlinkSync(file);
        }
        catch {
            return key;
        }
    }
    return key;
}
export async function runHook(eventName, input, dataDir) {
    if (shouldSuppressSession(dataDir, eventName, input))
        return;
    const cfg = loadConfig(dataDir);
    if (!cfg)
        return;
    const cwd = input.cwd ?? process.cwd();
    const gitRemote = gitRemoteOf(cwd);
    let policy = loadPolicy(dataDir);
    const cachedRoute = matchRoute(policy, gitRemote);
    if (!cachedRoute.send)
        return;
    if (!isPolicyFresh(policy, Date.now())) {
        try {
            policy = await refreshPolicy(dataDir, cfg);
        }
        catch {
            policy = null;
        }
    }
    const route = routeFor(policy, Date.now(), gitRemote);
    if (!route.send)
        return;
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
    try {
        await drain(dataDir, cfg);
    }
    catch {
        return;
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
        .catch(() => undefined)
        .finally(() => process.exit(0));
}
