import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeDialect } from "../src/claude-hook.js";
import { saveConfig, savePolicy } from "../src/config.js";
import { claimTurnKey, runHook } from "../src/hook-core.js";

test("turn-key filenames preserve distinct vendor ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "trinity-turn-key-"));
  const first = claimTurnKey(dir, "../evil");
  const second = claimTurnKey(dir, "..2fevil");

  assert.notEqual(first, second);
  assert.equal(readdirSync(dir).length, 2);
});

test("SessionStart never carries a turn key even when prompt_id is present", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-start-key-data-"));
  const repo = mkdtempSync(join(tmpdir(), "trinity-start-key-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: repo });
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, {
    etag: "e1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });

  await runHook(
    claudeCodeDialect,
    "SessionStart",
    JSON.stringify({ session_id: "s1", prompt_id: "unexpected", cwd: repo }),
    { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  );

  const events = readdirSync(join(dataDir, "outbox")).map((file) =>
    JSON.parse(readFileSync(join(dataDir, "outbox", file), "utf8")) as { kind: string; turnKey?: string },
  );
  assert.ok(events.length >= 1);
  for (const event of events) assert.equal(event.turnKey, undefined, event.kind);
});
