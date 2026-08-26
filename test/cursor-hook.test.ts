import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorDialect, runCursorHook } from "../src/cursor-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";

// Pins test/testdata/cursor_session.jsonl against the constant recorded in
// both trinity-capture's and trinity's own copy of this fixture (the
// cross-repo byte-identity guarantee) — a silent edit on either side fails
// this test rather than drifting quietly.
const CURSOR_FIXTURE_SHA256 = "494d36e51c4c2fb8f76691089f0ef611432ec76c7767fcd04b5d4588a8e435ac";

function fixtureLines(): Record<string, unknown>[] {
  const raw = readFileSync(join(process.cwd(), "test", "testdata", "cursor_session.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-cursor-data-"));
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Trinity Test",
    GIT_AUTHOR_EMAIL: "test@trinity.dev",
    GIT_COMMITTER_NAME: "Trinity Test",
    GIT_COMMITTER_EMAIL: "test@trinity.dev",
  };
}

function initRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-cursor-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

function pairedDataDir(): { dataDir: string; repo: string } {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  const policy: Policy = {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/cursor-fixture", aliases: [], route: "project:p1" }],
  };
  savePolicy(dataDir, policy);
  const repo = initRepo("git@github.com:acme/cursor-fixture.git");
  return { dataDir, repo };
}

// Every call goes through the real dialect + the shared engine, the same
// way the CLI bootstrap does — just with dataDir pinned via env instead of
// relying on the platform default resolveDataDir would otherwise pick.
function run(event: string, payload: Record<string, unknown>, dataDir: string): Promise<void> {
  return runCursorHook(event, JSON.stringify(payload), { ...process.env, TRINITY_CAPTURE_DATA: dataDir });
}

interface OutboxEvent {
  kind: string;
  externalSessionId: string;
  turnKey?: string;
  payload: Record<string, unknown>;
}

function outboxFiles(dataDir: string): string[] {
  const dir = join(dataDir, "outbox");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function readStatusDrops(dataDir: string): { reason: string; kind: string }[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "status.json"), "utf8")) as { drops?: { reason: string; kind: string }[] };
    return parsed.drops ?? [];
  } catch {
    return [];
  }
}

test("the fixture's on-disk content matches the recorded cross-repo SHA-256", () => {
  const raw = readFileSync(join(process.cwd(), "test", "testdata", "cursor_session.jsonl"));
  const sum = createHash("sha256").update(raw).digest("hex");
  assert.equal(sum, CURSOR_FIXTURE_SHA256);
});

// --- Dialect field extraction ---

test("sessionId reads conversation_id, not the coincidentally-identical session_id field", () => {
  assert.equal(cursorDialect.sessionId("sessionStart", { conversation_id: "conv-1", session_id: "sess-9" }), "conv-1");
});

test("cwd resolves a single workspace_roots entry and nothing else", () => {
  assert.equal(cursorDialect.cwd("postToolUse", { workspace_roots: ["/workspace/repo"] }), "/workspace/repo");
  assert.equal(cursorDialect.cwd("postToolUse", { workspace_roots: [] }), null);
  assert.equal(cursorDialect.cwd("postToolUse", { workspace_roots: ["/a", "/b"] }), null, "cwd itself never picks a root out of a multi-root event");
  assert.equal(cursorDialect.cwd("postToolUse", {}), null);
});

test("vendorTurnId is null for sessionStart/sessionEnd despite carrying generation_id, and the generation_id otherwise", () => {
  assert.equal(cursorDialect.vendorTurnId("sessionStart", { generation_id: "g1" }), null);
  assert.equal(cursorDialect.vendorTurnId("sessionEnd", { generation_id: "g1" }), null);
  for (const event of ["beforeSubmitPrompt", "preToolUse", "beforeReadFile", "postToolUse", "afterAgentResponse", "stop"]) {
    assert.equal(cursorDialect.vendorTurnId(event, { generation_id: "g1" }), "g1", `${event} must report generation_id as its vendor turn id`);
  }
});

test("isPromptSubmit/isSessionStart match exactly one kind each", () => {
  assert.equal(cursorDialect.isPromptSubmit("beforeSubmitPrompt"), true);
  assert.equal(cursorDialect.isPromptSubmit("preToolUse"), false);
  assert.equal(cursorDialect.isSessionStart("sessionStart"), true);
  assert.equal(cursorDialect.isSessionStart("sessionEnd"), false);
});

