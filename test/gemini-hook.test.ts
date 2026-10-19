import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook-core.js";
import { geminiDataDir, geminiDialect } from "../src/gemini-hook.js";
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
  const dir = mkdtempSync(join(tmpdir(), "trinity-gemini-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@trinity.dev", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@trinity.dev" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

function paired(ingestUrl = "http://127.0.0.1:1/api/v1/ingest/batches"): { dataDir: string; repo: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-gemini-data-"));
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
  return runHook(geminiDialect, event, JSON.stringify({ hook_event_name: event, ...payload }), { ...process.env, TRINITY_CAPTURE_DATA: dataDir });
}

function readEvents(dataDir: string): OutboxEvent[] {
  const dir = join(dataDir, "outbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as OutboxEvent);
}

// Every documented base field plus each event's bodies, so the allowlist is tested against what Gemini actually sends.
function base(repo: string): Record<string, unknown> {
  return { session_id: "gem-1", transcript_path: "/Users/someone/.gemini/tmp/chat.json", cwd: repo, timestamp: "2026-10-19T10:00:00Z", some_future_field: "FUTURE" };
}

test("the dialect reads session_id and cwd, names no vendor turn, and arms on startup or clear", () => {
  assert.equal(geminiDialect.tool, "gemini_cli");
  assert.equal(geminiDialect.sessionId("AfterTool", { session_id: "s1" }), "s1");
  assert.equal(geminiDialect.cwd("AfterTool", { cwd: "/w" }), "/w");
  assert.equal(geminiDialect.vendorTurnId("BeforeAgent", { session_id: "s1", prompt: "p" }), null);
  assert.equal(geminiDialect.isPromptSubmit("BeforeAgent"), true);
  assert.equal(geminiDialect.isSessionStart("SessionStart"), true);
  assert.equal(geminiDialect.isFreshSessionStart?.("SessionStart", { source: "startup" }), true);
  assert.equal(geminiDialect.isFreshSessionStart?.("SessionStart", { source: "clear" }), true);
  assert.equal(geminiDialect.isFreshSessionStart?.("SessionStart", { source: "resume" }), false);
});

test("drains at both ends of a turn and never on SessionEnd, which the CLI does not await", () => {
  assert.equal(geminiDialect.drainInline, true);
  assert.equal(geminiDialect.drainsOn("BeforeAgent"), true);
  assert.equal(geminiDialect.drainsOn("AfterAgent"), true);
  for (const event of ["SessionStart", "AfterTool", "SessionEnd"]) assert.equal(geminiDialect.drainsOn(event), false, event);
});

test("the allowlist per event is the prompt, the reply, tool names and lifecycle fields, nothing else", () => {
  const common = ["hook_event_name", "session_id"];
  const sorted = (event: string) => [...geminiDialect.allow(event)].sort();
  assert.deepEqual(sorted("SessionStart"), [...common, "source"].sort());
  assert.deepEqual(sorted("BeforeAgent"), [...common, "prompt"].sort());
  assert.deepEqual(sorted("AfterTool"), [...common, "tool_name"].sort());
  assert.deepEqual(sorted("AfterAgent"), [...common, "prompt_response", "stop_hook_active"].sort());
  assert.deepEqual(sorted("SessionEnd"), [...common, "reason"].sort());
  assert.deepEqual(sorted("BeforeTool"), common.sort(), "an unhooked event forwards identity alone");
});

test("a whole session is captured under one session id, turns keyed from BeforeAgent, and no body, path or unknown field travels", async () => {
  const { dataDir, repo } = paired();
  const toolBodies = { tool_input: { file_path: "/secret/a.ts", content: "TOOL_BODY" }, tool_response: { llmContent: "TOOL_RESULT" }, mcp_context: { server: "x" } };
  await run("SessionStart", { ...base(repo), source: "startup" }, dataDir);
  await run("BeforeAgent", { ...base(repo), prompt: "first ask" }, dataDir);
  await run("AfterTool", { ...base(repo), tool_name: "read_file", ...toolBodies }, dataDir);
  await run("AfterAgent", { ...base(repo), prompt: "first ask", prompt_response: "first reply", stop_hook_active: false }, dataDir);
  await run("BeforeAgent", { ...base(repo), prompt: "second ask" }, dataDir);
  await run("AfterAgent", { ...base(repo), prompt: "second ask", prompt_response: "second reply", stop_hook_active: false }, dataDir);
  await run("SessionEnd", { ...base(repo), reason: "exit" }, dataDir);

  const events = readEvents(dataDir);
  assert.equal(events.length, 8, "seven hook events plus the synthesized workspace.observed");
  for (const event of events) {
    assert.equal(event.tool, "gemini_cli");
    assert.equal(event.externalSessionId, "gem-1");
    const raw = JSON.stringify(event.payload);
    for (const forbidden of ["TOOL_BODY", "TOOL_RESULT", "tool_input", "tool_response", "mcp_context", "transcript_path", "/secret", "FUTURE", "timestamp", repo]) {
      assert.ok(!raw.includes(forbidden), `${event.kind} must not forward ${forbidden}`);
    }
  }
  const tool = events.find((e) => e.kind === "AfterTool");
  assert.deepEqual(tool?.payload, { hook_event_name: "AfterTool", session_id: "gem-1", tool_name: "read_file" });

  const prompts = events.filter((e) => e.kind === "BeforeAgent");
  const replies = events.filter((e) => e.kind === "AfterAgent");
  const first = prompts.find((e) => e.payload.prompt === "first ask");
  const second = prompts.find((e) => e.payload.prompt === "second ask");
  assert.ok(first?.turnKey && second?.turnKey && first.turnKey !== second.turnKey, "each prompt mints its own turn");
  assert.equal(tool?.turnKey, first.turnKey);
  assert.equal(replies.find((e) => e.payload.prompt_response === "first reply")?.turnKey, first.turnKey);
  assert.equal(replies.find((e) => e.payload.prompt_response === "second reply")?.turnKey, second.turnKey);
  assert.ok(replies.every((e) => !("prompt" in e.payload)), "the reply event does not repeat the prompt");
  assert.equal(events.find((e) => e.kind === "SessionStart")?.turnKey, undefined);
});

test("AfterAgent forwards the final reply whole", async () => {
  const { dataDir, repo } = paired();
  const reply = `Done.\n\n${"line of the final answer\n".repeat(400)}`;
  await run("BeforeAgent", { ...base(repo), prompt: "go" }, dataDir);
  await run("AfterAgent", { ...base(repo), prompt: "go", prompt_response: reply, stop_hook_active: false }, dataDir);
  assert.equal(readEvents(dataDir).find((e) => e.kind === "AfterAgent")?.payload.prompt_response, reply);
});

test("SessionStart and then the first prompt answer task context in Gemini's hookSpecificOutput shape", async () => {
  const { dataDir, repo } = paired("https://ingest.example/api/v1/ingest/batches");
  const answers = [
    Response.json({ route: "project", candidates: [] }),
    Response.json({ route: "project", candidates: [{ taskId: "t1", key: "ENG-7", title: "Add task sync", status: "todo", priority: "P1", via: "prompt" }] }),
  ];
  const restore = stubFetch({ onSessionContext: () => answers.shift() ?? assert.fail("one pull per door") });
  try {
    assert.equal(await run("SessionStart", { ...base(repo), source: "startup" }, dataDir), undefined);
    const output = await run("BeforeAgent", { ...base(repo), prompt: "add task sync" }, dataDir);
    assert.ok(output !== undefined);
    const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.match(parsed.hookSpecificOutput.additionalContext, /ENG-7 "Add task sync" — todo; P1/);
  } finally {
    restore();
  }
  const startOutput = geminiDialect.contextOutput?.("SessionStart", "ctx");
  assert.deepEqual(JSON.parse(startOutput ?? "{}"), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" } });
});

test("SessionEnd appends and sends nothing, while AfterAgent drains", async () => {
  const { dataDir, repo } = paired("https://ingest.example/api/v1/ingest/batches");
  let batches = 0;
  const restore = stubFetch({
    onBatch: (items) => {
      batches++;
      return Response.json({ results: items.map((item) => ({ captureEventId: item.captureEventId, outcome: "retry_later" })) });
    },
  });
  try {
    await run("SessionEnd", { ...base(repo), reason: "exit" }, dataDir);
    assert.equal(batches, 0, "SessionEnd must not drain");
    assert.equal(readEvents(dataDir)[0]?.payload.reason, "exit");
    await run("AfterAgent", { ...base(repo), prompt_response: "r", stop_hook_active: false }, dataDir);
    assert.equal(batches, 1, "AfterAgent drains inline");
  } finally {
    restore();
  }
});

test("an unpaired device writes nothing and the data directory honors its override", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-gemini-data-"));
  await run("SessionStart", { ...base(initRepo()), source: "startup" }, dataDir);
  assert.equal(readEvents(dataDir).length, 0);
  assert.equal(geminiDataDir({ TRINITY_CAPTURE_DATA: "/override" }), "/override");
  assert.match(geminiDataDir({ HOME: process.env.HOME }), /[Tt]rinity[ -][Cc]apture[\\/]gemini$/);
});
