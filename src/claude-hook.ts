import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dialect } from "./hook-core.js";
import { runHook } from "./hook-core.js";
import { isMainModule } from "./main-module.js";

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
const SETUP_MARKER_TRANSFER_WINDOW_MS = 30 * 60_000;
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
// falls back to a paired sibling of the same plugin, whose name prefix comes
// from this build's own manifest rather than a spelled-out product name.
// Selection is by IDENTITY, never by sort order: the chosen directory
// supplies the token and the allowlist policy, so picking between siblings
// that disagree would file one account's prompts under another's device.
// Siblings holding the same pairing are one device reached by two names and
// stay usable; anything else is ambiguous and captures nowhere.
function pairingIdentity(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { deviceId, ingestUrl, token } = parsed as Record<string, unknown>;
    if (typeof deviceId !== "string" || typeof ingestUrl !== "string" || typeof token !== "string") return null;
    return JSON.stringify([deviceId, ingestUrl, token]);
  } catch (error) {
    if (error instanceof Error) return null;
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
  if (pairingIdentity(provided) !== null) return provided;
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
  const candidates = siblings
    .filter((name) => name.startsWith(prefix) && name !== basename(provided))
    .sort()
    .map((name) => ({ dir: join(parent, name), identity: pairingIdentity(join(parent, name)) }))
    .filter((candidate) => candidate.identity !== null);
  if (candidates.length === 0) return provided;
  if (candidates.some((candidate) => candidate.identity !== candidates[0].identity)) return null;
  return candidates[0].dir;
}

function suppressionDirs(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  payload: Record<string, unknown>,
): readonly string[] {
  const provided = env.CLAUDE_PLUGIN_DATA;
  if (!provided) return [dataDir];
  const prefix = pluginNamePrefix();
  if (prefix === null) return provided === dataDir ? [dataDir] : [provided, dataDir];
  try {
    const parent = dirname(provided);
    const identity = pairingIdentity(dataDir);
    const sessionId = stringField(payload, "session_id");
    const entries = readdirSync(parent, { withFileTypes: true });
    return [...new Set([
      dataDir,
      ...entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => join(parent, entry.name))
    ])].filter((dir) => {
      if (dir === dataDir) return true;
      const candidate = pairingIdentity(dir);
      if (identity !== null && candidate === identity) return true;
      if (candidate !== null || sessionId === null) return false;
      try {
        const age = Date.now() - statSync(suppressedSessionFile(dir, sessionId)).mtimeMs;
        return age >= 0 && age <= SETUP_MARKER_TRANSFER_WINDOW_MS;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        return true;
      }
    });
  } catch (error) {
    if (error instanceof Error) return provided === dataDir ? [dataDir] : [provided, dataDir];
    throw error;
  }
}

export const claudeCodeDialect: Dialect = {
  tool: "claude_code",
  sessionId: (_event, payload) => stringField(payload, "session_id"),
  cwd: (_event, payload) => stringField(payload, "cwd"),
  vendorTurnId: (_event, payload) => stringField(payload, "prompt_id"),
  isPromptSubmit: (event) => event === "UserPromptSubmit",
  isSessionStart: (event) => event === "SessionStart",
  isFreshSessionStart: (event, payload) => {
    if (event !== "SessionStart") return false;
    const source = stringField(payload, "source");
    return source === "startup" || source === "clear" || source === "fork";
  },
  // SessionEnd fires while the host tears the session down, so it stays
  // append-only; every other event drains within the inline budget.
  drainsOn: (event) => event !== "SessionEnd",
  suppress: suppressConnectSession,
  suppressionDirs,
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

if (isMainModule(import.meta.url)) {
  cli()
    .catch(() => {})
    .finally(() => process.exit(0));
}
