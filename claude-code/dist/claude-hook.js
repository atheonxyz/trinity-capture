import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
// Claude's hosts hand this plugin different data directories for the same
// install (the CLI keys by marketplace, the desktop app by "inline"), so a
// device paired on one surface would be invisible to the other. A provided
// dir that holds config.json always wins; an unpaired one falls back to the
// lexically first paired trinity-* sibling.
function resolveDataDir(env) {
    const provided = env.CLAUDE_PLUGIN_DATA;
    if (!provided)
        return null;
    if (existsSync(join(provided, "config.json")))
        return provided;
    const parent = dirname(provided);
    let siblings;
    try {
        siblings = readdirSync(parent);
    }
    catch (error) {
        if (error instanceof Error)
            return provided;
        throw error;
    }
    const paired = siblings
        .filter((name) => name.startsWith("trinity-") && name !== basename(provided))
        .filter((name) => existsSync(join(parent, name, "config.json")))
        .sort();
    return paired.length > 0 ? join(parent, paired[0]) : provided;
}
export const claudeCodeDialect = {
    tool: "claude_code",
    sessionId: (_event, payload) => stringField(payload, "session_id"),
    cwd: (_event, payload) => stringField(payload, "cwd"),
    vendorTurnId: (_event, payload) => stringField(payload, "prompt_id"),
    isPromptSubmit: (event) => event === "UserPromptSubmit",
    isSessionStart: (event) => event === "SessionStart",
    // SessionEnd fires while the host tears the session down, so it stays
    // append-only; every other event drains within the inline budget.
    drainsOn: (event) => event !== "SessionEnd",
    suppress: suppressConnectSession,
    allow: (event) => [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[event] ?? [])],
    // Every hook runs synchronously — the desktop app silently skips entries
    // declared "async": true — so drains are budgeted inline, like codex's.
    drainInline: true,
    dataDir: resolveDataDir,
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
