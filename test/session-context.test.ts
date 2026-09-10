import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";
import { claudeCodeDialect } from "../src/claude-hook.js";
import { renderSessionContext, runHook } from "../src/hook-core.js";
import type { Dialect } from "../src/hook-core.js";
import { initRepo, outboxFiles, sessionStartInput, stubFetch, tmpDataDir } from "./helpers/claude-hook-fixture.js";

// The real dialect minus its inline budget: that budget is wall-clock, and a
// loaded suite can spend it on git before the pull, which is the pull's own
// fail-open behaviour rather than what these tests are about.
const contextDialect: Dialect = { ...claudeCodeDialect, drainInline: false };

function run(event: string, input: Record<string, unknown>, dataDir: string): Promise<string | undefined> {
  return runHook(contextDialect, event, JSON.stringify(input), { ...process.env, CLAUDE_PLUGIN_DATA: dataDir });
}

function pairedDataDir(): string {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  const policy: Policy = {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  };
  savePolicy(dataDir, policy);
  return dataDir;
}

const timeouts = {
  taskId: "t1", key: "acme/widgets#42", url: "https://github.com/acme/widgets/issues/42",
  title: "Fix the timeouts", status: "todo", priority: "P1", via: "branch",
};

interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

function parseOutput(output: string | undefined): HookOutput {
  assert.ok(output !== undefined, "the hook should have answered with context");
  return JSON.parse(output) as HookOutput;
}

test("SessionStart asks once with the branch and hands Claude the task as context", async () => {
  const dataDir = pairedDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");
  const asked: Record<string, unknown>[] = [];
  const restore = stubFetch({
    onSessionContext: (body, init) => {
      asked.push(body);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer tok");
      return Response.json({ route: "project", projectId: "p1", candidates: [timeouts] });
    },
  });
  try {
    const output = await run("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);
    const parsed = parseOutput(output);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /acme\/widgets#42 "Fix the timeouts" \(todo\)/);
    assert.deepEqual(asked, [{ repo: "github.com/acme/widgets", branch: "main" }]);
    assert.equal(outboxFiles(dataDir).length, 2, "capture is unchanged by the pull");

    // A settled session never asks again, prompt or not.
    const prompt = await run("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p1", prompt: "fix the timeouts" }, dataDir);
    assert.equal(prompt, undefined);
    assert.equal(asked.length, 1);
  } finally {
    restore();
  }
});

test("when the branch names nothing, the first prompt asks once more and later prompts never do", async () => {
  const dataDir = pairedDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");
  const asked: Record<string, unknown>[] = [];
  const restore = stubFetch({
    onSessionContext: (body) => {
      asked.push(body);
      const candidates = typeof body.prompt === "string" ? [timeouts, { ...timeouts, taskId: "t2", key: "ENG-7", title: "Add task sync", status: "in_progress" }] : [];
      return Response.json({ route: "project", projectId: "p1", candidates });
    },
  });
  try {
    assert.equal(await run("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir), undefined);
    const first = await run("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p1", prompt: "fix the timeouts" }, dataDir);
    const parsed = parseOutput(first);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(parsed.hookSpecificOutput.additionalContext, /one of acme\/widgets#42 "Fix the timeouts" \(todo\); ENG-7 "Add task sync" \(in_progress\)/);
    assert.deepEqual(asked, [
      { repo: "github.com/acme/widgets", branch: "main" },
      { repo: "github.com/acme/widgets", branch: "main", prompt: "fix the timeouts" },
    ]);

    const second = await run("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p2", prompt: "now the tests" }, dataDir);
    assert.equal(second, undefined);
    assert.equal(asked.length, 2, "one prompt-time pull per session, whatever it answered");
  } finally {
    restore();
  }
});

test("a branch switched mid-session asks again for the new branch, once", async () => {
  const dataDir = pairedDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");
  const asked: Record<string, unknown>[] = [];
  const restore = stubFetch({
    onSessionContext: (body) => {
      asked.push(body);
      return Response.json({ route: "project", projectId: "p1", candidates: [timeouts] });
    },
  });
  try {
    parseOutput(await run("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir));
    assert.equal(await run("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p1", prompt: "start" }, dataDir), undefined);

    execFileSync("git", ["checkout", "-q", "-b", "fix/issue-43"], { cwd: repo });
    const switched = await run("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p2", prompt: "now the other one" }, dataDir);
    assert.equal(parseOutput(switched).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(await run("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p3", prompt: "and on" }, dataDir), undefined);
    assert.deepEqual(asked, [
      { repo: "github.com/acme/widgets", branch: "main" },
      { repo: "github.com/acme/widgets", branch: "fix/issue-43", prompt: "now the other one" },
    ]);
  } finally {
    restore();
  }
});

test("a pull that fails leaves capture untouched and lets the first prompt try once", async () => {
  const dataDir = pairedDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");
  let calls = 0;
  const restore = stubFetch({
    onSessionContext: () => {
      calls++;
      throw new Error("stub: unreachable by design");
    },
  });
  try {
    assert.equal(await run("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir), undefined);
    assert.equal(outboxFiles(dataDir).length, 2);
    assert.equal(await run("UserPromptSubmit", { session_id: "s1", cwd: repo, prompt_id: "p1", prompt: "hello" }, dataDir), undefined);
    assert.equal(outboxFiles(dataDir).length, 3);
    assert.equal(calls, 2);
    assert.ok(existsSync(join(dataDir, "session-context")), "the marker keeps later prompts from asking again");
    assert.equal(readdirSync(join(dataDir, "session-context")).length, 1);
  } finally {
    restore();
  }
});

test("a host with no context door never pulls at all", async () => {
  const dataDir = pairedDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");
  let calls = 0;
  const restore = stubFetch({
    onSessionContext: () => {
      calls++;
      return Response.json({ route: "project", candidates: [timeouts] });
    },
  });
  try {
    const { contextOutput: _door, ...silent } = contextDialect;
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
    assert.equal(await runHook(silent, "SessionStart", JSON.stringify({ ...sessionStartInput, cwd: repo }), env), undefined);
    assert.equal(await runHook(silent, "UserPromptSubmit", JSON.stringify({ session_id: "s1", cwd: repo, prompt_id: "p1", prompt: "hello" }), env), undefined);
    assert.equal(calls, 0);
    assert.equal(outboxFiles(dataDir).length, 3, "capture is the same with or without the door");
  } finally {
    restore();
  }
});

test("the context line names at most three candidates and keeps titles to one short line", () => {
  assert.equal(renderSessionContext([]), null);
  const one = renderSessionContext([{ ...timeouts, title: "Fix   the\n timeouts" }]);
  assert.equal(one, 'Trinity: this session likely relates to acme/widgets#42 "Fix the timeouts" (todo). If it is a different task, say "trinity-task: <key>" once.');
  const many = renderSessionContext([1, 2, 3, 4].map((n) => ({ ...timeouts, taskId: `t${n}`, key: `ENG-${n}`, title: "x".repeat(200) })));
  assert.ok(many !== null);
  assert.equal((many.match(/ENG-\d/g) ?? []).length, 3);
  assert.ok(many.includes(`"${"x".repeat(80)}"`), "titles are cut to eighty characters");
  const untracked = renderSessionContext([{ ...timeouts, key: undefined }]);
  assert.match(untracked ?? "", /relates to "Fix the timeouts" \(todo\)/);
});
