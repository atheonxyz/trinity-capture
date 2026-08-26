import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook-core.js";
import { codexDialect } from "../src/codex-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-codex-data-"));
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
  const dir = mkdtempSync(join(tmpdir(), "trinity-codex-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

function outboxFiles(dataDir: string): string[] {
  const dir = join(dataDir, "outbox");
  return existsSync(dir) ? readdirSync(dir) : [];
}

interface OutboxEvent {
  kind: string;
  turnKey?: string;
  payload: Record<string, unknown>;
}

function readEvents(dataDir: string): OutboxEvent[] {
  return outboxFiles(dataDir).map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as OutboxEvent);
}

// The real captured stream (codex-cli 0.149.0-alpha.4.3) — one line per hook
// invocation, in order. See test/testdata/codex_session.jsonl's own header
// comment (none; the sha256 pin below stands in for one) for provenance.
function loadFixtureLines(): Record<string, unknown>[] {
  const raw = readFileSync(join(process.cwd(), "test/testdata/codex_session.jsonl"), "utf8").trim();
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Every call goes through the real dialect table + the shared engine, the
// same way the CLI bootstrap does — just with an in-memory env instead of
// argv/stdin.
function runCodexHook(payload: Record<string, unknown>, dataDir: string): Promise<void> {
  const eventName = payload.hook_event_name as string;
  return runHook(codexDialect, eventName, JSON.stringify(payload), { ...process.env, PLUGIN_DATA: dataDir });
}

function freshPolicy(canonicalRepo: string): Policy {
  return {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo, aliases: [], route: "project:p1" }],
  };
}

test("SessionStart in an allowlisted repo appends the session event and workspace.observed", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, freshPolicy("github.com/acme/widgets"));
  const repo = initRepo("git@github.com:acme/widgets.git");

  const [sessionStart] = loadFixtureLines();
  await runCodexHook({ ...sessionStart, cwd: repo }, dataDir);

  assert.equal(outboxFiles(dataDir).length, 2);
  const events = readEvents(dataDir);
  const started = events.find((e) => e.kind === "SessionStart");
  assert.ok(started, "SessionStart must be captured");
  assert.equal(started.payload.model, "gpt-5.6-sol", "the real model field must be forwarded — the codex decoder projects it");
  assert.equal(started.turnKey, undefined, "SessionStart must carry no turnKey");
});

test("gate fail-closed: an unpaired device appends nothing and never throws", async () => {
  const dataDir = tmpDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");

  const [sessionStart] = loadFixtureLines();
  await assert.doesNotReject(runCodexHook({ ...sessionStart, cwd: repo }, dataDir));

  assert.equal(outboxFiles(dataDir).length, 0);
});

test("PreToolUse and PostToolUse forward only allowlisted metadata — no tool bodies under either observed field, no local paths, no unheard-of future field", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, freshPolicy("github.com/acme/widgets"));
  const repo = initRepo("git@github.com:acme/widgets.git");

  const lines = loadFixtureLines();
  const preToolUse = lines.find((l) => l.hook_event_name === "PreToolUse")!;
  const postToolUse = lines.find((l) => l.hook_event_name === "PostToolUse")!;

  // some_future_vendor_field proves the allowlist drops what it has not
  // heard of, not just the two body fields the current capture happens to use.
  await runCodexHook({ ...preToolUse, cwd: repo, some_future_vendor_field: "FUTURE_BODY_MUST_NOT_FORWARD" }, dataDir);
  await runCodexHook({ ...postToolUse, cwd: repo, some_future_vendor_field: "FUTURE_BODY_MUST_NOT_FORWARD" }, dataDir);

  const files = outboxFiles(dataDir);
  assert.equal(files.length, 2);
  for (const f of files) {
    const raw = readFileSync(join(dataDir, "outbox", f), "utf8");
    assert.doesNotMatch(raw, /tool_input/, `${f} must never forward tool_input`);
    assert.doesNotMatch(raw, /tool_response/, `${f} must never forward tool_response`);
    assert.doesNotMatch(raw, /synthetic fixture text/, `${f} must never forward the tool body's content`);
    assert.doesNotMatch(raw, /FUTURE_BODY_MUST_NOT_FORWARD/, `${f} must drop a field the allowlist has never heard of`);
    assert.doesNotMatch(raw, /transcript_path/, `${f} must never forward the absolute transcript path`);
    assert.match(raw, /"tool_name":"Bash"/);
  }

  const events = readEvents(dataDir);
  const pre = events.find((e) => e.kind === "PreToolUse")!;
  const post = events.find((e) => e.kind === "PostToolUse")!;
  assert.equal(pre.payload.tool_use_id, "vendor-id-003");
  assert.equal(post.payload.tool_use_id, "vendor-id-003");
  assert.ok(!("cwd" in pre.payload) && !("cwd" in post.payload), "the absolute cwd must never ride the payload");

  // Both events belong to the same vendor turn (turn_id vendor-id-002 in the
  // fixture) and must resolve the same minted turnKey.
  assert.ok(pre.turnKey && post.turnKey);
  assert.equal(pre.turnKey, post.turnKey);
});

