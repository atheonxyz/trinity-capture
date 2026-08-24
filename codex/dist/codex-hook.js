// The single entry every Codex hook invokes, with the event name as argv[2]
// and the hook JSON on stdin. Must never throw to the IDE: the CLI bootstrap
// below always exits 0. Everything vendor-specific lives here as one Dialect
// table; runHook (hook-core.ts) owns the shared engine.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runHook } from "./hook-core.js";
import { codexHome, promotePendingConfig } from "./codex-connect.js";
function str(payload, key) {
    const value = payload[key];
    return typeof value === "string" && value !== "" ? value : null;
}
// What leaves the machine is an ALLOWLIST, never a strip list (see
// claude-hook.ts's own comment for the rationale). Every key below was
// observed on a real captured hook stream (codex-cli 0.149.0-alpha.4.3,
// test/testdata/codex_session.jsonl). Neither tool-body field the vendor
// carries (tool_input on PreToolUse/PostToolUse, tool_response on
// PostToolUse) is ever forwarded, under any event.
const ALLOW_EVERY_EVENT = ["hook_event_name", "session_id", "turn_id", "permission_mode"];
const ALLOW_PER_EVENT = {
    SessionStart: ["source", "model"],
    // The prompt text and the assistant reply are the capture contract (spec
    // §4.4): forwarded whole, exactly like claude_code's.
    UserPromptSubmit: ["prompt"],
    PreToolUse: ["tool_name", "tool_use_id"],
    PostToolUse: ["tool_name", "tool_use_id"],
    Stop: ["stop_hook_active", "last_assistant_message"],
    SessionEnd: ["reason"],
};
export const codexDialect = {
    tool: "codex",
    sessionId: (_event, payload) => str(payload, "session_id"),
    cwd: (_event, payload) => str(payload, "cwd"),
    // The observed correlation field (C2.0): a turn-scoped event's own
    // turn_id, never a turn IDENTITY — hook-core mints the actual turn key,
    // correlated by this vendor id.
    vendorTurnId: (_event, payload) => str(payload, "turn_id"),
    isPromptSubmit: (event) => event === "UserPromptSubmit",
    isSessionStart: (event) => event === "SessionStart",
    // Codex documents its hooks as async-capable (spec's global constraints).
    // Unlike Claude's captured hooks.json, nothing in the capture singles out
    // one Codex event as synchronous, so every event may attempt the open
    // multi-batch drain below.
    drainsOn: () => true,
    allow: (event) => [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[event] ?? [])],
    // Async-capable, like claude_code's: the open multi-batch drain in
    // hook-core is fine (contrast Cursor's drainInline: true).
    drainInline: false,
    // The proven official env var (C2.0) for hook COMMANDS. TRINITY_CAPTURE_DATA
    // overrides it for the documented fallback (an installer-managed
    // user-level hooks stanza outside the plugin layer, README's "Fallback"
    // section) where PLUGIN_DATA may not exist at all.
    dataDir: (env) => env.TRINITY_CAPTURE_DATA ?? env.PLUGIN_DATA ?? null,
};
async function cli() {
    const eventName = process.argv[2];
    if (!eventName)
        return;
    const stdin = readFileSync(0, "utf8");
    // The connect skill's shell command has no PLUGIN_DATA (C2.0); this hook
    // COMMAND does, so it's the one that promotes a pending pairing on its
    // way through — cheap when nothing is pending, and best-effort: a
    // promotion failure must never surface to the IDE.
    if (eventName === "PostToolUse") {
        try {
            const dataDir = codexDialect.dataDir(process.env);
            if (dataDir)
                promotePendingConfig(codexHome(process.env), dataDir);
        }
        catch {
            // malformed pending file, unwritable PLUGIN_DATA, etc. — leave the
            // pending record for the next PostToolUse to retry
        }
    }
    await runHook(codexDialect, eventName, stdin, process.env);
}
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    cli()
        .catch(() => { })
        .finally(() => process.exit(0));
}
