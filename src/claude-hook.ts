import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Dialect } from "./hook-core.js";
import { runHook } from "./hook-core.js";

function stringField(payload: Record<string, unknown>, key: string): string | null {
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
  const sessionId = stringField(payload, "session_id");
  const prompt = stringField(payload, "prompt");

  if (event === "UserPromptSubmit" && prompt !== null && CONNECT_COMMAND.test(prompt.trimStart())) {
    if (sessionId !== null) {
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
  if (sessionId === null) return false;
  try {
    readFileSync(suppressedSessionFile(dataDir, sessionId));
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

// Claude's hosts key one install's data directory per surface as
// "<plugin-name>-<source>" (marketplace name for the CLI, "inline" for the
// desktop app), so a device paired on one surface would be invisible to the
// other. A provided dir that holds a pairing always wins; an unpaired one
// falls back to the lexically first paired sibling of the same plugin. The
// name comes from this build's own manifest, never a spelled-out product
// name, and a sibling qualifies only when its config carries the pairing
// shape, so another plugin sharing a name prefix is never adopted.
function hasPairing(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const cfg = parsed as Record<string, unknown>;
    return typeof cfg.token === "string" && typeof cfg.ingestUrl === "string" && typeof cfg.deviceId === "string";
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function pluginNamePrefix(): string | null {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const parsed: unknown = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const name = (parsed as Record<string, unknown>).name;
    return typeof name === "string" && name !== "" ? `${name}-` : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function resolveDataDir(env: NodeJS.ProcessEnv): string | null {
  const provided = env.CLAUDE_PLUGIN_DATA;
  if (!provided) return null;
  if (hasPairing(provided)) return provided;
  const prefix = pluginNamePrefix();
  if (prefix === null) return provided;
  const parent = dirname(provided);
  let siblings: string[];
  try {
    siblings = readdirSync(parent);
  } catch (error) {
    if (error instanceof Error) return provided;
    throw error;
  }
  const paired = siblings
    .filter((name) => name.startsWith(prefix) && name !== basename(provided))
    .filter((name) => hasPairing(join(parent, name)))
    .sort();
  return paired.length > 0 ? join(parent, paired[0]) : provided;
}

export const claudeCodeDialect: Dialect = {
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
