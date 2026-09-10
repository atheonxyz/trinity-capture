import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";
import { describeCandidates } from "../src/session-context.js";
import { initRepo, tmpDataDir } from "./helpers/claude-hook-fixture.js";

const commandBin = join(process.cwd(), "claude-code", "dist", "session-context.js");

const timeouts = {
  taskId: "t1", key: "acme/widgets#42", url: "https://github.com/acme/widgets/issues/42",
  title: "Fix the timeouts", status: "todo", priority: "P1", via: "prompt",
};

function runCommand(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [commandBin, ...args], { cwd, env, timeout: 10_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
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

  const run = await runCommand(["the timeouts", dataDir], repo, { ...process.env, CLAUDE_PLUGIN_DATA: dataDir });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /acme\/widgets#42 Fix the timeouts \(todo, https:\/\/github\.com\/acme\/widgets\/issues\/42\) via prompt/);
  assert.match(run.stdout, /trinity-task: <key>/);
  assert.deepEqual(bodies, [{ repo: "github.com/acme/widgets", branch: "main", prompt: "the timeouts" }]);

  const unpaired = await runCommand(["anything", tmpDataDir()], repo, { ...process.env, CLAUDE_PLUGIN_DATA: undefined });
  assert.equal(unpaired.code, 1);
  assert.match(unpaired.stderr, /not paired/);
  assert.equal(bodies.length, 1);
});

test("the task command is manual-only and passes what was said plus the persistent data directory", () => {
  const command = readFileSync(join(process.cwd(), "claude-code", "commands", "task.md"), "utf8");
  assert.match(command, /^argument-hint: \[what you are working on\]$/m);
  assert.match(command, /^disable-model-invocation: true$/m);
  assert.match(command, /dist\/session-context\.js" "\$ARGUMENTS" "\$\{CLAUDE_PLUGIN_DATA\}"/);
});

test("the printed list carries key, title, status, link and rung, or says nothing matched", () => {
  assert.equal(describeCandidates([]), "Trinity: no task matched this branch or what you said.");
  const text = describeCandidates([timeouts, { ...timeouts, taskId: "t2", key: undefined, url: undefined, title: "Untracked", status: "in_progress", via: "assigned" }]);
  assert.match(text, /^- acme\/widgets#42 Fix the timeouts \(todo, https:\/\/github\.com\/acme\/widgets\/issues\/42\) via prompt$/m);
  assert.match(text, /^- Untracked \(in_progress\) via assigned$/m);
});
