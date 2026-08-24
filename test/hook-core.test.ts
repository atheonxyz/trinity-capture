import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimTurnKey, runHook } from "../src/hook-core.js";
import type { Dialect } from "../src/hook-core.js";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig, Policy } from "../src/config.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "trinity-hookcore-"));
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
  const dir = mkdtempSync(join(tmpdir(), "trinity-hookcore-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

// --- claimTurnKey: the write-once, one-file-per-vendor-id store ---

test("distinct vendor ids each mint their own key — no shared state to lose an update on", () => {
  const dataDir = tmpDataDir();
  const sessionDir = join(dataDir, "turnkeys", "claude_code-s1");

  const k1 = claimTurnKey(sessionDir, "P1");
  const k2 = claimTurnKey(sessionDir, "P2");
  assert.notEqual(k1, k2);

  // Resolving again (as a later, out-of-order event would) reads the same
  // winner back rather than minting fresh — P1's key never becomes P2's.
  assert.equal(claimTurnKey(sessionDir, "P1"), k1);
  assert.equal(claimTurnKey(sessionDir, "P2"), k2);
});

test("a hostile vendor id sanitizes to a safe filename with no path traversal", () => {
  const dataDir = tmpDataDir();
  const sessionDir = join(dataDir, "turnkeys", "claude_code-s1");

  const key = claimTurnKey(sessionDir, "../evil");
  const entries = readdirSync(sessionDir);
  assert.equal(entries.length, 1);
  assert.ok(!entries[0].includes("/"), `sanitized filename must not contain a path separator: ${entries[0]}`);
  assert.notEqual(entries[0], "..", "must not sanitize to a bare parent-dir segment");
  // Idempotent: resolving the same hostile id again reads the same file back.
  assert.equal(claimTurnKey(sessionDir, "../evil"), key);
});

test("a vendor id of exactly '..' does not sanitize to a parent-dir escape", () => {
  const dataDir = tmpDataDir();
  const sessionDir = join(dataDir, "turnkeys", "claude_code-s1");

  claimTurnKey(sessionDir, "..");
  const entries = readdirSync(sessionDir);
  assert.equal(entries.length, 1);
  assert.notEqual(entries[0], "..");
  assert.notEqual(entries[0], ".");
});

test("an unseen vendor id on a non-prompt turn event lazily mints exactly one key under two racing processes", async () => {
  const dataDir = tmpDataDir();
  const sessionDir = join(dataDir, "turnkeys", "claude_code-s1");
  const workerPath = join(process.cwd(), "dist-test", "test", "helpers", "turnkey-race-worker.js");

  function runWorker(vendorTurnId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, sessionDir, vendorTurnId]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`worker exited ${code}: ${err}`))));
    });
  }

  const [a, b] = await Promise.all([runWorker("racing-turn"), runWorker("racing-turn")]);
  assert.equal(a, b, "both racing processes must resolve to the identical minted key");
  assert.match(a, /^[0-9a-f-]{36}$/, "the resolved key should be a uuid");

  const entries = readdirSync(sessionDir);
  assert.equal(entries.length, 1, "exactly one file exists for the raced vendor id");
});

// --- id-less fallback: hook-core's generic engine, not any one dialect ---

function fakeDialect(overrides: Partial<Dialect> = {}): Dialect {
  return {
    tool: "claude_code",
    sessionId: (_event, payload) => (typeof payload.session_id === "string" ? payload.session_id : null),
    cwd: (_event, payload) => (typeof payload.cwd === "string" ? payload.cwd : null),
    vendorTurnId: (_event, payload) => (typeof payload.vendor_turn_id === "string" ? payload.vendor_turn_id : null),
    isPromptSubmit: (event) => event === "PromptSubmit",
    isSessionStart: () => false,
    drainsOn: () => true,
    allow: () => ["marker", "vendor_turn_id"],
    drainInline: false,
    dataDir: (env) => env.TEST_HOOK_CORE_DATA_DIR ?? null,
    ...overrides,
  };
}

function freshPolicy(): Policy {
  return {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  };
}

// A stub that counts fetch attempts and always fails request-level (so
// drain treats each as "abort" and never actually needs a real endpoint) —
// what matters for these tests is whether a drain was attempted at all.
function stubFetchCounting(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("stub: unreachable by design");
  }) as typeof fetch;
  return { calls: () => calls, restore: () => (globalThis.fetch = original) };
}

