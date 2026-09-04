import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeDialect } from "../src/claude-hook.js";
import { runHook } from "../src/hook-core.js";
import { saveConfig, savePolicy } from "../src/config.js";

function initRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-privacy-repo-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Trinity Test",
    GIT_AUTHOR_EMAIL: "test@trinity.dev",
    GIT_COMMITTER_NAME: "Trinity Test",
    GIT_COMMITTER_EMAIL: "test@trinity.dev",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

test("an unmatched repository may refresh policy but sends no session events", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-privacy-data-"));
  saveConfig(dataDir, { token: "tok", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "stale",
    fetchedAt: 0,
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/work", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:personal/private.git");
  let policyRequests = 0;
  let batchRequests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith("/policy")) policyRequests += 1;
    if (String(url).endsWith("/batches")) batchRequests += 1;
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  try {
    await runHook(claudeCodeDialect, "SessionStart", JSON.stringify({ session_id: "s1", cwd: repo }), {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
    });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(policyRequests, 1);
  assert.equal(batchRequests, 0);
  assert.equal(existsSync(join(dataDir, "outbox")), false);
});
