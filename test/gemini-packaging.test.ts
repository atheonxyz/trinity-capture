// The committed gemini/ extension, exactly as `gemini extensions install` copies it, run as Gemini CLI runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, savePolicy } from "../src/config.js";
import { answerJson, runMcpBinary, startDoor, toolsListResult } from "./helpers/mcp-door.js";

const root = join(process.cwd(), "gemini");
const hookBin = join(root, "dist", "gemini-hook.js");
const connectBin = join(root, "dist", "gemini-connect.js");
const mcpBin = join(root, "dist", "gemini-mcp.js");
const EVENTS = ["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent", "SessionEnd"];

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "trinity-gemini-pkg-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@trinity.dev", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@trinity.dev" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

function runHookBinary(dataDir: string, event: string, payload: Record<string, unknown>): string {
  return execFileSync("node", [hookBin, event], { input: JSON.stringify(payload), env: { ...process.env, TRINITY_CAPTURE_DATA: dataDir }, encoding: "utf8" });
}

test("the committed hook, connect and MCP binaries exist", () => {
  for (const bin of [hookBin, connectBin, mcpBin]) assert.ok(existsSync(bin), `${bin} is missing: run pnpm build:gemini and commit the output`);
});

test("gemini/dist is current with src and ships no other product's entrypoint", () => {
  const files = readdirSync(join(root, "dist"));
  for (const file of files) {
    assert.equal(readFileSync(join(root, "dist", file), "utf8"), readFileSync(join(process.cwd(), "dist-test", "src", file), "utf8"), `${file} is stale: run pnpm build:gemini`);
  }
  for (const foreign of ["claude-hook.js", "cursor-hook.js", "codex-hook.js", "copilot-hook.js", "claude-mcp.js", "cursor-mcp.js", "codex-mcp.js", "copilot-mcp.js"]) {
    assert.ok(!files.includes(foreign), `gemini/dist must not ship ${foreign}`);
  }
  for (const other of ["claude-code", "codex", "cursor", "copilot"]) {
    const shipped = readdirSync(join(process.cwd(), other, "dist"));
    assert.ok(!shipped.some((file) => file.startsWith("gemini-")), `${other}/dist must not ship a gemini entrypoint`);
  }
});

test("gemini-extension.json names the extension, its version and the bundled MCP server at the committed proxy", () => {
  const manifest = JSON.parse(readFileSync(join(root, "gemini-extension.json"), "utf8")) as {
    name: string;
    version: string;
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.equal(manifest.name, "trinity-capture");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.mcpServers.trinity, { command: "node", args: ["${extensionPath}${/}dist${/}gemini-mcp.js"] });
  assert.ok(!("hooks" in manifest), "Gemini reads hooks from hooks/hooks.json, never the manifest");
});

test("hooks/hooks.json registers the five captured events at the committed hook, inside the extension", () => {
  const file = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout: number; name: string }[] }[]>;
  };
  assert.deepEqual(Object.keys(file.hooks), EVENTS);
  for (const event of EVENTS) {
    const [group] = file.hooks[event];
    const [hook] = group.hooks;
    assert.equal(hook.type, "command");
    assert.equal(hook.command, `node "\${extensionPath}\${/}dist\${/}gemini-hook.js" ${event}`);
    assert.ok(hook.timeout > 0 && hook.timeout <= 60_000, "Gemini timeouts are milliseconds");
    assert.match(hook.name, /^trinity-capture-/);
  }
  assert.equal(file.hooks.AfterTool[0].matcher, "*");
});

test("/trinity:connect runs the committed connect script with the escaped pairing code", () => {
  const command = readFileSync(join(root, "commands", "trinity", "connect.toml"), "utf8");
  assert.match(command, /!\{node "\$HOME\/\.gemini\/extensions\/trinity-capture\/dist\/gemini-connect\.js" \{\{args\}\}\}/);
  assert.doesNotMatch(command.replace(/!\{[^}]*\{\{args\}\}\}/, ""), /\{\{args\}\}/, "the code reaches the shell only, never the model's prompt");
});

test("committed binary, unauthorized device: exits 0 and writes nothing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-gemini-pkg-data-"));
  runHookBinary(dataDir, "SessionStart", { hook_event_name: "SessionStart", session_id: "s1", cwd: initRepo(), source: "startup" });
  assert.ok(!existsSync(join(dataDir, "outbox")));
});

test("committed binary, authorized and allowlisted: appends the SessionStart pair and prints nothing but JSON", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-gemini-pkg-data-"));
  saveConfig(dataDir, { token: "tok", ingestUrl: "http://127.0.0.1:1/api/v1/ingest/batches", deviceId: "dev1" });
  savePolicy(dataDir, { etag: "e1", fetchedAt: Date.now(), ttlSeconds: 900, captureLevel: "metadata", workspaces: [{ canonicalRepo: "github.com/acme/widgets", aliases: [], route: "project:p1" }] });
  const repo = initRepo();
  const out = runHookBinary(dataDir, "SessionStart", { hook_event_name: "SessionStart", session_id: "s1", transcript_path: "/x", cwd: repo, source: "startup" });
  assert.equal(out, "");
  const kinds = readdirSync(join(dataDir, "outbox")).map((f) => (JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { kind: string }).kind).sort();
  assert.deepEqual(kinds, ["SessionStart", "workspace.observed"]);
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dataDir = mkdtempSync(join(tmpdir(), "trinity-gemini-pkg-data-"));
  try {
    const { port } = server.address() as AddressInfo;
    const env = { ...process.env, TRINITY_CAPTURE_DATA: dataDir, TRINITY_BASE_URL: `http://127.0.0.1:${port}` };
    const missing = spawnSync(process.execPath, [connectBin], { env, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.equal(loadConfig(dataDir), null);
    const paired = await new Promise<{ status: number; stdout: string }>((resolve) => {
      execFile(process.execPath, [connectBin, "ABCD1234"], { env, encoding: "utf8" }, (error, stdout) => resolve({ status: error ? 1 : 0, stdout }));
    });
    assert.equal(paired.status, 0);
    assert.match(paired.stdout, /Trinity paired \(paired-awaiting-new-session\)\. Start a new Gemini CLI session/);
    assert.ok(!paired.stdout.includes("secret-device-token"));
    assert.equal(loadConfig(dataDir)?.deviceId, "dev9");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the committed proxy reads the credential where the hooks keep it and prints no token", async () => {
  const door = await startDoor((incoming, res) => answerJson(res, toolsListResult(incoming.body.id, ["get_task"])));
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "trinity-gemini-pkg-data-"));
    saveConfig(dataDir, { token: "secret-device-token", ingestUrl: door.ingestUrl, deviceId: "dev1", mcpUrl: door.mcpUrl });
    const run = await runMcpBinary(mcpBin, { ...process.env, TRINITY_CAPTURE_DATA: dataDir }, [
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
