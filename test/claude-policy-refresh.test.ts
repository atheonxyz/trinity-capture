import assert from "node:assert/strict";
import test from "node:test";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig } from "../src/config.js";
import {
  initRepo,
  outboxFiles,
  runClaudeHook,
  sessionStartInput,
  stubFetch,
  tmpDataDir,
} from "./helpers/claude-hook-fixture.js";

const cfg: DeviceConfig = {
  token: "tok",
  ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches",
  deviceId: "dev1",
};

function saveMatchingPolicy(dataDir: string, fetchedAt: number): void {
  savePolicy(dataDir, {
    etag: "old",
    fetchedAt,
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
}

test("a stale matching policy is refreshed before capture", async () => {
  const dataDir = tmpDataDir();
  saveConfig(dataDir, cfg);
  saveMatchingPolicy(dataDir, 0);
  const repo = initRepo("git@github.com:acme/widgets.git");
  let policyCalls = 0;
  const restore = stubFetch({
    onPolicy: () => {
      policyCalls++;
      return Response.json({
        etag: "new",
        ttlSeconds: 900,
        captureLevel: "metadata",
        workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
      });
    },
  });
  try {
    await runClaudeHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);
  } finally {
    restore();
  }

  assert.equal(policyCalls, 1);
  assert.equal(outboxFiles(dataDir).length, 2);
});

test("a failed policy refresh still fails closed", async () => {
  const dataDir = tmpDataDir();
  saveConfig(dataDir, cfg);
  saveMatchingPolicy(dataDir, 0);
  const repo = initRepo("git@github.com:acme/widgets.git");
  const original = globalThis.fetch;
  const failingFetch: typeof fetch = async () => {
    throw new Error("network down");
  };
  globalThis.fetch = failingFetch;
  try {
    await assert.doesNotReject(runClaudeHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir));
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(outboxFiles(dataDir).length, 0);
});

test("a fresh policy is not refetched", async () => {
  const dataDir = tmpDataDir();
  saveConfig(dataDir, cfg);
  saveMatchingPolicy(dataDir, Date.now());
  const repo = initRepo("git@github.com:acme/widgets.git");
  let policyCalls = 0;
  const restore = stubFetch({
    onPolicy: () => {
      policyCalls++;
      return Response.json({});
    },
  });
  try {
    await runClaudeHook("SessionStart", { ...sessionStartInput, cwd: repo }, dataDir);
  } finally {
    restore();
  }

  assert.equal(policyCalls, 0);
});

const toolUseInput = { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "tu1" } as const;

test("a policy that expires mid-session is refreshed before the next event is captured", async () => {
  const dataDir = tmpDataDir();
  saveConfig(dataDir, cfg);
  saveMatchingPolicy(dataDir, Date.now() - 901_000);
  const repo = initRepo("git@github.com:acme/widgets.git");
  let policyCalls = 0;
  const restore = stubFetch({
    onPolicy: () => {
      policyCalls++;
      return Response.json({
        etag: "new",
        ttlSeconds: 900,
        captureLevel: "metadata",
        workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
      });
    },
  });
  try {
    await runClaudeHook("PostToolUse", { ...toolUseInput, cwd: repo }, dataDir);
  } finally {
    restore();
  }

  assert.equal(policyCalls, 1);
  assert.equal(outboxFiles(dataDir).length, 1);
});

test("a failed mid-session refresh fails closed and waits before trying again", async () => {
  const dataDir = tmpDataDir();
  saveConfig(dataDir, cfg);
  saveMatchingPolicy(dataDir, Date.now() - 901_000);
  const repo = initRepo("git@github.com:acme/widgets.git");
  let policyCalls = 0;
  const restore = stubFetch({
    onPolicy: () => {
      policyCalls++;
      return new Response(null, { status: 503 });
    },
  });
  try {
    await runClaudeHook("PostToolUse", { ...toolUseInput, cwd: repo }, dataDir);
    await runClaudeHook("PostToolUse", { ...toolUseInput, tool_use_id: "tu2", cwd: repo }, dataDir);
  } finally {
    restore();
  }

  assert.equal(policyCalls, 1);
  assert.equal(outboxFiles(dataDir).length, 0);
});
