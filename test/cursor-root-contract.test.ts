import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCursorHook } from "../src/cursor-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";

test("Cursor drops every event without exactly one non-empty workspace root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-cursor-root-data-"));
  const repo = mkdtempSync(join(tmpdir(), "trinity-cursor-root-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/cursor-fixture.git"], { cwd: repo });
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/cursor-fixture", aliases: [], route: "project:p1" }],
  });

  const originalCwd = process.cwd();
  process.chdir(repo);
  try {
    for (const workspaceRoots of [[], [""], [repo, repo], "not-an-array"] as const) {
      await runCursorHook(
        "postToolUse",
        JSON.stringify({
          conversation_id: "s1",
          generation_id: "g1",
          hook_event_name: "postToolUse",
          tool_name: "Read",
          tool_use_id: "call-1",
          workspace_roots: workspaceRoots,
        }),
        { ...process.env, TRINITY_CAPTURE_DATA: dataDir },
      );
    }
    await runCursorHook(
      "postToolUse",
      JSON.stringify({
        conversation_id: "s1",
        generation_id: "g1",
        hook_event_name: "postToolUse",
        tool_name: "Read",
        tool_use_id: "call-1",
      }),
      { ...process.env, TRINITY_CAPTURE_DATA: dataDir },
    );
  } finally {
    process.chdir(originalCwd);
  }

  const outbox = join(dataDir, "outbox");
  assert.deepEqual(existsSync(outbox) ? readdirSync(outbox) : [], []);
  const status: unknown = JSON.parse(readFileSync(join(dataDir, "status.json"), "utf8"));
  if (typeof status !== "object" || status === null || !("drops" in status) || !Array.isArray(status.drops)) {
    assert.fail("status has no drops");
  }
  assert.equal(status.drops.length, 5);
});
