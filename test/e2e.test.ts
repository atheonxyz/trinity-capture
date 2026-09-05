// e2e smoke: pairs a device against a real running backend and replays a
// session through the actual plugin client code (connect.ts's exchange,
// send.ts's refreshPolicy/sendBatch, outbox.ts's appendEvent/drain) — never
// a bare fetch standing in for the client.
//
// Skipped unless TRINITY_E2E_URL is set. Also requires (the backend has no
// OAuth-free login, so these come from a one-off seed step — see
// README.md "e2e smoke" for the exact commands):
//   TRINITY_E2E_SESSION_TOKEN  a live person session's bearer token
//   TRINITY_E2E_PROJECT_ID     the project that selected the fixture's repo
//   TRINITY_E2E_USER_ID        that session's user id
//   TRINITY_E2E_POSTGRES_URL   read-only: confirms tool_calls carries no bodies
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
import { appendEvent, drain } from "../src/outbox.js";
import type { CaptureEvent } from "../src/outbox.js";

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

interface Fixture {
  captureEventId: string;
  tool: "claude_code";
  kind: string;
  externalSessionId: string;
  repo: string;
  repoCwd: string;
  occurredAt: string;
  turnKey?: string;
  payload: unknown;
}

function retargetClaudePayload(raw: Fixture, externalSessionId: string): unknown {
  if (raw.kind === "workspace.observed" || typeof raw.payload !== "object" || raw.payload === null || Array.isArray(raw.payload)) {
    return raw.payload;
  }
  return { ...raw.payload, session_id: externalSessionId };
}

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

test("pairs a device, replays a session, and reads it back through the dashboard API", { skip }, async () => {
  if (!e2eURL || !sessionToken || !projectId || !userId || !postgresURL) {
    assert.fail("E2E configuration is incomplete");
  }
  const baseUrl = e2eURL;

  // 1. A person requests a pairing code (dashboard-side; the plugin has no
  // equivalent call, so this alone is a plain authenticated fetch).
  const codeRes = await fetch(`${baseUrl}/api/v1/devices/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "claude_code", name: "e2e-smoke-device" }),
  });
  if (codeRes.status !== 200) assert.fail(`POST /devices/code: ${codeRes.status} ${await codeRes.text()}`);
  const { code } = (await codeRes.json()) as { code: string };

  // 2. The plugin's own exchange() — real client code, not a raw fetch.
  const cfg: DeviceConfig = await exchange(baseUrl, code, null);
  assert.ok(cfg.token && cfg.deviceId && cfg.ingestUrl);

  // 2b. Re-pairing the same data dir's saved deviceId reconnects the same
  // machine instead of minting a second one.
  const secondCodeRes = await fetch(`${baseUrl}/api/v1/devices/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "claude_code", name: "e2e-smoke-device" }),
  });
  if (secondCodeRes.status !== 200) assert.fail(`POST /devices/code: ${secondCodeRes.status} ${await secondCodeRes.text()}`);
  const { code: secondCode } = (await secondCodeRes.json()) as { code: string };
  const again: DeviceConfig = await exchange(baseUrl, secondCode, cfg.deviceId);
  assert.equal(again.deviceId, cfg.deviceId, "a re-pair from the same data dir reconnects the same device");

  const dataDir = mkdtempSync(join(tmpdir(), "trinity-e2e-"));
  saveConfig(dataDir, cfg);

  // 3. The plugin's own policy fetch — asserts the seeded repo is allowlisted.
  const policy = await refreshPolicy(dataDir, cfg);
  assert.ok(policy, "policy fetch failed");
  const entry = policy.workspaces.find((w) => w.canonicalRepo === "github.com/acme/claude-code-fixture");
  assert.ok(entry, "seeded repo missing from policy");
  assert.match(entry.route, /^project:/);

  // 4. Replay the Task 5.1 fixture through the real outbox/send path.
  // Resolved from cwd (pnpm test always runs from the repository root), not
  // import.meta.url: tsc doesn't copy this .jsonl asset into dist-test/.
  const fixturePath = join(process.cwd(), "test/testdata/claude_code_session.jsonl");
  const lines = readFileSync(fixturePath, "utf8").trim().split("\n");
  const externalSessionId = randomUUID();
  for (const line of lines) {
    const raw = JSON.parse(line) as Fixture;
    const ev: CaptureEvent = {
      ...raw,
      captureEventId: randomUUID(),
      externalSessionId,
      payload: retargetClaudePayload(raw, externalSessionId),
    };
    appendEvent(dataDir, ev);
  }
  await drain(dataDir, cfg, { inline: false, deadline: 0 });

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
  assert.ok(session, "session with 2 turns never appeared");

  assert.equal(session.repository_key, "github.com/acme/claude-code-fixture");
  assert.equal(session.lifecycle_status, "complete");
  // Title fallback: no gold title yet, so it's the first turn's prompt.
  assert.equal(session.title, "Add the claude_code adapter");

  // 6. tool_calls carries no bodies — the sessions list DTO doesn't expose
  // it, so this is a direct, read-only check against the seeded database.
  const toolCalls = execFileSync(
    "psql",
    [postgresURL, "-tA", "-c",
      `SELECT tool_calls::text FROM coding_session_turns t JOIN coding_sessions s ON s.id = t.session_id WHERE s.external_session_id = '${externalSessionId}' ORDER BY t.ordinal`],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(toolCalls, /MARKER_TOOL_INPUT_BODY_MUST_NOT_PROJECT/);
  assert.doesNotMatch(toolCalls, /MARKER_TOOL_RESPONSE_BODY_MUST_NOT_PROJECT/);
  assert.match(toolCalls, /Read/, "expected the PostToolUse call's tool name to still be present");
});
