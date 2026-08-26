import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runHook } from "./hook-core.js";
function stringField(payload, key) {
    const value = payload[key];
    return typeof value === "string" && value !== "" ? value : null;
}
// What leaves the machine is an ALLOWLIST, never a strip list: the vendor
// grows and renames payload fields without notice (tool_output became
// tool_response), and a strip list forwards whatever it has not heard of.
// Every key below was observed on a real captured hook stream (claude
// 2.1.241). Beyond them nothing is forwarded — not tool bodies under any
// name, not absolute local paths (cwd, transcript_path), not anything
// reasoning/thinking-named.
const ALLOW_EVERY_EVENT = ["hook_event_name", "session_id", "prompt_id", "permission_mode"];
const CONNECT_COMMAND = /^\/trinity:connect(?:\s|$)/;
const ALLOW_PER_EVENT = {
    SessionStart: ["source"],
    // The prompt text and the assistant reply are the capture contract (spec
    // §4.4): forwarded whole.
    UserPromptSubmit: ["prompt"],
    PostToolUse: ["tool_name", "tool_use_id", "duration_ms"],
    Stop: ["stop_hook_active", "last_assistant_message"],
    SessionEnd: ["reason"],
};
function suppressedSessionFile(dataDir, sessionId) {
    return join(dataDir, "suppressed-sessions", `claude_code-${encodeURIComponent(sessionId)}`);
}
function suppressConnectSession(dataDir, event, payload) {
    const sessionId = stringField(payload, "session_id");
    const prompt = stringField(payload, "prompt");
    if (event === "UserPromptSubmit" && prompt !== null && CONNECT_COMMAND.test(prompt.trimStart())) {
        if (sessionId !== null) {
            const file = suppressedSessionFile(dataDir, sessionId);
            try {
                mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
                writeFileSync(file, "", { mode: 0o600 });
            }
            catch (error) {
                if (!(error instanceof Error))
                    throw error;
            }
        }
        return true;
    }
    if (sessionId === null)
        return false;
    try {
        readFileSync(suppressedSessionFile(dataDir, sessionId));
        return true;
    }
    catch (error) {
        if (error instanceof Error)
            return false;
        throw error;
    }
}
export const claudeCodeDialect = {
    tool: "claude_code",
    sessionId: (_event, payload) => stringField(payload, "session_id"),
    cwd: (_event, payload) => stringField(payload, "cwd"),
    vendorTurnId: (_event, payload) => stringField(payload, "prompt_id"),
    isPromptSubmit: (event) => event === "UserPromptSubmit",
    isSessionStart: (event) => event === "SessionStart",
    // SessionEnd is the one hook hooks.json runs synchronously (no "async":
    // true, unlike its four siblings) — it must stay append-only and
    // timeout-bounded, so it's the one event that never drains.
    drainsOn: (event) => event !== "SessionEnd",
    suppress: suppressConnectSession,
    allow: (event) => [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[event] ?? [])],
    // Async-capable: four of Claude's five hooks run detached ("async": true
    // in hooks.json), so the open multi-batch drain in hook-core is fine.
    drainInline: false,
    dataDir: (env) => env.CLAUDE_PLUGIN_DATA ?? null,
};
async function cli() {
    const eventName = process.argv[2];
    if (!eventName)
        return;
    const stdin = readFileSync(0, "utf8");
    await runHook(claudeCodeDialect, eventName, stdin, process.env);
}
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    cli()
        .catch(() => { })
        .finally(() => process.exit(0));
}
