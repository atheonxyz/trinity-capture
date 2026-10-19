import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook-core.js";
import { copilotDataDir, copilotDialect } from "../src/copilot-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";
import { stubFetch } from "./helpers/claude-hook-fixture.js";

interface OutboxEvent {
  tool: string;
  kind: string;
  externalSessionId: string;
  turnKey?: string;
  payload: Record<string, unknown>;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-copilot-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@trinity.dev", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@trinity.dev" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

function paired(ingestUrl = "http://127.0.0.1:1/api/v1/ingest/batches"): { dataDir: string; repo: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-copilot-data-"));
  saveConfig(dataDir, { token: "tok", ingestUrl, deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  return { dataDir, repo: initRepo() };
}

function run(event: string, payload: Record<string, unknown>, dataDir: string): Promise<string | undefined> {
  return runHook(copilotDialect, event, JSON.stringify(payload), { ...process.env, TRINITY_CAPTURE_DATA: dataDir });
}

function readEvents(dataDir: string): OutboxEvent[] {
  const dir = join(dataDir, "outbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as OutboxEvent);
}

// The camelCase base fields every documented Copilot event carries, plus a field no version has sent yet.
function base(repo: string): Record<string, unknown> {
  return { sessionId: "cop-1", timestamp: 1_760_868_000_000, cwd: repo, someFutureField: "FUTURE" };
}

test("the dialect reads sessionId and cwd, names no vendor turn, and arms on startup or new but not resume", () => {
  assert.equal(copilotDialect.tool, "copilot_cli");
  assert.equal(copilotDialect.sessionId("postToolUse", { sessionId: "s1", session_id: "other" }), "s1");
  assert.equal(copilotDialect.cwd("postToolUse", { cwd: "/w" }), "/w");
  assert.equal(copilotDialect.vendorTurnId("userPromptSubmitted", { sessionId: "s1" }), null);
  assert.equal(copilotDialect.isPromptSubmit("userPromptSubmitted"), true);
  assert.equal(copilotDialect.isSessionStart("sessionStart"), true);
  assert.equal(copilotDialect.isFreshSessionStart?.("sessionStart", { source: "startup" }), true);
  assert.equal(copilotDialect.isFreshSessionStart?.("sessionStart", { source: "new" }), true);
  assert.equal(copilotDialect.isFreshSessionStart?.("sessionStart", { source: "resume" }), false);
});

test("drains at a prompt and at agentStop, never on sessionEnd", () => {
  assert.equal(copilotDialect.drainInline, true);
  assert.equal(copilotDialect.drainsOn("userPromptSubmitted"), true);
  assert.equal(copilotDialect.drainsOn("agentStop"), true);
  for (const event of ["sessionStart", "postToolUse", "sessionEnd"]) assert.equal(copilotDialect.drainsOn(event), false, event);
});

test("the allowlist per event is the prompt, tool names and lifecycle fields, nothing else", () => {
  const sorted = (event: string) => [...copilotDialect.allow(event)].sort();
  assert.deepEqual(sorted("sessionStart"), ["sessionId", "source"]);
  assert.deepEqual(sorted("userPromptSubmitted"), ["prompt", "sessionId"]);
  assert.deepEqual(sorted("postToolUse"), ["sessionId", "toolName"]);
  assert.deepEqual(sorted("agentStop"), ["sessionId", "stopReason", "stop_hook_active"]);
  assert.deepEqual(sorted("sessionEnd"), ["reason", "sessionId"]);
  assert.deepEqual(sorted("preToolUse"), ["sessionId"], "an unhooked event forwards identity alone");
});

test("a whole session is captured under one session id, turns keyed from the prompt, and no body, path or transcript travels", async () => {
  const { dataDir, repo } = paired();
  const transcript = join(mkdtempSync(join(tmpdir(), "trinity-copilot-transcript-")), "events.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant.message", data: { content: "TRANSCRIPT_REPLY" } })}\n`);
  await run("sessionStart", { ...base(repo), source: "new", initialPrompt: "INITIAL_PROMPT" }, dataDir);
  await run("userPromptSubmitted", { ...base(repo), prompt: "first ask" }, dataDir);
  await run("postToolUse", { ...base(repo), toolName: "bash", toolArgs: { command: "cat /secret" }, toolResult: { resultType: "success", textResultForLlm: "TOOL_RESULT" } }, dataDir);
  await run("agentStop", { ...base(repo), transcriptPath: transcript, stopReason: "end_turn", stop_hook_active: false }, dataDir);
  await run("userPromptSubmitted", { ...base(repo), prompt: "second ask" }, dataDir);
  await run("agentStop", { ...base(repo), transcriptPath: transcript, stopReason: "end_turn", stop_hook_active: false }, dataDir);
  await run("sessionEnd", { ...base(repo), reason: "user_exit" }, dataDir);

  const events = readEvents(dataDir);
  assert.equal(events.length, 8, "seven hook events plus the synthesized workspace.observed");
  for (const event of events) {
    assert.equal(event.tool, "copilot_cli");
    assert.equal(event.externalSessionId, "cop-1");
    const raw = JSON.stringify(event.payload);
    for (const forbidden of ["TRANSCRIPT_REPLY", "TOOL_RESULT", "/secret", "toolArgs", "toolResult", "transcriptPath", transcript, "INITIAL_PROMPT", "FUTURE", "timestamp", repo]) {
      assert.ok(!raw.includes(forbidden), `${event.kind} must not forward ${forbidden}`);
    }
  }
  assert.deepEqual(events.find((e) => e.kind === "postToolUse")?.payload, { sessionId: "cop-1", toolName: "bash" });
  assert.deepEqual(events.find((e) => e.kind === "sessionEnd")?.payload, { sessionId: "cop-1", reason: "user_exit" });

  const first = events.find((e) => e.payload.prompt === "first ask");
  const second = events.find((e) => e.payload.prompt === "second ask");
  assert.ok(first?.turnKey && second?.turnKey && first.turnKey !== second.turnKey);
  assert.equal(events.find((e) => e.kind === "postToolUse")?.turnKey, first.turnKey);
  const stops = events.filter((e) => e.kind === "agentStop");
  assert.deepEqual(stops.map((e) => e.turnKey).sort(), [first.turnKey, second.turnKey].sort());
  for (const stop of stops) assert.deepEqual(stop.payload, { sessionId: "cop-1", stopReason: "end_turn", stop_hook_active: false });
});

test("sessionStart answers task context as top-level additionalContext, and a prompt makes no pull its output could not deliver", async () => {
  const { dataDir, repo } = paired("https://ingest.example/api/v1/ingest/batches");
  let calls = 0;
  const restore = stubFetch({
    onSessionContext: () => {
      calls++;
      return Response.json({ route: "project", candidates: [{ taskId: "t1", key: "ENG-7", title: "Add task sync", status: "todo", priority: "P1", via: "branch" }] });
    },
  });
  try {
    const output = await run("sessionStart", { ...base(repo), source: "startup" }, dataDir);
    assert.ok(output !== undefined);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["additionalContext"]);
    assert.match(String(parsed.additionalContext), /ENG-7 "Add task sync" — todo; P1/);
    assert.equal(await run("userPromptSubmitted", { ...base(repo), prompt: "something else" }, dataDir), undefined);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("sessionEnd appends and sends nothing, while agentStop drains", async () => {
  const { dataDir, repo } = paired("https://ingest.example/api/v1/ingest/batches");
  let batches = 0;
  const restore = stubFetch({
    onBatch: (items) => {
      batches++;
      return Response.json({ results: items.map((item) => ({ captureEventId: item.captureEventId, outcome: "retry_later" })) });
    },
  });
  try {
    await run("sessionEnd", { ...base(repo), reason: "complete" }, dataDir);
    assert.equal(batches, 0, "sessionEnd must not drain");
    await run("agentStop", { ...base(repo), stopReason: "end_turn", stop_hook_active: false }, dataDir);
    assert.equal(batches, 1, "agentStop drains inline");
  } finally {
    restore();
  }
});

test("an unpaired device writes nothing and the data directory honors its override", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-copilot-data-"));
  await run("sessionStart", { ...base(initRepo()), source: "startup" }, dataDir);
  assert.equal(readEvents(dataDir).length, 0);
  assert.equal(copilotDataDir({ TRINITY_CAPTURE_DATA: "/override" }), "/override");
  assert.match(copilotDataDir({ HOME: process.env.HOME }), /[Tt]rinity[ -][Cc]apture[\\/]copilot$/);
});
