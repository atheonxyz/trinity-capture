import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config.js";

type TestServer = {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly close: () => Promise<void>;
};

async function startServer(): Promise<TestServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/devices/exchange") {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      response.end(JSON.stringify({
        token: "tok",
        deviceId: "dev1",
        ingestUrl: `http://127.0.0.1:${address.port}/api/v1/ingest/batches`,
      }));
      return;
    }
    if (request.url === "/api/v1/ingest/policy") {
      response.end(JSON.stringify({ etag: "e1", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function runConnect(dataDir: string, baseUrl: string, code?: string): Promise<number | null> {
  const child = spawn(process.execPath, [join(process.cwd(), "dist-test/src/connect.js"), ...(code ? [code] : [])], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, TRINITY_BASE_URL: baseUrl },
    stdio: "ignore",
  });
  const [exitCode] = await once(child, "exit");
  return typeof exitCode === "number" ? exitCode : null;
}

test("pairing fetches the initial policy before reporting the device connected", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-connect-data-"));
  const server = await startServer();
  try {
    assert.equal(await runConnect(dataDir, server.baseUrl, "ABCD1234EFGH"), 0);
    assert.deepEqual(server.requests, ["POST /api/v1/devices/exchange", "GET /api/v1/ingest/policy"]);
    assert.equal(existsSync(join(dataDir, "policy.json")), true);
  } finally {
    await server.close();
  }
});

test("running connect without a new code retries policy sync for an existing device", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-connect-data-"));
  const server = await startServer();
  saveConfig(dataDir, {
    token: "tok",
    deviceId: "dev1",
    ingestUrl: `${server.baseUrl}/api/v1/ingest/batches`,
  });
  try {
    assert.equal(await runConnect(dataDir, server.baseUrl), 0);
    assert.deepEqual(server.requests, ["GET /api/v1/ingest/policy"]);
    assert.equal(existsSync(join(dataDir, "policy.json")), true);
  } finally {
    await server.close();
  }
});
