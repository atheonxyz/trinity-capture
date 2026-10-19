// The committed copilot/ plugin, exactly as `copilot plugin install` caches it, run as Copilot CLI runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, saveConfig, savePolicy } from "../src/config.js";
import { answerJson, runMcpBinary, startDoor, toolsListResult } from "./helpers/mcp-door.js";

const root = join(process.cwd(), "copilot");
const hookBin = join(root, "dist", "copilot-hook.js");
const connectBin = join(root, "dist", "copilot-connect.js");
const mcpBin = join(root, "dist", "copilot-mcp.js");
const EVENTS = ["sessionStart", "userPromptSubmitted", "postToolUse", "agentStop", "sessionEnd"];
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-copilot-pkg-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@trinity.dev", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@trinity.dev" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

function runHookBinary(dataDir: string, event: string, payload: Record<string, unknown>): string {
  return execFileSync("node", [hookBin, event], { input: JSON.stringify(payload), env: { ...process.env, PLUGIN_ROOT: root, TRINITY_CAPTURE_DATA: dataDir }, encoding: "utf8" });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

test("the committed hook, connect and MCP binaries exist", () => {
  for (const bin of [hookBin, connectBin, mcpBin]) assert.ok(existsSync(bin), `${bin} is missing: run pnpm build:copilot and commit the output`);
});

test("copilot/dist is current with src and ships no other product's entrypoint", () => {
  const files = readdirSync(join(root, "dist"));
  for (const file of files) {
    assert.equal(readFileSync(join(root, "dist", file), "utf8"), readFileSync(join(process.cwd(), "dist-test", "src", file), "utf8"), `${file} is stale: run pnpm build:copilot`);
  }
  for (const foreign of ["claude-hook.js", "cursor-hook.js", "codex-hook.js", "gemini-hook.js", "claude-mcp.js", "cursor-mcp.js", "codex-mcp.js", "gemini-mcp.js"]) {
    assert.ok(!files.includes(foreign), `copilot/dist must not ship ${foreign}`);
  }
  for (const other of ["claude-code", "codex", "cursor", "gemini"]) {
    const shipped = readdirSync(join(process.cwd(), other, "dist"));
    assert.ok(!shipped.some((file) => file.startsWith("copilot-")), `${other}/dist must not ship a copilot entrypoint`);
  }
});

test("plugin.json is an Agent Plugins 1.0 manifest, and the marketplace entry points at it with the same version", () => {
  const plugin = readJson<Record<string, unknown>>(join(root, "plugin.json"));
  assert.equal(plugin.$schema, PLUGIN_SCHEMA);
  assert.equal(plugin.name, "trinity-capture");
  assert.match(String(plugin.version), /^\d+\.\d+\.\d+$/);
  for (const field of ["hooks", "mcpServers", "skills", "agents", "commands"]) {
    assert.ok(!(field in plugin), `${field} is not an Agent Plugins 1.0 manifest field; its location is fixed`);
  }
  const marketplace = readJson<{ name: string; plugins: { name: string; source: string; version: string }[] }>(join(process.cwd(), ".github", "plugin", "marketplace.json"));
  const entry = marketplace.plugins.find((p) => p.name === "trinity-capture");
  assert.ok(entry);
  assert.equal(resolve(process.cwd(), entry.source), root);
  assert.equal(entry.version, plugin.version, "marketplace entry and plugin.json disagree on the version");
});

test("mcp.json declares the stdio trinity server at the committed proxy under the plugin root", () => {
  const mcp = readJson<{ $schema: string; mcpServers: Record<string, unknown> }>(join(root, "mcp.json"));
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(mcp.mcpServers.trinity, { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/dist/copilot-mcp.js"] });
});

test("the hooks file registers the five captured camelCase events at the committed hook, for bash and PowerShell", () => {
  const file = readJson<{ version: number; hooks: Record<string, { type: string; bash: string; powershell: string; timeoutSec: number }[]> }>(
    join(root, "com.github.copilot", "hooks", "hooks.json"),
  );
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.hooks), EVENTS);
  for (const event of EVENTS) {
    const [hook] = file.hooks[event];
    assert.equal(hook.type, "command");
    assert.equal(hook.bash, `node "$PLUGIN_ROOT/dist/copilot-hook.js" ${event}`);
    assert.equal(hook.powershell, `node "$env:PLUGIN_ROOT/dist/copilot-hook.js" ${event}`);
    assert.ok(hook.timeoutSec > 0 && hook.timeoutSec <= 30);
  }
});

test("the connect skill finds the installed plugin and runs its committed connect script", () => {
  const skill = readFileSync(join(root, "skills", "trinity-connect", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: trinity-connect\n/);
  assert.match(skill, /installed-plugins/);
  assert.match(skill, /dist\/copilot-connect\.js/);
  assert.doesNotMatch(skill, /PLUGIN_ROOT/, "a skill runs without hook-only environment");
});

test("committed binary, unauthorized device: exits 0 and writes nothing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-copilot-pkg-data-"));
  runHookBinary(dataDir, "sessionStart", { sessionId: "s1", timestamp: 1, cwd: initRepo(), source: "startup" });
  assert.ok(!existsSync(join(dataDir, "outbox")));
});

