import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeDialect } from "../src/claude-hook.js";
import { codexDialect } from "../src/codex-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";
import { cursorDialect } from "../src/cursor-hook.js";
import type { Dialect } from "../src/hook-core.js";
import { runHook } from "../src/hook-core.js";
import { initRepo } from "./helpers/claude-hook-fixture.js";

const SETUP_PROMPT = "[Trinity setup]\nsetup instructions CODE";
const CANONICAL_REPO = "github.com/acme/setup-safe";

type DialectCase = {
  readonly dialect: Dialect;
  readonly promptEvent: string;
  readonly laterEvent: string;
  readonly idPrefix: string;
  readonly payload: (sessionId: string | null, prompt: string) => Record<string, unknown>;
  readonly laterPayload: (sessionId: string, repo: string) => Record<string, unknown>;
};

const CASES: readonly DialectCase[] = [
  {
    dialect: claudeCodeDialect,
    promptEvent: "UserPromptSubmit",
    laterEvent: "Stop",
    idPrefix: "claude",
    payload: (sessionId, prompt) => (sessionId === null ? { prompt } : { session_id: sessionId, prompt }),
    laterPayload: (sessionId, repo) => ({ session_id: sessionId, cwd: repo, last_assistant_message: "done" }),
  },
  {
    dialect: codexDialect,
    promptEvent: "UserPromptSubmit",
    laterEvent: "Stop",
    idPrefix: "codex",
    payload: (sessionId, prompt) => (sessionId === null ? { prompt } : { session_id: sessionId, turn_id: "turn-1", prompt }),
    laterPayload: (sessionId, repo) => ({ session_id: sessionId, turn_id: "turn-1", cwd: repo, last_assistant_message: "done" }),
  },
  {
    dialect: cursorDialect,
    promptEvent: "beforeSubmitPrompt",
    laterEvent: "afterAgentResponse",
    idPrefix: "cursor",
    payload: (sessionId, prompt) =>
      sessionId === null ? { prompt } : { conversation_id: sessionId, generation_id: "turn-1", prompt },
    laterPayload: (sessionId, repo) => ({
      conversation_id: sessionId,
      generation_id: "turn-1",
      workspace_roots: [repo],
      text: "done",
    }),
  },
] as const;

function outboxFiles(dataDir: string): string[] {
  const dir = join(dataDir, "outbox");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function tmpPluginDataDir(prefix: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), prefix)), "trinity-fixture");
  mkdirSync(dir);
  return dir;
}

function pairAllowlistedRepo(dataDir: string): string {
  saveConfig(dataDir, { token: "tok", ingestUrl: "https://ingest.example/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: CANONICAL_REPO, aliases: [], route: "project:p1" }],
  });
  return initRepo("git@github.com:acme/setup-safe.git");
}

function envFor(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
    PLUGIN_DATA: dataDir,
    TRINITY_CAPTURE_DATA: dataDir,
  };
}

test("setup marker suppresses prompt and later events for every paired allowlisted dialect", async () => {
  for (const testCase of CASES) {
    const dataDir = tmpPluginDataDir(`trinity-setup-${testCase.idPrefix}-`);
    const repo = pairAllowlistedRepo(dataDir);
    const env = envFor(dataDir);
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("setup suppression must not touch the network");
    }) as typeof fetch;

    try {
      await runHook(testCase.dialect, testCase.promptEvent, JSON.stringify(testCase.payload("setup-session", SETUP_PROMPT)), env);
      await runHook(testCase.dialect, testCase.laterEvent, JSON.stringify(testCase.laterPayload("setup-session", repo)), env);
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(outboxFiles(dataDir), [], `${testCase.idPrefix} setup session must not write outbox events`);
    assert.equal(requests, 0, `${testCase.idPrefix} setup session must not make network requests`);
    assert.equal(existsSync(join(dataDir, "suppressed-sessions")), true);
  }
});

test("ordinary prompts in a different session still capture for every dialect", async () => {
  for (const testCase of CASES) {
    const dataDir = tmpPluginDataDir(`trinity-setup-ordinary-${testCase.idPrefix}-`);
    const repo = pairAllowlistedRepo(dataDir);
    const env = envFor(dataDir);

    await runHook(
      testCase.dialect,
      testCase.promptEvent,
      JSON.stringify({ ...testCase.payload("ordinary-session", "normal work prompt"), cwd: repo, workspace_roots: [repo] }),
      env,
    );

    assert.equal(outboxFiles(dataDir).length, 1, `${testCase.idPrefix} ordinary prompt must still be captured`);
  }
});

test("near-match setup text is not suppressed and still captures", async () => {
  const dataDir = tmpPluginDataDir("trinity-setup-near-");
  const repo = pairAllowlistedRepo(dataDir);

  await runHook(
    claudeCodeDialect,
    "UserPromptSubmit",
    JSON.stringify({ session_id: "near", cwd: repo, prompt: "[Trinity setup] setup" }),
    envFor(dataDir),
  );

  assert.equal(existsSync(join(dataDir, "suppressed-sessions")), false);
  assert.equal(outboxFiles(dataDir).length, 1);
});

test("marked setup prompt without a session id writes nothing", async () => {
  for (const testCase of CASES) {
    const dataDir = tmpPluginDataDir(`trinity-setup-missing-session-${testCase.idPrefix}-`);
    const repo = pairAllowlistedRepo(dataDir);
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("missing-session setup suppression must not touch the network");
    }) as typeof fetch;

    try {
      await runHook(
        testCase.dialect,
        testCase.promptEvent,
        JSON.stringify({ ...testCase.payload(null, SETUP_PROMPT), cwd: repo, workspace_roots: [repo] }),
        envFor(dataDir),
      );
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(outboxFiles(dataDir), [], `${testCase.idPrefix} missing-session setup prompt must not write outbox events`);
    assert.equal(requests, 0, `${testCase.idPrefix} missing-session setup prompt must not make network requests`);
    assert.equal(existsSync(join(dataDir, "suppressed-sessions")), false);
  }
});

test("unreadable setup suppression state fails closed", async () => {
  const dataDir = tmpPluginDataDir("trinity-setup-unreadable-");
  const repo = pairAllowlistedRepo(dataDir);
  writeFileSync(join(dataDir, "suppressed-sessions"), "not a directory");
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error("unreadable suppression state must not touch the network");
  }) as typeof fetch;

  try {
    await runHook(
      claudeCodeDialect,
      "Stop",
      JSON.stringify({ session_id: "setup-session", cwd: repo, last_assistant_message: "done" }),
      envFor(dataDir),
    );
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(outboxFiles(dataDir), []);
  assert.equal(requests, 0);
});

test("setup marker write failure is not swallowed", async () => {
  const dataDir = tmpPluginDataDir("trinity-setup-write-failure-");
  const repo = pairAllowlistedRepo(dataDir);
  writeFileSync(join(dataDir, "suppressed-sessions"), "not a directory");

  await assert.rejects(
    runHook(
      claudeCodeDialect,
      "UserPromptSubmit",
      JSON.stringify({ session_id: "setup-session", cwd: repo, prompt: SETUP_PROMPT }),
      envFor(dataDir),
    ),
  );
  assert.deepEqual(outboxFiles(dataDir), []);
});
