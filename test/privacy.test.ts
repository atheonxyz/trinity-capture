import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/claude-hook.js";
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

test("an unmatched repository makes no policy request when the cache is stale", async () => {
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
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  try {
    await runHook("SessionStart", { session_id: "s1", cwd: repo }, dataDir);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(requests, 0);
});