test("committed binary, authorized and allowlisted: appends the sessionStart pair and prints nothing but JSON", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-copilot-pkg-data-"));
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, { etag: "e1", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }] });
  const out = runHookBinary(dataDir, "sessionStart", { sessionId: "s1", timestamp: 1, cwd: initRepo(), source: "startup" });
  assert.equal(out, "");
  const kinds = readdirSync(join(dataDir, "outbox")).map((f) => readJson<{ kind: string }>(join(dataDir, "outbox", f)).kind).sort();
  assert.deepEqual(kinds, ["sessionStart", "workspace.observed"]);
});

test("the committed connect script pairs into the hooks' directory, prints no token, and refuses a missing code", async () => {
  const server = createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    if (req.method === "POST" && req.url === "/api/v1/devices/exchange") {
      answerJson(res, { token: "secret-device-token", deviceId: "dev9", ingestUrl: `http://127.0.0.1:${port}/api/v1/ingest/batches` });
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/ingest/policy") {
      answerJson(res, { etag: "e1", ttlSeconds: 900, captureLevel: "metadata", workspaces: [] });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-copilot-pkg-data-"));
  try {
    const { port } = server.address() as AddressInfo;
    const env = { ...process.env, TRINITY_CAPTURE_DATA: dataDir, TRINITY_BASE_URL: `http://127.0.0.1:${port}` };
    const missing = spawnSync(process.execPath, [connectBin], { env, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.equal(loadConfig(dataDir), null);
    const paired = await new Promise<{ status: number; stdout: string }>((done) => {
      execFile(process.execPath, [connectBin, "ABCD1234"], { env, encoding: "utf8" }, (error, stdout) => done({ status: error ? 1 : 0, stdout }));
    });
    assert.equal(paired.status, 0);
    assert.match(paired.stdout, /Trinity paired \(paired-awaiting-new-session\)\. Start a new Copilot CLI session/);
    assert.ok(!paired.stdout.includes("secret-device-token"));
    assert.equal(loadConfig(dataDir)?.deviceId, "dev9");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("the committed proxy reads the credential where the hooks keep it and prints no token", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task"])));
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "trinity-copilot-pkg-data-"));
    saveConfig(dataDir, { token: "secret-device-token", ingestUrl: door.ingestUrl, deviceId: "dev1", mcpUrl: door.mcpUrl });
    const run = await runMcpBinary(mcpBin, { ...process.env, PLUGIN_ROOT: root, TRINITY_CAPTURE_DATA: dataDir }, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.equal(run.exitCode, 0);
    assert.deepEqual(run.answers.find((answer) => answer.id === 2), toolsListResult(2, ["get_task"]));
    assert.equal(door.requests[0]?.authorization, "Bearer secret-device-token");
    assert.ok(!run.stdout.includes("secret-device-token"));
  } finally {
    await door.close();
  }
});
