import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pendingConfigPath, targetKeyForPluginData } from "../src/codex-connect.js";
import { saveConfig, savePolicy } from "../src/config.js";
import type { DeviceConfig } from "../src/config.js";

const execFileAsync = promisify(execFile);

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "trinity-codex-identity-home-"));
}

function tmpPluginDataWithKey(key: string): string {
  const parent = mkdtempSync(join(tmpdir(), "trinity-codex-identity-data-"));
  const dir = join(parent, key);
  mkdirSync(dir);
  return dir;
}

function saveFreshPolicy(dataDir: string): void {
  savePolicy(dataDir, {
    etag: "policy-1",
    fetchedAt: Date.now(),
    ttlSeconds: 900,
    captureLevel: "metadata",
    workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }],
  });
}

async function runCompiledCodexConnect(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync("node", [join(process.cwd(), "dist-test", "src", "codex-connect.js"), ...args], {
    encoding: "utf8",
    env,
  });
  return result.stdout;
}

async function withStubServer<T>(cfg: DeviceConfig, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/devices/exchange") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cfg));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withBodyRecordingServer<T>(cfg: DeviceConfig, fn: (baseUrl: string, bodies: readonly unknown[]) => Promise<T>): Promise<T> {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/devices/exchange") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cfg));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("status prefers TRINITY_CAPTURE_DATA over PLUGIN_DATA when both are present", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginDataWithKey("wrong-plugin-data");
  const captureData = tmpPluginDataWithKey("right-trinity-capture-data");
  saveConfig(captureData, { token: "tok", ingestUrl: "https://api.example/api/v1/ingest/batches", deviceId: "dev1" });
  saveFreshPolicy(captureData);

  const output = await runCompiledCodexConnect(["--status"], {
    ...process.env,
    CODEX_HOME: home,
    PLUGIN_DATA: pluginData,
    TRINITY_CAPTURE_DATA: captureData,
  });

  assert.match(output, /Trinity status: ready\./);
});

test("connect subprocess writes pending config for TRINITY_CAPTURE_DATA identity when target is omitted", async () => {
  const home = tmpHome();
  const pluginData = tmpPluginDataWithKey("trinity-capture-openai-curated-remote");
  const cfg: DeviceConfig = {
    token: "subprocess-token",
    ingestUrl: "https://api.example/api/v1/ingest/batches",
    deviceId: "subprocess-device",
  };

  await withStubServer(cfg, async (baseUrl) => {
    await runCompiledCodexConnect(["PAIR-CODE"], {
      ...process.env,
      CODEX_HOME: home,
      TRINITY_CAPTURE_DATA: pluginData,
      TRINITY_BASE_URL: baseUrl,
    });
  });

  const key = targetKeyForPluginData(pluginData);
  assert.ok(existsSync(pendingConfigPath(home, key)), "pending config must be keyed to TRINITY_CAPTURE_DATA basename");
  assert.ok(!existsSync(pendingConfigPath(home)), "pending config must not use the hardcoded public package fallback");
});

test("connect subprocess sends the same machine id from isolated config directories", async () => {
  const home = tmpHome();
  const firstData = tmpPluginDataWithKey("trinity-capture-first");
  const secondData = tmpPluginDataWithKey("trinity-capture-second");
  const cfg: DeviceConfig = {
    token: "subprocess-token",
    ingestUrl: "https://api.example/api/v1/ingest/batches",
    deviceId: "subprocess-device",
  };

  await withBodyRecordingServer(cfg, async (baseUrl, bodies) => {
    await runCompiledCodexConnect(["FIRST-CODE"], {
      ...process.env,
      CODEX_HOME: home,
      TRINITY_CAPTURE_DATA: firstData,
      TRINITY_BASE_URL: baseUrl,
    });
    await runCompiledCodexConnect(["SECOND-CODE"], {
      ...process.env,
      CODEX_HOME: home,
      TRINITY_CAPTURE_DATA: secondData,
      TRINITY_BASE_URL: baseUrl,
    });

    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies, [
      { code: "FIRST-CODE", hostname: hostname(), machineId: readMachineId(bodies[0]) },
      { code: "SECOND-CODE", hostname: hostname(), machineId: readMachineId(bodies[0]) },
    ]);
  });
});

function readMachineId(body: unknown): string {
  assert.ok(typeof body === "object" && body !== null && "machineId" in body);
  const machineId = Reflect.get(body, "machineId");
  if (typeof machineId !== "string") assert.fail("machineId must be a string");
  assert.match(machineId, /^[0-9a-f]{64}$/);
  assert.ok(!("deviceId" in body), "pairing request must not reuse the saved device id");
  return machineId;
}
