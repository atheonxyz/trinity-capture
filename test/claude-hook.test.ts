import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/claude-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-data-"));
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Trinity Test",
    GIT_AUTHOR_EMAIL: "test@trinity.dev",
    GIT_COMMITTER_NAME: "Trinity Test",
    GIT_COMMITTER_EMAIL: "test@trinity.dev",
  };
}

function initRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

function outboxFiles(dataDir: string): string[] {
  const dir = join(dataDir, "outbox");
  return existsSync(dir) ? readdirSync(dir) : [];
}

const sessionStartInput = {
  session_id: "s1",
  hook_event_name: "SessionStart",
  transcript_path: "/Users/dev/.claude/transcripts/s1.jsonl",
  model: "claude-fable-5",
};

test("SessionStart in an allowlisted repo appends the session event and workspace.observed", async () => {
  const dataDir = tmpDataDir();
  // Unreachable on purpose (TEST-NET port 0): drain must fail fast and
  // leave the outbox intact, so the assertion below is about appendEvent,
  // not about a real batch round-trip.
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  const policy: Policy = {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  };
  savePolicy(dataDir, policy);

  const repo = initRepo("git@github.com:acme/widgets.git");

  await runHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);

  assert.equal(outboxFiles(dataDir).length, 2);
});

test("the same fixture with no config file appends nothing and never throws", async () => {
  const dataDir = tmpDataDir();
  const repo = initRepo("git@github.com:acme/widgets.git");

  await assert.doesNotReject(runHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir));

  assert.equal(outboxFiles(dataDir).length, 0);
});

test("PostToolUse strips tool_input/tool_output but keeps tool_name/tool_use_id", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
  const repo = initRepo("git@github.com:acme/widgets.git");

  await runHook(
    "PostToolUse",
    {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      cwd: repo,
      prompt_id: "p1",
      tool_name: "Bash",
      tool_use_id: "tu1",
      tool_input: { command: "cat ~/.ssh/id_rsa" },
      tool_output: "-----BEGIN OPENSSH PRIVATE KEY-----",
    },
    dataDir,
  );

  const files = outboxFiles(dataDir);
  assert.equal(files.length, 1);
  const raw = readFileSync(join(dataDir, "outbox", files[0]), "utf8");
  assert.doesNotMatch(raw, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(raw, /id_rsa/);
  assert.match(raw, /"tool_name":"Bash"/);
  assert.match(raw, /"tool_use_id":"tu1"/);

  const parsed = JSON.parse(raw) as { repoCwd: string };
  assert.equal(parsed.repoCwd, ".", "cwd at the repo root should be reported as '.', not an absolute or ../-laden path");
});
