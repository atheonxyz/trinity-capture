// The single entry every Claude Code hook invokes, with the event name as
// argv[2] and the hook JSON on stdin. Must never throw to the IDE: the CLI
// bootstrap below always exits 0. Everything vendor-specific lives here as
// one Dialect table; runHook (hook-core.ts) owns the shared engine.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const CONNECT_COMMAND = /^\/trinity:connect(?:\s|$)/;
const ALLOW_PER_EVENT: Record<string, readonly string[]> = {
  SessionStart: ["source"],
  // The prompt text and the assistant reply are the capture contract (spec
  // §4.4): forwarded whole.
  UserPromptSubmit: ["prompt"],
  PostToolUse: ["tool_name", "tool_use_id", "duration_ms"],
  Stop: ["stop_hook_active", "last_assistant_message"],
  SessionEnd: ["reason"],
};

function suppressedSessionFile(dataDir: string, sessionId: string): string {
  return join(dataDir, "suppressed-sessions", `claude_code-${encodeURIComponent(sessionId)}`);
}

function suppressConnectSession(dataDir: string, event: string, payload: Record<string, unknown>): boolean {
  const sessionId = str(payload, "session_id") ?? "";
  if (event === "UserPromptSubmit" && typeof payload.prompt === "string" && CONNECT_COMMAND.test(payload.prompt.trimStart())) {
    if (sessionId !== "") {
      const file = suppressedSessionFile(dataDir, sessionId);
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, "", { mode: 0o600 });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    return true;
  }
  if (sessionId === "") return false;
  try {
    readFileSync(suppressedSessionFile(dataDir, sessionId));
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export const claudeCodeDialect: Dialect = {
  tool: "claude_code",
  sessionId: (_event, payload) => str(payload, "session_id"),
  cwd: (_event, payload) => str(payload, "cwd"),
  vendorTurnId: (_event, payload) => str(payload, "prompt_id"),
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
