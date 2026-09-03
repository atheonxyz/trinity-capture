import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, savePolicy } from "../src/config.js";
import { initRepo, outboxFiles } from "./helpers/claude-hook-fixture.js";

const hook = join(process.cwd(), "claude-code", "dist", "claude-hook.js");

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "trinity-suppression-switch-"));
  const repo = initRepo("git@github.com:acme/widgets.git");
  const dirs = {
    inline: join(root, "trinity-inline"),
    cli: join(root, "trinity-capture-trinity"),
    alpha: join(root, "trinity-alpha"),
    beta: join(root, "trinity-beta"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ results: [] }));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    root,
    dirs,
    requests,
    pair(dataDir: string, deviceId = "fixture-device") {
      saveConfig(dataDir, {
        token: `token-${deviceId}`,
        deviceId,
        ingestUrl: `http://127.0.0.1:${address.port}/api/v1/ingest/batches`,
      });
      savePolicy(dataDir, {
        etag: "fixture-policy",
        fetchedAt: Date.now(),
        ttlSeconds: 900,
        captureLevel: "metadata",
        workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:fixture" }],
      });
    },
    run(dataDir: string, event: string, payload: Record<string, unknown>) {
      return new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, [hook, event], {
          cwd: repo,
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
          timeout: 5_000,
        }, (error) => error ? reject(error) : resolve());
        assert.ok(child.stdin);
        child.stdin.end(JSON.stringify({ session_id: "setup", cwd: repo, hook_event_name: event, ...payload }));
      });
    },
  };
}

for (const prompt of ["[Trinity setup]\nSETUP_SECRET", "/trinity:connect SETUP_SECRET"]) {
  for (const [source, paired] of [
    ["inline", "cli"],
    ["inline", "inline"],
    ["cli", "cli"],
    ["alpha", "beta"],
  ] as const) {
    test(`${prompt.split("\n")[0]} stays suppressed when setup starts on ${source} and pairs ${paired}`, async (t) => {
      const f = await fixture(t);
      await f.run(f.dirs[source], "UserPromptSubmit", { prompt });
      f.pair(f.dirs[paired]);

      for (const host of [source, paired]) {
        await f.run(f.dirs[host], "PostToolUse", { tool_name: "Bash", tool_use_id: "setup-command" });
        await f.run(f.dirs[host], "Stop", { last_assistant_message: "SETUP_SECRET" });
        await f.run(f.dirs[host], "SessionEnd", { reason: "other" });
      }

      assert.deepEqual(f.requests, []);
      for (const dir of Object.values(f.dirs)) assert.deepEqual(outboxFiles(dir), []);
    });
  }
}

test("a new session still captures after another surface paired during setup", async (t) => {
  const f = await fixture(t);
  await f.run(f.dirs.inline, "UserPromptSubmit", { prompt: "[Trinity setup]\nSETUP_SECRET" });
  f.pair(f.dirs.cli);

  await f.run(f.dirs.inline, "UserPromptSubmit", { session_id: "work", prompt: "ordinary work" });

  assert.deepEqual(f.requests, ["/api/v1/ingest/batches"]);
  assert.equal(outboxFiles(f.dirs.cli).length, 1);
  assert.deepEqual(outboxFiles(f.dirs.inline), []);
});

test("an unreadable sibling suppression marker fails closed", async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.dirs.inline, "suppressed-sessions", "claude_code-setup"), { recursive: true });
  f.pair(f.dirs.cli);

  await f.run(f.dirs.inline, "Stop", { last_assistant_message: "SETUP_SECRET" });

  assert.deepEqual(f.requests, []);
  assert.deepEqual(outboxFiles(f.dirs.cli), []);
});

test("another plugin's marker does not suppress Claude capture", async (t) => {
  const f = await fixture(t);
  const other = join(f.root, "other-plugin", "suppressed-sessions");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "claude_code-setup"), "");
  f.pair(f.dirs.cli);

  await f.run(f.dirs.inline, "UserPromptSubmit", { prompt: "ordinary work" });

  assert.deepEqual(f.requests, ["/api/v1/ingest/batches"]);
  assert.equal(outboxFiles(f.dirs.cli).length, 1);
});

test("a prefixed non-directory does not suppress Claude capture", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "trinity-capture.log"), "not a plugin directory");
  f.pair(f.dirs.cli);

  await f.run(f.dirs.cli, "UserPromptSubmit", { prompt: "ordinary work" });

  assert.deepEqual(f.requests, ["/api/v1/ingest/batches"]);
  assert.equal(outboxFiles(f.dirs.cli).length, 1);
});

test("a differently paired Claude sibling does not suppress capture", async (t) => {
  const f = await fixture(t);
  await f.run(f.dirs.inline, "UserPromptSubmit", { prompt: "[Trinity setup]\nSETUP_SECRET" });
  f.pair(f.dirs.inline, "other-device");
  f.pair(f.dirs.cli);

  await f.run(f.dirs.cli, "UserPromptSubmit", { prompt: "ordinary work" });

  assert.deepEqual(f.requests, ["/api/v1/ingest/batches"]);
  assert.equal(outboxFiles(f.dirs.cli).length, 1);
  assert.deepEqual(outboxFiles(f.dirs.inline), []);
});
