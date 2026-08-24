// The single entry every Claude Code hook invokes, with the event name as
// argv[2] and the hook JSON on stdin. Must never throw to the IDE: the CLI
// bootstrap below always exits 0.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig, loadPolicy } from "./config.js";
import { routeFor } from "./gate.js";
import { appendEvent, drain } from "./outbox.js";
import { gitRemoteOf, repoRelativeCwd, workspaceObserved } from "./observe.js";
import { refreshPolicy } from "./send.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt_id?: string;
  user_input?: unknown;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  tool_use_id?: string;
  last_assistant_message?: unknown;
  reason?: string;
  [key: string]: unknown;
}

// Fields that never leave the machine regardless of event: absolute local
// paths (spec §4.2) and anything reasoning/thinking-named (spec §4.4).
const ALWAYS_STRIP = new Set(["cwd", "transcript_path"]);
const PER_EVENT_STRIP: Record<string, string[]> = {
  PostToolUse: ["tool_input", "tool_output"],
};

function isReasoningKey(key: string): boolean {
  return /reasoning|thinking/i.test(key);
}

function filterPayload(eventName: string, raw: HookInput): Record<string, unknown> {
  const strip = new Set([...ALWAYS_STRIP, ...(PER_EVENT_STRIP[eventName] ?? [])]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (strip.has(key) || isReasoningKey(key)) continue;
    out[key] = value;
  }
  return out;
}

export async function runHook(eventName: string, input: HookInput, dataDir: string): Promise<void> {
  const cfg = loadConfig(dataDir);
  if (!cfg) return; // never authorized — fail closed, zero network requests

  const cwd = input.cwd ?? process.cwd();
  const policy = loadPolicy(dataDir);
  const route = routeFor(policy, Date.now(), gitRemoteOf(cwd));
  if (!route.send) return; // not allowlisted, or policy missing/stale — zero network requests

  const sessionId = input.session_id ?? "";
  const repoCwd = repoRelativeCwd(cwd);

  appendEvent(dataDir, {
    captureEventId: randomUUID(),
    tool: "claude_code",
    kind: eventName,
    externalSessionId: sessionId,
    repo: route.canonicalRepo,
    repoCwd,
    occurredAt: new Date().toISOString(),
    payload: filterPayload(eventName, input),
  });

  if (eventName === "SessionStart") {
    const observed = workspaceObserved(cwd);
    if (observed) {
      appendEvent(dataDir, { ...observed, externalSessionId: sessionId, repo: route.canonicalRepo, repoCwd });
    }
    const stale = !policy || Date.now() > policy.fetchedAt + policy.ttlSeconds * 1000;
    if (stale) {
      try {
        await refreshPolicy(dataDir, cfg);
      } catch {
        // best-effort: keep operating on the existing (possibly stale) policy
      }
    }
  }

  // SessionEnd is synchronous and timeout-bounded — it only appends to the
  // outbox, never drains.
  if (eventName !== "SessionEnd") {
    try {
      await drain(dataDir, cfg);
    } catch {
      // never let a drain failure reach the IDE
    }
  }
}

async function cli(): Promise<void> {
  const eventName = process.argv[2];
  if (!eventName) return;
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) return;
  const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  await runHook(eventName, input, dataDir);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  cli()
    .catch(() => {})
    .finally(() => process.exit(0));
}
