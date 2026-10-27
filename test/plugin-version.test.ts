import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { saveConfig } from "../src/config.js";
import type { DeviceConfig } from "../src/config.js";
import type { CaptureEvent } from "../src/outbox.js";

type Send = typeof import("../src/send.js");

const manifests: Record<string, string> = {
  "claude-code": ".claude-plugin/plugin.json",
  codex: ".codex-plugin/plugin.json",
  cursor: ".cursor-plugin/plugin.json",
  gemini: "gemini-extension.json",
  copilot: "plugin.json",
};

const event: CaptureEvent = {
  captureEventId: "11111111-1111-4111-8111-111111111111",
  tool: "claude_code",
  kind: "SessionStart",
  externalSessionId: "s1",
  repo: "github.com/acme/work",
  repoCwd: ".",
  occurredAt: new Date().toISOString(),
  payload: { session_id: "s1" },
};

// Runs every device-token request one plugin build makes and answers which version header each carried.
async function versionsSent(t: TestContext, pluginRoot: string): Promise<Record<string, string | undefined>> {
  const seen: Record<string, string | undefined> = {};
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = request.url ?? "";
      const version = request.headers["x-trinity-plugin-version"];
      seen[path] = Array.isArray(version) ? version.join(",") : version;
      const answers: Record<string, unknown> = {
        "/api/v1/ingest/batches": { results: [{ captureEventId: event.captureEventId, outcome: "stored" }] },
        "/api/v1/ingest/policy": { etag: "e1", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] },
        "/api/v1/ingest/session-context": { route: "project", candidates: [] },
        "/api/v1/ingest/handoffs/ack": { acknowledged: 1 },
      };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(answers[path] ?? {}));
    });
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const send = (await import(pathToFileURL(join(pluginRoot, "dist", "send.js")).href)) as Send;
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-plugin-version-"));
  const cfg: DeviceConfig = { token: "tok", deviceId: "dev1", ingestUrl: `http://127.0.0.1:${address.port}/api/v1/ingest/batches` };
  saveConfig(dataDir, cfg);

  assert.deepEqual(await send.sendBatch(cfg, [event]), [{ captureEventId: event.captureEventId, outcome: "stored" }]);
  assert.equal((await send.refreshPolicy(dataDir, cfg))?.etag, "e1");
  assert.equal((await send.fetchSessionContext(cfg, { repo: event.repo, branch: "main" }, send.REQUEST_TIMEOUT_MS))?.route, "project");
  await send.ackHandoffs(cfg, ["h1"], send.REQUEST_TIMEOUT_MS);
  assert.deepEqual(Object.keys(seen).sort(), [
    "/api/v1/ingest/batches",
    "/api/v1/ingest/handoffs/ack",
    "/api/v1/ingest/policy",
    "/api/v1/ingest/session-context",
  ]);
  return seen;
}

for (const [plugin, manifest] of Object.entries(manifests)) {
  test(`${plugin}: every device-token request names the version its own manifest states`, async (t) => {
    const root = join(process.cwd(), plugin);
    const { version } = JSON.parse(readFileSync(join(root, manifest), "utf8")) as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+$/);
    for (const [path, sent] of Object.entries(await versionsSent(t, root))) {
      assert.equal(sent, version, `${plugin} ${path}`);
    }
  });
}

const unreadable: Record<string, string | null> = {
  "a missing manifest": null,
  "a manifest that is not JSON": "{",
  "a version that is not x.y.z": JSON.stringify({ version: "next" }),
};

for (const [name, manifest] of Object.entries(unreadable)) {
  test(`${name} sends no version header and every request still goes`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "trinity-plugin-root-"));
    cpSync(join(process.cwd(), "claude-code", "dist"), join(root, "dist"), { recursive: true });
    if (manifest !== null) {
      const path = join(root, ".claude-plugin", "plugin.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, manifest);
    }
    for (const [path, sent] of Object.entries(await versionsSent(t, root))) {
      assert.equal(sent, undefined, path);
    }
  });
}
