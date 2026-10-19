// Gemini CLI hook entry (argv[2] = event, stdin = JSON); fields follow the Gemini hooks reference and it always exits 0.
import { readFileSync, writeSync } from "node:fs";
import { perUserDataDir } from "./config.js";
import type { Dialect } from "./hook-core.js";
import { runHook } from "./hook-core.js";
import { isMainModule } from "./main-module.js";

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

// An allowlist, never a strip list: tool bodies, transcript_path and cwd never travel.
const ALLOW_EVERY_EVENT = ["hook_event_name", "session_id"] as const;
const ALLOW_PER_EVENT: Record<string, readonly string[]> = {
  SessionStart: ["source"],
  BeforeAgent: ["prompt"],
  AfterTool: ["tool_name"],
  AfterAgent: ["stop_hook_active", "prompt_response"],
  SessionEnd: ["reason"],
};

export function geminiDataDir(env: NodeJS.ProcessEnv): string {
  return perUserDataDir(env, "gemini");
}

export const geminiDialect: Dialect = {
  tool: "gemini_cli",
  sessionId: (_event, payload) => stringField(payload, "session_id"),
  cwd: (_event, payload) => stringField(payload, "cwd"),
  // No Gemini event names its turn, so hook-core mints the key at BeforeAgent.
  vendorTurnId: () => null,
  isPromptSubmit: (event) => event === "BeforeAgent",
  isSessionStart: (event) => event === "SessionStart",
  isFreshSessionStart: (event, payload) => {
    if (event !== "SessionStart") return false;
    const source = stringField(payload, "source");
    return source === "startup" || source === "clear";
  },
  // The CLI does not await SessionEnd, so it stays append-only.
  drainsOn: (event) => event === "BeforeAgent" || event === "AfterAgent",
  allow: (event) => [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[event] ?? [])],
  drainInline: true,
  dataDir: geminiDataDir,
  contextEvents: ["SessionStart", "BeforeAgent"],
  contextOutput: (event, context) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }),
};

async function cli(): Promise<void> {
  const eventName = process.argv[2];
  if (!eventName) return;
  const stdin = readFileSync(0, "utf8");
  const output = await runHook(geminiDialect, eventName, stdin, process.env);
  if (output !== undefined) writeSync(1, `${output}\n`);
}

if (isMainModule(import.meta.url)) {
  cli()
    .catch(() => {})
    .finally(() => process.exit(0));
}
