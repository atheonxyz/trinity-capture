// Shared hook engine every dialect's thin entrypoint calls (see
// claude-hook.ts for the first one). Owns config/policy gating, race-safe
// turn-key correlation, the outbox append, and bounded-network draining. A
// dialect supplies only vendor-specific field extraction and event naming.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadPolicy } from "./config.js";
import { routeFor } from "./gate.js";
import { appendEvent, drain, INLINE_DRAIN_BUDGET_MS } from "./outbox.js";
import type { CaptureEvent } from "./outbox.js";
import { gitRemoteOf, repoRelativeCwd, workspaceObserved } from "./observe.js";
import { refreshPolicy } from "./send.js";

export interface Dialect {
  tool: "claude_code" | "codex" | "cursor";
  sessionId(event: string, payload: Record<string, unknown>): string | null;
  cwd(event: string, payload: Record<string, unknown>): string | null;
  vendorTurnId(event: string, payload: Record<string, unknown>): string | null;
  // The preferred turn-key mint point (Claude: UserPromptSubmit). Unseen
  // vendor ids on any other turn-scoped event still lazily mint — required
  // by dialects whose first observable turn-scoped event isn't this one.
  isPromptSubmit(event: string): boolean;
  // Gates the stale-policy self-heal refresh and the workspace.observed
  // synthesis — both are "new session" moments, not necessarily named
  // "SessionStart" (dialects use their own event vocabulary).
  isSessionStart(event: string): boolean;
  // Gates WHETHER this event drains at all (a dialect whose hooks run
  // synchronously may only want to drain on its own lifecycle boundaries).
  // drainInline separately governs HOW a drain that does happen behaves
  // (one bounded batch vs. the open multi-batch default).
  drainsOn(event: string): boolean;
  allow(event: string): string[];
  drainInline: boolean;
  dataDir(env: NodeJS.ProcessEnv): string | null;
}

function filterPayload(payload: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in payload) out[key] = payload[key];
  }
  return out;
}

// --- turn-key store ---
// One write-once file per vendor turn id, never a shared map: two hook
// processes racing to mint the same vendor id can only ever collide on the
// SAME file's exclusive-create, and the loser reads the winner back rather
// than overwriting it. A shared JSON map under temp+rename would still lose
// updates when two processes each read-modify-write a distinct key at once.

// Sanitizes a vendor turn id for filesystem use: keep [A-Za-z0-9._-],
// hex-encode everything else (multi-byte characters hex-encode to more than
// one pair, which stays inside the allowed charset). That alone still lets
// a vendor id of exactly "." or ".." pass through as a dot-segment, so
// hex-encode the whole id in that one case rather than leaving a
// traversal-shaped name on disk.
function sanitizeTurnId(id: string): string {
  const mapped = id.replace(/[^A-Za-z0-9._-]/g, (ch) => Buffer.from(ch, "utf8").toString("hex"));
  return mapped === "." || mapped === ".." || mapped === "" ? Buffer.from(id, "utf8").toString("hex") || "empty" : mapped;
}

function turnKeyDir(dataDir: string, tool: string, sessionId: string): string {
  return join(dataDir, "turnkeys", `${tool}-${sessionId}`);
}

// Exported for tests exercising the race directly (including across real
// child processes, not just concurrent in-process calls, since Node's
// synchronous fs calls can't interleave with themselves).
export function claimTurnKey(sessionDir: string, vendorTurnId: string): string {
  const file = join(sessionDir, sanitizeTurnId(vendorTurnId));
  mkdirSync(sessionDir, { recursive: true });
  const minted = randomUUID();
  try {
    writeFileSync(file, minted, { flag: "wx" });
    return minted;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return readFileSync(file, "utf8"); // another process won the race — read its key back
  }
}

