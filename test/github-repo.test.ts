import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitHubRepository } from "../src/github-repo.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-github-repo-"));
}

test("GitHub repository resolver caches by hash, not repository name", async () => {
  const dataDir = tmpDataDir();
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;
  let calls = 0;
  process.env.PATH = dataDir;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ id: 123 });
  }) as typeof fetch;
  try {
    assert.equal(await resolveGitHubRepository(dataDir, "person/private-repo", 100), 123);
    assert.equal(await resolveGitHubRepository(dataDir, "person/private-repo", 100), 123);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
  }

  assert.equal(calls, 1);
  const cache = readFileSync(join(dataDir, "github-repositories.json"), "utf8");
  assert.doesNotMatch(cache, /person|private-repo/);
});

test("live GitHub resolver maps the old Trinity repo name to the selected immutable ID", {
  skip: process.env.TRINITY_LIVE_GITHUB_RENAME === "1" ? false : "set TRINITY_LIVE_GITHUB_RENAME=1 to run",
}, () => {
  const output = execFileSync("gh", ["api", "--hostname", "github.com", "repos/atheonxyz/trinity-v2", "--jq", ".id"], {
    encoding: "utf8",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1_500,
  }).trim();
  assert.equal(Number(output), 1_309_924_480);
});
