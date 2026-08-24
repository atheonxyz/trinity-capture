// The single entry every Claude Code hook invokes, with the event name as
// argv[2] and the hook JSON on stdin. Must never throw to the IDE: the CLI
// bootstrap below always exits 0. Everything vendor-specific lives here as
// one Dialect table; runHook (hook-core.ts) owns the shared engine.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Dialect } from "./hook-core.js";
import { runHook } from "./hook-core.js";

function str(payload: Record<string, unknown>, key: string): string | null {
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
const ALLOW_EVERY_EVENT = ["hook_event_name", "session_id", "prompt_id", "permission_mode"] as const;
const ALLOW_PER_EVENT: Record<string, readonly string[]> = {
  SessionStart: ["source"],
  // The prompt text and the assistant reply are the capture contract (spec
  // §4.4): forwarded whole.
  UserPromptSubmit: ["prompt"],
  PostToolUse: ["tool_name", "tool_use_id", "duration_ms"],
  Stop: ["stop_hook_active", "last_assistant_message"],
  SessionEnd: ["reason"],
};

export const claudeCodeDialect: Dialect = {
  tool: "claude_code",
  sessionId: (_event, payload) => str(payload, "session_id"),
  cwd: (_event, payload) => str(payload, "cwd"),
  vendorTurnId: (_event, payload) => str(payload, "prompt_id"),
  isPromptSubmit: (event) => event === "UserPromptSubmit",
  allow: (event) => [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[event] ?? [])],
  // Async-capable: four of Claude's five hooks run detached ("async": true
  // in hooks.json), so the open multi-batch drain in hook-core is fine.
  drainInline: false,
  dataDir: (env) => env.CLAUDE_PLUGIN_DATA ?? null,
};

async function cli(): Promise<void> {
  const eventName = process.argv[2];
  if (!eventName) return;
  const stdin = readFileSync(0, "utf8");
  await runHook(claudeCodeDialect, eventName, stdin, process.env);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  cli()
    .catch(() => {})
    .finally(() => process.exit(0));
}