// latest is a separate one-line temp+rename file, consulted only by events
// whose dialect returns no vendor turn id — those are inherently
// order-ambiguous (no vendor identity to correlate on), so its benign race
// between two id-less events is documented, not hidden behind a lock.
function mintLatest(sessionDir: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const minted = randomUUID();
  const tmp = join(sessionDir, `.latest.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, minted);
  renameSync(tmp, join(sessionDir, "latest"));
  return minted;
}

function readLatest(sessionDir: string): string | undefined {
  try {
    return readFileSync(join(sessionDir, "latest"), "utf8").trim() || undefined;
  } catch {
    return undefined; // no prompt observed yet (or state lost) — omit the hint
  }
}

function resolveTurnKey(dataDir: string, d: Dialect, event: string, sessionId: string, payload: Record<string, unknown>): string | undefined {
  const sessionDir = turnKeyDir(dataDir, d.tool, sessionId);
  try {
    const vendorId = d.vendorTurnId(event, payload);
    if (vendorId !== null && vendorId !== "") return claimTurnKey(sessionDir, vendorId);
    if (d.isPromptSubmit(event)) return mintLatest(sessionDir);
    return readLatest(sessionDir);
  } catch {
    return undefined; // best-effort; the server falls back to open-turn-by-ordinal
  }
}

// --- hook engine ---

export async function runHook(d: Dialect, event: string, stdin: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Taken at hook entry, before any I/O: an inline drain's budget covers
  // this whole invocation, not just the time spent inside drain() itself.
  const hookEntryDeadline = Date.now() + INLINE_DRAIN_BUDGET_MS;

  const dataDir = d.dataDir(env);
  if (!dataDir) return; // dialect found no durable writable dir — never paired, or the host gave none

  const cfg = loadConfig(dataDir);
  if (!cfg) return; // never authorized — fail closed, zero network requests

  const payload = JSON.parse(stdin) as Record<string, unknown>;

  // Self-healing happens before the gate, not after: routeFor already
  // fails closed on a stale policy, so a refresh attempted only once
  // send:false has been decided can never run. Scoped to the dialect's own
  // session-start moment, not a literal event name — hook-core carries no
  // vendor vocabulary of its own.
  let policy = loadPolicy(dataDir);
  if (d.isSessionStart(event)) {
    const stale = !policy || Date.now() > policy.fetchedAt + policy.ttlSeconds * 1000;
    if (stale) {
      try {
        policy = await refreshPolicy(dataDir, cfg);
      } catch {
        // best-effort: routeFor below still fails closed on whatever policy we have
      }
    }
  }

  const cwd = d.cwd(event, payload) ?? process.cwd();
  const route = routeFor(policy, Date.now(), gitRemoteOf(cwd));
  if (!route.send) return; // not allowlisted, or policy missing/still stale — no event, no drain

  const sessionId = d.sessionId(event, payload) ?? "";
  const repoCwd = repoRelativeCwd(cwd);
  const turnKey = sessionId === "" ? undefined : resolveTurnKey(dataDir, d, event, sessionId, payload);

  const captureEvent: CaptureEvent = {
    captureEventId: randomUUID(),
    tool: d.tool,
    kind: event,
    externalSessionId: sessionId,
    repo: route.canonicalRepo,
    repoCwd,
    occurredAt: new Date().toISOString(),
    ...(turnKey === undefined ? {} : { turnKey }),
    payload: filterPayload(payload, d.allow(event)),
  };
  appendEvent(dataDir, captureEvent);

  if (d.isSessionStart(event)) {
    const observed = workspaceObserved(cwd);
    if (observed) {
      appendEvent(dataDir, { ...observed, tool: d.tool, externalSessionId: sessionId, repo: route.canonicalRepo, repoCwd });
    }
  }

  // Whether THIS event drains at all is the dialect's call (a synchronous
  // dialect may only want its own lifecycle boundaries to drain); drainInline
  // above governs how a drain that does happen behaves.
  if (d.drainsOn(event)) {
    try {
      await drain(dataDir, cfg, { inline: d.drainInline, deadline: hookEntryDeadline });
    } catch {
      // never let a drain failure reach the IDE
    }
  }
}
