// GitHub Copilot CLI hook entry (argv[2] = camelCase event, stdin = JSON); fields follow the Copilot hooks reference and it always exits 0.
import { readFileSync, writeSync } from "node:fs";
import { perUserDataDir } from "./config.js";
import type { Dialect } from "./hook-core.js";
import { runHook } from "./hook-core.js";
import { isMainModule } from "./main-module.js";

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

// An allowlist, never a strip list: toolArgs, toolResult, transcriptPath and cwd never travel.
// agentStop carries no reply, and the transcript's format is undocumented, so no reply is read from it.
const ALLOW_EVERY_EVENT = ["sessionId"] as const;
const ALLOW_PER_EVENT: Record<string, readonly string[]> = {
  sessionStart: ["source"],
  userPromptSubmitted: ["prompt"],
  postToolUse: ["toolName"],
  agentStop: ["stopReason", "stop_hook_active"],
  sessionEnd: ["reason"],
};

export function copilotDataDir(env: NodeJS.ProcessEnv): string {
  return perUserDataDir(env, "copilot");
}

export const copilotDialect: Dialect = {
  tool: "copilot_cli",
  sessionId: (_event, payload) => stringField(payload, "sessionId"),
  cwd: (_event, payload) => stringField(payload, "cwd"),
  // No Copilot event names its turn, so hook-core mints the key at userPromptSubmitted.
  vendorTurnId: () => null,
  isPromptSubmit: (event) => event === "userPromptSubmitted",
  isSessionStart: (event) => event === "sessionStart",
  isFreshSessionStart: (event, payload) => {
    if (event !== "sessionStart") return false;
    const source = stringField(payload, "source");
    return source === "startup" || source === "new";
  },
  // sessionEnd may run detached while the CLI moves on, so it stays append-only.
  drainsOn: (event) => event === "userPromptSubmitted" || event === "agentStop",
  allow: (event) => [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[event] ?? [])],
  drainInline: true,
  dataDir: copilotDataDir,
  // Command hooks' userPromptSubmitted output is dropped, so sessionStart is the one context door.
  contextEvents: ["sessionStart"],
  contextOutput: (_event, context) => JSON.stringify({ additionalContext: context }),
};

async function cli(): Promise<void> {
  const eventName = process.argv[2];
  if (!eventName) return;
  const stdin = readFileSync(0, "utf8");
  const output = await runHook(copilotDialect, eventName, stdin, process.env);
  if (output !== undefined) writeSync(1, `${output}\n`);
}

if (isMainModule(import.meta.url)) {
  cli()
    .catch(() => {})
    .finally(() => process.exit(0));
}
