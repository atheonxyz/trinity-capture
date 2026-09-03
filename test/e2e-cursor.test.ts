// e2e smoke, Cursor's twin of test/e2e.test.ts: pairs a Cursor device
// against a real running backend and replays the RAW captured
// cursor-agent hook stream through the actual client pipeline —
// connectCursor's real exchange(), cursor-hook.ts's real runCursorHook
// (dialect + hook-core + outbox + send), never a pre-shaped BatchItem
// array standing in for it. Unlike claude_code_session.jsonl,
// cursor_session.jsonl is the raw hook envelope, not wire-shaped, so this
// is what actually proves the dialect's raw->wire mapping end-to-end
// against a live server (the same shape test/cursor-hook.test.ts's
// in-process "reconciliation gate" test proves locally).
//
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { connectCursor } from "../src/cursor-connect.js";
import { loadConfig } from "../src/config.js";
import { refreshPolicy } from "../src/send.js";
import { runCursorHook } from "../src/cursor-hook.js";

const SEEDED_CANONICAL_REPO = "github.com/acme/cursor-fixture";
const SEEDED_REPO_REMOTE = "git@github.com:acme/cursor-fixture.git";

const e2eURL = process.env.TRINITY_E2E_URL;
const sessionToken = process.env.TRINITY_E2E_SESSION_TOKEN;
const projectId = process.env.TRINITY_E2E_PROJECT_ID;
const userId = process.env.TRINITY_E2E_USER_ID;
const postgresURL = process.env.TRINITY_E2E_POSTGRES_URL;

const ready = Boolean(e2eURL && sessionToken && projectId && userId && postgresURL);
const skip = ready
  ? false
  : "set TRINITY_E2E_URL, TRINITY_E2E_SESSION_TOKEN, TRINITY_E2E_PROJECT_ID, TRINITY_E2E_USER_ID, TRINITY_E2E_POSTGRES_URL to run (see README.md)";
const sessionPollDeadlineMs = 6 * 60 * 1_000;
const sessionPollIntervalMs = 1_000;

interface SessionDTO {
  session_id: string;
  title: string;
  repository_key: string;
  turn_count: number;
  lifecycle_status: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function projectedSessionID(postgresURL: string, externalSessionId: string): string | undefined {
  const output = execFileSync(
    "psql",
    [
      postgresURL,
      "-tA",
      "-c",
      `SELECT id FROM coding_sessions WHERE external_session_id = '${externalSessionId}' AND turn_count = 2 AND ended_at IS NOT NULL AND capture_state = 'complete'`,
    ],
    { encoding: "utf8" },
  ).trim();
  return output === "" ? undefined : output;
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
  const dir = mkdtempSync(join(tmpdir(), "trinity-e2e-cursor-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: gitEnv() });
  return dir;
}

test("pairs a Cursor device, replays the raw captured stream, and reads it back through the dashboard API", { skip }, async () => {
  if (!e2eURL || !sessionToken || !projectId || !userId || !postgresURL) {
    assert.fail("E2E configuration is incomplete");
  }
  const baseUrl = e2eURL;

  // 1. A person requests a pairing code for a Cursor device.
  const codeRes = await fetch(`${baseUrl}/api/v1/devices/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "cursor", name: "e2e-smoke-device-cursor" }),
  });
  if (codeRes.status !== 200) assert.fail(`POST /devices/code: ${codeRes.status} ${await codeRes.text()}`);
  const { code } = (await codeRes.json()) as { code: string };

  // 2. The plugin's own connectCursor() — real client code, writing a
  // 0700/0600-secured DeviceConfig, not a raw fetch standing in for it.
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-e2e-cursor-"));
  await connectCursor(baseUrl, code, dataDir);
  const cfg = loadConfig(dataDir);
  assert.ok(cfg?.token && cfg.deviceId && cfg.ingestUrl);

  // 3. The plugin's own policy fetch — asserts the seeded repo is allowlisted.
  const policy = await refreshPolicy(dataDir, cfg);
  assert.ok(policy, "policy fetch failed");
  const entry = policy.workspaces.find((w) => w.canonicalRepo === SEEDED_CANONICAL_REPO);
  assert.ok(entry, "seeded repo missing from policy");
  assert.match(entry.route, /^project:/);

  // 4. Replay the raw captured cursor-agent stream through the real
  // dialect + hook-core pipeline, retargeted at a real repo whose origin
  // normalizes to the seeded canonicalRepo. drainInline is true, but only
  // afterAgentResponse/sessionEnd actually drain — by sessionEnd the whole
  // 13-event outbox (well under the 100-event batch cap) sends in one
  // inline batch.
  const repo = initRepo(SEEDED_REPO_REMOTE);
  const fixturePath = join(process.cwd(), "test/testdata/cursor_session.jsonl");
  const lines = readFileSync(fixturePath, "utf8").trim().split("\n");
  const externalSessionId = randomUUID();
  const env = { ...process.env, TRINITY_CAPTURE_DATA: dataDir };
  for (const line of lines) {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const retargeted: Record<string, unknown> = { ...raw, conversation_id: externalSessionId, session_id: externalSessionId, workspace_roots: [repo] };
    await runCursorHook(retargeted.hook_event_name as string, JSON.stringify(retargeted), env);
  }

  // 5. Poll the dashboard API — real person-session bearer, not the device token.
  let session: SessionDTO | undefined;
  let sessionID: string | undefined;
  const deadline = Date.now() + sessionPollDeadlineMs;
  while (!session && Date.now() < deadline) {
    sessionID = projectedSessionID(postgresURL, externalSessionId);
    const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/people/${userId}/sessions?limit=50`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.status !== 200) assert.fail(`GET .../sessions: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { sessions: SessionDTO[] };
    session = body.sessions.find((s) => s.session_id === sessionID && s.turn_count === 2 && s.lifecycle_status === "complete");
    if (!session) await sleep(sessionPollIntervalMs);
  }
  assert.ok(session, "the replayed cursor session never appeared");

  assert.equal(session.repository_key, SEEDED_CANONICAL_REPO);
  assert.equal(session.turn_count, 2, "the fixture's first turn opens with no beforeSubmitPrompt but still counts");
  assert.equal(session.lifecycle_status, "complete");

  // 6. tool_calls carries no bodies for either turn (metadata-only capture).
  const toolCalls = execFileSync(
    "psql",
    [postgresURL, "-tA", "-c",
      `SELECT tool_calls::text FROM coding_session_turns t JOIN coding_sessions s ON s.id = t.session_id WHERE s.external_session_id = '${externalSessionId}' ORDER BY t.ordinal`],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(toolCalls, /tool_input|tool_output|file_path/);
  assert.match(toolCalls, /Read/, "expected postToolUse's tool name to still be present");
});
