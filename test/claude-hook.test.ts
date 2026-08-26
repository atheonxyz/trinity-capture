import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";
import { initRepo, outboxFiles, runClaudeHook, sessionStartInput, tmpDataDir } from "./helpers/claude-hook-fixture.js";

test("SessionStart in an allowlisted repo appends the session event and workspace.observed", async () => {
  const dataDir = tmpDataDir();
  // Unreachable on purpose (TEST-NET port 0): drain must fail fast and
  // leave the outbox intact, so the assertion below is about appendEvent,
  // not about a real batch round-trip.
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  const policy: Policy = {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  };
  savePolicy(dataDir, policy);

  const repo = initRepo("git@github.com:acme/widgets.git");

  await runClaudeHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);

  assert.equal(outboxFiles(dataDir).length, 2);
});

test("the same fixture with no config file appends nothing and never throws", async () => {
  const dataDir = tmpDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");

  await assert.doesNotReject(runClaudeHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir));

  assert.equal(outboxFiles(dataDir).length, 0);
});

test("PostToolUse forwards only allowlisted metadata — no tool bodies under any name, no local paths", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  // The real captured PostToolUse shape (claude 2.1.241: tool_response, not
  // tool_output) plus a field the vendor has never sent — the allowlist must
  // drop what it has not heard of, not just what it can name.
  await runClaudeHook(
    "PostToolUse",
    {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      transcript_path: "/Users/dev/.claude/transcripts/s1.jsonl",
      cwd: repo,
      prompt_id: "p1",
      permission_mode: "default",
      tool_name: "Bash",
      tool_use_id: "tu1",
      duration_ms: 2,
      tool_input: { command: "cat ~/.ssh/id_rsa" },
      tool_response: { stdout: "-----BEGIN OPENSSH PRIVATE KEY-----" },
      tool_output: "LEGACY_BODY_FIELD_MUST_NOT_FORWARD",
      some_future_vendor_field: "FUTURE_BODY_MUST_NOT_FORWARD",
    },
    dataDir,
  );

  const files = outboxFiles(dataDir);
  assert.equal(files.length, 1);
  const raw = readFileSync(join(dataDir, "outbox", files[0]), "utf8");
  assert.doesNotMatch(raw, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(raw, /id_rsa/);
  assert.doesNotMatch(raw, /LEGACY_BODY_FIELD_MUST_NOT_FORWARD/);
  assert.doesNotMatch(raw, /FUTURE_BODY_MUST_NOT_FORWARD/);
  assert.doesNotMatch(raw, /transcripts/);
  assert.match(raw, /"tool_name":"Bash"/);
  assert.match(raw, /"tool_use_id":"tu1"/);

  const parsed = JSON.parse(raw) as { repoCwd: string; payload: Record<string, unknown> };
  assert.equal(parsed.repoCwd, ".", "cwd at the repo root should be reported as '.', not an absolute or ../-laden path");
  assert.ok(!("cwd" in parsed.payload), "the absolute cwd must never ride the payload");
  assert.ok(!("tool_input" in parsed.payload) && !("tool_response" in parsed.payload));
});

test("UserPromptSubmit mints a turnKey the following events carry until the next prompt", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  interface OutboxEvent {
    kind: string;
    turnKey?: string;
    payload: { prompt?: string };
  }
  const readEvents = (): OutboxEvent[] =>
    outboxFiles(dataDir).map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as OutboxEvent);

  await runClaudeHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);
  await runClaudeHook("UserPromptSubmit", { session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: repo, prompt_id: "p1", prompt: "one" }, dataDir);
  await runClaudeHook("PostToolUse", { session_id: "s1", hook_event_name: "PostToolUse", cwd: repo, prompt_id: "p1", tool_name: "Read", tool_use_id: "tu1" }, dataDir);
  await runClaudeHook("Stop", { session_id: "s1", hook_event_name: "Stop", cwd: repo, prompt_id: "p1", last_assistant_message: "done" }, dataDir);
  await runClaudeHook("UserPromptSubmit", { session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: repo, prompt_id: "p2", prompt: "two" }, dataDir);
  await runClaudeHook("SessionEnd", { session_id: "s1", hook_event_name: "SessionEnd", cwd: repo, prompt_id: "p2", reason: "other" }, dataDir);

  const events = readEvents();
  const byKind = (kind: string) => events.filter((e) => e.kind === kind);

  for (const e of [...byKind("SessionStart"), ...byKind("workspace.observed")]) {
    assert.equal(e.turnKey, undefined, `${e.kind} must carry no turnKey`);
  }
  const prompt1 = events.find((e) => e.kind === "UserPromptSubmit" && e.payload.prompt === "one");
  const prompt2 = events.find((e) => e.kind === "UserPromptSubmit" && e.payload.prompt === "two");
  assert.ok(prompt1?.turnKey && prompt2?.turnKey, "each prompt mints a turnKey");
  assert.notEqual(prompt1.turnKey, prompt2.turnKey, "a new prompt replaces the key");
  assert.equal(byKind("PostToolUse")[0].turnKey, prompt1.turnKey);
  assert.equal(byKind("Stop")[0].turnKey, prompt1.turnKey);
  assert.equal(byKind("SessionEnd")[0].turnKey, prompt2.turnKey, "SessionEnd still carries the latest prompt's key");
});

test("out-of-order delivery still correlates by the vendor's own turn id, not arrival order", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  interface OutboxEvent {
    kind: string;
    turnKey?: string;
    payload: { prompt?: string; tool_use_id?: string };
  }
  const readEvents = (): OutboxEvent[] =>
    outboxFiles(dataDir).map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as OutboxEvent);

  // Two prompts mint two independent keys (K1 for p1, K2 for p2); a
  // PostToolUse for the FIRST prompt (p1) arrives only after the SECOND
  // prompt has already been submitted — it must still resolve K1, never K2
  // or whatever "latest" happens to hold.
  await runClaudeHook("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p1", prompt: "one" }, dataDir);
  await runClaudeHook("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p2", prompt: "two" }, dataDir);
  await runClaudeHook("PostToolUse", { session_id: "s1", cwd: repo, prompt_id: "p1", tool_name: "Read", tool_use_id: "late-for-p1" }, dataDir);

  const events = readEvents();
  const k1 = events.find((e) => e.payload.prompt === "one")?.turnKey;
  const k2 = events.find((e) => e.payload.prompt === "two")?.turnKey;
  const late = events.find((e) => e.payload.tool_use_id === "late-for-p1")?.turnKey;

  assert.ok(k1 && k2 && k1 !== k2);
  assert.equal(late, k1, "an out-of-order PostToolUse for p1 must resolve K1, not K2");
});
