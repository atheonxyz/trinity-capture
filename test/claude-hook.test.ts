import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/claude-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";

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

function saveDevicePolicy(dataDir: string, fetchedAt: number): void {
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: fetchedAt === 0 ? "old" : "e1",
    fetchedAt,
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
}

function stubFetch(opts: {
  onPolicy?: () => Response;
  onBatch?: (items: { captureEventId: string }[]) => Response;
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/policy")) {
      if (!opts.onPolicy) throw new Error(`unexpected policy fetch: ${href}`);
      return opts.onPolicy();
    }
    if (href.endsWith("/batches")) {
      const body = JSON.parse(String(init?.body)) as { items: { captureEventId: string }[] };
      if (opts.onBatch) return opts.onBatch(body.items);
      return new Response(
        JSON.stringify({ results: body.items.map((i) => ({ captureEventId: i.captureEventId, outcome: "retry_later" })) }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const sessionStartInput = {
  session_id: "s1",
  hook_event_name: "SessionStart",
  transcript_path: "/Users/dev/.claude/transcripts/s1.jsonl",
  model: "claude-fable-5",
};

test("SessionStart in an allowlisted repo appends the session event and workspace.observed", async () => {
  const dataDir = tmpDataDir();
  saveDevicePolicy(dataDir, Date.now());

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

test("PostToolUse forwards only allowlisted metadata — no tool bodies under any name, no local paths", async () => {
  const dataDir = tmpDataDir();
  saveDevicePolicy(dataDir, Date.now());
  const repo = initRepo("git@github.com:acme/widgets.git");

  await runHook(
    "PostToolUse",
    {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      transcript_path: "/Users/dev/.claude/transcripts/s1.jsonl",
      cwd: repo,
      prompt_id: "p1",
      permission_mode: "default",
      tool_name: "Bash",
      tool_use_id: "tu1",
      duration_ms: 2,
      tool_input: { command: "cat ~/.ssh/id_rsa" },
      tool_response: { stdout: "-----BEGIN OPENSSH PRIVATE KEY-----" },
      tool_output: "LEGACY_BODY_FIELD_MUST_NOT_FORWARD",
      some_future_vendor_field: "FUTURE_BODY_MUST_NOT_FORWARD",
    },
    dataDir,
  );

  const files = outboxFiles(dataDir);
  assert.equal(files.length, 1);
  const raw = readFileSync(join(dataDir, "outbox", files[0]), "utf8");
  assert.doesNotMatch(raw, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(raw, /id_rsa/);
  assert.doesNotMatch(raw, /LEGACY_BODY_FIELD_MUST_NOT_FORWARD/);
  assert.doesNotMatch(raw, /FUTURE_BODY_MUST_NOT_FORWARD/);
  assert.doesNotMatch(raw, /transcripts/);
  assert.match(raw, /"tool_name":"Bash"/);
  assert.match(raw, /"tool_use_id":"tu1"/);

  const parsed = JSON.parse(raw) as { repoCwd: string; payload: Record<string, unknown> };
  assert.equal(parsed.repoCwd, ".", "cwd at the repo root should be reported as '.', not an absolute or ../-laden path");
  assert.ok(!("cwd" in parsed.payload), "the absolute cwd must never ride the payload");
  assert.ok(!("tool_input" in parsed.payload) && !("tool_response" in parsed.payload));
});

test("UserPromptSubmit mints a turnKey the following events carry until the next prompt", async () => {
  const dataDir = tmpDataDir();
  saveDevicePolicy(dataDir, Date.now());
  const repo = initRepo("git@github.com:acme/widgets.git");

  interface OutboxEvent {
    kind: string;
    turnKey?: string;
    payload: { prompt?: string };
  }
  const readEvents = (): OutboxEvent[] =>
    outboxFiles(dataDir).map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as OutboxEvent);

  await runHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);
  await runHook("UserPromptSubmit", { session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: repo, prompt: "one" }, dataDir);
  await runHook("PostToolUse", { session_id: "s1", hook_event_name: "PostToolUse", cwd: repo, tool_name: "Read", tool_use_id: "tu1" }, dataDir);
  await runHook("Stop", { session_id: "s1", hook_event_name: "Stop", cwd: repo, last_assistant_message: "done" }, dataDir);
  await runHook("UserPromptSubmit", { session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: repo, prompt: "two" }, dataDir);
  await runHook("SessionEnd", { session_id: "s1", hook_event_name: "SessionEnd", cwd: repo, reason: "other" }, dataDir);

  const events = readEvents();
  const byKind = (kind: string) => events.filter((e) => e.kind === kind);

  for (const e of [...byKind("SessionStart"), ...byKind("workspace.observed")]) {
    assert.equal(e.turnKey, undefined, `${e.kind} must carry no turnKey`);
  }
  const prompt1 = events.find((e) => e.kind === "UserPromptSubmit" && e.payload.prompt === "one");
  const prompt2 = events.find((e) => e.kind === "UserPromptSubmit" && e.payload.prompt === "two");
  assert.ok(prompt1?.turnKey && prompt2?.turnKey, "each prompt mints a turnKey");
  assert.notEqual(prompt1.turnKey, prompt2.turnKey, "a new prompt replaces the key");
  assert.equal(byKind("PostToolUse")[0].turnKey, prompt1.turnKey);
  assert.equal(byKind("Stop")[0].turnKey, prompt1.turnKey);
  assert.equal(byKind("SessionEnd")[0].turnKey, prompt2.turnKey, "SessionEnd still carries the latest prompt's key");
});

test("a stale policy is refreshed only after the cached allowlist matches", async () => {
  const dataDir = tmpDataDir();
  saveDevicePolicy(dataDir, 0);
  const repo = initRepo("git@github.com:acme/widgets.git");

  let policyCalls = 0;
  const restore = stubFetch({
    onPolicy: () => {
      policyCalls++;
      return new Response(
        JSON.stringify({
          etag: "new",
          ttlSeconds: 900,
          captureLevel: "metadata",
          workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
        }),
        { status: 200 },
      );
    },
  });
  try {
    await runHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);
  } finally {
    restore();
  }

  assert.equal(policyCalls, 1);
  assert.equal(outboxFiles(dataDir).length, 2, "the refreshed policy should have let this SessionStart pass the gate");
});

test("a failed policy refresh still fails closed", async () => {
  const dataDir = tmpDataDir();
  saveDevicePolicy(dataDir, 0);
  const repo = initRepo("git@github.com:acme/widgets.git");

  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    await assert.doesNotReject(runHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir));
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(outboxFiles(dataDir).length, 0, "an expired policy whose refresh failed must still fail closed");
});

test("a fresh policy is not refetched", async () => {
  const dataDir = tmpDataDir();
  saveDevicePolicy(dataDir, Date.now());
  const repo = initRepo("git@github.com:acme/widgets.git");

  let policyCalls = 0;
  const restore = stubFetch({
    onPolicy: () => {
      policyCalls++;
      return new Response("{}", { status: 200 });
    },
  });
  try {
    await runHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);
  } finally {
    restore();
  }

  assert.equal(policyCalls, 0, "a fresh (non-expired) policy must not trigger a refresh fetch");
});
