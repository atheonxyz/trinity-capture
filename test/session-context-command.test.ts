import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";
import { describeCandidates } from "../src/session-context.js";
import { initRepo, tmpDataDir } from "./helpers/claude-hook-fixture.js";

const commandBin = join(process.cwd(), "claude-code", "dist", "session-context.js");
const command = readFileSync(join(process.cwd(), "claude-code", "commands", "task.md"), "utf8");

const timeouts = {
  taskId: "t1", key: "acme/widgets#42", url: "https://github.com/acme/widgets/issues/42",
  title: "Fix the timeouts", status: "todo", priority: "P1", via: "prompt",
};

function runProcess(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd, env, timeout: 10_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
    child.stdin!.end(input);
  });
}

function runCommand(input: string, dataDir: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess(process.execPath, [commandBin, dataDir], cwd, env, input);
}

test("/trinity:task pulls with the branch and what the person said, and prints the tasks", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      assert.equal(request.url, "/api/v1/ingest/session-context");
      assert.equal(request.headers.authorization, "Bearer tok");
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ route: "project", projectId: "p1", candidates: [timeouts] }));
    });
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const dataDir = tmpDataDir();
  saveConfig(dataDir, { token: "tok", deviceId: "dev1", ingestUrl: `http://127.0.0.1:${address.port}/api/v1/ingest/batches` });
  savePolicy(dataDir, {
    etag: "e1", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  const run = await runCommand(JSON.stringify({ prompt: "the timeouts" }), dataDir, repo, { ...process.env, CLAUDE_PLUGIN_DATA: dataDir });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /acme\/widgets#42 Fix the timeouts \(todo, https:\/\/github\.com\/acme\/widgets\/issues\/42\) via prompt/);
  assert.match(run.stdout, /trinity-task: <key>/);
  assert.deepEqual(bodies, [{ repo: "github.com/acme/widgets", branch: "main", prompt: "the timeouts" }]);

  const unpaired = await runCommand(JSON.stringify({ prompt: "anything" }), tmpDataDir(), repo, { ...process.env, CLAUDE_PLUGIN_DATA: undefined });
  assert.equal(unpaired.code, 1);
  assert.match(unpaired.stderr, /not paired/);
  assert.equal(bodies.length, 1);

  // Execute the documented shell transport, not just execFile's already-safe argv.
  const template = command.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  assert.ok(template);
  const sentinel = join(repo, "shell-expanded");
  const descriptions = [
    'fix "new task" matching',
    `literal 'quotes', $TRINITY_TASK_TEST_VALUE, $(touch "${sentinel}"), and \`touch "${sentinel}"\``,
    `first line\nTRINITY_TASK_INPUT\ntouch "${sentinel}"\n# last line with \\ and\ta tab`,
    "",
  ];
  for (const prompt of descriptions) {
    const input = JSON.stringify({ prompt });
    assert.doesNotMatch(input, /[\r\n]/);
    const script = template.replace("<task-input-json>", () => input);
    const result = await runProcess("bash", ["-c", script], repo, {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: join(process.cwd(), "claude-code"),
      CLAUDE_PLUGIN_DATA: dataDir,
      TRINITY_TASK_TEST_VALUE: "must not expand",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(bodies.at(-1), {
      repo: "github.com/acme/widgets", branch: "main", ...(prompt ? { prompt } : {}),
    });
    assert.equal(existsSync(sentinel), false, "task text must never execute as shell code");
  }

  const fallback = await runCommand(JSON.stringify({ prompt: "use the saved pairing" }), dataDir, repo, {
    ...process.env, CLAUDE_PLUGIN_DATA: undefined,
  });
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.equal(bodies.at(-1)?.prompt, "use the saved pairing");
});

test("the task command is manual-only and keeps free text out of automatic shell execution", () => {
  assert.match(command, /^argument-hint: \[what you are working on\]$/m);
  assert.match(command, /^disable-model-invocation: true$/m);
  assert.doesNotMatch(command, /!`/);
  const template = command.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  assert.ok(template);
  assert.doesNotMatch(template, /\$ARGUMENTS/);
  assert.match(command, /single-line JSON object/);
  assert.match(command, /^\$ARGUMENTS$/m);
});

test("the task helper rejects missing or malformed JSON without treating it as task text", async () => {
  const dataDir = tmpDataDir();
  for (const input of ["", "not JSON", "null", "[]", "{}", '{"prompt":42}']) {
    const result = await runCommand(input, dataDir, process.cwd(), { ...process.env, CLAUDE_PLUGIN_DATA: dataDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /task input must be a JSON object with a string prompt on stdin/);
    assert.equal(result.stdout, "");
  }
});

test("the printed list carries key, title, status, link and rung, or says nothing matched", () => {
  assert.equal(describeCandidates([]), "Trinity: no task matched this branch or what you said.");
  const text = describeCandidates([timeouts, { ...timeouts, taskId: "t2", key: undefined, url: undefined, title: "Untracked", status: "in_progress", via: "assigned" }]);
  assert.match(text, /^- acme\/widgets#42 Fix the timeouts \(todo, https:\/\/github\.com\/acme\/widgets\/issues\/42\) via prompt$/m);
  assert.match(text, /^- Untracked \(in_progress\) via assigned$/m);
});