test("drainsOn is true only for the two lifecycle boundaries; drainInline is true (no async hooks)", () => {
  assert.equal(cursorDialect.drainInline, true);
  assert.equal(cursorDialect.drainsOn("afterAgentResponse"), true);
  assert.equal(cursorDialect.drainsOn("sessionEnd"), true);
  for (const event of ["sessionStart", "beforeSubmitPrompt", "preToolUse", "beforeReadFile", "postToolUse", "stop"]) {
    assert.equal(cursorDialect.drainsOn(event), false, `${event} must not drain — draining on a mid-turn hook would stall the agent`);
  }
});

// --- Allowlist: never a tool body, never a local path, never PII, never reasoning ---

test("allow() per kind matches exactly what the backend decoder reads, nothing else", () => {
  assert.deepEqual([...cursorDialect.allow("sessionStart")].sort(), ["conversation_id", "generation_id", "hook_event_name", "model"]);
  assert.deepEqual([...cursorDialect.allow("beforeSubmitPrompt")].sort(), ["conversation_id", "generation_id", "hook_event_name", "prompt"]);
  assert.deepEqual([...cursorDialect.allow("postToolUse")].sort(), ["conversation_id", "generation_id", "hook_event_name", "tool_name", "tool_use_id"]);
  assert.deepEqual([...cursorDialect.allow("afterAgentResponse")].sort(), ["conversation_id", "generation_id", "hook_event_name", "text"]);
  assert.deepEqual([...cursorDialect.allow("sessionEnd")].sort(), ["conversation_id", "generation_id", "hook_event_name", "reason"]);
  // Genuinely captured (hooks.json wires them) but quarantined server-side —
  // only the common identity fields travel, never a body.
  for (const event of ["preToolUse", "beforeReadFile", "stop"]) {
    assert.deepEqual([...cursorDialect.allow(event)].sort(), ["conversation_id", "generation_id", "hook_event_name"], `${event} must forward identity only`);
  }
  // An unregistered/unknown kind (afterAgentThought is never hooked at all —
  // see cursor/hooks/hooks.json) falls back to the same identity-only set by
  // construction, never a body field.
  assert.deepEqual([...cursorDialect.allow("afterAgentThought")].sort(), ["conversation_id", "generation_id", "hook_event_name"]);
});

// --- The reconciliation gate: the raw fixture, replayed, matches the backend's own mapping ---

test("the full captured fixture, replayed in order, matches the backend's own envelope mapping", async () => {
  const { dataDir, repo } = pairedDataDir();
  const lines = fixtureLines();

  const events: OutboxEvent[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const retargeted: Record<string, unknown> = { ...line, workspace_roots: [repo] };
    const kind = retargeted.hook_event_name as string;
    await run(kind, retargeted, dataDir);
    const newFilenames = outboxFiles(dataDir).filter((f) => !seen.has(f));
    newFilenames.forEach((f) => seen.add(f));
    const newFiles = newFilenames.map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as OutboxEvent);
    // sessionStart additionally synthesizes workspace.observed (hook-core's
    // own behavior, gated on isSessionStart — not part of the raw fixture
    // line count, so it is tracked but excluded from the per-line mapping).
    const own = newFiles.find((ev) => ev.kind === kind);
    assert.ok(own, `hook_event_name=${kind} must append its own event`);
    if (kind === "sessionStart") {
      assert.equal(newFiles.length, 2, "sessionStart must also synthesize workspace.observed");
      assert.ok(newFiles.some((ev) => ev.kind === "workspace.observed"));
    } else {
      assert.equal(newFiles.length, 1, `hook_event_name=${kind} must append exactly one event`);
    }
    events.push(own);
  }

  assert.equal(events.length, lines.length, "every observed hook_event_name is captured, even the ones the backend later quarantines");

  // kind == hook_event_name, externalSessionId == conversation_id, for every line.
  events.forEach((ev, i) => {
    assert.equal(ev.kind, lines[i].hook_event_name);
    assert.equal(ev.externalSessionId, lines[i].conversation_id);
  });

  // Turn correlation: sessionStart/sessionEnd (generation_id "vendor-id-001",
  // the shared lifecycle id) carry no turnKey; every other line's turnKey is
  // internally consistent per generation_id — same generation_id, same
  // minted key, and the two turns' keys never collide. This is the same
  // shape trinity's loadCursorFixture asserts against this raw fixture.
  const byGen = new Map<string, (string | undefined)[]>();
  lines.forEach((line, i) => {
    const gen = line.generation_id as string;
    const list = byGen.get(gen) ?? [];
    list.push(events[i].turnKey);
    byGen.set(gen, list);
  });
  const lifecycleGen = lines[0].generation_id as string; // sessionStart's own generation_id
  for (const key of byGen.get(lifecycleGen) ?? []) {
    assert.equal(key, undefined, "sessionStart/sessionEnd must carry no turnKey despite sharing a generation_id");
  }
  const turnGens = [...byGen.keys()].filter((g) => g !== lifecycleGen);
  assert.equal(turnGens.length, 2, "the fixture carries exactly two real turns");
  const turnKeysByGen = turnGens.map((g) => {
    const keys = byGen.get(g);
    assert.ok(keys);
    assert.ok(keys.every((k) => k !== undefined && k === keys[0]), `all events of generation_id ${g} must share one minted turnKey`);
    const key = keys[0];
    assert.ok(key);
    return key;
  });
  assert.notEqual(turnKeysByGen[0], turnKeysByGen[1], "the two turns must never collide on the same minted key");

  // Privacy: across every one of the 13 forwarded payloads, nothing
  // body-shaped or PII-shaped ever appears — not tool_input, not
  // tool_output, not beforeReadFile's content, not user_email, not any
  // absolute local path (workspace_roots/transcript_path), not
  // afterAgentThought reasoning (never even hooked).
  for (const ev of events) {
    const raw = JSON.stringify(ev.payload);
    assert.doesNotMatch(raw, /tool_input|tool_output|"content"/, `${ev.kind} payload must never carry a tool body`);
    assert.doesNotMatch(raw, /user_email|redacted-user/, `${ev.kind} payload must never carry PII`);
    assert.doesNotMatch(raw, /workspace_roots|transcript_path|\/workspace\//, `${ev.kind} payload must never carry a local path`);
    assert.doesNotMatch(raw, /afterAgentThought|loop_count|status|cache_read_tokens/, `${ev.kind} payload must never carry reasoning/token telemetry`);
  }
});

