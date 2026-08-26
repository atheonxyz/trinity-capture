// e2e smoke: pairs a Codex device against a real running backend and replays
// the real captured hook stream through the actual dialect + shared engine
// (codex-hook.ts's codexDialect, hook-core.ts's runHook, send.ts's real
// sendBatch/refreshPolicy, outbox.ts's real appendEvent/drain) — never a bare
// fetch, and never a hand-built envelope standing in for the dialect. This is
// what makes the smoke capture-side honest: T2's parametrized decoder test
// (Trinity repo) already proves the backend's governed=true parity from a
// synthetic envelope; this smoke instead proves the PLUGIN's own raw→envelope
// mapping produces a backend-visible result that matches it.
//
// Skipped unless TRINITY_E2E_URL is set — same seeded-backend contract as
// test/e2e.test.ts (see README.md "e2e smoke"), reusing the same live person
// session/project/user, and the same seeded repository
// (github.com/acme/codex-fixture, matching the Trinity repo's
// codex_test.go fixture naming so both sides agree on which repo is
// allowlisted).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { exchange } from "../src/connect.js";
import { saveConfig } from "../src/config.js";
import type { DeviceConfig } from "../src/config.js";
import { refreshPolicy } from "../src/send.js";
import { drain } from "../src/outbox.js";
import { runHook } from "../src/hook-core.js";
import { codexDialect } from "../src/codex-hook.js";

const e2eURL = process.env.TRINITY_E2E_URL;
const sessionToken = process.env.TRINITY_E2E_SESSION_TOKEN;
const projectId = process.env.TRINITY_E2E_PROJECT_ID;
const userId = process.env.TRINITY_E2E_USER_ID;
const postgresURL = process.env.TRINITY_E2E_POSTGRES_URL;

const ready = Boolean(e2eURL && sessionToken && projectId && userId && postgresURL);
const skip = ready
  ? false
  : "set TRINITY_E2E_URL, TRINITY_E2E_SESSION_TOKEN, TRINITY_E2E_PROJECT_ID, TRINITY_E2E_USER_ID, TRINITY_E2E_POSTGRES_URL to run (see README.md). The Trinity backend must be started from a checkout carrying the codex decoder (T2) — .worktrees/ide-codex until it merges to main.";

const SEEDED_REPO_REMOTE = "git@github.com:acme/codex-fixture.git";
const SEEDED_CANONICAL_REPO = "github.com/acme/codex-fixture";

interface SessionDTO {
  session_id: string;
  title: string;
  repository_key: string;
  turn_count: number;
  lifecycle_status: string;
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
  const dir = mkdtempSync(join(tmpdir(), "trinity-e2e-codex-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("pairs a codex device, replays the real captured hook stream through the real dialect, and reads it back through the dashboard API", { skip }, async () => {
  if (!e2eURL || !sessionToken || !projectId || !userId || !postgresURL) {
    assert.fail("E2E configuration is incomplete");
  }
  const baseUrl = e2eURL;

  // 1. A person requests a pairing code for a codex device (dashboard-side).
  const codeRes = await fetch(`${baseUrl}/api/v1/devices/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "codex", name: "e2e-smoke-codex-device" }),
  });
  if (codeRes.status !== 200) assert.fail(`POST /devices/code: ${codeRes.status} ${await codeRes.text()}`);
  const { code } = (await codeRes.json()) as { code: string };

  // 2. The plugin's own exchange() — real client code shared with every
  // dialect's connect flow, not a raw fetch.
  const cfg: DeviceConfig = await exchange(baseUrl, code);
  assert.ok(cfg.token && cfg.deviceId && cfg.ingestUrl);

  const dataDir = mkdtempSync(join(tmpdir(), "trinity-e2e-codex-"));
  // The connect skill's pending-file→PLUGIN_DATA promotion dance is proven
  // separately (codex-connect.test.ts, codex-packaging.test.ts); seeding
  // PLUGIN_DATA directly here keeps this smoke's own scope to capture
  // correctness, exactly like test/e2e.test.ts does for claude_code.
  saveConfig(dataDir, cfg);

  // 3. The plugin's own policy fetch — asserts the seeded repo is allowlisted.
  const policy = await refreshPolicy(dataDir, cfg);
  assert.ok(policy, "policy fetch failed");
  const entry = policy.workspaces.find((w) => w.canonicalRepo === SEEDED_CANONICAL_REPO);
  assert.ok(entry, "seeded codex repo missing from policy");
  assert.match(entry.route, /^project:/);

  // 4. Replay the real captured hook stream through the REAL dialect + shared
  // engine — codex_session.jsonl is raw-hook-shaped (spec's cross-lane
  // ruling), so unlike claude_code's Phase-1 envelope-shaped fixture, there
  // is no pre-built CaptureEvent to hand to appendEvent() directly; runHook()
  // is what turns a raw vendor line into one. A fresh session_id per run
  // avoids colliding with a previous smoke's rows.
  const fixturePath = join(process.cwd(), "test/testdata/codex_session.jsonl");
  const lines = readFileSync(fixturePath, "utf8").trim().split("\n");
  const externalSessionId = randomUUID();
  const repo = initRepo(SEEDED_REPO_REMOTE);
  const env = { ...process.env, PLUGIN_DATA: dataDir };
  for (const line of lines) {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const payload = { ...raw, cwd: repo, session_id: externalSessionId };
    await runHook(codexDialect, raw.hook_event_name as string, JSON.stringify(payload), env);
  }
  await drain(dataDir, cfg, { inline: false, deadline: 0 });

  // 5. Poll the dashboard API — real person-session bearer, not the device token.
  let session: SessionDTO | undefined;
  for (let attempt = 0; attempt < 20 && !session; attempt++) {
    const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/people/${userId}/sessions`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.status !== 200) assert.fail(`GET .../sessions: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { sessions: SessionDTO[] };
    session = body.sessions.find((s) => s.turn_count === 2 && s.repository_key === SEEDED_CANONICAL_REPO);
    if (!session) await sleep(500);
  }
  assert.ok(session, "codex session with 2 turns never appeared");

  assert.equal(session.repository_key, SEEDED_CANONICAL_REPO);
  assert.equal(session.lifecycle_status, "complete");

  // 6. tool_calls carries no bodies — the sessions list DTO doesn't expose
  // it, so this is a direct, read-only check against the seeded database,
  // covering both PreToolUse's and PostToolUse's observed tool-body fields.
  const toolCalls = execFileSync(
    "psql",
    [
      postgresURL,
      "-tA",
      "-c",
      `SELECT tool_calls::text FROM coding_session_turns t JOIN coding_sessions s ON s.id = t.session_id WHERE s.external_session_id = '${externalSessionId}' ORDER BY t.ordinal`,
    ],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(toolCalls, /synthetic fixture text/, "no tool_input/tool_response body content may reach tool_calls");
  assert.match(toolCalls, /Bash/, "expected the PostToolUse call's tool name to still be present");
});
