// The single entry every Cursor hook invokes, with the event name as argv[2]
// and the hook JSON on stdin (same contract as claude-hook.ts). Must never
// throw to the IDE: the CLI bootstrap below always exits 0. Everything
// vendor-specific lives here as one Dialect table; runHook (hook-core.ts)
// owns the shared engine.
//
// Field mapping is pinned against the empirically captured cursor-agent
// 2026.08.11-e8db854 CLI hook stream (test/testdata/cursor_session.jsonl,
// SHA-256 494d36e51c4c2fb8f76691089f0ef611432ec76c7767fcd04b5d4588a8e435ac)
// AND against the backend's own decoder of that same raw fixture
// (trinity/backend/internal/store/coding/cursor.go's projectCursor +
// cursor_test.go's loadCursorFixture) — sessionId = conversation_id,
// vendorTurnId = generation_id for every turn-scoped kind and null for the
// two session-scoped kinds despite their shared lifecycle generation_id.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import type { Dialect } from "./hook-core.js";
import { runHook } from "./hook-core.js";
import { isMainModule } from "./main-module.js";
import { recordDrop } from "./outbox.js";

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The captured dialect's only cwd-shaped field is workspace_roots (an
// array), never a literal "cwd" string the way claude_code's hooks carry
// one. A single entry names an exact root; anything else (0 or 2+) is
// handled by the multi-root fail-closed check below, never fabricated here.
function singleWorkspaceRoot(payload: Record<string, unknown>): string | null {
  const roots = payload["workspace_roots"];
  if (!Array.isArray(roots) || roots.length !== 1) return null;
  const root = roots[0];
  return typeof root === "string" && root !== "" ? root : null;
}

// What leaves the machine is an ALLOWLIST, never a strip list (same rule as
// claude-hook.ts). Every key below was observed on the real captured
// cursor-agent stream. workspace_roots and user_email are absolute-path- and
// PII-shaped and are never forwarded, whatever event carries them; tool
// bodies (tool_input, tool_output, beforeReadFile's content) and reasoning
// (afterAgentThought — never even hooked, see hooks.json) are excluded by
// the same construction the claude dialect uses: a field not named here
// never travels.
const ALLOW_EVERY_EVENT = ["hook_event_name", "conversation_id", "generation_id"] as const;
const ALLOW_PER_EVENT: Record<string, readonly string[]> = {
  sessionStart: ["model"],
  beforeSubmitPrompt: ["prompt"],
  postToolUse: ["tool_name", "tool_use_id"],
  afterAgentResponse: ["text"],
  sessionEnd: ["reason"],
  // preToolUse, beforeReadFile and stop are genuinely captured (hooks.json
  // wires all 8 observed kinds, matching the empirical capture) but the
  // backend's projectCursor quarantines them — nothing downstream reads
  // their payload, so they carry only the common identity fields above.
};

export const cursorDialect: Dialect = {
  tool: "cursor",
  sessionId: (_event, payload) => str(payload, "conversation_id"),
  cwd: (_event, payload) => singleWorkspaceRoot(payload),
  // sessionStart/sessionEnd share one lifecycle generation_id distinct from
  // both turns' own — a captured, misleading fact — so both report no
  // vendor turn id despite the field being present on their payload.
  vendorTurnId: (event, payload) => (event === "sessionStart" || event === "sessionEnd" ? null : str(payload, "generation_id")),
  isPromptSubmit: (event) => event === "beforeSubmitPrompt",
  isSessionStart: (event) => event === "sessionStart",
  // Cursor hooks run synchronously — hooks.json has no async/detached mode
  // the way Claude Code's does — so only the two lifecycle boundaries drain;
  // every other hook (tool/file events, mid-turn) appends and returns
  // immediately, or the agent would stall on every tool call.
  drainsOn: (event) => event === "afterAgentResponse" || event === "sessionEnd",
  allow: (event) => [...ALLOW_EVERY_EVENT, ...(ALLOW_PER_EVENT[event] ?? [])],
  drainInline: true,
  dataDir: (env) => resolveDataDir(env),
};

// Cursor's docs and capture expose no CURSOR_PLUGIN_DATA equivalent (unlike
// CURSOR_PLUGIN_ROOT, which does exist and locates the installed plugin's
// own files — see hooks/hooks.json). Credentials therefore live in the
// secured per-user application-data location instead, exactly like a
// desktop app would, overridable for local builds and non-default hosts.
function resolveDataDir(env: NodeJS.ProcessEnv): string | null {
  if (env.TRINITY_CAPTURE_DATA) return env.TRINITY_CAPTURE_DATA;
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Trinity Capture", "cursor");
    case "win32": {
      const base = env.LOCALAPPDATA;
      return base ? join(base, "Trinity Capture", "cursor") : null;
    }
    default: {
      const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
      return join(base, "trinity-capture", "cursor");
    }
  }
}

// Cursor's only trustworthy repo field must name exactly one root. Invalid
// roots are dropped before runHook can fall back to process.cwd().
export async function runCursorHook(event: string, stdin: string, env: NodeJS.ProcessEnv): Promise<void> {
  const parsed: unknown = JSON.parse(stdin);
  const payload = isRecord(parsed) ? parsed : null;
  if (payload === null || singleWorkspaceRoot(payload) === null) {
    const dataDir = cursorDialect.dataDir(env);
    if (dataDir && loadConfig(dataDir)) {
      recordDrop(dataDir, { reason: "multi_root", captureEventId: randomUUID(), kind: event });
    }
    return;
  }
  await runHook(cursorDialect, event, stdin, env);
}

async function cli(): Promise<void> {
  const eventName = process.argv[2];
  if (!eventName) return;
  const stdin = readFileSync(0, "utf8");
  await runCursorHook(eventName, stdin, process.env);
}

if (isMainModule(import.meta.url)) {
  cli()
    .catch(() => {})
    .finally(() => process.exit(0));
}