// --- Multi-root fail-closed (finding 4) ---

test("multi-root fail-closed: both legs, the captured payload modified only in workspace_roots", async () => {
  const { dataDir, repo } = pairedDataDir();
  const captured = fixtureLines().find((l) => l.hook_event_name === "postToolUse");
  assert.ok(captured);

  // Leg A: the event names exactly one root (retargeted to a real repo so
  // the rest of the pipeline can actually run) — captured through normally.
  const singleRoot = { ...captured, workspace_roots: [repo] };
  await run("postToolUse", singleRoot, dataDir);
  assert.equal(outboxFiles(dataDir).length, 1, "a single named root must be captured");
  assert.equal(readStatusDrops(dataDir).length, 0);

  // Leg B: only the roots array changes — now naming two roots. No field
  // in this dialect's captured events says which one the event is about,
  // so it must be dropped whole rather than guessed.
  const multiRoot = { ...captured, workspace_roots: [repo, "/workspace/some-other-repo"] };
  await run("postToolUse", multiRoot, dataDir);
  assert.equal(outboxFiles(dataDir).length, 1, "a multi-root event must add nothing to the outbox");
  const drops = readStatusDrops(dataDir);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "multi_root");
  assert.equal(drops[0].kind, "postToolUse");
});

test("multi-root fail-closed applies even to a lifecycle event (sessionStart)", async () => {
  const { dataDir, repo } = pairedDataDir();
  const captured = fixtureLines().find((l) => l.hook_event_name === "sessionStart");
  assert.ok(captured);
  const multiRoot = { ...captured, workspace_roots: [repo, "/workspace/some-other-repo"] };

  await run("sessionStart", multiRoot, dataDir);

  assert.equal(outboxFiles(dataDir).length, 0, "no session event and no workspace.observed synthesis for a dropped sessionStart");
  const drops = readStatusDrops(dataDir);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "multi_root");
});

test("multi-root drop is recorded only for a paired device — an unpaired device stays silent, same as every other hook path", async () => {
  const dataDir = join(tmpdir(), `trinity-cursor-unpaired-${process.pid}-${Date.now()}`); // deliberately never created: no saveConfig, never paired
  const captured = fixtureLines().find((l) => l.hook_event_name === "postToolUse");
  assert.ok(captured);
  const multiRoot = { ...captured, workspace_roots: ["/a", "/b"] };

  await assert.doesNotReject(run("postToolUse", multiRoot, dataDir));

  assert.ok(!existsSync(dataDir), "an unpaired device's dataDir may not even exist on disk — recording must not create it");
});
