// Shared hook engine every dialect's thin entrypoint calls (see
// claude-hook.ts for the first one). Owns config/policy gating, race-safe
// turn-key correlation, the outbox append, and bounded-network draining. A
// dialect supplies only vendor-specific field extraction and event naming.
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadPolicy } from "./config.js";
import { isPolicyFresh, matchRoute, routeFor } from "./gate.js";
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
  suppress?(dataDir: string, event: string, payload: Record<string, unknown>): boolean;
  allow(event: string): readonly string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// One write-once file per vendor turn id, never a shared map: two hook
// processes racing to mint the same vendor id can only ever collide on the
// SAME file's exclusive-create, and the loser reads the winner back rather
// than overwriting it. A shared JSON map under temp+rename would still lose
// updates when two processes each read-modify-write a distinct key at once.

// Hex encoding is injective and keeps hostile ids from becoming path segments.
function sanitizeTurnId(id: string): string {
  return `id-${Buffer.from(id, "utf8").toString("hex") || "empty"}`;
}

export function turnKeyDir(dataDir: string, tool: string, sessionId: string): string {
  // sessionId comes straight from untrusted hook stdin — join() does not
  // neutralize a "/" or ".." embedded inside one path segment, so it goes
  // through the same sanitizer as a vendor turn id before touching disk.
  return join(dataDir, "turnkeys", `${tool}-${sanitizeTurnId(sessionId)}`);
}

export function claimTurnKey(sessionDir: string, vendorTurnId: string): string {
  const file = join(sessionDir, sanitizeTurnId(vendorTurnId));
  mkdirSync(sessionDir, { recursive: true });
  const minted = randomUUID();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, minted, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, file);
    return minted;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      return readFileSync(file, "utf8");
    }
    throw err;
  } finally {
    rmSync(temporary, { force: true });
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

function resolveTurnKey(dataDir: string, dialect: Dialect, event: string, sessionId: string, payload: Record<string, unknown>): string | undefined {
  const sessionDir = turnKeyDir(dataDir, dialect.tool, sessionId);
  try {
    const vendorTurnId = dialect.vendorTurnId(event, payload);
    if (vendorTurnId !== null && vendorTurnId !== "") return claimTurnKey(sessionDir, vendorTurnId);
    if (dialect.isPromptSubmit(event)) return mintLatest(sessionDir);
    return readLatest(sessionDir);
  } catch {
    return undefined; // best-effort; the server falls back to open-turn-by-ordinal
  }
}

export async function runHook(dialect: Dialect, event: string, stdin: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Taken at hook entry, before any I/O: an inline drain's budget covers
  // this whole invocation, not just the time spent inside drain() itself.
  const hookEntryDeadline = Date.now() + INLINE_DRAIN_BUDGET_MS;

  const dataDir = dialect.dataDir(env);
  if (!dataDir) return; // dialect found no durable writable dir — never paired, or the host gave none

  const parsed: unknown = JSON.parse(stdin);
  if (!isRecord(parsed)) return;
  const payload = parsed;
  if (dialect.suppress?.(dataDir, event, payload)) return;

  const cfg = loadConfig(dataDir);
  if (!cfg) return; // never authorized — fail closed, zero network requests

  // Self-healing happens before the gate, not after: routeFor already
  // fails closed on a stale policy, so a refresh attempted only once
  // send:false has been decided can never run. Scoped to the dialect's own
  // session-start moment, not a literal event name — hook-core carries no
  // vendor vocabulary of its own.
  const cwd = dialect.cwd(event, payload) ?? process.cwd();
  const gitRemote = gitRemoteOf(cwd);
  let policy = loadPolicy(dataDir);
  if (!matchRoute(policy, gitRemote).send) return;
  if (dialect.isSessionStart(event) && !isPolicyFresh(policy, Date.now())) {
    const remaining = dialect.drainInline ? hookEntryDeadline - Date.now() : undefined;
    if (remaining === undefined || remaining > 0) {
      try {
        policy = await refreshPolicy(dataDir, cfg, remaining);
      } catch {
        policy = null;
      }
    }
  }

  const route = routeFor(policy, Date.now(), gitRemote);
  if (!route.send) return; // not allowlisted, or policy missing/still stale — no event, no drain

  const sessionId = dialect.sessionId(event, payload) ?? "";
  const repoCwd = repoRelativeCwd(cwd);
  const turnKey = sessionId === "" || dialect.isSessionStart(event)
    ? undefined
    : resolveTurnKey(dataDir, dialect, event, sessionId, payload);

  const captureEvent: CaptureEvent = {
    captureEventId: randomUUID(),
    tool: dialect.tool,
    kind: event,
    externalSessionId: sessionId,
    repo: route.canonicalRepo,
    repoCwd,
    occurredAt: new Date().toISOString(),
    ...(turnKey === undefined ? {} : { turnKey }),
    payload: filterPayload(payload, dialect.allow(event)),
  };
  appendEvent(dataDir, captureEvent);

  if (dialect.isSessionStart(event)) {
    const observed = workspaceObserved(cwd);
    if (observed) {
      appendEvent(dataDir, { ...observed, tool: dialect.tool, externalSessionId: sessionId, repo: route.canonicalRepo, repoCwd });
    }
  }

  // Whether THIS event drains at all is the dialect's call (a synchronous
  // dialect may only want its own lifecycle boundaries to drain); drainInline
  // above governs how a drain that does happen behaves.
  if (dialect.drainsOn(event)) {
    await drain(dataDir, cfg, { inline: dialect.drainInline, deadline: hookEntryDeadline }).catch(() => undefined);
  }
}