test("turnKey correlation: two turns each mint their own key, shared by every event carrying that turn_id", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, freshPolicy("github.com/acme/widgets"));
  const repo = initRepo("git@github.com:acme/widgets.git");

  for (const line of loadFixtureLines()) {
    await runCodexHook({ ...line, cwd: repo }, dataDir);
  }

  const events = readEvents(dataDir);
  const byKind = (kind: string) => events.filter((e) => e.kind === kind);

  for (const e of [...byKind("SessionStart"), ...byKind("workspace.observed"), ...byKind("SessionEnd")]) {
    assert.equal(e.turnKey, undefined, `${e.kind} must carry no turnKey (SessionEnd's raw event carries no turn_id either)`);
  }

  const turn1Events = events.filter((e) => e.payload.turn_id === "vendor-id-002");
  const turn2Events = events.filter((e) => e.payload.turn_id === "vendor-id-004");
  assert.equal(turn1Events.length, 4, "UserPromptSubmit, PreToolUse, PostToolUse, Stop");
  assert.equal(turn2Events.length, 4);

  const key1 = turn1Events[0].turnKey;
  const key2 = turn2Events[0].turnKey;
  assert.ok(key1 && key2 && key1 !== key2, "each turn mints its own key");
  for (const e of turn1Events) assert.equal(e.turnKey, key1);
  for (const e of turn2Events) assert.equal(e.turnKey, key2);
});

test("out-of-order delivery still correlates by turn_id, not arrival order", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, freshPolicy("github.com/acme/widgets"));
  const repo = initRepo("git@github.com:acme/widgets.git");

  const lines = loadFixtureLines();
  const prompt1 = lines.find((l) => l.hook_event_name === "UserPromptSubmit" && l.turn_id === "vendor-id-002")!;
  const prompt2 = lines.find((l) => l.hook_event_name === "UserPromptSubmit" && l.turn_id === "vendor-id-004")!;
  const lateForTurn1 = lines.find((l) => l.hook_event_name === "PostToolUse" && l.turn_id === "vendor-id-002")!;

  await runCodexHook({ ...prompt1, cwd: repo }, dataDir);
  await runCodexHook({ ...prompt2, cwd: repo }, dataDir);
  await runCodexHook({ ...lateForTurn1, cwd: repo }, dataDir);

  const events = readEvents(dataDir);
  const k1 = events.find((e) => e.payload.turn_id === "vendor-id-002" && e.kind === "UserPromptSubmit")?.turnKey;
  const k2 = events.find((e) => e.payload.turn_id === "vendor-id-004" && e.kind === "UserPromptSubmit")?.turnKey;
  const late = events.find((e) => e.kind === "PostToolUse")?.turnKey;

  assert.ok(k1 && k2 && k1 !== k2);
  assert.equal(late, k1, "a PostToolUse for turn 1 arriving after turn 2's prompt must still resolve turn 1's key");
});

test("dataDir prefers TRINITY_CAPTURE_DATA over PLUGIN_DATA (the documented fallback override)", () => {
  assert.equal(codexDialect.dataDir({ PLUGIN_DATA: "/plugin/data" }), "/plugin/data");
  assert.equal(
    codexDialect.dataDir({ PLUGIN_DATA: "/plugin/data", TRINITY_CAPTURE_DATA: "/fallback/data" }),
    "/fallback/data",
  );
  assert.equal(codexDialect.dataDir({}), null);
});

test("SessionEnd forwards the session's end reason", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, freshPolicy("github.com/acme/widgets"));
  const repo = initRepo("git@github.com:acme/widgets.git");

  const sessionEnd = loadFixtureLines().find((l) => l.hook_event_name === "SessionEnd")!;
  await runCodexHook({ ...sessionEnd, cwd: repo }, dataDir);

  const events = readEvents(dataDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, "other");
});

test("the connect command suppresses the rest of its Codex session", async () => {
  const dataDir = tmpDataDir();
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, freshPolicy("github.com/acme/widgets"));
  const repo = initRepo("git@github.com:acme/widgets.git");
  const session = "connect-session";

  await runCodexHook({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: "t1", prompt: "/trinity-connect ABCD", cwd: repo }, dataDir);
  await runCodexHook({ hook_event_name: "Stop", session_id: session, turn_id: "t1", last_assistant_message: "connected", cwd: repo }, dataDir);
  await runCodexHook({ hook_event_name: "SessionEnd", session_id: session, reason: "other", cwd: repo }, dataDir);

  assert.deepEqual(outboxFiles(dataDir), []);
});