test("hook-core: vendor-id events correlate out of order; id-less events fall back to latest", async () => {
  const dataDir = tmpDataDir();
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

  const dialect = fakeDialect();
  const env = { ...process.env, TEST_HOOK_CORE_DATA_DIR: dataDir };
  const send = (event: string, marker: string, extra: Record<string, unknown> = {}) =>
    runHook(dialect, event, JSON.stringify({ session_id: "s1", cwd: repo, marker, ...extra }), env);

  await send("PromptSubmit", "prompt-1", { vendor_turn_id: "P1" }); // mints K1, keyed by P1
  await send("PromptSubmit", "prompt-2", { vendor_turn_id: "P2" }); // mints K2, keyed by P2 — independent of K1
  await send("ToolCall", "tool-for-p1", { vendor_turn_id: "P1" }); // resolves K1, not K2 — out-of-order correlation
  await send("PromptSubmit", "prompt-idless"); // no vendor id — mints via latest
  await send("ToolCall", "tool-idless"); // no vendor id, not prompt-submit — falls back to latest

  interface OutboxEvent {
    turnKey?: string;
    payload: { marker: string };
  }
  const events = readdirSync(join(dataDir, "outbox")).map(
    (f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as OutboxEvent,
  );
  const byMarker = (marker: string) => events.find((e) => e.payload.marker === marker);

  const k1 = byMarker("prompt-1")?.turnKey;
  const k2 = byMarker("prompt-2")?.turnKey;
  assert.ok(k1 && k2, "both prompt-submits must mint a turn key");
  assert.notEqual(k1, k2);
  assert.equal(byMarker("tool-for-p1")?.turnKey, k1, "an out-of-order event carrying P1 must resolve K1, not K2");

  const kIdless = byMarker("prompt-idless")?.turnKey;
  assert.ok(kIdless, "the id-less prompt-submit must still mint (via latest)");
  assert.equal(byMarker("tool-idless")?.turnKey, kIdless, "an id-less non-prompt event must fall back to latest");
});

// --- drainsOn: WHETHER an event drains at all is the dialect's call ---

test("hook-core: drainsOn, not a literal event name, gates whether an event attempts a network drain", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, freshPolicy());
  const repo = initRepo("git@github.com:acme/widgets.git");

  // Deliberately not Claude's vocabulary: drains on "X" only, the opposite
  // shape of Claude's "everything but SessionEnd".
  const dialect = fakeDialect({ drainsOn: (event) => event === "X" });
  const env = { ...process.env, TEST_HOOK_CORE_DATA_DIR: dataDir };
  const send = (event: string) => runHook(dialect, event, JSON.stringify({ session_id: "s1", cwd: repo }), env);

  const { calls, restore } = stubFetchCounting();
  try {
    await send("X");
    assert.equal(calls(), 1, "drainsOn(true) must attempt a drain");

    await send("Y");
    assert.equal(calls(), 1, "drainsOn(false) must skip the drain entirely — no new fetch");
  } finally {
    restore();
  }
});

// --- isSessionStart: gates the self-heal refresh + workspace.observed synthesis ---

test("hook-core: isSessionStart, not a literal event name, gates the workspace.observed synthesis", async () => {
  const dataDir = tmpDataDir();
  const cfg: DeviceConfig = { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" };
  saveConfig(dataDir, cfg);
  savePolicy(dataDir, freshPolicy());
  const repo = initRepo("git@github.com:acme/widgets.git");

  // Deliberately not "SessionStart": proves the synthesis follows the
  // predicate, not the string.
  const dialect = fakeDialect({ isSessionStart: (event) => event === "Begin", drainsOn: () => false });
  const env = { ...process.env, TEST_HOOK_CORE_DATA_DIR: dataDir };
  const send = (event: string) => runHook(dialect, event, JSON.stringify({ session_id: "s1", cwd: repo }), env);

  await send("Begin");
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 2, "isSessionStart(true) must synthesize workspace.observed alongside the main event");

  await send("Other");
  assert.equal(readdirSync(join(dataDir, "outbox")).length, 3, "isSessionStart(false) must add only the main event, no workspace.observed");
});
